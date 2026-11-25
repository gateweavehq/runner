// Tests for the runner's pure parts and its Track client: node --test

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildEnv } from "./env.mjs";
import { ensureWorktree } from "./git.mjs";
import { creatorAllowed, ownerOrAdminEmails, pickCandidates, statusMatches } from "./pick.mjs";
import { engineArgv, parseCheckReports } from "./process.mjs";
import { Runner } from "./runner.mjs";
import { forbiddenEnvName, validateConfig, ConfigError } from "./config.mjs";
import { parseSse, toolResult, TrackMcp } from "./track.mjs";
import { GIB, SlotsGate } from "./slots.mjs";

test("buildEnv keeps the OS basics, applies pass and set, drops the rest", () => {
	const env = buildEnv({
		baseEnv: {
			PATH: "/usr/bin",
			HOME: "/home/x",
			GATEWEAVE_TRACK_RUNNER_KEY: "secret",
			GH_TOKEN: "secret",
			CUSTOM_BENIGN: "yes",
		},
		pass: ["CUSTOM_BENIGN"],
		set: { CI: "1" },
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/x");
	assert.equal(env.CUSTOM_BENIGN, "yes");
	assert.equal(env.CI, "1");
	assert.equal(env.GATEWEAVE_TRACK_RUNNER_KEY, undefined);
	assert.equal(env.GH_TOKEN, undefined);
});

test("forbiddenEnvName refuses credentials and the runner's own key", () => {
	assert.ok(forbiddenEnvName("GH_TOKEN", "K"));
	assert.ok(forbiddenEnvName("CLOUDFLARE_API_TOKEN", "K"));
	assert.ok(forbiddenEnvName("AWS_SECRET_ACCESS_KEY", "K"));
	assert.ok(forbiddenEnvName("GATEWEAVE_TRACK_RUNNER_KEY", "GATEWEAVE_TRACK_RUNNER_KEY"));
	assert.equal(forbiddenEnvName("PNPM_HOME", "K"), null);
});

test("validateConfig demands repo, engine with {prompt} and a label", () => {
	const base = { track: { url: "https://t.example", keyEnv: "K" }, workspace: "ws" };
	assert.throws(() => validateConfig(base), ConfigError);
	assert.throws(() => validateConfig({ ...base, teams: { ENG: { repo: "~/r" } } }), ConfigError);
	assert.throws(
		() =>
			validateConfig({
				...base,
				teams: { ENG: { repo: "~/r", label: "go", engine: { command: ["codex", "exec"] } } },
			}),
		(error) => error instanceof ConfigError,
	);
	const ok = validateConfig({
		...base,
		teams: { ENG: { repo: "~/r", label: "go", engine: { command: ["codex", "exec", "{prompt}"] } } },
	});
	assert.equal(ok.teams.ENG.base, "main");
	assert.equal(ok.teams.ENG.isolation, "worktree");
});

test("validateConfig refuses unsupported isolation and untrusted teams", () => {
	const config = (settings) => ({
		track: { url: "https://t.example", keyEnv: "K" },
		workspace: "ws",
		teams: { ENG: { repo: "~/r", label: "go", engine: { command: ["codex", "{prompt}"] }, ...settings } },
	});
	assert.throws(() => validateConfig(config({ isolation: "worktre" })), /teams\.ENG\.isolation/);
	assert.throws(() => validateConfig(config({ untrusted: true })), /untrusted/);
	assert.throws(
		() => validateConfig(config({ isolation: "container", container: { image: "runner:local" }, untrusted: true })),
		/untrusted/,
	);
	assert.throws(() => validateConfig(config({ untrusted: "false" })), /untrusted must be a boolean/);
	assert.equal(validateConfig(config({ isolation: "worktree", untrusted: false })).teams.ENG.untrusted, false);
});

test("validateConfig requires a local container image and rejects host environment forwarding", () => {
	const config = (settings) => ({
		track: { url: "https://t.example", keyEnv: "K" },
		workspace: "ws",
		teams: {
			ENG: {
				repo: "~/r",
				label: "go",
				engine: { command: ["node", "{prompt}"] },
				isolation: "container",
				...settings,
			},
		},
	});
	for (const container of [undefined, {}, { image: "" }, { image: "--privileged" }, { image: "some image" }]) {
		assert.throws(() => validateConfig(config({ container })), /container\.image/);
	}
	const container = { image: "runner:local" };
	assert.equal(validateConfig(config({ container })).teams.ENG.container.image, container.image);
	for (const env of [{ pass: ["TMP"] }, { set: { CUSTOM_BENIGN: "yes" } }]) {
		assert.throws(
			() => validateConfig(config({ container, env })),
			/does not support env\.pass or env\.set with container isolation/,
		);
	}
});

test("validateConfig validates the container model and defaults its request quota", () => {
	const config = (model) => ({
		track: { url: "https://t.example", keyEnv: "K" },
		workspace: "ws",
		teams: {
			ENG: {
				repo: "~/r",
				label: "go",
				engine: { command: ["node", "{prompt}"] },
				isolation: "container",
				container: { image: "runner:local", model },
			},
		},
	});
	for (const model of [{}, { name: "" }, { name: 42 }, { name: "two models" }]) {
		assert.throws(() => validateConfig(config(model)), ConfigError);
	}
	const name = "gpt-6.2-sol";
	for (const maxRequests of [0, -1, 1.5, "1"]) {
		assert.throws(() => validateConfig(config({ name, maxRequests })), ConfigError);
	}
	assert.deepEqual(validateConfig(config({ name })).teams.ENG.container.model, { name, maxRequests: 8 });
	assert.deepEqual(validateConfig(config({ name, maxRequests: 1 })).teams.ENG.container.model, { name, maxRequests: 1 });
});

test("validateConfig accepts only supported container package registries", () => {
	const config = (packages) => ({
		track: { url: "https://t.example", keyEnv: "K" },
		workspace: "ws",
		teams: {
			ENG: {
				repo: "~/r",
				label: "go",
				engine: { command: ["node", "{prompt}"] },
				isolation: "container",
				container: { image: "runner:local", packages },
			},
		},
	});
	for (const packages of ["npm", "pnpm"]) {
		assert.equal(validateConfig(config(packages)).teams.ENG.container.packages, packages);
	}
	for (const packages of ["yarn", "auto", "", true]) {
		assert.throws(() => validateConfig(config(packages)), ConfigError);
	}
});

const workspace = {
	members: [
		{ email: "owner@example.com", role: "owner" },
		{ email: "admin@example.com", role: "admin" },
		{ email: "member@example.com", role: "member" },
	],
};

test("pickCandidates keeps labelled, unstarted, unarchived issues of the team", () => {
	const issues = [
		{ key: "ENG-1", statusName: "Todo", status: "todo", labels: ["local-runner"], archived: false, intake: false },
		{ key: "ENG-2", statusName: "Todo", status: "todo", labels: [], archived: false, intake: false },
		{ key: "ENG-3", statusName: "In Progress", status: "in_progress", labels: ["local-runner"], archived: false, intake: false },
		{ key: "ENG-4", statusName: "Todo", status: "todo", labels: ["local-runner"], archived: true, intake: false },
	];
	const picked = pickCandidates({ issues, team: "ENG", label: "local-runner", pickupStatuses: ["Todo"] });
	assert.deepEqual(picked.map((i) => i.key), ["ENG-1"]);
});

test("creatorAllowed takes owners and admins, not members or non-people", () => {
	const allowed = ownerOrAdminEmails(workspace);
	assert.equal(creatorAllowed({ creator: "owner@example.com" }, allowed), true);
	assert.equal(creatorAllowed({ creator: "Admin@Example.com" }, allowed), true);
	assert.equal(creatorAllowed({ creator: "member@example.com" }, allowed), false);
	assert.equal(creatorAllowed({ creator: "GitHub" }, allowed), false);
	assert.equal(creatorAllowed({ creator: "Request form" }, allowed), false);
});

test("statusMatches accepts the name or the key, any case", () => {
	const issue = { statusName: "In Progress", status: "in_progress" };
	assert.equal(statusMatches(issue, "In Progress"), true);
	assert.equal(statusMatches(issue, "in_progress"), true);
	assert.equal(statusMatches({ statusName: "Todo", status: "todo" }, "In Progress"), false);
});

test("parseCheckReports reads the engine's RUNNER-CHECK lines", () => {
	const reports = parseCheckReports("working...\nRUNNER-CHECK: check = pass\nRUNNER-CHECK: typecheck = FAIL\n");
	assert.equal(reports.get("check"), true);
	assert.equal(reports.get("typecheck"), false);
	assert.equal(reports.get("missing"), undefined);
});

test("engineArgv substitutes the prompt as one argument", () => {
	assert.deepEqual(engineArgv(["claude", "-p", "{prompt}"], "do it"), ["claude", "-p", "do it"]);
	assert.deepEqual(engineArgv(["codex", "exec", "--flag", "{prompt}"], "x"), ["codex", "exec", "--flag", "x"]);
});

test("parseSse reads data lines and ignores keepalives", () => {
	const body = ': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\ndata: [DONE]\n';
	assert.deepEqual(parseSse(body), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("toolResult prefers structured content, then parses text", () => {
	assert.deepEqual(toolResult({ structuredContent: { a: 1 } }), { a: 1 });
	assert.deepEqual(toolResult({ content: [{ type: "text", text: '{"b":2}' }] }), { b: 2 });
	assert.throws(() => toolResult({ isError: true, content: [{ type: "text", text: "nope" }] }));
});

function fakeTrack({ sse = true } = {}) {
	const calls = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const message = JSON.parse(body || "{}");
			calls.push({ message, headers: req.headers });
			if (message.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			if (message.method === "initialize") {
				res.writeHead(200, {
					"content-type": "application/json",
					"mcp-session-id": "sess-1",
				});
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {} } }));
				return;
			}
			if (message.method === "tools/call") {
				const result = { structuredContent: { echoed: message.params.arguments }, isError: false };
				if (sse) {
					res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
					res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
				} else {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
				}
				return;
			}
			res.writeHead(404).end();
		});
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => resolvePromise({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
	});
}

