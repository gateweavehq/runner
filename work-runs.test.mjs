import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "./git.mjs";
import { CloudUnavailableError } from "./cloud.mjs";
import { Runner } from "./runner.mjs";
import { GIB, SlotsGate } from "./slots.mjs";
import { TrackMcp } from "./track.mjs";
import { claimScopedWork, findScopedWork, inspectScopedWork, replayWorkRunReports, resumeScopedWork } from "./work-runs.mjs";

const fixtureToken = `gwh_${"a".repeat(43)}`;

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "work-runs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, ["init", "-q"]);
	await git(root, ["remote", "add", "origin", "git@github.com:acme/site.git"]);
	const team = { repo: root, remote: "origin", workRunRepository: "acme/site" };
	const config = {
		track: { url: "https://track.example.test" },
		workspace: "acme",
		teams: { ENG: team },
		stateDir: join(root, "private"),
		worktreesDir: join(root, "trees"),
		branchPrefix: "runner",
	};
	const requestId = randomUUID();
	const attemptId = randomUUID();
	const claims = [];
	const sent = [];
	let loseClaimReply = false;
	let offline = false;
	const track = {
		async workRun(action, data) {
			if (action === "find") {
				return { requestId, repository: "acme/site", lastAttemptId: claims.length ? attemptId : null,
					activeAttemptId: claims.length ? attemptId : null };
			}
			if (action === "claim") {
				assert.equal(data.requestId, requestId);
				claims.push(data.claimId);
				if (loseClaimReply) throw new Error("Lost claim reply");
				return { attemptId, repository: "acme/site", canLaunch: true, token: fixtureToken, linkOrigins: ["https://github.com"] };
			}
			assert.equal(action, "report");
			assert.equal(data.attemptId, attemptId);
			assert.equal(data.token, fixtureToken);
			if (offline) throw new Error("Track offline");
			sent.push(data);
			return { sequence: data.sequence };
		},
	};
	const log = () => {};
	return {
		root, config, team, track, requestId, attemptId, claims, sent, log,
		options: { config, team, track, log, key: "ENG-1" },
		loseClaim(value) { loseClaimReply = value; },
		setOffline(value) { offline = value; },
	};
}

test("one local launcher recovers a lost claim reply and replays reports without keeping the token", async (t) => {
	const check = await fixture(t);
	check.loseClaim(true);
	await assert.rejects(claimScopedWork(check.options), /Lost claim reply/);
	check.loseClaim(false);
	const contenders = await Promise.all([claimScopedWork(check.options), claimScopedWork(check.options)]);
	assert.equal(contenders.filter(Boolean).length, 1);
	assert.equal(new Set(check.claims).size, 1);
	const granted = contenders.find(Boolean);
	check.setOffline(true);
	await granted.report("running", "Local runner started");
	await granted.report("passed", "Local runner finished", "https://github.com/acme/site/pull/1");
	assert.deepEqual(check.sent, []);
	assert.equal(await claimScopedWork(check.options), null);

	const state = join(check.config.stateDir, "work-runs");
	for (const name of await readdir(state, { recursive: true })) {
		if (name.endsWith(".json")) assert.doesNotMatch(await readFile(join(state, name), "utf8"), /gwh_/);
	}
	check.setOffline(false);
	await replayWorkRunReports(check.config, check.track, check.log);
	assert.deepEqual(check.sent.map(({ state, sequence, url }) => ({ state, sequence, url })), [
		{ state: "running", sequence: 1, url: undefined },
		{ state: "passed", sequence: 2, url: "https://github.com/acme/site/pull/1" },
	]);
	await replayWorkRunReports(check.config, check.track, check.log);
	assert.equal(check.sent.length, 2);
});

