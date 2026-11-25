// Tests for the routing advice: node --test routing.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, validateConfig } from "./config.mjs";
import { adviseRoute, describeRoute } from "./routing.mjs";
import { Runner } from "./runner.mjs";
import { GIB, SlotsGate } from "./slots.mjs";

const team = (routing) => ({
	repo: "~/r",
	label: "go",
	engine: { command: ["codex", "exec", "{prompt}"] },
	...(routing !== undefined && { routing }),
});
const config = (routing) =>
	validateConfig({ track: { url: "https://t.example", keyEnv: "K" }, workspace: "ws", teams: { ENG: team(routing) } });

test("a portable repository is advised to Docker Cloud, and anything else stays local with its reasons", () => {
	assert.deepEqual(adviseRoute({ source: "public", needs: [] }), {
		advice: "cloud",
		cloudEligible: true,
		reasons: ["public source, and it needs no secrets, host services or person"],
	});
	assert.deepEqual(adviseRoute({ source: "private", needs: ["secrets", "interactive"] }), {
		advice: "local",
		cloudEligible: false,
		reasons: ["its source is private", "it needs secrets that stay on this machine", "it needs a person at the machine"],
	});
	assert.deepEqual(adviseRoute({ source: "public", needs: ["host-services"] }).reasons, [
		"it needs services bound to this machine or account",
	]);
	assert.equal(adviseRoute({ source: "public", needs: ["host-services"] }).cloudEligible, false);
});

test("a repository without routing capabilities assumes nothing and stays local", () => {
	assert.deepEqual(adviseRoute(undefined), {
		advice: "local",
		cloudEligible: false,
		reasons: ["the repository's capabilities are not configured"],
	});
	assert.equal(config(undefined).teams.ENG.routing, undefined);
	assert.match(describeRoute(adviseRoute(undefined)), /^routing advice local \(.+\); advise only, it runs here$/);
});

test("the log says a Docker Cloud team's job runs in Docker Cloud, not here", () => {
	const portable = adviseRoute({ source: "public", needs: [] });
	assert.match(describeRoute(portable, { isolation: "cloud" }), /^routing advice Docker Cloud \(.+\); it runs in Docker Cloud$/);
	assert.match(describeRoute(portable, { isolation: "worktree" }), /; advise only, it runs here$/);
});

test("validateConfig spells out routing: an unknown field or need never makes a job look portable", () => {
	assert.deepEqual(config({ source: "public", needs: ["secrets", "secrets"] }).teams.ENG.routing, {
		source: "public",
		needs: ["secrets"],
	});
	assert.deepEqual(config({ source: "private" }).teams.ENG.routing, { source: "private", needs: [] });
	for (const routing of [
		{ source: "public", secret: true }, // misspelt: would have read as needing nothing
		{ source: "public", needs: ["secret"] },
		{ source: "public", needs: "secrets" },
		{ needs: [] }, // the source is never assumed
		{ source: "internal" },
		["public"],
		null,
	]) {
		assert.throws(() => config(routing), ConfigError, JSON.stringify(routing));
	}
});

/** A real gate on a temp dir whose host always has room, with this process as the only one. */
function roomyGate(dir) {
	return new SlotsGate({
		dir,
		reserveBytes: GIB,
		probe: async () => ({ availableBytes: 32 * GIB, totalBytes: 64 * GIB, commitAvailableBytes: 64 * GIB }),
		processTable: async () => [{ pid: process.pid, ppid: 1, workingSetBytes: GIB, startedAtMs: 1234 }],
		uptimeSec: () => 100_000,
		sleep: async () => {},
	});
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

const heldInTodo = {
	async call(name, args) {
		// Track holds the status change, so the job ends before any engine runs.
		if (name === "get_issue") return { key: args.key, statusName: "Todo", status: "todo" };
		return {};
	},
};

test("the runner records each job's routing advice with its claim and changes nothing else", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-routing-"));
	const gate = roomyGate(join(tmp, "slots"));
	const messages = [];
	const runner = new Runner(runnerConfig(tmp), { track: heldInTodo, log: (message) => messages.push(message), slots: gate });
	const base = { inProgressStatus: "In Progress", engine: { command: ["codex"] }, checks: [] };
	await runner.run({ teamKey: "ENG", team: { ...base, routing: { source: "public", needs: [] } }, detail: { key: "ENG-1", title: "t" } });
	await runner.run({ teamKey: "ENG", team: { ...base, routing: { source: "private", needs: [] } }, detail: { key: "ENG-2", title: "t" } });
	await runner.run({ teamKey: "ENG", team: base, detail: { key: "ENG-3", title: "t" } });

	const ended = (await readFile(join(tmp, "slots", "history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(
		ended.map((entry) => [entry.task, entry.route.advice, entry.dockerCloudEligible, entry.endedHow]),
		[
			["ENG-1", "cloud", true, "clean"],
			["ENG-2", "local", false, "clean"],
			["ENG-3", "local", false, "clean"],
		],
	);
	assert.deepEqual(ended[1].route.reasons, ["its source is private"]);
	assert.ok(messages.includes("ENG-1: routing advice Docker Cloud (public source, and it needs no secrets, host services or person); advise only, it runs here"));
	assert.ok(messages.some((message) => /^ENG-1: status did not move/.test(message)), "a cloud-advised job still runs here");
});

test("a dry run logs the advice without touching the gate", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-routing-"));
	const messages = [];
	const slots = {
		ownProcess: async () => assert.fail("a dry run asks the gate nothing"),
		acquire: async () => assert.fail("a dry run claims no slot"),
	};
	const runner = new Runner(runnerConfig(tmp), { track: heldInTodo, log: (message) => messages.push(message), dryRun: true, slots });
	await runner.run({
		teamKey: "ENG",
		team: { inProgressStatus: "In Progress", engine: { command: ["codex"] }, routing: { source: "public", needs: [] } },
		detail: { key: "ENG-1", title: "t" },
	});
	assert.ok(messages.some((message) => message.startsWith("ENG-1: routing advice Docker Cloud")));
});