test("TrackMcp handshakes, keeps the session and calls tools over SSE and JSON", async () => {
	for (const sse of [true, false]) {
		const { server, calls, url } = await fakeTrack({ sse });
		try {
			const track = new TrackMcp({ url, key: "gwt_test" });
			const result = await track.call("search_issues", { workspace: "gateweave" });
			assert.deepEqual(result, { echoed: { workspace: "gateweave" } });
			const init = calls.find((c) => c.message.method === "initialize");
			assert.equal(init.headers.authorization, "Bearer gwt_test");
			const tool = calls.find((c) => c.message.method === "tools/call");
			assert.equal(tool.headers["mcp-session-id"], "sess-1");
			assert.ok(tool.headers["mcp-protocol-version"]);
		} finally {
			server.close();
		}
	}
});

test("TrackMcp forgets a failed handshake so the next call reconnects", async () => {
	let inits = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const message = JSON.parse(body || "{}");
			if (message.method === "initialize") {
				inits++;
				if (inits === 1) {
					res.writeHead(500).end("boom");
					return;
				}
				res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s2" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {} } }));
				return;
			}
			if (message.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			if (message.method === "tools/call") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { ok: true } } }));
				return;
			}
			res.writeHead(404).end();
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		const track = new TrackMcp({ url: `http://127.0.0.1:${server.address().port}`, key: "k" });
		await assert.rejects(track.call("get_workspace", { workspace: "w" }), /HTTP 500/);
		const result = await track.call("get_workspace", { workspace: "w" });
		assert.deepEqual(result, { ok: true });
		assert.equal(inits, 2);
	} finally {
		server.close();
	}
});