test("the normal runner entry requires the scoped claim and releases it when the board move is refused", async (t) => {
	const check = await fixture(t);
	const runner = new Runner(check.config, { track: check.track, log: check.log });
	let pickups = 0;
	runner.claimIssue = async () => {
		pickups++;
		return false;
	};
	const work = { teamKey: "ENG", team: check.team, detail: { key: "ENG-1", title: "Fixture" } };
	await git(check.root, ["remote", "set-url", "--push", "origin", "https://github.com/acme/site.git"]);
	await git(check.root, ["remote", "set-url", "--push", "--add", "origin", "https://github.com/acme/other.git"]);
	await runner.run(work);
	assert.equal(pickups, 0);
	assert.deepEqual(check.claims, []);
	await git(check.root, ["remote", "set-url", "--push", "--delete", "origin", "https://github.com/acme/other.git"]);
	await runner.run(work);
	await runner.run(work);
	assert.equal(pickups, 1);
	assert.equal(check.sent.length, 1);
	assert.equal(check.sent[0].state, "failed");
	assert.equal(check.sent[0].sequence, 2);
});

test("the slot claim names the Track attempt it works for, so routing and reporting share one id", async (t) => {
	const check = await fixture(t);
	const slotsDir = join(check.root, "slots");
	const slots = new SlotsGate({
		dir: slotsDir,
		reserveBytes: GIB,
		probe: async () => ({ availableBytes: 32 * GIB, totalBytes: 64 * GIB, commitAvailableBytes: 64 * GIB }),
		processTable: async () => [{ pid: process.pid, ppid: 1, workingSetBytes: GIB, startedAtMs: 1234 }],
		uptimeSec: () => 100_000,
		sleep: async () => {},
	});
	const runner = new Runner(check.config, { track: check.track, log: check.log, slots });
	runner.claimIssue = async () => false;
	await git(check.root, ["remote", "set-url", "--push", "origin", "https://github.com/acme/site.git"]);
	await runner.run({ teamKey: "ENG", team: check.team, detail: { key: "ENG-1", title: "Fixture" } });
	const [ended] = (await readFile(join(slotsDir, "history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(ended.task, "ENG-1");
	assert.equal(ended.attemptId, check.attemptId);
});

test("scoped reporting uses a direct authenticated route and rejects redirects", async () => {
	const transport = new TrackMcp({
		url: "https://track.example.test/",
		key: "test-agent-key",
		fetchImpl: async (url, request) => {
			assert.equal(url, "https://track.example.test/api/work-runs/find");
			assert.equal(request.headers.authorization, "Bearer test-agent-key");
			assert.equal(request.redirect, "error");
			assert.deepEqual(JSON.parse(request.body), { issue: "ENG-1" });
			return Response.json({ requestId: "fixture" });
		},
	});
	assert.deepEqual(await transport.workRun("find", { issue: "ENG-1" }), { requestId: "fixture" });
});

test("the inspection shows the retained changes and check without calling Track", async (t) => {
	const check = await fixture(t);
	check.team.checks = ["typecheck", "test"];
	const granted = await claimScopedWork(check.options);
	await git(check.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
		"commit", "--allow-empty", "-m", "base"]);
	const branch = "runner/eng-1";
	const checkout = join(check.config.worktreesDir, "ENG-1");
	await mkdir(check.config.worktreesDir);
	await git(check.root, ["worktree", "add", "-b", branch, checkout, "HEAD"]);
	await granted.checkpoint(checkout, branch, "HEAD");
	await writeFile(join(checkout, "work.txt"), "Retained change\n");
	await git(checkout, ["add", "work.txt"]);
	granted.checkLine("RUNNER-CHECK: typecheck = pass");
	granted.checkLine("RUNNER-CHECK: test = fail");
	granted.checkLine("RUNNER-CHECK: unconfigured output = pass");
	const summary = await inspectScopedWork(check.config, "ENG-1");
	assert.match(summary, /Track attempt [a-f0-9-]+/);
	assert.match(summary, /Branch runner\/eng-1/);
	assert.match(summary, /work\.txt/);
	assert.match(summary, /Last reported check: test \(failed\)/);
	assert.equal(check.claims.length, 1);
	assert.equal(check.sent.length, 0);
});

test("an explicit resume recovers a lost reply and preserves the original worktree and check", async (t) => {
	const check = await fixture(t);
	const branch = "runner/eng-1";
	const checkout = join(check.config.worktreesDir, "ENG-1");
	const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m"];
	Object.assign(check.team, {
		base: "pilot-base", label: "runner", inProgressStatus: "In Progress", todoStatus: "Todo",
		pickupStatuses: ["Todo"], engineTimeoutMinutes: 1, checks: ["test"],
		engine: { command: [process.execPath, "-e", `
			const fs = require("node:fs");
			if (!/retained changes/.test(process.argv[1]) || !fs.existsSync("partial.txt")) process.exit(1);
			fs.writeFileSync("resumed.txt", "Continued");
			// As codex exec does: progress, each check included, on stderr; stdout has only the final message.
			console.error("RUNNER-CHECK: test = fail");
			console.log("Added resumed.txt.");
		`, "{prompt}"] },
	});
	await git(check.root, [...commit, "base"]);
	await git(check.root, ["branch", check.team.base, "HEAD"]);
	await mkdir(check.config.worktreesDir);
	await git(check.root, ["worktree", "add", "-b", branch, checkout, "HEAD"]);

	const prior = await claimScopedWork(check.options);
	await prior.checkpoint(checkout, branch, "HEAD");
	await prior.checks([{ name: "test", passed: true }]);
	await writeFile(join(checkout, "partial.txt"), "Retained change\n");
	await git(checkout, ["add", "partial.txt"]);

	const ssh = join(check.root, "fixture-ssh.mjs");
	await writeFile(ssh, `import { spawnSync } from "node:child_process";
const { status } = spawnSync("git", ["upload-pack", ${JSON.stringify(check.root)}], { stdio: "inherit" });
process.exit(status ?? 1);
`);
	const quote = (path) => `"${path.replaceAll("\\", "/")}"`;
	const sshEnv = {
		GIT_SSH_COMMAND: `${quote(process.execPath)} ${quote(ssh)}`, GIT_SSH_VARIANT: "simple",
		GIT_CONFIG_GLOBAL: join(check.root, "gitempty"), GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "ssh",
	};
	for (const [name, value] of Object.entries(sshEnv)) {
		const previous = process.env[name];
		process.env[name] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		});
	}
	await git(check.root, ["ls-remote", "--exit-code", "origin", "refs/heads/pilot-base"]);
	const attemptId = randomUUID();
	const claims = [];
	const reports = [];
	const messages = [];
	let priorState = "running";
	let lost = true;
	const track = {
		async call(action) {
			if (action === "get_workspace") return { members: [{ role: "owner", email: "owner@example.test" }] };
			return { key: "ENG-1", title: "Fixture", status: "Todo", labels: ["runner"], creator: "owner@example.test" };
		},
		async workRun(action, data) {
			if (action === "find") {
				return {
					requestId: check.requestId, repository: "acme/site",
					lastAttemptId: claims.length ? attemptId : check.attemptId,
					lastAttemptState: claims.length ? "queued" : priorState,
					activeAttemptId: claims.length ? attemptId : priorState === "running" ? check.attemptId : null,
				};
			}
			if (action === "claim") {
				assert.equal(data.previousAttemptId, check.attemptId);
				const pickedUp = messages.findLastIndex((line) => line.includes(": picked up ("));
				assert.match(messages[pickedUp - 1], /Last reported check: test \(passed\)/);
				claims.push(data.claimId);
				if (lost) throw new Error("Lost reply");
				return { attemptId, repository: "acme/site", token: fixtureToken, canLaunch: true };
			}
			assert.equal(action, "report");
			assert.equal(data.attemptId, attemptId);
			reports.push(data);
			return { sequence: data.sequence };
		},
	};
	const resume = await resumeScopedWork(check.config, check.team, "ENG-1", check.attemptId);
	await assert.rejects(resumeScopedWork(check.config, { ...check.team, checks: ["changed"] }, "ENG-1", check.attemptId),
		/runner capabilities changed/);
	const runner = new Runner(check.config, { track, log: (message) => messages.push(message) });
	runner.claimIssue = async () => true;
	await runner.resumeWork("ENG-1", check.attemptId);
	assert.match(messages.at(-1), /verified failed or cancelled outcome/);
	priorState = "cancelled";
	await git(check.root, [...commit, "changed"]);
	await git(check.root, ["branch", "-f", check.team.base, "HEAD"]);
	await runner.resumeWork("ENG-1", check.attemptId);
	assert.match(messages.at(-1), /approved base changed/);
	assert.deepEqual(claims, []);
	await git(check.root, ["branch", "-f", check.team.base, resume.checkpoint.baseHead]);
	await assert.rejects(runner.resumeWork("ENG-1", check.attemptId), /Lost reply/);
	lost = false;
	await runner.resumeWork("ENG-1", check.attemptId);
	await runner.resumeWork("ENG-1", check.attemptId);
	assert.equal(claims.length, 2);
	assert.equal(new Set(claims).size, 1);
	assert.equal(await readFile(join(checkout, "resumed.txt"), "utf8"), "Continued");
	assert.equal(await readFile(join(checkout, "partial.txt"), "utf8"), "Retained change\n");
	assert.deepEqual(reports.map(({ state }) => state), ["running", "failed"]);
	// The stderr line moved the checkpoint; the verdict waits for the final output, which named no result.
	assert.match(await inspectScopedWork(check.config, "ENG-1"), /Last reported check: test \(failed\)/);
	assert.ok(messages.includes("ENG-1: failed — a required check did not pass: test (not reported)"), messages.join(" | "));
});

