// The local job admission gate. One machine-local lock that every launcher shares —
// the runner and the hand-started Codex jobs' CLI — so two starters never take the same heavy
// slot, and a second heavy job is admitted only when the host's measured memory allows it.
//
// Layout, all under `dir` (default ~/.codex-jobs/.slots):
//   .lock/          the admission lock (a directory: mkdir is atomic)
//   claims/<id>.json  one per live claim
//   peaks.json      per class, the measured peak working set of a job's process tree and the most
//                   a job took from the host's available memory (never a point sample)
//   history.jsonl   every ended claim, with how it ended and its exit code when known
//   reaps.jsonl     memory snapshots taken when a reap notice arrived
//
// Claims never carry a command line, a prompt, an environment or a secret: only the task
// key or worktree, the launcher, the class, the process id and its start time, and when it was
// claimed. For the routing pilot a claim also keeps the routing advice and the admission decision,
// in plain words, the Track attempt it works for and its own measured peak, so each ended
// claim's history line holds what the pilot reviews. Node 24, no dependencies.

import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { freemem, totalmem, uptime } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expandHome } from "./config.mjs";

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

export const SLOT_DEFAULTS = {
	dir: "~/.codex-jobs/.slots",
	maxHeavy: 1,
	// What available memory must keep while a job runs, after the class's measured peak. Leaves room
	// for the OS and for work no launcher started.
	reserveBytes: 2 * GIB,
	launchTimeoutMs: 5 * 60_000,
	lockTimeoutMs: 15_000,
	lockStaleMs: 2 * 60_000,
	mode: "advise", // "advise" admits as today and only logs what it would have decided
};

export const CLASSES = ["heavy", "light"];

export class SlotsError extends Error {}

// --- Probes: memory and processes, injectable so tests never touch the real host. ---