test("TrackMcp surfaces a refused key without retrying", async () => {
	const server = createServer((req, res) => {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid agent key" }, id: null }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		const track = new TrackMcp({ url: `http://127.0.0.1:${server.address().port}`, key: "bad" });
		await assert.rejects(track.call("get_workspace", { workspace: "gateweave" }), /refused the agent key/);
	} finally {
		server.close();
	}
});

test("ensureWorktree creates from the start point, and reuses a leftover branch with its commits", async () => {
	const exec = promisify(execFile);
	const dir = await mkdtemp(join(tmpdir(), "runner-git-"));
	const repo = join(dir, "repo");
	await mkdir(repo, { recursive: true });
	const gitc = (args) => exec("git", args, { cwd: repo });
	await gitc(["init", "-b", "main"]);
	await gitc(["config", "user.email", "test@example.com"]);
	await gitc(["config", "user.name", "Test"]);
	await writeFile(join(repo, "a.txt"), "one\n");
	await gitc(["add", "-A"]);
	await gitc(["commit", "-m", "initial"]);
	// A branch an earlier run left behind, with a commit the retry must keep.
	await gitc(["checkout", "-b", "runner/eng-1"]);
	await writeFile(join(repo, "b.txt"), "two\n");
	await gitc(["add", "-A"]);
	await gitc(["commit", "-m", "leftover work"]);
	await gitc(["checkout", "main"]);

	const fresh = join(dir, "wt-fresh");
	assert.equal(await ensureWorktree(repo, fresh, "runner/eng-2", "main"), "created");
	const { stdout: freshLog } = await exec("git", ["-C", fresh, "log", "--format=%s", "-1"]);
	assert.equal(freshLog.trim(), "initial");

	const reused = join(dir, "wt-reused");
	assert.equal(await ensureWorktree(repo, reused, "runner/eng-1", "main"), "reused");
	const { stdout: reusedLog } = await exec("git", ["-C", reused, "log", "--format=%s", "-1"]);
	assert.equal(reusedLog.trim(), "leftover work");
});

function fakeTrackForClaim(statusAfterUpdate) {
	const calls = [];
	return {
		calls,
		async call(name, args) {
			calls.push([name, args]);
			if (name === "get_issue") {
				return { key: args.key, statusName: statusAfterUpdate, status: statusAfterUpdate.toLowerCase().replaceAll(" ", "_") };
			}
			return {};
		},
	};
}

function runnerConfig(tmp) {
	return {
		workspace: "gateweave",
		stateDir: join(tmp, "state"),
		pauseFile: join(tmp, "PAUSE"),
		logDir: join(tmp, "logs"),
		worktreesDir: join(tmp, "wt"),
		branchPrefix: "runner",
		pollSeconds: 1,
		dailyLimit: 5,
		teams: {},
	};
}

const claimTeam = { inProgressStatus: "In Progress", engine: { command: ["codex"] } };

test("claimIssue verifies the status moved before commenting or counting", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-claim-"));
	const track = fakeTrackForClaim("In Progress");
	const runner = new Runner(runnerConfig(tmp), { track, log: () => {} });
	assert.equal(await runner.claimIssue({ key: "ENG-1", team: claimTeam, branch: "runner/eng-1", machine: "m" }), true);
	assert.ok(track.calls.some(([name]) => name === "add_comment"));
	assert.equal(await runner.dailyCount(), 1);
});

test("claimIssue skips when Track holds the move as a proposal", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-claim-"));
	const track = fakeTrackForClaim("Todo");
	const runner = new Runner(runnerConfig(tmp), { track, log: () => {} });
	assert.equal(await runner.claimIssue({ key: "ENG-1", team: claimTeam, branch: "runner/eng-1", machine: "m" }), false);
	assert.ok(!track.calls.some(([name]) => name === "add_comment"));
	assert.equal(await runner.dailyCount(), 0);
});

test("a dry run neither claims nor counts", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-dry-"));
	const track = fakeTrackForClaim("In Progress");
	const runner = new Runner(runnerConfig(tmp), { track, log: () => {}, dryRun: true });
	await runner.run({ teamKey: "ENG", team: { ...claimTeam, checks: [] }, detail: { key: "ENG-1", title: "t" } });
	assert.equal(track.calls.length, 0);
	assert.equal(await runner.dailyCount(), 0);
});

