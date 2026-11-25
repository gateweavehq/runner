import { createHash, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { link, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.mjs";
import { parseCheckReports } from "./process.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token = /^gwh_[A-Za-z0-9_-]{43}$/;
// Pending reports, in the order their sequences rise. Only a cloud attempt waits.
const files = ["waiting.json", "running.json", "finished.json"];
const commit = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function stateRoot(config) {
	const scope = createHash("sha256").update(JSON.stringify([config.track.url, config.workspace])).digest("hex");
	return join(config.stateDir, "work-runs", scope);
}

export function githubRepository(remote) {
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z0-9-]+\/[a-z0-9_.-]+)$/i.exec(remote.trim());
	return match?.[1].replace(/\.git$/i, "").toLowerCase() ?? null;
}

async function read(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

async function uuidDirectories(path) {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && uuid.test(entry.name))
			.map((entry) => join(path, entry.name));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function attemptDirectories(path) {
	return [path, ...await uuidDirectories(join(path, "retries"))];
}

function capabilities(team) {
	return createHash("sha256").update(JSON.stringify([
		resolve(team.repo), team.remote, team.base, team.workRunRepository, team.isolation,
		team.engine?.command, team.engineTimeoutMinutes, team.setup, team.checks,
		Object.keys(team.env?.set ?? {}).sort(), team.env?.pass, team.container,
		// Only a cloud team has these, so a retained checkout of any other team keeps its hash.
		...(team.cloud ? [team.cloud] : []),
	])).digest("hex");
}

/** Who claims this team's work in Track: the local runner, or a Docker Cloud run. */
export function executorOf(team) {
	return team.isolation === "cloud" ? "cloud" : "local-runner";
}

async function writeOnce(path, value) {
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
	try {
		// Publish a complete file and let the first launcher win without overwriting it.
		await link(temp, path);
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(temp).catch(() => {});
	}
}

function validGrant(grant, repository) {
	return uuid.test(grant?.attemptId ?? "") && token.test(grant?.token ?? "") && grant.repository === repository;
}

async function send(track, path, event, grant) {
	try {
		const reply = await track.workRun("report", { ...event, attemptId: grant.attemptId, token: grant.token });
		if (!Number.isSafeInteger(reply?.sequence) || reply.sequence < event.sequence) {
			throw new Error("Track did not acknowledge the report");
		}
	} catch (error) {
		// Reconciliation may have closed the attempt before this report reached Track.
		if (grant.active !== false || error.status !== 409) throw error;
	}
	await unlink(path).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function registeredWork(team, key, track) {
	const request = await track.workRun("find", { issue: key }).catch((error) => {
		if (error.status === 404) return null;
		throw error;
	});
	if (!request || !uuid.test(request.requestId) || request.repository !== team.workRunRepository) {
		return null;
	}
	// A Track that predates executors registers everything for the local runner.
	if ((request.executor ?? "local-runner") !== executorOf(team)) return null;
	return request;
}

/**
 * The launch of an attempt that is still waiting for Docker Cloud: Track holds it queued, the
 * board never moved, and the next poll may try it again with the same grant.
 */
async function waitingLaunch(dir, request) {
	const [launched, waited] = await Promise.all([read(join(dir, "launched.json")), read(join(dir, "waited.json"))]);
	return launched && waited && request.activeAttemptId === launched.attemptId && request.lastAttemptState === "queued"
		? launched : null;
}

export async function findScopedWork(config, team, key, track) {
	const request = await registeredWork(team, key, track);
	if (!request) return null;
	const dir = join(stateRoot(config), request.requestId);
	if (await read(join(dir, "launched.json"))) return await waitingLaunch(dir, request) ? request : null;
	if (request.lastAttemptId && (!request.activeAttemptId || !await read(join(dir, "claim.json")))) return null;
	return request;
}

/** Pick up an explicitly approved assignment exactly once on this runner. */
export async function claimScopedWork({ config, team, key, track, log, request, resume }) {
	const [fetchTargets, pushTargets] = await Promise.all([
		git(team.repo, ["remote", "get-url", "--all", team.remote]),
		git(team.repo, ["remote", "get-url", "--push", "--all", team.remote]),
	]);
	const matched = team.workRunRepository;
	const targets = [...fetchTargets.trim().split(/\r?\n/), ...pushTargets.trim().split(/\r?\n/)];
	if (targets.some((target) => githubRepository(target) !== matched)) {
		log(`${key}: the configured repository does not match the Git remote`);
		return null;
	}
	request ??= await (resume ? registeredWork(team, key, track) : findScopedWork(config, team, key, track));
	if (!request || !uuid.test(request.requestId) || request.repository !== matched ||
		(resume && request.requestId !== resume.requestId)) {
		log(`${key}: Track has no matching registration for this repository`);
		return null;
	}
	const root = join(stateRoot(config), request.requestId);
	const previousAttemptId = resume?.attemptId;
	const dir = resume ? join(root, "retries", previousAttemptId) : root;
	const launchPath = join(dir, "launched.json");
	const launched = await read(launchPath);
	const retry = launched && await waitingLaunch(dir, request);
	if (launched && !retry) {
		if (request.activeAttemptId) log(`${key}: reconcile attempt ${request.activeAttemptId} before resuming`);
		return null;
	}
	// One launcher at a time tries a waiting attempt again. A launcher that dies while trying
	// leaves the marker, and the attempt then waits for an admin to reconcile it: it never runs twice.
	const retryPath = join(dir, "retrying.json");
	if (retry && !await writeOnce(retryPath, { at: Date.now() })) return null;
	const claimPath = join(dir, "claim.json");
	const savedClaim = await read(claimPath);
	if (resume) {
		const ready = !request.activeAttemptId && request.lastAttemptId === previousAttemptId &&
			["failed", "cancelled"].includes(request.lastAttemptState);
		const recovering = request.activeAttemptId && request.lastAttemptState === "queued" &&
			savedClaim?.previousAttemptId === previousAttemptId;
		if (!ready && !recovering) {
			log(`${key}: waiting for the previous attempt to have a verified failed or cancelled outcome`);
			return null;
		}
		try {
			await validateResumeCheckout(team, resume);
		} catch (error) {
			log(`${key}: waiting to resume. ${error.message}`);
			return null;
		}
	} else if (request.lastAttemptId && !savedClaim) {
		log(`${key}: reconcile the previous Track attempt before claiming again`);
		return null;
	}
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// Keep the nonce, never the report token. A lost reply can be recovered using the same claim.
	const executor = executorOf(team);
	await writeOnce(claimPath, {
		requestId: request.requestId, claimId: randomUUID(), repository: matched, issue: key, previousAttemptId, executor,
	});
	const claim = await read(claimPath);
	if (claim?.requestId !== request.requestId || !uuid.test(claim.claimId) || claim.repository !== matched ||
		claim.previousAttemptId !== previousAttemptId || claim.issue !== key || (claim.executor ?? "local-runner") !== executor) {
		throw new Error("The saved work run claim does not match Track");
	}
	const { requestId, claimId } = claim;
	const grant = await track.workRun("claim", { requestId, claimId, previousAttemptId, executor });
	if (!validGrant(grant, matched) || grant.canLaunch !== true) return null;
	if (retry ? grant.attemptId !== launched.attemptId :
		!await writeOnce(launchPath, { attemptId: grant.attemptId, claimedAt: Date.now() })) return null;
	const namedChecks = new Set((team.checks ?? []).map((check) =>
		typeof check === "string" ? check : check.name ?? check.command));
	let lastCheck;
	let checkWriteFailed = false;
	// An attempt that waited reported sequence 1 already, so its start and end come after it.
	let waited = Boolean(await read(join(dir, "waited.json")));
	const deliver = async (file, event) => {
		const path = join(dir, file);
		const pending = await writeOnce(path, event) ? event : await read(path);
		if (!pending) return;
		try {
			await send(track, path, pending, grant);
		} catch {
			log(`${key}: Track report is saved for replay`);
		}
	};
	return {
		attemptId: grant.attemptId,
		async checkpoint(worktree, branch, base) {
			const baseHead = (await git(worktree, ["rev-parse", base])).trim();
			await writeOnce(join(dir, "checkpoint.json"), {
				worktree: resolve(worktree), branch, baseHead, capabilities: capabilities(team),
			});
		},
		async checks(checks) {
			await writeOnce(join(dir, "checks.json"), checks.map(({ name, passed }) => ({ name, passed })));
		},
		checkLine(line) {
			for (const [name, passed] of parseCheckReports(line)) {
				if (!namedChecks.has(name) || (lastCheck?.name === name && lastCheck.passed === passed)) continue;
				const value = { name, passed };
				try {
					const temp = join(dir, "last-check.next");
					writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
					renameSync(temp, join(dir, "last-check.json"));
					lastCheck = value;
				} catch {
					if (!checkWriteFailed) log(`${key}: could not save a check checkpoint`);
					checkWriteFailed = true;
				}
			}
		},
		/**
		 * The attempt stays queued with the reason it waits, and the launcher lets go of it so a
		 * later poll can try again.
		 */
		async wait(progress, reason, detail) {
			await writeOnce(join(dir, "waited.json"), { at: Date.now() });
			waited = true;
			await deliver(files[0], { state: "queued", progress, sequence: 1, waitReason: reason, waitDetail: detail });
			await unlink(retryPath).catch(() => {});
		},
		async report(state, progress, url) {
			const running = state === "running";
			const link = url && URL.parse(url);
			const allowed = link && Array.isArray(grant.linkOrigins) && grant.linkOrigins.includes(link.origin);
			const sequence = (running ? 1 : 2) + (waited ? 1 : 0);
			await deliver(running ? files[1] : files[2], { state, progress, sequence, ...(allowed && { url: link.href }) });
		},
	};
}

async function localAttempt(config, key, attemptId) {
	let latest;
	for (const root of await uuidDirectories(stateRoot(config))) {
		for (const dir of await attemptDirectories(root)) {
			const claim = await read(join(dir, "claim.json"));
			if (claim?.issue !== key) continue;
			const launch = await read(join(dir, "launched.json"));
			if (!launch) continue;
			if (attemptId && launch.attemptId === attemptId) return { dir, launch, claim };
			if (!attemptId && (!latest || launch.claimedAt >= latest.launch.claimedAt)) latest = { dir, launch, claim };
		}
	}
	return latest;
}

/** Reads the local evidence without contacting Track or launching work. */
export async function inspectScopedWork(config, key, attemptId) {
	const attempt = await localAttempt(config, key, attemptId);
	if (!attempt) return null;
	const { dir, launch } = attempt;
	const checkpoint = await read(join(dir, "checkpoint.json"));
	const checks = await read(join(dir, "checks.json"));
	const lines = [`${key} · Track attempt ${launch.attemptId}`];
	if (checkpoint) {
		lines.push(`Branch ${checkpoint.branch}`, `Base ${checkpoint.baseHead}`);
		const inside = relative(resolve(config.worktreesDir), checkpoint.worktree);
		if (inside && !isAbsolute(inside) && !inside.startsWith("..") && commit.test(checkpoint.baseHead)) {
			try {
				const status = (await git(checkpoint.worktree, ["-c", "core.fsmonitor=false", "status", "--short"])).trim();
				const diff = (await git(checkpoint.worktree, ["diff", "--no-ext-diff", "--no-textconv", "--stat", checkpoint.baseHead, "--"])).trim();
				lines.push(status || "Clean worktree", diff || "No tracked changes from the recorded base");
			} catch {
				lines.push("The worktree is unavailable. Inspect the recorded branch before retrying.");
			}
		}
	} else lines.push("No checkout was recorded");
	const last = await read(join(dir, "last-check.json")) ?? checks?.findLast((check) => check.passed !== null);
	lines.push(last ? `Last reported check: ${last.name} (${last.passed ? "passed" : "failed"})` : "No completed check was recorded");
	return lines.join("\n");
}

/** Require the exact approved local checkout and configuration before asking for another attempt. */
export async function resumeScopedWork(config, team, key, attemptId) {
	if (!uuid.test(attemptId)) throw new Error("Use the Track attempt ID printed by --inspect-work");
	if (team.isolation === "container") throw new Error("This executor does not retain the isolated checkout for resume");
	const prior = await localAttempt(config, key, attemptId);
	const checkpoint = prior && await read(join(prior.dir, "checkpoint.json"));
	const branch = `${config.branchPrefix}/${key}`.toLowerCase();
	const worktree = resolve(config.worktreesDir, key);
	if (!checkpoint || checkpoint.worktree !== worktree || checkpoint.branch !== branch ||
		checkpoint.capabilities !== capabilities(team) || !commit.test(checkpoint.baseHead)) {
		throw new Error("The retained checkout, repository mapping or runner capabilities changed");
	}
	return { attemptId, requestId: prior.claim.requestId, checkpoint };
}

async function validateResumeCheckout(team, { checkpoint }) {
	const { worktree, branch, baseHead } = checkpoint;
	try {
		const commonDir = async (cwd) => realpath((await git(cwd,
			["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
		const top = (await git(worktree, ["rev-parse", "--show-toplevel"])).trim();
		if (await realpath(top) !== await realpath(worktree) || await commonDir(worktree) !== await commonDir(team.repo) ||
			(await git(worktree, ["symbolic-ref", "--short", "HEAD"])).trim() !== branch) {
			throw new Error("checkout differs");
		}
	} catch {
		throw new Error("The retained checkout is unavailable or no longer on the approved branch");
	}
	const target = `refs/heads/${team.base}`;
	const current = await git(team.repo, ["ls-remote", "--exit-code", team.remote, target])
		.catch(() => { throw new Error("The approved base could not be verified"); });
	if (current.trim() !== `${baseHead}\t${target}`) throw new Error("The approved base changed");
}

/** Replay only preexisting reports, even when the launcher is paused or has no new eligible work. */
export async function replayWorkRunReports(config, track, log) {
	for (const root of await uuidDirectories(stateRoot(config))) {
		for (const dir of await attemptDirectories(root)) {
			await replayAttempt(basename(root), dir, track, log);
		}
	}
}

async function replayAttempt(requestId, dir, track, log) {
	try {
		const pending = await Promise.all(files.map(async (file) => [file, await read(join(dir, file))]));
		if (pending.every(([, event]) => !event)) return;
		const claim = await read(join(dir, "claim.json"));
		const launch = await read(join(dir, "launched.json"));
		if (claim?.requestId !== requestId || !uuid.test(claim.claimId) || !launch) return;
		const { claimId, previousAttemptId } = claim;
		const executor = claim.executor ?? "local-runner";
		const grant = await track.workRun("claim", { requestId, claimId, previousAttemptId, executor });
		if (!validGrant(grant, claim.repository) || grant.attemptId !== launch.attemptId) return;
		for (const [file, event] of pending) {
			if (event) await send(track, join(dir, file), event, grant);
		}
	} catch {
		log(`Track reports for request ${requestId} are still pending`);
	}
}
