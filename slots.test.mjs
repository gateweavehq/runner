// Tests for the admission gate: node --test slots.test.mjs
// Memory and processes are faked; the lock, claims and history are real files in a temp dir.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admissionPeak, decideAdmission, formatReport, parseMeminfo, samplePeak, SLOT_DEFAULTS, SlotsGate, summarizeHistory, GIB } from "./slots.mjs";

const GIB8 = 8 * GIB;
const GIB12 = 12 * GIB;
const GIB6 = 6 * GIB;
const GIB20 = 20 * GIB;
const GIB4 = 4 * GIB;

/** A gate on a fresh temp dir, with memory and processes the test controls. */
async function gate(overrides = {}) {
	const dir = await mkdtemp(join(tmpdir(), "slots-"));
	const state = { available: GIB12, commit: GIB20, processes: new Map(), now: new Date("2026-11-20T21:00:00Z") };
	const g = new SlotsGate({
		dir,
		reserveBytes: GIB8,
		probe: async () => ({ availableBytes: state.available, totalBytes: 32 * GIB, commitAvailableBytes: state.commit }),
		processTable: async () =>
			[...state.processes.entries()].map(([pid, p]) => ({
				pid,
				ppid: 1,
				workingSetBytes: p.workingSet ?? GIB,
				startedAtMs: p.startedAtMs ?? 1000,
			})),
		now: () => state.now,
		uptimeSec: () => 100_000,
		sleep: async () => {},
		...overrides,
	});
	return { gate: g, dir, state };
}

const heavy = (over = {}) => ({ klass: "heavy", task: "ENG-69", launcher: "hand", ...over });

test("parseMeminfo reads available and commit figures", () => {
	const parsed = parseMeminfo("MemTotal: 1 kB\nMemAvailable: 2048 kB\nCommitLimit: 4096 kB\nCommitted_AS: 1024 kB\n");
	assert.equal(parsed.availableBytes, 2048 * 1024);
	assert.equal(parsed.commitAvailableBytes, 3072 * 1024);
});

test("two contenders for the last slot: exactly one claim results", async () => {
	const { gate: g, state } = await gate({ mode: "enforce" });
	const first = await g.acquire(heavy({ pid: 100, pidStartMs: 1000 }));
	state.processes.set(100, { startedAtMs: 1000 });
	const second = await g.acquire(heavy({ task: "ENG-70", pid: 101, pidStartMs: 1000 }));
	assert.equal(first.admitted, true);
	assert.equal(second.admitted, false);
	assert.match(second.reason, /one heavy job is running: ENG-69/);
});

test("both contenders racing on one slot: exactly one wins", async () => {
	const { gate: g, state } = await gate({ mode: "enforce" });
	state.processes.set(100, { startedAtMs: 1000 });
	state.processes.set(101, { startedAtMs: 1000 });
	const [a, b] = await Promise.all([
		g.acquire(heavy({ task: "A", pid: 100, pidStartMs: 1000 })),
		g.acquire(heavy({ task: "B", pid: 101, pidStartMs: 1000 })),
	]);
	assert.equal([a.admitted, b.admitted].filter(Boolean).length, 1);
});

test("a lock still being removed (EPERM on Windows) is waited for, not fatal", async () => {
	let refusals = 0;
	const { gate: g } = await gate({
		mkdir: async (path, options) => {
			if (path.endsWith(".lock") && refusals < 3) {
				refusals++;
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			}
			return mkdir(path, options);
		},
	});
	const result = await g.acquire(heavy());
	assert.equal(result.admitted, true);
	assert.equal(refusals, 3);

	const { gate: denied } = await gate({
		lockTimeoutMs: 0,
		mkdir: async (path, options) => {
			if (path.endsWith(".lock")) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			return mkdir(path, options);
		},
	});
	await assert.rejects(denied.acquire(heavy()), { code: "EPERM" });
});

