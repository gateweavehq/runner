// The Docker Cloud engine. A team with `isolation: "cloud"` runs its engine in a
// Docker Agentic Platform cloud sandbox (`sbx --cloud`), using the Codex sign-in that
// the sandbox's `codex` kit carries. The runner keeps every credential on this host: the
// worktree goes up as a tarball, a patch comes back, and the runner itself commits, pushes,
// opens the pull request and reports to Track. Neither the Track key nor the report token, nor
// a GitHub token, ever enters the sandbox.
//
// The sandbox is made before the issue moves on the board. When Docker Cloud cannot make one, the
// attempt waits with that reason and the job is never run on this host instead. The
// sandbox is removed however the job ends; a runner that dies leaves it to its TTL.
// Node 24, no dependencies.

import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const JOB = "/home/agent/work/job";
const REPO = "/home/agent/work/repo";
const DEFAULT_HOSTS = ["registry.npmjs.org", "nodejs.org"];
// How long Docker keeps a new cloud sandbox before `sbx --cloud ttl` extends it.
const SANDBOX_TTL_MS = 60 * 60_000;

export const CLOUD_DEFAULTS = {
	cpus: 4,
	memory: "8g",
	model: "gpt-6.2-sol",
	effort: "medium",
	nodeVersion: "v24.22.3",
	allow: [],
	pollSeconds: 60,
};

/** Docker Cloud could not take the job: it waits, and nothing runs on this host instead. */
export class CloudUnavailableError extends Error {
	constructor(message, { budget = false } = {}) {
		super(message);
		this.budget = budget;
	}
}

/** `sbx` as a function of its arguments, so tests never reach Docker. */
export function sbxCli(executable = process.env.SBX || "sbx") {
	return async (args, { timeoutMs = 5 * 60_000 } = {}) => {
		const { stdout } = await execFileAsync(executable, ["--cloud", ...args], {
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
		});
		return stdout;
	};
}