/** Track's claim and report rules for one registration, without the network. */
function executorTrack(executor) {
	const requestId = randomUUID();
	const attemptId = randomUUID();
	const state = { attempt: null, claimId: null, signal: null, sequence: 0 };
	const claims = [];
	const sent = [];
	const unfinished = () => ["queued", "running"].includes(state.signal);
	return {
		requestId, attemptId, claims, sent, state,
		async workRun(action, data) {
			if (action === "find") {
				return {
					requestId, repository: "acme/site", executor, lastAttemptId: state.attempt,
					activeAttemptId: unfinished() ? state.attempt : null, lastAttemptState: state.signal,
				};
			}
			const grant = (canLaunch) => ({
				attemptId, repository: "acme/site", canLaunch, active: unfinished(), token: fixtureToken, linkOrigins: [],
			});
			if (action === "claim") {
				claims.push(data);
				if (data.executor !== executor) throw Object.assign(new Error("other executor"), { status: 409 });
				if (state.attempt) {
					if (data.claimId !== state.claimId) throw Object.assign(new Error("claimed"), { status: 409 });
					return grant(state.signal === "queued");
				}
				Object.assign(state, { attempt: attemptId, claimId: data.claimId, signal: "queued" });
				return grant(true);
			}
			assert.equal(action, "report");
			if (data.sequence <= state.sequence) return { sequence: state.sequence, applied: false };
			if (!unfinished() || (state.signal === "running" && data.state === "queued")) {
				throw Object.assign(new Error("cannot change"), { status: 409 });
			}
			Object.assign(state, { signal: data.state, sequence: data.sequence });
			sent.push(data);
			return { sequence: data.sequence };
		},
	};
}