/** Parses /proc/meminfo (Linux) into the memory figures admission reads. */
export function parseMeminfo(text) {
	const kb = (name) => {
		const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
		return match ? Number(match[1]) * 1024 : null;
	};
	const available = kb("MemAvailable");
	const commitLimit = kb("CommitLimit");
	const committed = kb("Committed_AS");
	return {
		availableBytes: available,
		totalBytes: null,
		commitAvailableBytes: commitLimit !== null && committed !== null ? commitLimit - committed : null,
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The host's memory: `os.freemem()` is the available figure on Windows and Linux. */
export function osProbe() {
	let commitCache = { at: 0, value: null };
	return async () => {
		const availableBytes = freemem();
		let commitAvailableBytes = null;
		if (process.platform === "win32") {
			// Commit charge against the commit limit, through CIM. Cached: it changes slowly and a
			// PowerShell start is slow.
			if (Date.now() - commitCache.at > 30_000) {
				try {
					const { stdout } = await execFileAsync(
						"powershell.exe",
						[
							"-NoProfile",
							"-Command",
							"$o=Get-CimInstance Win32_OperatingSystem; '{0} {1}' -f $o.FreeVirtualMemory,$o.TotalVirtualMemorySize",
						],
						{ timeout: 20_000 },
					);
					const [freeKb, totalKb] = stdout.trim().split(/\s+/).map(Number);
					if (Number.isFinite(freeKb)) commitAvailableBytes = freeKb * 1024;
					commitCache = { at: Date.now(), value: commitAvailableBytes };
				} catch {
					commitCache = { at: Date.now(), value: null };
				}
			} else {
				commitAvailableBytes = commitCache.value;
			}
		} else if (process.platform === "linux") {
			try {
				commitAvailableBytes = parseMeminfo(await readFile("/proc/meminfo", "utf8")).commitAvailableBytes;
			} catch {
				// No commit figure: the check is skipped rather than guessed.
			}
		}
		return { availableBytes, totalBytes: totalmem(), commitAvailableBytes };
	};
}

/**
 * The host's processes as one table: { pid, ppid, workingSetBytes, startedAtMs } per row.
 * Windows answers through one CIM query; Linux reads /proc (start time = boot time + the
 * process's start ticks, USER_HZ is 100 on every platform Node supports).
 */
export function osProcessTable() {
	if (process.platform === "win32") return windowsProcessTable;
	return linuxProcessTable;
}

async function windowsProcessTable() {
	const { stdout } = await execFileAsync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process | ForEach-Object { $s=$null; try { $s=[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } catch {}; '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,$s }",
		],
		{ timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
	);
	const table = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [pid, ppid, workingSet, startedAtMs] = line.trim().split("|").map((v) => Number(v));
		if (Number.isFinite(pid)) {
			table.push({ pid, ppid: Number.isFinite(ppid) ? ppid : 0, workingSetBytes: Number.isFinite(workingSet) ? workingSet : 0, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null });
		}
	}
	return table;
}

async function linuxProcessTable() {
	const { readdir: readDir, readFile: read } = await import("node:fs/promises");
	const table = [];
	let btime = 0;
	try {
		const statText = await read("/proc/stat", "utf8");
		btime = Number(statText.match(/^btime (\d+)/m)?.[1] ?? 0);
	} catch {
		// Without boot time no start time can be computed; claims then reconcile on liveness alone.
	}
	for (const entry of await readDir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		try {
			const statText = await read(`/proc/${pid}/stat`, "utf8");
			const rest = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
			const ppid = Number(rest[1]);
			const startTicks = Number(rest[19]); // field 22: starttime
			const startedAtMs = btime && Number.isFinite(startTicks) ? (btime + startTicks / 100) * 1000 : null;
			let workingSetBytes = 0;
			try {
				const status = await read(`/proc/${pid}/status`, "utf8");
				workingSetBytes = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0) * 1024;
			} catch {
				// A process that vanished mid-read counts as gone.
				continue;
			}
			table.push({ pid, ppid, workingSetBytes, startedAtMs });
		} catch {
			// Vanished between readdir and read.
		}
	}
	return table;
}

// --- The gate. ---

const fmtGiB = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * What admission subtracts for a class: the most one of its jobs took from the host's available
 * memory, or, until a job measured that, its tree's peak working set. The tree's figure counts a
 * page shared by its processes once per process, so it overstates what the job took.
 */
export function admissionPeak(peak) {
	if (Number.isFinite(peak?.hostBytes)) return peak.hostBytes;
	return Number.isFinite(peak?.bytes) ? peak.bytes : null;
}

/**
 * The admission decision, pure so tests drive it directly. `claims` are the reconciled live
 * claims, `memory` the probe's figures, `peakBytes` the class's measured peak (`admissionPeak`;
 * null until a job of the class is measured).
 */
export function decideAdmission({ klass, claims, memory, reserveBytes, maxHeavy, peakBytes }) {
	if (klass === "light") return { admit: true, reason: "a light claim takes no slot" };
	const heavy = claims.filter((claim) => claim.class === "heavy");
	if (heavy.length >= maxHeavy) {
		const names = heavy.map((claim) => claim.task ?? claim.id).join(", ");
		return {
			admit: false,
			reason: heavy.length === 1 ? `one heavy job is running: ${names}` : `${heavy.length} heavy jobs are running: ${names}`,
		};
	}
	// the host's memory decides, not only the claims — work no launcher started lowers this.
	const headroom = memory.availableBytes - (peakBytes ?? 0);
	if (headroom < reserveBytes) {
		return {
			admit: false,
			reason: peakBytes
				? `available ${fmtGiB(memory.availableBytes)} leaves ${fmtGiB(Math.max(0, headroom))} after a ${klass} job's measured ${fmtGiB(peakBytes)}, below the ${fmtGiB(reserveBytes)} reserve`
				: `available ${fmtGiB(memory.availableBytes)}, below the ${fmtGiB(reserveBytes)} reserve`,
		};
	}
	if (memory.commitAvailableBytes != null && memory.commitAvailableBytes < reserveBytes) {
		return {
			admit: false,
			reason: `commit charge leaves ${fmtGiB(memory.commitAvailableBytes)}, below the ${fmtGiB(reserveBytes)} reserve`,
		};
	}
	return { admit: true, reason: "capacity allows it" };
}

export class SlotsGate {
	#ownProcess = null;

	constructor({
		dir = SLOT_DEFAULTS.dir,
		maxHeavy = SLOT_DEFAULTS.maxHeavy,
		reserveBytes = SLOT_DEFAULTS.reserveBytes,
		launchTimeoutMs = SLOT_DEFAULTS.launchTimeoutMs,
		lockTimeoutMs = SLOT_DEFAULTS.lockTimeoutMs,
		lockStaleMs = SLOT_DEFAULTS.lockStaleMs,
		mode = SLOT_DEFAULTS.mode,
		probe = osProbe(),
		processTable = osProcessTable(),
		now = () => new Date(),
		uptimeSec = uptime,
		log = () => {},
		sleep: sleepImpl = sleep,
		mkdir: mkdirImpl = mkdir,
	} = {}) {
		this.dir = expandHome(dir);
		this.claimsDir = join(this.dir, "claims");
		this.lockDir = join(this.dir, ".lock");
		this.peaksFile = join(this.dir, "peaks.json");
		this.historyFile = join(this.dir, "history.jsonl");
		this.maxHeavy = maxHeavy;
		this.reserveBytes = reserveBytes;
		this.launchTimeoutMs = launchTimeoutMs;
		this.lockTimeoutMs = lockTimeoutMs;
		this.lockStaleMs = lockStaleMs;
		this.mode = mode;
		this.probe = probe;
		this.processTable = processTable;
		this.now = now;
		this.uptimeSec = uptimeSec;
		this.log = log;
		this.sleep = sleepImpl;
		this.mkdir = mkdirImpl;
	}

	/**
	 * This process as a claim's holder: its id and its start time, so a later process that reuses
	 * the id is not taken for it. Asked once; without a start time only the id is compared.
	 */
	async ownProcess() {
		this.#ownProcess ??= this.processTable([process.pid]).then(
			(rows) => ({ pid: process.pid, pidStartMs: rows.find((row) => row.pid === process.pid)?.startedAtMs ?? null }),
			() => ({ pid: process.pid, pidStartMs: null }),
		);
		return this.#ownProcess;
	}

	async #withLock(fn) {
		await mkdir(this.dir, { recursive: true });
		const deadline = Date.now() + this.lockTimeoutMs;
		for (;;) {
			try {
				await this.mkdir(this.lockDir);
				break;
			} catch (error) {
				// Windows refuses to make a directory that the holder is still removing (EPERM).
				// That is the lock being released, so it is retried like a held lock.
				if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
				// A lock older than lockStaleMs is a dead holder's; break it.
				try {
					const { mtimeMs } = await stat(this.lockDir);
					if (Date.now() - mtimeMs > this.lockStaleMs) {
						await rm(this.lockDir, { recursive: true, force: true });
						continue;
					}
				} catch {
					// The holder released between our mkdir and stat; retry.
				}
				if (Date.now() > deadline) {
					throw error.code === "EPERM" ? error : new SlotsError("another starter holds the admission lock");
				}
				await this.sleep(50);
			}
		}
		try {
			return await fn();
		} finally {
			await rm(this.lockDir, { recursive: true, force: true });
		}
	}

	async #readClaims() {
		let names;
		try {
			names = await readdir(this.claimsDir);
		} catch {
			return [];
		}
		const claims = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			try {
				claims.push(JSON.parse(await readFile(join(this.claimsDir, name), "utf8")));
			} catch {
				// A torn write is a claim that never was; the next reconcile's re-read settles it.
			}
		}
		return claims;
	}

	async #writeClaim(claim) {
		await mkdir(this.claimsDir, { recursive: true });
		await writeFile(join(this.claimsDir, `${claim.id}.json`), `${JSON.stringify(claim, null, "\t")}\n`, { flag: "wx" });
	}

	async #history(entry) {
		await mkdir(this.dir, { recursive: true });
		await appendFile(this.historyFile, `${JSON.stringify(entry)}\n`);
	}

	async #peaks() {
		try {
			return JSON.parse(await readFile(this.peaksFile, "utf8"));
		} catch {
			return {};
		}
	}

	/**
	 * Drops what no longer holds, on every acquire and every status:
	 *  - the machine rebooted since the claim (uptime went backwards);
	 *  - the process is gone (ended somehow; exit code only the releaser knows);
	 *  - the process id now belongs to a process with a different start time (the id was reused);
	 *  - a claim with no process after launchTimeoutMs is an interrupted launch.
	 * A stopped-under-pressure ending is recognised when the host's memory was under the reserve
	 * as the process went; nothing here relaunches anything or touches a worktree.
	 */
	async reconcile() {
		const claims = await this.#readClaims();
		if (!claims.length) return [];
		const withPid = claims.filter((claim) => claim.pid != null);
		const table = withPid.length ? await this.processTable(withPid.map((claim) => claim.pid)) : [];
		const byPid = new Map(table.map((row) => [row.pid, row]));
		const memory = await this.probe();
		const peaks = await this.#peaks();
		const nowMs = this.now().getTime();
		const uptimeNow = this.uptimeSec();
		const removed = [];
		for (const claim of claims) {
			let ended = null;
			if (uptimeNow + 5 < claim.claimedAtUptimeSec) {
				ended = { endedHow: "stale", why: "the machine rebooted" };
			} else if (claim.pid == null) {
				if (nowMs - new Date(claim.claimedAt).getTime() > this.launchTimeoutMs) {
					ended = { endedHow: "interrupted", why: "launched without a process" };
				}
			} else {
				const row = byPid.get(claim.pid);
				const headroom = memory.availableBytes - (admissionPeak(peaks[claim.class]) ?? 0);
				const underPressure = headroom < this.reserveBytes;
				if (!row) {
					ended = {
						endedHow: underPressure ? "stopped-under-pressure" : "interrupted",
						why: "the process is gone",
					};
				} else if (claim.pidStartMs != null && row.startedAtMs != null && row.startedAtMs !== claim.pidStartMs) {
					ended = { endedHow: "stale", why: "the process id was reused" };
				}
			}
			if (!ended) continue;
			await this.#history({ ...claim, ...ended, endedAt: this.now().toISOString() });
			await rm(join(this.claimsDir, `${claim.id}.json`), { force: true });
			removed.push({ claim, ...ended });
		}
		return removed;
	}

	/**
	 * Claims a slot. In `advise` mode the claim is always written (the job runs as today) and the
	 * result carries `advisory` with what enforce mode would have decided; in `enforce` mode a
	 * held claim returns `admitted: false` with the plain-words reason and writes nothing.
	 */
	async acquire({ klass = "heavy", task = null, worktree = null, launcher, pid = null, pidStartMs = null, dockerCloudEligible = false, route = null }) {
		if (!CLASSES.includes(klass)) throw new SlotsError(`class must be one of ${CLASSES.join(", ")}`);
		if (!launcher) throw new SlotsError("a claim names its launcher");
		return this.#withLock(async () => {
			const removed = await this.reconcile();
			for (const { claim, endedHow } of removed) this.log(`${claim.task ?? claim.id}: claim ended (${endedHow})`);
			const claims = await this.#readClaims();
			const memory = await this.probe();
			const peaks = await this.#peaks();
			const decision = decideAdmission({
				klass,
				claims,
				memory,
				reserveBytes: this.reserveBytes,
				maxHeavy: this.maxHeavy,
				peakBytes: admissionPeak(peaks[klass]),
			});
			let reason = decision.reason;
			if (!decision.admit && dockerCloudEligible) reason += "; eligible for Docker Cloud";
			if (this.mode === "enforce" && !decision.admit) {
				this.log(`held ${task ?? "a job"} (${klass}): ${reason}`);
				return { admitted: false, reason, claim: null, removed };
			}
			const claim = {
				id: randomUUID(),
				task,
				worktree,
				launcher,
				class: klass,
				pid,
				pidStartMs,
				claimedAt: this.now().toISOString(),
				claimedAtUptimeSec: this.uptimeSec(),
				dockerCloudEligible,
				route: route && { advice: route.advice, reasons: [...route.reasons] },
				admission: { admit: decision.admit, reason: decision.reason },
			};
			await this.#writeClaim(claim);
			const advisory = decision.admit ? null : { wouldAdmit: false, reason };
			this.log(`${task ?? claim.id}: claimed a ${klass} slot${advisory ? ` (advise: would have held — ${reason})` : ""}`);
			return { admitted: true, reason, claim, advisory, removed };
		});
	}

	/**
	 * Changes a live claim under the lock and returns it, or null when it has ended. Only under the
	 * lock: a write after a release or a reconcile removed the file would bring the claim back.
	 */
	async #updateClaim(id, change) {
		return this.#withLock(async () => {
			const file = join(this.claimsDir, `${id}.json`);
			let claim;
			try {
				claim = JSON.parse(await readFile(file, "utf8"));
			} catch {
				return null;
			}
			change(claim);
			const tmp = `${file}.tmp`;
			await writeFile(tmp, `${JSON.stringify(claim, null, "\t")}\n`);
			await rename(tmp, file);
			return claim;
		});
	}

	/** Sets the process a claim runs as, once the launcher knows it (the hand launcher's attach step). */
	async attach(id, { pid, pidStartMs = null }) {
		const claim = await this.#updateClaim(id, (live) => {
			live.pid = pid;
			live.pidStartMs = pidStartMs;
			live.attachedAt = this.now().toISOString();
		});
		if (!claim) throw new SlotsError(`no claim ${id}`);
		return claim;
	}

	/** Names the Track attempt a claim works for; routing and reporting share its id. */
	async linkAttempt(id, attemptId) {
		return this.#updateClaim(id, (live) => {
			live.attemptId = attemptId;
		});
	}

	/** Releases a claim by its id, recording the exit code when the launcher knows it. */
	async release(id, { code = null } = {}) {
		return this.#withLock(async () => {
			const file = join(this.claimsDir, `${id}.json`);
			let claim;
			try {
				claim = JSON.parse(await readFile(file, "utf8"));
			} catch {
				return false;
			}
			await this.#history({
				...claim,
				endedHow: "clean",
				exitCode: code,
				endedAt: this.now().toISOString(),
			});
			await rm(file, { force: true });
			return true;
		});
	}

	/**
	 * Records a measured peak for a class, the highest sample winning: `bytes`, the tree's
	 * working set, and `hostBytes`, how far the host's available memory fell since the job began.
	 * With `claimId` the claim's own peaks too, which its history line keeps however the claim ends.
	 */
	async recordPeak(klass, bytes, { source = "sample", claimId = null, hostBytes = null } = {}) {
		if (!CLASSES.includes(klass)) throw new SlotsError(`class must be one of ${CLASSES.join(", ")}`);
		const peaks = await this.#peaks();
		const at = this.now().toISOString();
		const entry = { ...peaks[klass] };
		let changed = false;
		if (bytes > (entry.bytes ?? 0)) {
			Object.assign(entry, { bytes, at, source });
			changed = true;
		}
		if (hostBytes != null && hostBytes > (entry.hostBytes ?? 0)) {
			Object.assign(entry, { hostBytes, hostAt: at });
			changed = true;
		}
		if (changed) {
			peaks[klass] = entry;
			await mkdir(this.dir, { recursive: true });
			const tmp = `${this.peaksFile}.tmp`;
			await writeFile(tmp, `${JSON.stringify(peaks, null, "\t")}\n`);
			await rename(tmp, this.peaksFile);
		}
		if (claimId) {
			// Best-effort: a busy lock must not stop the sampling, and the next higher sample retries.
			await this.#updateClaim(claimId, (live) => {
				if (!(live.peakBytes >= bytes)) live.peakBytes = bytes;
				if (hostBytes != null && !(live.hostPeakBytes >= hostBytes)) live.hostPeakBytes = hostBytes;
			}).catch((error) => this.log(`could not note the peak on claim ${claimId}: ${error.message}`));
		}
		return peaks[klass];
	}

	/** What status shows: claims, the host's figures, the peaks — never a command line. */
	async status() {
		const removed = await this.reconcile();
		const claims = (await this.#readClaims()).map((claim) => ({
			id: claim.id,
			task: claim.task,
			worktree: claim.worktree,
			launcher: claim.launcher,
			class: claim.class,
			pid: claim.pid,
			since: claim.claimedAt,
			dockerCloudEligible: claim.dockerCloudEligible === true,
			route: claim.route?.advice ?? null,
			attemptId: claim.attemptId ?? null,
		}));
		const memory = await this.probe();
		const peaks = await this.#peaks();
		const history = await this.#historyTail(10);
		return {
			at: this.now().toISOString(),
			mode: this.mode,
			reserveBytes: this.reserveBytes,
			maxHeavy: this.maxHeavy,
			memory: {
				availableBytes: memory.availableBytes,
				totalBytes: memory.totalBytes,
				commitAvailableBytes: memory.commitAvailableBytes,
			},
			peaks,
			claims,
			history,
			reconciled: removed.map((entry) => ({ task: entry.claim.task, endedHow: entry.endedHow, why: entry.why })),
		};
	}

	/** Every ended claim, oldest first; a torn line is skipped. */
	async #historyEntries() {
		let text;
		try {
			text = await readFile(this.historyFile, "utf8");
		} catch {
			return [];
		}
		return text
			.split("\n")
			.filter((line) => line.trim())
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
	}

	async #historyTail(count) {
		return (await this.#historyEntries()).slice(-count).map((entry) => ({
			task: entry.task ?? entry.id,
			class: entry.class,
			endedHow: entry.endedHow,
			exitCode: entry.exitCode ?? null,
			endedAt: entry.endedAt,
			route: entry.route?.advice ?? null,
			peakBytes: entry.peakBytes ?? null,
			hostPeakBytes: entry.hostPeakBytes ?? null,
		}));
	}

	/** The pilot's summary of the claims that ended at or after `since`, if given. */
	async report({ since = null } = {}) {
		const from = since === null ? null : new Date(since);
		if (from && Number.isNaN(from.getTime())) throw new SlotsError(`since is not a date: ${since}`);
		const entries = (await this.#historyEntries()).filter((entry) => !from || new Date(entry.endedAt) >= from);
		return { at: this.now().toISOString(), since: from?.toISOString() ?? null, ...summarizeHistory(entries) };
	}
}

