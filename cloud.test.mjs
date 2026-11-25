import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CloudUnavailableError, jobScript, packWorktree, prepareCloud, runCloudEngine, sandboxName, CLOUD_DEFAULTS } from "./cloud.mjs";
import { validateConfig } from "./config.mjs";

const exec = promisify(execFile);
const JOB = "/home/agent/work/job";

async function repo(t) {
	const root = await mkdtemp(join(tmpdir(), "cloud-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const worktree = join(root, "wt");
	await mkdir(worktree);
	const git = (...args) => exec("git", args, { cwd: worktree });
	await git("init", "-q", "-b", "main");
	await git("config", "core.autocrlf", "false");
	await writeFile(join(worktree, "a.txt"), "one\n");
	await writeFile(join(worktree, ".gitignore"), "secret.env\n");
	await writeFile(join(worktree, "secret.env"), "TOKEN=gwt_never\n");
	await git("add", "a.txt", ".gitignore");
	await git("-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-qm", "base");
	// The patch the sandbox would hand back: one edit and one new file.
	const other = join(root, "other");
	await exec("git", ["clone", "-q", worktree, other]);
	await writeFile(join(other, "a.txt"), "two\n");
	await writeFile(join(other, "b.txt"), "new\n");
	await exec("git", ["add", "-A"], { cwd: other });
	const { stdout: patch } = await exec("git", ["diff", "--cached", "--binary"], { cwd: other });
	return { root, worktree, patch };
}

/** sbx as a fake: a sandbox is a directory, and every call is recorded. */
function fakeSbx(root, { done = true, files = {}, createError = null } = {}) {
	const box = join(root, "box");
	const calls = [];
	const sbx = async (args) => {
		calls.push(args);
		const [command] = args;
		if (command === "create") {
			if (createError) throw createError;
			await mkdir(box, { recursive: true });
			return "";
		}
		if (command === "exec" && args[2] === "test") {
			if (!done) throw new Error("not yet");
			return "";
		}
		if (command === "cp") {
			const [, from, to] = args;
			if (to.includes(`:${JOB}/`)) return copyFile(from, join(box, to.split("/").at(-1)));
			const name = from.split("/").at(-1);
			if (!(name in files)) throw new Error("no such file");
			return writeFile(to, files[name]);
		}
		return "";
	};
	return { sbx, calls, box };
}

test("a cloud run sends the worktree, never an ignored secret, and brings its patch back", async (t) => {
	const { root, worktree, patch } = await repo(t);
	const log = "working\nRUNNER-CHECK: test = pass\n";
	const fake = fakeSbx(root, { files: { "codex.log": log, exit: "0\n", "out.patch": patch, "run.log": "ok\n" } });
	const sandbox = await prepareCloud({ key: "ENG-1", nonce: "0f3c9a1e-aaaa", settings: {}, sbx: fake.sbx, jobRoot: join(root, "jobs") });
	assert.equal(sandbox.name, "gw-eng-1-0f3c9a1e");
	const create = fake.calls[0];
	assert.deepEqual(create.slice(0, 7), ["create", "--name", "gw-eng-1-0f3c9a1e", "--cpus", "4", "--memory", "8g"]);
	assert.equal(create.at(-1), "codex");
	assert.deepEqual(create.filter((_, i) => create[i - 1] === "--allow-network"), ["registry.npmjs.org", "nodejs.org"]);

	const lines = [];
	const result = await runCloudEngine({
		key: "ENG-1", sandbox, worktree, prompt: "Do the thing", timeoutMs: 60_000, sbx: fake.sbx,
		onStdoutLine: (line) => lines.push(line), sleep: async () => {},
	});
	assert.deepEqual(result, { code: 0, stdout: log, stderr: "ok\n", timedOut: false });
	assert.ok(lines.includes("RUNNER-CHECK: test = pass"));
	assert.equal(await readFile(join(worktree, "a.txt"), "utf8"), "two\n");
	assert.equal(await readFile(join(worktree, "b.txt"), "utf8"), "new\n");

	// Exactly the tarball, the prompt and the script go up, and none of them carries a credential.
	const uploads = fake.calls.filter(([command, , to]) => command === "cp" && to.includes(`:${JOB}/`));
	assert.deepEqual(uploads.map(([, , to]) => to.split("/").at(-1)), ["repo.tgz", "prompt.md", "run.sh"]);
	// A relative name: GNU tar reads "C:" in an absolute Windows path as a remote host.
	const { stdout: listing } = await exec("tar", ["-tzf", "repo.tgz"], { cwd: fake.box });
	assert.deepEqual(listing.trim().split(/\r?\n/).sort(), [".gitignore", "a.txt"]);
	assert.equal(await readFile(join(fake.box, "prompt.md"), "utf8"), "Do the thing");
	assert.doesNotMatch(await readFile(join(fake.box, "run.sh"), "utf8"), /gwt_|gwh_|GITHUB_TOKEN|GATEWEAVE/);

	await sandbox.remove();
	assert.deepEqual(fake.calls.at(-1), ["rm", "--force", "gw-eng-1-0f3c9a1e"]);
});

test("a sandbox that never finishes is a timeout, and nothing comes back into the worktree", async (t) => {
	const { root, worktree, patch } = await repo(t);
	const fake = fakeSbx(root, { done: false, files: { "codex.log": "partial\n", "out.patch": patch } });
	const sandbox = await prepareCloud({ key: "ENG-2", nonce: "abcdef12", settings: { pollSeconds: 30 }, sbx: fake.sbx, jobRoot: join(root, "jobs") });
	let clock = 0;
	const result = await runCloudEngine({
		key: "ENG-2", sandbox, worktree, prompt: "p", timeoutMs: 90_000, sbx: fake.sbx,
		sleep: async (ms) => { clock += ms; }, now: () => clock,
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.code, null);
	assert.equal(fake.calls.filter(([command, , what]) => command === "exec" && what === "test").length, 3);
	assert.equal(await readFile(join(worktree, "a.txt"), "utf8"), "one\n");
});

test("Docker Cloud's refusal names the reason, and leaves no sandbox behind", async (t) => {
	const { root } = await repo(t);
	const refused = Object.assign(new Error("exit status 1"), { stderr: "Error: insufficient credits on the account" });
	const broke = fakeSbx(root, { createError: refused });
	const error = await prepareCloud({ key: "ENG-3", nonce: "11111111", settings: {}, sbx: broke.sbx, jobRoot: join(root, "jobs") })
		.catch((caught) => caught);
	assert.ok(error instanceof CloudUnavailableError);
	assert.equal(error.budget, true);
	assert.equal(error.message, "Docker Cloud has no credit left for a sandbox");
	assert.deepEqual(broke.calls.at(-1), ["rm", "--force", "gw-eng-3-11111111"]);
	// Nor an empty job directory on this host: the retry gets a new sandbox and a new directory.
	await assert.rejects(stat(join(root, "jobs", "gw-eng-3-11111111")), { code: "ENOENT" });

	const down = fakeSbx(root, { createError: Object.assign(new Error("exit status 1"), { stderr: "connection reset" }) });
	const other = await prepareCloud({ key: "ENG-3", nonce: "22222222", settings: {}, sbx: down.sbx, jobRoot: join(root, "jobs") })
		.catch((caught) => caught);
	assert.equal(other.budget, false);
	assert.equal(other.message, "Docker Cloud could not start a sandbox");
});

test("the sandbox name and job script keep the issue traceable and the prompt off the command line", () => {
	assert.equal(sandboxName("ENG-12", "A1B2-C3D4-E5"), "gw-eng-12-a1b2c3d4");
	const script = jobScript(CLOUD_DEFAULTS);
	assert.match(script, /codex exec -m gpt-6\.2-sol -c model_reasoning_effort=medium .* - < \/home\/agent\/work\/job\/prompt\.md/);
	assert.match(script, /echo \$\? > \/home\/agent\/work\/job\/exit/);
});

test("a Docker Cloud team needs a scoped registration and routing that advises the cloud", () => {
	const config = (team) => ({
		track: { url: "https://t.example", keyEnv: "K" },
		workspace: "ws",
		teams: { CLOUD: { repo: "~/r", label: "go", isolation: "cloud", workRunRepository: "acme/pilot", routing: { source: "public" }, ...team } },
	});
	const valid = validateConfig(config({})).teams.CLOUD;
	assert.deepEqual(valid.cloud, CLOUD_DEFAULTS);
	assert.equal(validateConfig(config({ cloud: { cpus: 8, memory: "16g" } })).teams.CLOUD.cloud.cpus, 8);
	assert.throws(() => validateConfig(config({ workRunRepository: undefined })), /only with workRunRepository/);
	assert.throws(() => validateConfig(config({ routing: { source: "private" } })), /must advise Docker Cloud/);
	assert.throws(() => validateConfig(config({ routing: { source: "public", needs: ["secrets"] } })), /must advise Docker Cloud/);
	assert.throws(() => validateConfig(config({ routing: undefined })), /must advise Docker Cloud/);
	assert.throws(() => validateConfig(config({ env: { pass: ["HOME"] } })), /env\.pass or env\.set/);
	assert.throws(() => validateConfig(config({ engine: { command: ["codex", "{prompt}"] } })), /engine does not apply/);
	assert.throws(() => validateConfig(config({ cloud: { gpu: true } })), /does not take gpu/);
	assert.throws(() => validateConfig(config({ cloud: { memory: "8GB" } })), /cloud\.memory/);
	assert.throws(() => validateConfig(config({ cloud: { allow: ["https://evil.example"] } })), /cloud\.allow/);
	assert.throws(() => validateConfig(config({ isolation: "worktree", engine: { command: ["codex", "{prompt}"] }, cloud: {} })),
		/applies only with isolation "cloud"/);
});

test("a sandbox that must outlast its first hour is extended to the engine's timeout", async (t) => {
	const { root, worktree, patch } = await repo(t);
	const files = { "codex.log": "", exit: "0", "out.patch": patch };
	const short = fakeSbx(root, { files });
	const quick = await prepareCloud({ key: "ENG-4", nonce: "aaaa0001", settings: {}, sbx: short.sbx, jobRoot: join(root, "jobs") });
	await runCloudEngine({ key: "ENG-4", sandbox: quick, worktree, prompt: "p", timeoutMs: 45 * 60_000, sbx: short.sbx, sleep: async () => {} });
	assert.equal(short.calls.some(([command]) => command === "ttl"), false);

	await exec("git", ["checkout", "--", "."], { cwd: worktree });
	await exec("git", ["clean", "-fdq"], { cwd: worktree });
	const long = fakeSbx(root, { files });
	const slow = await prepareCloud({ key: "ENG-5", nonce: "aaaa0002", settings: {}, sbx: long.sbx, jobRoot: join(root, "jobs") });
	await runCloudEngine({ key: "ENG-5", sandbox: slow, worktree, prompt: "p", timeoutMs: 120 * 60_000, sbx: long.sbx, sleep: async () => {} });
	assert.deepEqual(long.calls.find(([command]) => command === "ttl"), ["ttl", "+75m", "gw-eng-5-aaaa0002"]);
});

test("the worktree tarball is complete whether tar or the file finishes first", { timeout: 60_000 }, async (t) => {
	const { root, worktree } = await repo(t);
	// The archive's file used to be awaited only after tar exited, so a file that closed first hung the run.
	// Many at once, so a busy machine notices tar's exit after the file has closed.
	const names = Array.from({ length: 48 }, (_, i) => `pack-${i}.tgz`);
	await Promise.all(names.map((name) => packWorktree(worktree, join(root, name))));
	for (const name of names) {
		const { stdout } = await exec("tar", ["-tzf", name], { cwd: root });
		assert.deepEqual(stdout.trim().split(/\r?\n/).sort(), [".gitignore", "a.txt"]);
	}
});