test("each executor claims only the work registered for it", async (t) => {
	const check = await fixture(t);
	const cloudWork = executorTrack("cloud");
	const local = { ...check.options, track: cloudWork };
	assert.equal(await findScopedWork(check.config, check.team, "ENG-1", cloudWork), null);
	assert.equal(await claimScopedWork(local), null);
	assert.deepEqual(cloudWork.claims, []);

	const cloudTeam = { ...check.team, isolation: "cloud" };
	assert.ok(await findScopedWork(check.config, cloudTeam, "ENG-1", cloudWork));
	const granted = await claimScopedWork({ ...local, team: cloudTeam });
	assert.equal(granted.attemptId, cloudWork.attemptId);
	assert.deepEqual(cloudWork.claims.map(({ executor }) => executor), ["cloud"]);

	const localWork = executorTrack("local-runner");
	assert.equal(await findScopedWork(check.config, cloudTeam, "ENG-1", localWork), null);
	assert.ok(await claimScopedWork({ ...local, track: localWork }));
	assert.deepEqual(localWork.claims.map(({ executor }) => executor), ["local-runner"]);
});

test("a cloud attempt that waits stays queued with its reason, and one later poll runs it", async (t) => {
	const check = await fixture(t);
	const track = executorTrack("cloud");
	const team = { ...check.team, isolation: "cloud" };
	const options = { ...check.options, team, track };
	const first = await claimScopedWork(options);
	await first.wait("Waiting for Docker Cloud", "budget-limit", "Docker Cloud has no credit left for a sandbox");
	assert.deepEqual(track.sent, [{
		state: "queued", progress: "Waiting for Docker Cloud", sequence: 1, waitReason: "budget-limit",
		waitDetail: "Docker Cloud has no credit left for a sandbox", attemptId: track.attemptId, token: fixtureToken,
	}]);

	// The next poll finds it again; two launchers trying at once start it only once.
	assert.ok(await findScopedWork(check.config, team, "ENG-1", track));
	const retries = await Promise.all([claimScopedWork(options), claimScopedWork(options)]);
	assert.equal(retries.filter(Boolean).length, 1);
	assert.equal(new Set(track.claims.map(({ claimId }) => claimId)).size, 1);
	const retried = retries.find(Boolean);
	assert.equal(retried.attemptId, track.attemptId);

	await retried.report("running", "Docker Cloud run started");
	await retried.report("passed", "Docker Cloud run finished");
	assert.deepEqual(track.sent.map(({ state, sequence }) => [state, sequence]), [["queued", 1], ["running", 2], ["passed", 3]]);
	assert.equal(await findScopedWork(check.config, team, "ENG-1", track), null);
	assert.equal(await claimScopedWork(options), null);
});