test("the admission gate holds a job before any Track call", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-gate-"));
	const track = fakeTrackForClaim("In Progress");
	const slots = {
		ownProcess: async () => ({ pid: process.pid, pidStartMs: null }),
		acquire: async () => ({ admitted: false, reason: "one heavy job is running: ENG-1", claim: null }),
		release: async () => true,
	};
	const runner = new Runner(runnerConfig(tmp), { track, log: () => {}, slots });
	await runner.run({ teamKey: "ENG", team: { ...claimTeam, checks: [] }, detail: { key: "ENG-1", title: "t" } });
	assert.equal(track.calls.length, 0, "a held job never touches Track");
	assert.equal(await runner.dailyCount(), 0);
});

test("the slot claim is released with the exit code, even when the claim does not move", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-gate-"));
	const track = fakeTrackForClaim("Todo"); // Track holds the move as a proposal
	const released = [];
	const slots = {
		ownProcess: async () => ({ pid: process.pid, pidStartMs: null }),
		acquire: async () => ({ admitted: true, claim: { id: "claim-1" }, advisory: { wouldAdmit: false, reason: "held in advise" }, reason: "capacity allows it" }),
		release: async (id, options) => {
			released.push([id, options]);
			return true;
		},
	};
	const runner = new Runner(runnerConfig(tmp), { track, log: () => {}, slots });
	await runner.run({ teamKey: "ENG", team: { ...claimTeam, checks: [] }, detail: { key: "ENG-1", title: "t" } });
	assert.deepEqual(released, [["claim-1", { code: null }]]);
});