const INTERRUPTIONS = ["interrupted", "stopped-under-pressure"];

/**
 * What the routing pilot reviews before routing does anything: the launches, the routing
 * advice and why a job stays local, what enforce would have held, how claims ended and the peaks
 * measured. Pure, over ended claims as history.jsonl keeps them.
 */
export function summarizeHistory(entries) {
	const tally = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
	const launchers = new Map();
	const routes = new Map();
	const localReasons = new Map();
	const endings = new Map();
	const peaks = [];
	const hostPeaks = [];
	let wouldHold = 0;
	let failedExits = 0;
	let cloudInterrupted = 0;
	for (const entry of entries) {
		tally(launchers, entry.launcher ?? "unknown");
		const advice = entry.route?.advice ?? "unrecorded";
		tally(routes, advice);
		if (advice === "local") for (const reason of entry.route.reasons ?? []) tally(localReasons, reason);
		if (entry.admission?.admit === false) wouldHold++;
		tally(endings, entry.endedHow ?? "unknown");
		if (entry.endedHow === "clean" && entry.exitCode != null && entry.exitCode !== 0) failedExits++;
		if (advice === "cloud" && INTERRUPTIONS.includes(entry.endedHow)) cloudInterrupted++;
		if (Number.isFinite(entry.peakBytes) && entry.peakBytes > 0) peaks.push(entry.peakBytes);
		if (Number.isFinite(entry.hostPeakBytes) && entry.hostPeakBytes > 0) hostPeaks.push(entry.hostPeakBytes);
	}
	const interrupted = INTERRUPTIONS.reduce((sum, how) => sum + (endings.get(how) ?? 0), 0);
	return {
		launches: entries.length,
		launchers: Object.fromEntries(launchers),
		routes: { cloud: routes.get("cloud") ?? 0, local: routes.get("local") ?? 0, unrecorded: routes.get("unrecorded") ?? 0 },
		localReasons: Object.fromEntries([...localReasons].sort((a, b) => b[1] - a[1])),
		wouldHold,
		endings: Object.fromEntries(endings),
		interrupted,
		interruptionRate: entries.length ? interrupted / entries.length : null,
		failedExits,
		cloudInterrupted,
		peaks: spread(peaks),
		hostPeaks: spread(hostPeaks),
	};
}