test("a retry that waits again lets the next poll try, and a running attempt is never tried again", async (t) => {
	const check = await fixture(t);
	const track = executorTrack("cloud");
	const team = { ...check.team, isolation: "cloud" };
	const options = { ...check.options, team, track };
	await (await claimScopedWork(options)).wait("Waiting for Docker Cloud", "retry", "Docker Cloud could not start a sandbox");
	await (await claimScopedWork(options)).wait("Waiting for Docker Cloud", "retry", "Docker Cloud could not start a sandbox");
	const third = await claimScopedWork(options);
	assert.ok(third);
	await third.report("running", "Docker Cloud run started");
	assert.deepEqual(track.sent.map(({ state, sequence }) => [state, sequence]), [["queued", 1], ["running", 2]]);
	assert.equal(await findScopedWork(check.config, team, "ENG-1", track), null);
});

test("when Docker Cloud refuses, the runner leaves the board alone and never runs the job here", async (t) => {
	const check = await fixture(t);
	const track = executorTrack("cloud");
	const team = { ...check.team, isolation: "cloud", cloud: {} };
	const prepared = [];
	let removed = 0;
	let refuse = true;
	const cloud = {
		async prepare({ nonce }) {
			prepared.push(nonce);
			if (refuse) throw new CloudUnavailableError("Docker Cloud has no credit left for a sandbox", { budget: true });
			return { name: "gw-eng-1", async remove() { removed++; } };
		},
		async run() {
			throw new Error("the engine must not run when the board did not move");
		},
	};
	const runner = new Runner(check.config, { track, log: check.log, cloud });
	let pickups = 0;
	runner.claimIssue = async () => {
		pickups++;
		return false;
	};
	await git(check.root, ["remote", "set-url", "--push", "origin", "https://github.com/acme/site.git"]);
	const work = () => ({ teamKey: "ENG", team, detail: { key: "ENG-1", title: "Fixture" } });
	await runner.run(work());
	assert.equal(pickups, 0);
	assert.deepEqual(track.sent.map(({ state, waitReason }) => [state, waitReason]), [["queued", "budget-limit"]]);

	refuse = false;
	await runner.run(work());
	assert.deepEqual(prepared, [track.attemptId, track.attemptId]);
	assert.equal(pickups, 1);
	assert.equal(removed, 1);
	assert.deepEqual(track.sent.map(({ state, sequence }) => [state, sequence]), [["queued", 1], ["failed", 3]]);
});