test("a job keeps its admission claim for as long as the runner works on it", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-gate-"));
	const clock = { now: new Date("2026-11-25T10:00:00Z") };
	const gate = new SlotsGate({
		dir: join(tmp, "slots"),
		mode: "enforce",
		reserveBytes: GIB,
		probe: async () => ({ availableBytes: 32 * GIB, totalBytes: 64 * GIB, commitAvailableBytes: 64 * GIB }),
		processTable: async () => [{ pid: process.pid, ppid: 1, workingSetBytes: GIB, startedAtMs: 1234 }],
		now: () => clock.now,
		uptimeSec: () => 100_000,
		sleep: async () => {},
	});
	let second;
	const track = {
		async call(name, args) {
			if (name === "update_issue") {
				// Ten minutes into the job, past the gate's launch timeout, a hand job asks.
				clock.now = new Date(clock.now.getTime() + 10 * 60_000);
				second = await gate.acquire({ klass: "heavy", task: "ENG-70", launcher: "hand" });
			}
			if (name === "get_issue") return { key: args.key, statusName: "Todo", status: "todo" };
			return {};
		},
	};
	const runner = new Runner(runnerConfig(tmp), { track, log: () => {}, slots: gate });
	await runner.run({ teamKey: "ENG", team: { ...claimTeam, checks: [] }, detail: { key: "ENG-1", title: "t" } });
	assert.equal(second.admitted, false, "the running job still holds the heavy slot");
	assert.match(second.reason, /one heavy job is running: ENG-1/);
	const history = (await readFile(join(tmp, "slots", "history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(history.map((entry) => [entry.task, entry.endedHow]), [["ENG-1", "clean"]]);
});

async function createBareRepo(tmp) {
	const repo = join(tmp, "repo");
	const remote = join(tmp, "remote");
	const exec = promisify(execFile);
	const gitc = async (args, cwd = repo) => {
		const { stdout } = await exec("git", args, { cwd });
		return stdout.trim();
	};
	await mkdir(repo);
	await mkdir(remote);
	await gitc(["init", "--bare"], remote);
	await gitc(["init", "-b", "main"]);
	await gitc(["config", "user.email", "test@example.com"]);
	await gitc(["config", "user.name", "Test"]);
	await gitc(["config", "core.autocrlf", "false"]);
	await writeFile(join(repo, "a.txt"), "one\n");
	await gitc(["add", "a.txt"]);
	await gitc(["commit", "-m", "initial"]);
	await gitc(["remote", "add", "origin", remote]);
	await gitc(["push", "origin", "main"]);
	return { repo, remote, gitc };
}

test("run keeps setup inside the engine and publishes saved commits after a failed push", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-retry-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const { repo, remote, gitc } = await createBareRepo(tmp);

	const engine = join(tmp, "engine.mjs");
	const tempDirectoryLog = join(tmp, "engine-temp.log");
	await writeFile(engine, `
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [mode, prompt] = process.argv.slice(2);
assert.match(prompt, /run these setup commands in order inside your sandbox/);
assert.ok(prompt.includes("echo setup > host-setup.txt"));
assert.equal(existsSync("host-setup.txt"), false);
if (process.platform === "win32") {
	assert.equal(process.env.TEMP, process.env.TMP);
	writeFileSync(join(process.env.TEMP, "scratch.txt"), "scratch");
	appendFileSync(${JSON.stringify(tempDirectoryLog)}, process.env.TEMP + "\\n");
}
if (mode !== "no-change") writeFileSync("b.txt", "two\\n");
if (mode !== "missing-report") console.log("RUNNER-SETUP: pass");
`);
	const track = fakeTrackForClaim("In Progress");
	const ghCalls = [];
	const prUrl = "https://github.example/repo/pull/1";
	const runner = new Runner(runnerConfig(tmp), {
		track,
		log: () => {},
		async runGh(executable, args) {
			assert.equal(executable, "gh");
			ghCalls.push(args);
			if (args[1] === "list") return { stdout: ghCalls.length === 1 ? "[]" : JSON.stringify([{ url: prUrl }]) };
			assert.equal(args[1], "create");
			return { stdout: prUrl };
		},
	});
	const run = (mode) => runner.run({
		teamKey: "ENG",
		team: {
			...claimTeam,
			repo,
			base: "main",
			remote: "origin",
			engineTimeoutMinutes: 1,
			todoStatus: "Todo",
			reviewStatus: "In Review",
			engine: { command: [process.execPath, engine, mode, "{prompt}"] },
			setup: ["echo setup > host-setup.txt"],
			env: { set: { temp: tmp, TMP: tmp } },
		},
		detail: { key: "ENG-1", title: "Retry" },
	});
	const branch = "refs/heads/runner/eng-1";

	await run("missing-report");
	assert.ok(track.calls.some(([name, args]) => name === "add_comment" && args.body.includes("did not report successful setup")));
	assert.equal(await gitc(["rev-parse", branch]), await gitc(["rev-parse", "main"]));

	await gitc(["remote", "set-url", "--push", "origin", join(tmp, "unavailable")]);
	await run("edit");
	const savedCommit = await gitc(["rev-parse", branch]);
	assert.notEqual(savedCommit, await gitc(["rev-parse", "main"]));
	assert.equal(await gitc(["for-each-ref", "--format=%(refname)", branch], remote), "");
	assert.equal(ghCalls.length, 0);

	await gitc(["remote", "set-url", "--push", "origin", remote]);
	await run("no-change");
	assert.equal(await gitc(["rev-parse", branch], remote), savedCommit);
	assert.deepEqual(ghCalls.map((args) => args[1]), ["list", "create"]);
	assert.ok(track.calls.some(([name, args]) => name === "update_issue" && args.status === "In Review"));

	await run("no-change");
	assert.deepEqual(ghCalls.map((args) => args[1]), ["list", "create", "list"]);

	if (process.platform === "win32") {
		const dirs = (await readFile(tempDirectoryLog, "utf8")).trim().split("\n");
		assert.equal(dirs.length, 4);
		assert.equal(new Set(dirs).size, dirs.length);
		for (const dir of dirs) {
			assert.equal(dirname(dir), join(tmp, "wt"));
			await assert.rejects(stat(dir), { code: "ENOENT" });
		}
	}
});

test("run publishes successful offline container changes and drops failed edits", {
	skip: process.env.TRACK_RUNNER_DOCKER_TEST !== "1" && "requires Docker and a locally installed node:24-bookworm-slim image",
}, async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-container-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const { repo, remote, gitc } = await createBareRepo(tmp);
	const hookMarker = join(tmp, "host-hook-ran");
	await mkdir(join(repo, "hooks"));
	const hook = "#!/bin/sh\nprintf ran > " + JSON.stringify(hookMarker.replaceAll("\\", "/")) + "\n";
	for (const name of ["post-checkout", "pre-commit", "pre-push"]) {
		await writeFile(join(repo, "hooks", name), hook, { mode: 0o755 });
		await gitc(["add", "--chmod=+x", `hooks/${name}`]);
	}
	await writeFile(join(repo, "engine.mjs"), `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
assert.equal(process.env.TRACK_RUNNER_TEST_HOST_ONLY, undefined);
assert.equal(existsSync(".git"), false);
assert.equal(existsSync("/var/run/docker.sock"), false);
assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
assert.equal(readFileSync("a.txt", "utf8").trimEnd(), "one");
unlinkSync("a.txt");
writeFileSync("b.txt", "from container\\n");
if (process.argv[2].includes("Failure case")) process.exit(1);
assert.match(process.argv[2], /node --version/);
execFileSync("node", ["--version"]);
if (!process.argv[2].includes("Missing setup report")) console.log("RUNNER-SETUP: pass");
console.log("RUNNER-CHECK: build = pass");
`);
	await gitc(["add", "engine.mjs"]);
	await gitc(["commit", "-m", "container engine fixture"]);
	await gitc(["push", "origin", "main"]);
	await gitc(["config", "core.hooksPath", "hooks"]);
	await gitc(["hook", "run", "pre-commit"]);
	assert.equal(await readFile(hookMarker, "utf8"), "ran");
	await rm(hookMarker);

	const hostOnlyName = "TRACK_RUNNER_TEST_HOST_ONLY";
	const previousHostOnly = process.env[hostOnlyName];
	process.env[hostOnlyName] = "host-only fixture";
	t.after(() => {
		if (previousHostOnly === undefined) delete process.env[hostOnlyName];
		else process.env[hostOnlyName] = previousHostOnly;
	});
	const config = validateConfig({
		...runnerConfig(tmp),
		track: { url: "https://t.example", keyEnv: "K" },
		teams: {
			ENG: {
				repo,
				label: "go",
				isolation: "container",
				container: { image: "node:24-bookworm-slim" },
				engine: { command: ["node", "engine.mjs", "{prompt}"] },
				setup: ["node --version"],
				checks: [{ name: "build", command: "node --version" }],
				engineTimeoutMinutes: 1,
			},
		},
	});
	const track = {
		status: "Todo",
		async call(name, args) {
			if (name === "update_issue") this.status = args.status;
			if (name === "get_issue") return { key: args.key, statusName: this.status };
			return {};
		},
	};
	const ghCalls = [];
	const logs = [];
	const runner = new Runner(config, {
		track,
		log: (line) => logs.push(line),
		async runGh(executable, args) {
			assert.equal(executable, "gh");
			ghCalls.push(args[1]);
			if (args[1] === "list") return { stdout: "[]" };
			assert.equal(args[1], "create");
			const body = await readFile(args[args.indexOf("--body-file") + 1], "utf8");
			assert.match(body, /passed.*build|build.*passed/i);
			return { stdout: "https://github.example/repo/pull/1" };
		},
	});
	const run = (description) => runner.run({
		teamKey: "ENG",
		team: config.teams.ENG,
		detail: { key: "ENG-1", title: "Offline container", description },
	});
	const branch = "refs/heads/runner/eng-1";

	await run("Failure case");
	assert.equal(track.status, "Todo", logs.join("\n"));
	assert.equal(await gitc(["for-each-ref", "--format=%(refname)", branch], remote), "");
	assert.equal(await gitc(["rev-parse", branch]), await gitc(["rev-parse", "main"]));
	assert.deepEqual(ghCalls, []);

	await run("Missing setup report");
	assert.equal(track.status, "Todo", logs.join("\n"));
	assert.match(logs.join("\n"), /engine did not report successful setup/);
	assert.equal(await gitc(["rev-parse", branch]), await gitc(["rev-parse", "main"]));
	assert.deepEqual(ghCalls, []);

	await run("Success case");
	assert.equal(await gitc(["show", `${branch}:b.txt`], remote), "from container", logs.join("\n"));
	assert.equal(await gitc(["ls-tree", "--name-only", branch, "a.txt"], remote), "");
	assert.deepEqual(ghCalls, ["list", "create"]);
	assert.equal(track.status, "In Review");
	await assert.rejects(stat(hookMarker), { code: "ENOENT" });
});