test("a memory dip below the reserve holds a claim, and the reason says why", async () => {
	const { gate: g, state } = await gate({ mode: "enforce" });
	state.available = GIB6; // 6 GiB available, 8 GiB reserve, no peak subtracted yet
	const result = await g.acquire(heavy());
	assert.equal(result.admitted, false);
	assert.match(result.reason, /available 6\.0 GiB, below the 8\.0 GiB reserve/);
});

test("unclaimed load — memory used with no claim — holds a heavy claim too", () => {
	const decision = decideAdmission({
		klass: "heavy",
		claims: [],
		memory: { availableBytes: GIB6, commitAvailableBytes: GIB20 },
		reserveBytes: GIB8,
		maxHeavy: 1,
		peakBytes: null,
	});
	assert.equal(decision.admit, false);
});

test("a measured peak is subtracted before comparing with the reserve", () => {
	const decision = decideAdmission({
		klass: "heavy",
		claims: [],
		memory: { availableBytes: GIB12, commitAvailableBytes: GIB20 },
		reserveBytes: GIB8,
		maxHeavy: 1,
		peakBytes: 5 * GIB,
	});
	assert.equal(decision.admit, false); // 12 - 5 = 7 GiB headroom < 8
	const ok = decideAdmission({
		klass: "heavy",
		claims: [],
		memory: { availableBytes: GIB12, commitAvailableBytes: GIB20 },
		reserveBytes: GIB8,
		maxHeavy: 1,
		peakBytes: 3 * GIB,
	});
	assert.equal(ok.admit, true);
});

test("a stale process id and a reused one with a different start time are reconciled", async () => {
	const { gate: g, state } = await gate({ mode: "enforce" });
	// A claim whose process is gone ends; its slot frees for the next acquire.
	await g.acquire(heavy({ task: "GONE", pid: 500, pidStartMs: 1 }));
	// pid 500 is not in state.processes, so the next acquire reconciles it away.
	const next = await g.acquire(heavy({ task: "NEXT", pid: 501, pidStartMs: 1000 }));
	assert.equal(next.admitted, true);

	// A living process with a different start time means the id was reused: stale too.
	state.processes.set(600, { startedAtMs: 999 });
	await g.acquire(heavy({ task: "REUSED", pid: 600, pidStartMs: 1000 }));
	state.available = GIB12;
	await g.release((await g.status()).claims.find((c) => c.task === "NEXT")?.id ?? "", {});
	const after = await g.acquire(heavy({ task: "AFTER", pid: 601, pidStartMs: 1000 }));
	assert.equal(after.admitted, true, "the reused pid's claim was reconciled");
});

test("an interrupted launch — a claim with no process — is reclaimed after the timeout", async () => {
	const { gate: g, state } = await gate({ mode: "enforce", launchTimeoutMs: 1000 });
	await g.acquire(heavy({ task: "STUCK", pid: null }));
	// Still inside the timeout: the claim holds its slot.
	state.now = new Date(state.now.getTime() + 500);
	const early = await g.acquire(heavy({ task: "OTHER", pid: null }));
	assert.equal(early.admitted, false);
	// Past the timeout: reconciled, and the slot is free.
	state.now = new Date(state.now.getTime() + 2000);
	const late = await g.acquire(heavy({ task: "OTHER", pid: null }));
	assert.equal(late.admitted, true);
});

test("a job stopped under pressure is marked, and nothing relaunches it", async () => {
	const { gate: g, state } = await gate({ mode: "enforce" });
	state.processes.set(700, { startedAtMs: 1000 });
	await g.acquire(heavy({ task: "REAPED", pid: 700, pidStartMs: 1000 }));
	state.processes.delete(700); // the reaper stopped it
	state.available = GIB4; // and the host was under the reserve
	await g.acquire(heavy({ task: "NEXT", pid: 701, pidStartMs: 1000 }));
	const status = await g.status();
	const ended = status.history.find((entry) => entry.task === "REAPED");
	assert.equal(ended?.endedHow, "stopped-under-pressure");
	assert.equal(ended?.exitCode ?? null, null); // no exit code is invented
});