/** How many figures, their median and their largest. */
function spread(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const medianBytes = !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	return { measured: sorted.length, medianBytes, maxBytes: sorted.at(-1) ?? null };
}

/**
 * Samples a process tree's working set until the process exits, and records the class peak.
 * `treeBytes(table, rootPid)` sums the root and its descendants.
 */
const ENDINGS = {
	clean: "released",
	interrupted: "interrupted",
	"stopped-under-pressure": "stopped under memory pressure",
	stale: "stale",
};

/** The report in plain words, for a person reviewing the pilot. */
export function formatReport(report) {
	const gib = (bytes) => (bytes == null ? "none" : fmtGiB(bytes));
	const list = (counts, name = (key) => key) =>
		Object.entries(counts).map(([key, n]) => `${name(key)} ${n}`).join(", ") || "none";
	const lines = [
		`${report.launches} ended claim${report.launches === 1 ? "" : "s"}${report.since ? ` since ${report.since}` : ""} (${list(report.launchers)})`,
		`routing advice: Docker Cloud ${report.routes.cloud}, local ${report.routes.local}, not recorded ${report.routes.unrecorded}`,
	];
	for (const [reason, n] of Object.entries(report.localReasons)) lines.push(`  local because ${reason}: ${n}`);
	lines.push(`enforce would have held: ${report.wouldHold}`);
	lines.push(`endings: ${list(report.endings, (how) => ENDINGS[how] ?? how)}`);
	if (report.failedExits) lines.push(`  released with a failing exit code: ${report.failedExits}`);
	const rate = report.interruptionRate == null ? "" : ` (${Math.round(report.interruptionRate * 100)}%)`;
	lines.push(`interrupted: ${report.interrupted}${rate}, of which Docker Cloud advice ${report.cloudInterrupted}`);
	lines.push(`peak working set: ${report.peaks.measured} measured, median ${gib(report.peaks.medianBytes)}, max ${gib(report.peaks.maxBytes)}`);
	const host = report.hostPeaks ?? { measured: 0 };
	lines.push(`taken from available memory: ${host.measured} measured, median ${gib(host.medianBytes)}, max ${gib(host.maxBytes)}`);
	return lines.join("\n");
}