test("run relays a container model stream without forwarding the provider key to the engine", {
	skip: process.env.TRACK_RUNNER_DOCKER_TEST !== "1" && "requires Docker and a locally installed node:24-bookworm-slim image",
}, async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-model-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const { repo, remote, gitc } = await createBareRepo(tmp);
	const model = "gpt-6.2-sol";
	const apiKey = "runner-test-key";
	await writeFile(join(repo, "engine.mjs"), `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const { RUNNER_MODEL_TOKEN: token, RUNNER_MODEL_BASE_URL: base } = process.env;
assert.equal(base, "http://model-relay:8787/v1");
assert.equal(typeof token, "string");
assert.ok(token.length > 0);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.notEqual(token, ${JSON.stringify(apiKey)});

const request = (model) => fetch(base + "/responses", {
	method: "POST",
	headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
	body: JSON.stringify({ model, input: [{ role: "user", content: "Hello" }], stream: true }),
	signal: AbortSignal.timeout(10_000),
});

const wrongModel = await request("other-model");
assert.ok(wrongModel.status >= 400 && wrongModel.status < 500);
await wrongModel.text();

const permittedModel = ${JSON.stringify(model)};
const allowed = await request(permittedModel);
const allowedText = await allowed.text();
assert.equal(allowed.status, 200, allowedText);
assert.match(allowed.headers.get("content-type") ?? "", /text\\/event-stream/);
assert.match(allowedText, /relayed fixture/);

const overQuota = await request(permittedModel);
assert.equal(overQuota.status, 429);
await overQuota.text();
console.log("relay token: " + token);
writeFileSync("b.txt", "container model relayed\\n");
`);
	await gitc(["add", "engine.mjs"]);
	await gitc(["commit", "-m", "container model fixture"]);
	await gitc(["push", "origin", "main"]);

	const config = validateConfig({
		...runnerConfig(tmp),
		track: { url: "https://t.example", keyEnv: "K" },
		teams: {
			ENG: {
				repo,
				label: "go",
				isolation: "container",
				container: { image: "node:24-bookworm-slim", model: { name: model, maxRequests: 1 } },
				engine: { command: ["node", "engine.mjs", "{prompt}"] },
				engineTimeoutMinutes: 1,
			},
		},
	});
	const track = {
		status: "Todo",
		comments: [],
		async call(name, args) {
			if (name === "update_issue") this.status = args.status;
			if (name === "add_comment") this.comments.push(args.body);
			if (name === "get_issue") return { key: args.key, statusName: this.status };
			return {};
		},
	};
	const requests = [];
	const ghCalls = [];
	const logs = [];
	const runner = new Runner(config, {
		track,
		log: (line) => logs.push(line),
		async modelFetch(url, init) {
			requests.push({
				url: String(url),
				method: init.method,
				auth: new Headers(init.headers).get("authorization"),
				body: JSON.parse(init.body),
			});
			return new Response('data: {"delta":"relayed fixture"}\n\n', {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
		async runGh(executable, args) {
			assert.equal(executable, "gh");
			ghCalls.push(args[1]);
			if (args[1] === "list") return { stdout: "[]" };
			assert.equal(args[1], "create");
			return { stdout: "https://github.example/repo/pull/1" };
		},
	});
	const previousApiKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = apiKey;
	try {
		await runner.run({
			teamKey: "ENG",
			team: config.teams.ENG,
			detail: { key: "ENG-1", title: "Container with a model" },
		});
	} finally {
		if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousApiKey;
	}

	assert.equal(track.status, "In Review", logs.join("\n"));
	assert.match(track.comments.join("\n"), /relay token: \[redacted\]/);
	assert.equal(await gitc(["show", "refs/heads/runner/eng-1:b.txt"], remote), "container model relayed");
	assert.deepEqual(ghCalls, ["list", "create"]);
	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.equal(request.url, "https://api.openai.com/v1/responses");
	assert.equal(request.method, "POST");
	assert.equal(request.auth, `Bearer ${apiKey}`);
	assert.equal(request.body.model, model);
	assert.deepEqual(request.body.input, [{ role: "user", content: "Hello" }]);
	assert.equal(request.body.stream, true);
	assert.equal(request.body.store, false);
});

const packageName = "runner-fixture";
const extraPackage = "runner-unlisted";
const packageVersion = "1.0.0";
const registry = "https://registry.npmjs.org";
const packagePath = (name) => `/${name}/-/${name}-${packageVersion}.tgz`;

function packageLock(manager, names, integrity) {
	if (manager === "npm") {
		return JSON.stringify({
			name: "runner-test", version: packageVersion, lockfileVersion: 3,
			packages: {
				"": { name: "runner-test", version: packageVersion, dependencies: Object.fromEntries(names.map((name) => [name, packageVersion])) },
				...Object.fromEntries(names.map((name) => [`node_modules/${name}`, {
					version: packageVersion, resolved: registry + packagePath(name), integrity,
				}])),
			},
		}, null, 2) + "\n";
	}
	return [
		"---",
		'lockfileVersion: "9.0"',
		"importers:",
		"  .:",
		"    configDependencies: {}",
		"    packageManagerDependencies: {}",
		"---",
		"lockfileVersion: '9.0'",
		"settings:",
		"  autoInstallPeers: true",
		"  excludeLinksFromLockfile: false",
		"importers:",
		"  .:",
		"    dependencies:",
		...names.flatMap((name) => [`      ${name}:`, `        specifier: ${packageVersion}`, `        version: ${packageVersion}`]),
		"packages:",
		...names.flatMap((name) => [`  ${name}@${packageVersion}:`, `    resolution: {integrity: ${integrity}}`]),
		"snapshots:",
		...names.map((name) => `  ${name}@${packageVersion}: {}`),
		"",
	].join("\n");
}

for (const [manager, flag, image] of [
	["npm", "TRACK_RUNNER_DOCKER_TEST", "node:24-bookworm-slim"],
	["pnpm", "TRACK_RUNNER_PNPM_DOCKER_TEST", "gateweave-runner-pnpm-probe:12.4.2"],
]) {
	test(`run installs committed ${manager} packages and rejects a package added only inside the container`, {
		skip: process.env[flag] !== "1" && `requires Docker and a locally installed ${image} image`,
	}, async (t) => {
		const tmp = await mkdtemp(join(tmpdir(), "runner-packages-"));
		t.after(() => rm(tmp, { recursive: true, force: true }));
		const { repo, remote, gitc } = await createBareRepo(tmp);
		const tarRoot = join(tmp, "tarball");
		await mkdir(join(tarRoot, "package"), { recursive: true });
		await writeFile(join(tarRoot, "package", "package.json"), JSON.stringify({
			name: packageName, version: packageVersion, main: "index.cjs",
		}));
		await writeFile(join(tarRoot, "package", "index.cjs"), 'module.exports = "locked package";\n');
		const { stdout: tarball } = await promisify(execFile)(
			"tar", ["-czf", "-", "-C", tarRoot, "package"], { encoding: "buffer" },
		);
		const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
		const lockName = manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
		const lock = packageLock(manager, [packageName], integrity);
		const mutatedLock = packageLock(manager, [packageName, extraPackage], integrity);
		await writeFile(join(repo, "package.json"), JSON.stringify({
			name: "runner-test", version: packageVersion, dependencies: { [packageName]: packageVersion },
		}));
		await writeFile(join(repo, lockName), lock);
		await writeFile(join(repo, ".gitignore"), "node_modules/\n");
		const install = manager === "npm"
			? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
			: ["install", "--frozen-lockfile", "--ignore-scripts"];
		await writeFile(join(repo, "engine.mjs"), `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const registry = process.env.RUNNER_PACKAGE_REGISTRY;
assert.equal(registry, "http://model-relay:8787");
assert.equal(process.env.npm_config_registry, registry);
assert.equal(process.env.RUNNER_MODEL_TOKEN, undefined);
assert.equal(process.env.NPM_TOKEN, undefined);
const lock = ${JSON.stringify(lockName)};
const original = readFileSync(lock, "utf8");
const install = ${JSON.stringify(install)};
if (${JSON.stringify(manager)} === "pnpm") {
	install.push("--registry=" + registry, "--network-concurrency=8");
}
execFileSync(${JSON.stringify(manager)}, install, {
	stdio: "inherit",
	timeout: 20000,
	env: { ...process.env, npm_config_fetch_retries: "0" },
});
assert.equal(createRequire(import.meta.url)(${JSON.stringify(packageName)}), "locked package");
assert.equal(readFileSync(lock, "utf8"), original);

try {
	writeFileSync(lock, ${JSON.stringify(mutatedLock)});
	const response = await fetch(registry + ${JSON.stringify(packagePath(extraPackage))}, {
		signal: AbortSignal.timeout(10000),
	});
	assert.equal(response.status, 404);
	await response.text();
} finally {
	writeFileSync(lock, original);
}
writeFileSync("b.txt", "installed from the committed lock\\n");
`);
		await gitc(["add", "-A"]);
		await gitc(["commit", "-m", `${manager} fixture and lock`]);
		await gitc(["push", "origin", "main"]);
		const config = validateConfig({
			...runnerConfig(tmp),
			track: { url: "https://t.example", keyEnv: "K" },
			teams: {
				ENG: {
					repo,
					label: "go",
					isolation: "container",
					container: { image, packages: manager },
					engine: { command: ["node", "engine.mjs", "{prompt}"] },
					engineTimeoutMinutes: 1,
				},
			},
		});
		const track = {
			status: "Todo",
			async call(name, args) {
				if (name === "update_issue") this.status = args.status;
				if (name === "get_issue") return { key: args.key, statusName: this.status };
				return {};
			},
		};
		const requests = [];
		const logs = [];
		const ghCalls = [];
		t.mock.method(globalThis, "fetch", async () => {
			throw new Error("Unexpected real registry fetch in package runner test");
		});
		const runner = new Runner(config, {
			track,
			log: (line) => logs.push(line),
			async packageFetch(url, init) {
				requests.push(String(url));
				assert.equal(String(url), registry + packagePath(packageName));
				assert.equal(new Headers(init?.headers).has("authorization"), false);
				return new Response(tarball, {
					headers: { "Content-Type": "application/octet-stream", "Content-Length": String(tarball.length) },
				});
			},
			async runGh(executable, args) {
				assert.equal(executable, "gh");
				ghCalls.push(args[1]);
				if (args[1] === "list") return { stdout: "[]" };
				assert.equal(args[1], "create");
				return { stdout: "https://github.example/repo/pull/1" };
			},
		});
		await runner.run({
			teamKey: "ENG",
			team: config.teams.ENG,
			detail: { key: "ENG-1", title: `Install committed ${manager} packages` },
		});
		const branch = "refs/heads/runner/eng-1";
		assert.equal(track.status, "In Review", logs.join("\n"));
		assert.equal(await gitc(["show", `${branch}:b.txt`], remote), "installed from the committed lock");
		assert.equal(await gitc(["show", `${branch}:${lockName}`], remote), lock.trimEnd());
		assert.equal(await gitc(["diff-tree", "--no-commit-id", "--name-only", "-r", branch], remote), "b.txt");
		assert.deepEqual(ghCalls, ["list", "create"]);
		assert.deepEqual(requests, [registry + packagePath(packageName)]);
	});
}

test("a Docker Cloud team's engine runs in the sandbox, and the host publishes and removes it", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-cloud-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const { repo, remote, gitc } = await createBareRepo(tmp);
	const track = fakeTrackForClaim("In Progress");
	const prompts = [];
	let removed = 0;
	let fail = false;
	const cloud = {
		async prepare({ key, settings }) {
			assert.match(key, /^ENG-\d$/);
			assert.deepEqual(settings, { cpus: 4 });
			return { name: "gw-eng-1", async remove() { removed++; } };
		},
		async run({ sandbox, worktree, prompt, onStdoutLine }) {
			assert.equal(sandbox.name, "gw-eng-1");
			prompts.push(prompt);
			if (fail) throw new Error("sandbox lost");
			await writeFile(join(worktree, "b.txt"), "from the cloud\n");
			onStdoutLine?.("RUNNER-CHECK: test = pass");
			return { code: 0, stdout: "RUNNER-CHECK: test = pass\n", stderr: "", timedOut: false };
		},
	};
	const bodies = [];
	const logs = [];
	const runner = new Runner(runnerConfig(tmp), {
		track,
		log: (line) => logs.push(line),
		cloud,
		async runGh(executable, args) {
			if (args[1] === "list") return { stdout: "[]" };
			bodies.push(await readFile(args[args.indexOf("--body-file") + 1], "utf8"));
			return { stdout: "https://github.example/repo/pull/7" };
		},
	});
	const team = {
		inProgressStatus: "In Progress", repo, base: "main", remote: "origin", engineTimeoutMinutes: 1,
		todoStatus: "Todo", reviewStatus: "In Review", isolation: "cloud", cloud: { cpus: 4 }, checks: ["test"],
	};
	await runner.run({ teamKey: "ENG", team, detail: { key: "ENG-1", title: "Cloud" } });
	assert.match(prompts[0], /RUNNER-CHECK: <name> = pass/);
	// codex exec prints only its final message on stdout, so the results must be repeated there.
	assert.match(prompts[0], /repeat each `RUNNER-CHECK` line, one per line, in your final output/);
	assert.equal(await gitc(["show", "refs/heads/runner/eng-1:b.txt"], remote), "from the cloud");
	assert.match(bodies[0], /Codex in a Docker Cloud sandbox/);
	// A proper name keeps its capitals, and a public repository never learns this machine's name.
	assert.match(bodies[0], /^## What the Docker Cloud run did$/m);
	assert.ok(!bodies[0].includes(hostname()), bodies[0]);
	assert.ok(!prompts[0].includes(hostname()), prompts[0]);
	assert.match(prompts[0], /^You are working in a git worktree of the repository on a Docker Cloud sandbox,/);
	assert.match(bodies[0], /runner for a Docker Cloud run\. It does not merge/);
	assert.equal(removed, 1);
	// The log says where it ran and how it ended, as it does for a failure.
	assert.ok(logs.some((line) => /^ENG-1: routing advice local .*; it runs in Docker Cloud$/.test(line)), logs.join(" | "));
	assert.ok(logs.includes("ENG-1: finished in 0 min — https://github.example/repo/pull/7"), logs.join(" | "));

	fail = true;
	await runner.run({ teamKey: "ENG", team, detail: { key: "ENG-2", title: "Cloud" } }).catch(() => {});
	assert.equal(removed, 2);
	assert.ok(track.calls.some(([name, args]) => name === "add_comment" && args.key === "ENG-2" && /sandbox lost/.test(args.body)));
});