/** A sandbox name sbx accepts and a person can trace back: the issue key and a short nonce. */
export function sandboxName(key, nonce) {
	return `gw-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${nonce.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
}

/** The job's script inside the sandbox. The prompt arrives as a file, never on a command line. */
export function jobScript({ nodeVersion, model, effort }) {
	return [
		"set -u",
		`exec > ${JOB}/run.log 2>&1`,
		`V=${nodeVersion}`,
		"mkdir -p $HOME/.local/node $HOME/.local/bin",
		"curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.gz | tar -xz -C $HOME/.local/node --strip-components=1",
		"for b in node npm npx corepack; do ln -sf $HOME/.local/node/bin/$b $HOME/.local/bin/$b; done",
		"export PATH=$HOME/.local/node/bin:$HOME/.local/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1",
		`mkdir -p ${REPO} && tar -xzf ${JOB}/repo.tgz -C ${REPO} && cd ${REPO}`,
		`git init -q && git config user.email job@sandbox && git config user.name job && git add -A && git commit -qm base && git rev-parse HEAD > ${JOB}/base`,
		`codex exec -m ${model} -c model_reasoning_effort=${effort} --dangerously-bypass-approvals-and-sandbox -C ${REPO} - < ${JOB}/prompt.md > ${JOB}/codex.log 2>&1`,
		`echo $? > ${JOB}/exit`,
		`git add -A && git diff --cached --binary $(cat ${JOB}/base) > ${JOB}/out.patch`,
		`echo done > ${JOB}/DONE`,
		"",
	].join("\n");
}

/** Every tracked and untracked-but-not-ignored file of the worktree, as a gzipped tarball. */
export async function packWorktree(worktree, archive) {
	const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
		cwd: worktree,
		maxBuffer: 64 * 1024 * 1024,
		encoding: "buffer",
	});
	// Relative names on stdin and the archive on stdout behave the same in GNU tar and bsdtar.
	const tar = spawn("tar", ["--null", "-czf", "-", "-T", "-"], { cwd: worktree, windowsHide: true });
	const out = createWriteStream(archive);
	let stderr = "";
	tar.stderr.on("data", (text) => {
		stderr += text;
	});
	// Either side may finish first, so wait for both: the exit code, and the file fully written.
	const exited = new Promise((resolvePromise, reject) => {
		tar.on("error", reject);
		tar.on("close", resolvePromise);
	});
	const written = new Promise((resolvePromise, reject) => {
		out.on("error", reject);
		out.on("close", resolvePromise);
	});
	// A tar that fails early closes its stdin; its exit code says why.
	tar.stdin.on("error", () => {});
	tar.stdout.pipe(out);
	tar.stdin.end(stdout);
	const [code] = await Promise.all([exited, written]);
	if (code !== 0) throw new Error(`tar failed: ${stderr.trim().slice(0, 300)}`);
}

const BUDGET_WORDS = /\b(credit|credits|billing|balance|quota|payment|insufficient)\b/i;

/**
 * Makes the sandbox the job will run in. Called before the issue moves on the board, so a refusal
 * leaves nothing to undo. Returns the handle the engine run and the cleanup use.
 */
export async function prepareCloud({ key, nonce, settings, sbx = sbxCli(), jobRoot, log = () => {} }) {
	const cloud = { ...CLOUD_DEFAULTS, ...settings };
	const name = sandboxName(key, nonce);
	const hosts = [...new Set([...DEFAULT_HOSTS, ...cloud.allow])];
	// Made first, so a local failure never leaves a sandbox behind.
	const dir = join(jobRoot, name);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		await sbx([
			"create", "--name", name, "--cpus", String(cloud.cpus), "--memory", cloud.memory, "--platform", "linux/amd64",
			...hosts.flatMap((host) => ["--allow-network", host]), "codex",
		]);
	} catch (error) {
		const said = `${error.stderr ?? ""} ${error.stdout ?? ""} ${error.message ?? ""}`;
		// Only the gist goes to Track; sbx's own words stay in the local log.
		log(`${key}: Docker Cloud could not make sandbox ${name}: ${said.trim().slice(0, 500)}`);
		// A create that failed halfway must not keep the name a later try needs, and a retry makes
		// its own job directory, so this one goes too.
		await sbx(["rm", "--force", name]).catch(() => {});
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw new CloudUnavailableError(
			BUDGET_WORDS.test(said) ? "Docker Cloud has no credit left for a sandbox" : "Docker Cloud could not start a sandbox",
			{ budget: BUDGET_WORDS.test(said) },
		);
	}
	return {
		name,
		dir,
		settings: cloud,
		async remove() {
			try {
				await sbx(["rm", "--force", name]);
			} catch (error) {
				log(`${key}: could not remove Docker Cloud sandbox ${name}; remove it by hand (sbx --cloud rm ${name}): ${error.message}`);
			}
		},
	};
}

/**
 * Runs the engine's prompt in the prepared sandbox and brings its changes back into the worktree.
 * Answers like a local engine run: { code, stdout, stderr, timedOut }, where stdout is Codex's
 * output, so the runner reads RUNNER-SETUP and RUNNER-CHECK lines as it does for a local run.
 */
export async function runCloudEngine({
	key, sandbox, worktree, prompt, timeoutMs, sbx = sbxCli(), onStdoutLine, log = () => {},
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
}) {
	const { name, dir, settings } = sandbox;
	// A new sandbox lives an hour. One that must outlast the engine's timeout, with room to fetch
	// its results, is extended first; Docker caps a sandbox at a day.
	const extraMinutes = Math.min(Math.ceil((timeoutMs + 15 * 60_000 - SANDBOX_TTL_MS) / 60_000), 22 * 60);
	if (extraMinutes > 0) {
		await sbx(["ttl", `+${extraMinutes}m`, name]).catch((error) =>
			log(`${key}: could not extend sandbox ${name} by ${extraMinutes} min; it may expire first: ${error.message}`));
	}
	const archive = join(dir, "repo.tgz");
	await packWorktree(worktree, archive);
	await writeFile(join(dir, "prompt.md"), prompt);
	await writeFile(join(dir, "run.sh"), jobScript(settings));
	await sbx(["exec", name, "mkdir", "-p", JOB]);
	for (const file of ["repo.tgz", "prompt.md", "run.sh"]) await sbx(["cp", join(dir, file), `${name}:${JOB}/${file}`]);
	await sbx(["exec", name, "sh", "-c", `nohup setsid sh ${JOB}/run.sh > /dev/null 2>&1 < /dev/null & echo started`]);
	log(`${key}: running in Docker Cloud sandbox ${name}`);

	const deadline = now() + timeoutMs;
	let finished = false;
	while (now() < deadline) {
		await sleep(settings.pollSeconds * 1000);
		finished = await sbx(["exec", name, "test", "-f", `${JOB}/DONE`]).then(() => true, () => false);
		if (finished) break;
	}
	const fetched = {};
	for (const file of ["codex.log", "exit", "out.patch", "run.log"]) {
		await rm(join(dir, file), { force: true });
		fetched[file] = await sbx(["cp", `${name}:${JOB}/${file}`, join(dir, file)])
			.then(() => readFile(join(dir, file), "utf8"), () => null);
	}
	const stdout = fetched["codex.log"] ?? "";
	for (const line of stdout.split(/\r?\n/)) onStdoutLine?.(line);
	if (!finished) return { code: null, stdout, stderr: fetched["run.log"] ?? "", timedOut: true };
	const patch = join(dir, "out.patch");
	if (fetched["out.patch"] && (await stat(patch)).size > 0) {
		await execFileAsync("git", ["apply", "--whitespace=nowarn", patch], { cwd: worktree });
	}
	const code = Number.parseInt(fetched.exit ?? "", 10);
	return { code: Number.isSafeInteger(code) ? code : null, stdout, stderr: fetched["run.log"] ?? "", timedOut: false };
}