test("two eligible jobs on enough capacity are both admitted", async () => {
	const { gate: g, state } = await gate({ mode: "enforce", maxHeavy: 2 });
	state.processes.set(800, { startedAtMs: 1000 });
	state.processes.set(801, { startedAtMs: 1000 });
	const a = await g.acquire(heavy({ task: "ONE", pid: 800, pidStartMs: 1000 }));
	const b = await g.acquire(heavy({ task: "TWO", pid: 801, pidStartMs: 1000 }));
	assert.equal(a.admitted, true);
	assert.equal(b.admitted, true);
});

test("advise mode changes no decision: it admits and only reports what it would have done", async () => {
	const { gate: g, state } = await gate({ mode: "advise" });
	state.available = GIB6;
	const result = await g.acquire(heavy({ task: "ADVISED" }));
	assert.equal(result.admitted, true, "advise admits as today");
	assert.equal(result.advisory?.wouldAdmit, false);
	assert.match(result.advisory?.reason ?? "", /below the 8\.0 GiB reserve/);
	const status = await g.status();
	assert.equal(status.claims.length, 1, "the claim was still recorded");
});

test("release takes the claim id and records the exit code", async () => {
	const { gate: g, state } = await gate();
	state.processes.set(900, { startedAtMs: 1000 });
	const { claim } = await g.acquire(heavy({ task: "DONE", pid: 900, pidStartMs: 1000 }));
	assert.equal(await g.release(claim.id, { code: 0 }), true);
	assert.equal(await g.release(claim.id, { code: 0 }), false, "released once");
	const status = await g.status();
	assert.equal(status.history.at(-1)?.exitCode, 0);
	assert.equal(status.history.at(-1)?.endedHow, "clean");
});

test("status carries no command line, prompt or environment", async () => {
	const { gate: g, state } = await gate();
	state.processes.set(1000, { startedAtMs: 1000 });
	await g.acquire(heavy({ task: "ENG-1", worktree: "C:\\work\\ENG-1", pid: 1000, pidStartMs: 1000 }));
	const status = await g.status();
	const text = JSON.stringify(status);
	for (const forbidden of ["command", "prompt", "env", "GATEWEAVE", "codex exec"]) {
		assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `status leaks ${forbidden}`);
	}
});

test("a waiting hand job's reason says when it is eligible for Docker Cloud", async () => {
	const { gate: g, state } = await gate({ mode: "enforce" });
	state.available = GIB6;
	const result = await g.acquire(heavy({ task: "PUBLIC-REPO-JOB", dockerCloudEligible: true }));
	assert.equal(result.admitted, false);
	assert.match(result.reason, /eligible for Docker Cloud/);
});

test("samplePeak sums the process tree until the root exits and records the class peak", async () => {
	const { gate: g } = await gate();
	let step = 0;
	const table = async () => {
		step++;
		if (step > 2) return []; // the root is gone: the peak is final
		return [
			{ pid: 900, ppid: 1, workingSetBytes: 2 * GIB, startedAtMs: 1 },
			{ pid: 901, ppid: 900, workingSetBytes: step === 1 ? 1 * GIB : 3 * GIB, startedAtMs: 1 },
			{ pid: 902, ppid: 901, workingSetBytes: 1 * GIB, startedAtMs: 1 }, // a grandchild counts too
		];
	};
	const peak = await samplePeak({ pid: 900, klass: "heavy", gate: g, intervalMs: 1, table, sleep: async () => {} });
	assert.equal(peak, 6 * GIB); // 2 + 3 + 1 on the second sample
	const status = await g.status();
	assert.equal(status.peaks.heavy.bytes, 6 * GIB);
});

// --- What each claim's history line keeps for the pilot. ---

const cloudRoute = { advice: "cloud", reasons: ["public source, and it needs no secrets, host services or person"] };
const privateRoute = { advice: "local", reasons: ["its source is private"] };