export async function samplePeak({ pid, klass, gate, claimId = null, intervalMs = 3000, table = osProcessTable(), sleep: nap = sleep, log = () => {} }) {
	let peak = 0;
	// How far the host's available memory fell since the first sample: what admission subtracts
	// (`admissionPeak`). Load that rose elsewhere meanwhile counts too, which errs on the safe side.
	let startAvailable = null;
	let hostPeak = 0;
	for (;;) {
		const all = await table();
		if (!all.some((row) => row.pid === pid)) break; // gone: the peak is final
		const byParent = new Map();
		for (const row of all) {
			const list = byParent.get(row.ppid) ?? [];
			list.push(row);
			byParent.set(row.ppid, list);
		}
		let total = 0;
		const queue = [pid];
		const seen = new Set();
		while (queue.length) {
			const current = queue.shift();
			if (seen.has(current)) continue;
			seen.add(current);
			const row = all.find((candidate) => candidate.pid === current);
			if (row) total += row.workingSetBytes ?? 0;
			for (const child of byParent.get(current) ?? []) queue.push(child.pid);
		}
		let fell = 0;
		try {
			const { availableBytes } = await gate.probe();
			if (Number.isFinite(availableBytes)) {
				startAvailable ??= availableBytes;
				fell = startAvailable - availableBytes;
			}
		} catch {
			// No memory figure this time: the working set still counts.
		}
		if (total > peak || fell > hostPeak) {
			peak = Math.max(peak, total);
			hostPeak = Math.max(hostPeak, fell);
			await gate.recordPeak(klass, peak, { claimId, hostBytes: hostPeak });
		}
		await nap(intervalMs);
	}
	log(`peak for ${klass}: working set ${fmtGiB(peak)}, ${fmtGiB(hostPeak)} taken from available memory`);
	return peak;
}

export { GIB };