async function history(dir) {
	return (await readFile(join(dir, "history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("an ended claim's history keeps its routing advice, admission decision, Track attempt and peak", async () => {
	const { gate: g, dir, state } = await gate({ mode: "advise" });
	state.processes.set(900, { startedAtMs: 1000 });
	state.available = GIB6;
	const { claim } = await g.acquire(heavy({ task: "ENG-1", pid: 900, pidStartMs: 1000, route: cloudRoute, dockerCloudEligible: true }));
	await g.linkAttempt(claim.id, "6f9619ff-8b86-4d11-b42d-00c04fc964ff");
	await g.recordPeak("heavy", 5 * GIB, { claimId: claim.id });
	await g.recordPeak("heavy", 3 * GIB, { claimId: claim.id }); // a lower sample never lowers it
	assert.equal(await g.release(claim.id, { code: 0 }), true);
	const [ended] = await history(dir);
	assert.deepEqual(ended.route, cloudRoute);
	assert.deepEqual(ended.admission, { admit: false, reason: "available 6.0 GiB, below the 8.0 GiB reserve" });
	assert.equal(ended.attemptId, "6f9619ff-8b86-4d11-b42d-00c04fc964ff");
	assert.equal(ended.peakBytes, 5 * GIB);
	assert.equal((await g.status()).history.at(-1).route, "cloud");
});

test("an interrupted claim keeps its advice and peak, and a late sample never brings it back", async () => {
	const { gate: g, dir, state } = await gate();
	state.processes.set(900, { startedAtMs: 1000 });
	const { claim } = await g.acquire(heavy({ task: "ENG-2", pid: 900, pidStartMs: 1000, route: privateRoute }));
	await g.recordPeak("heavy", 7 * GIB, { claimId: claim.id });
	state.processes.delete(900);
	state.available = GIB20; // no pressure as it went: an interruption, not a stop under pressure
	const status = await g.status();
	assert.equal(status.claims.length, 0);
	await g.recordPeak("heavy", 9 * GIB, { claimId: claim.id }); // the sampler's last look, after the end
	assert.equal((await g.status()).claims.length, 0, "a sample after the end writes no claim");
	assert.equal(await g.linkAttempt(claim.id, "6f9619ff-8b86-4d11-b42d-00c04fc964ff"), null);
	const [ended] = await history(dir);
	assert.equal(ended.endedHow, "interrupted");
	assert.deepEqual(ended.route, privateRoute);
	assert.equal(ended.peakBytes, 7 * GIB);
	assert.equal((await g.status()).peaks.heavy.bytes, 9 * GIB, "the class peak still counts every sample");
});

test("samplePeak records the claim's own peak beside the class peak", async () => {
	const { gate: g, dir, state } = await gate();
	state.processes.set(900, { startedAtMs: 1000 });
	const { claim } = await g.acquire(heavy({ task: "ENG-3", pid: 900, pidStartMs: 1000 }));
	let step = 0;
	const table = async () => (++step > 2 ? [] : [{ pid: 900, ppid: 1, workingSetBytes: step * GIB, startedAtMs: 1 }]);
	await samplePeak({ pid: 900, klass: "heavy", gate: g, claimId: claim.id, intervalMs: 1, table, sleep: async () => {} });
	await g.release(claim.id, { code: 1 });
	const [ended] = await history(dir);
	assert.equal(ended.peakBytes, 2 * GIB);
});

test("the report counts the advice, why jobs stay local, what enforce would hold, endings and peaks", async () => {
	const { gate: g, state } = await gate({ mode: "advise" });
	const run = async (task, route, { pid, peak, code = 0, low = false } = {}) => {
		state.available = low ? GIB6 : GIB20;
		state.processes.set(pid, { startedAtMs: 1000 });
		const { claim } = await g.acquire(heavy({ task, pid, pidStartMs: 1000, route, launcher: "runner" }));
		if (peak) await g.recordPeak("heavy", peak, { claimId: claim.id });
		return claim;
	};
	const a = await run("A-1", cloudRoute, { pid: 1, peak: 4 * GIB });
	await g.release(a.id, { code: 0 });
	const b = await run("B-1", privateRoute, { pid: 2, peak: 8 * GIB, low: true });
	await g.release(b.id, { code: 1 });
	await run("C-1", cloudRoute, { pid: 3, peak: 6 * GIB });
	state.processes.delete(3); // C-1's process went without a release
	state.now = new Date("2026-11-21T09:00:00Z");
	state.processes.set(4, { startedAtMs: 1000 });
	const d = await g.acquire(heavy({ task: "D-1", pid: 4, pidStartMs: 1000 })); // a hand job, no advice
	await g.release(d.claim.id, { code: 0 });

	const report = await g.report();
	assert.equal(report.launches, 4);
	assert.deepEqual(report.routes, { cloud: 2, local: 1, unrecorded: 1 });
	assert.deepEqual(report.localReasons, { "its source is private": 1 });
	assert.equal(report.wouldHold, 1);
	assert.deepEqual(report.endings, { clean: 3, interrupted: 1 });
	assert.equal(report.interrupted, 1);
	assert.equal(report.interruptionRate, 0.25);
	assert.equal(report.failedExits, 1);
	assert.equal(report.cloudInterrupted, 1);
	assert.deepEqual(report.peaks, { measured: 3, medianBytes: 6 * GIB, maxBytes: 8 * GIB });

	const later = await g.report({ since: "2026-11-21T00:00:00Z" });
	// D-1's acquire reconciled C-1 away, so both ended on the later day.
	assert.deepEqual(later.launchers, { runner: 1, hand: 1 }, "only claims that ended since then");
	await assert.rejects(g.report({ since: "yesterday-ish" }), /not a date/);

	const text = formatReport(report);
	assert.match(text, /^4 ended claims \(runner 3, hand 1\)/);
	assert.match(text, /routing advice: Docker Cloud 2, local 1, not recorded 1/);
	assert.match(text, /local because its source is private: 1/);
	assert.match(text, /interrupted: 1 \(25%\), of which Docker Cloud advice 1/);
	assert.match(text, /peak working set: 3 measured, median 6\.0 GiB, max 8\.0 GiB/);
	assert.equal(summarizeHistory([]).interruptionRate, null);
});

test("a busy lock never stops peak sampling: the class peak is kept and the claim's waits for the next sample", async () => {
	const logged = [];
	const { gate: g, dir, state } = await gate({ lockTimeoutMs: 20, log: (message) => logged.push(message) });
	state.processes.set(900, { startedAtMs: 1000 });
	const { claim } = await g.acquire(heavy({ task: "ENG-4", pid: 900, pidStartMs: 1000 }));
	await mkdir(join(dir, ".lock")); // another starter holds the lock
	const peak = await g.recordPeak("heavy", 4 * GIB, { claimId: claim.id });
	assert.equal(peak.bytes, 4 * GIB);
	assert.match(logged.at(-1), /could not note the peak on claim/);
	await rm(join(dir, ".lock"), { recursive: true });
	await g.recordPeak("heavy", 5 * GIB, { claimId: claim.id });
	await g.release(claim.id, { code: 0 });
	assert.equal((await history(dir))[0].peakBytes, 5 * GIB);
});

// --- What a job takes from the host, not its tree's working set. ---

test("samplePeak records how far available memory fell beside the tree's working set", async () => {
	const { gate: g, dir, state } = await gate();
	state.processes.set(900, { startedAtMs: 1000 });
	const { claim } = await g.acquire(heavy({ task: "ENG-4", pid: 900, pidStartMs: 1000 }));
	let step = 0;
	const table = async () => {
		step++;
		// A shared page counts once per process in the tree's sum, so it outgrows the host's fall.
		state.available = [GIB12, 9 * GIB, GIB8][step - 1] ?? GIB12;
		return step > 3 ? [] : [{ pid: 900, ppid: 1, workingSetBytes: [GIB, 5 * GIB, 6 * GIB][step - 1], startedAtMs: 1 }];
	};
	const peak = await samplePeak({ pid: 900, klass: "heavy", gate: g, claimId: claim.id, intervalMs: 1, table, sleep: async () => {} });
	assert.equal(peak, 6 * GIB);
	const { peaks } = await g.status();
	assert.equal(peaks.heavy.bytes, 6 * GIB);
	assert.equal(peaks.heavy.hostBytes, GIB4, "from 12 GiB at the first sample down to 8");
	await g.release(claim.id, { code: 0 });
	const [ended] = await history(dir);
	assert.equal(ended.peakBytes, 6 * GIB);
	assert.equal(ended.hostPeakBytes, GIB4);
	assert.equal((await g.status()).history.at(-1).hostPeakBytes, GIB4);
});

test("admission subtracts what a job took from the host, and the tree's peak only until that is known", async () => {
	assert.equal(admissionPeak({ bytes: 6 * GIB, hostBytes: GIB4 }), GIB4);
	assert.equal(admissionPeak({ bytes: 6 * GIB }), 6 * GIB);
	assert.equal(admissionPeak(undefined), null);

	const { gate: g, state } = await gate({ mode: "enforce", reserveBytes: 2 * GIB });
	await g.recordPeak("heavy", 6 * GIB);
	state.available = 7 * GIB; // 7 - 6 = 1 GiB would be left by the tree's figure: held
	const held = await g.acquire(heavy());
	assert.equal(held.admitted, false);
	await g.recordPeak("heavy", 6 * GIB, { hostBytes: GIB4 });
	const admitted = await g.acquire(heavy()); // 7 - 4 = 3 GiB stays above the 2 GiB reserve
	assert.equal(admitted.admitted, true, admitted.reason);
});

test("a held reason says what the measured peak would leave, not that available is below the reserve", () => {
	const decide = (availableBytes, peakBytes) =>
		decideAdmission({
			klass: "heavy",
			claims: [],
			memory: { availableBytes, commitAvailableBytes: GIB20 },
			reserveBytes: 2 * GIB,
			maxHeavy: 1,
			peakBytes,
		});
	const held = decide(7 * GIB, 6 * GIB);
	assert.equal(held.admit, false);
	assert.equal(held.reason, "available 7.0 GiB leaves 1.0 GiB after a heavy job's measured 6.0 GiB, below the 2.0 GiB reserve");
	assert.match(decide(5 * GIB, 6 * GIB).reason, /leaves 0\.0 GiB after/);
	assert.equal(decide(GIB, null).reason, "available 1.0 GiB, below the 2.0 GiB reserve");
	assert.equal(decide(9 * GIB, 6 * GIB).admit, true);
});

test("the report and status show what jobs took from available memory", async () => {
	const { gate: g, state } = await gate({ mode: "advise" });
	for (const [pid, host] of [[1, 4 * GIB], [2, 6 * GIB], [3, null]]) {
		state.processes.set(pid, { startedAtMs: 1000 });
		const { claim } = await g.acquire(heavy({ task: `T-${pid}`, pid, pidStartMs: 1000 }));
		await g.recordPeak("heavy", 7 * GIB, { claimId: claim.id, hostBytes: host });
		await g.release(claim.id, { code: 0 });
	}
	const report = await g.report();
	assert.deepEqual(report.hostPeaks, { measured: 2, medianBytes: 5 * GIB, maxBytes: 6 * GIB });
	assert.match(formatReport(report), /taken from available memory: 2 measured, median 5\.0 GiB, max 6\.0 GiB/);
	assert.match(formatReport(summarizeHistory([])), /taken from available memory: 0 measured, median none, max none/);
});

test("the reserve defaults to 2 GiB", () => {
	assert.equal(SLOT_DEFAULTS.reserveBytes, 2 * GIB);
});
