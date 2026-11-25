// The engine sees a disposable source checkout. The runner imports a checked Git patch
// only after the container has stopped, keeping host repository metadata and credentials outside.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { buildEnv } from "./env.mjs";
import { containerGitEnv, git } from "./git.mjs";
import { startContainerRelay } from "./model-relay.mjs";
import { createPackageHandler } from "./package-policy.mjs";
import { runProcess } from "./process.mjs";

const exec = promisify(execFile);
const windows = process.platform === "win32";
const dockerTimeout = 30_000;
const gitProtection = ["-c", "core.protectNTFS=true", "-c", "core.protectHFS=true", "-c", "core.fsmonitor=false"];

function inside(root, path) {
	const suffix = relative(root, path);
	return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
}

async function inspectSource(root, dir, skipDirectory) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		const normalized = entry.name.toLowerCase().replace(/[ .]+$/, "");
		if (normalized === ".git" || (windows && entry.name.includes(":"))) {
			throw new Error(`container returned an unsafe checkout path: ${relative(root, path)}`);
		}
		if (entry.isSymbolicLink()) {
			const target = await readlink(path);
			const resolved = await realpath(path).catch(() => null);
			if (windows || isAbsolute(target) || !inside(root, resolve(dirname(path), target))
				|| !resolved || !inside(root, resolved)) {
				throw new Error(`container returned an unsafe symlink: ${relative(root, path)}`);
			}
		} else if (entry.isDirectory()) {
			if (!(await skipDirectory?.(path))) await inspectSource(root, path, skipDirectory);
		} else if (!entry.isFile()) {
			throw new Error(`container returned an unsupported file type: ${relative(root, path)}`);
		}
	}
}

async function ignoredDependencyDirectories(checkout, snapshot, env) {
	const tracked = await git(checkout, [...snapshot, "ls-files", "-z"], { env });
	const trackedDirectories = new Set();
	for (const path of tracked.split("\0")) {
		const parts = (windows ? path.toLowerCase() : path).split("/");
		for (let index = 0; index < parts.length - 1; index++) {
			if (parts[index] === "node_modules") trackedDirectories.add(parts.slice(0, index + 1).join("/"));
		}
	}
	return async (path) => {
		const name = relative(checkout, path).split(sep).join("/");
		const lookup = windows ? name.toLowerCase() : name;
		if (lookup.split("/").at(-1) !== "node_modules" || trackedDirectories.has(lookup)) return false;
		if (!inside(checkout, await realpath(path))) throw new Error("container returned an unsafe dependency directory");
		try {
			await git(checkout, [...snapshot, "check-ignore", "--quiet", "--", name + "/"], { env });
			return true;
		} catch (error) {
			if (error.code === 1) return false;
			throw error;
		}
	};
}

async function assertClean(cwd, head, env) {
	if ((await git(cwd, [...gitProtection, "status", "--porcelain", "--untracked-files=all"], { env })).trim()) {
		throw new Error("container execution requires a clean host worktree");
	}
	if ((await git(cwd, ["rev-parse", "HEAD"], { env })).trim() !== head) {
		throw new Error("the host worktree HEAD changed during container execution");
	}
}

async function localDocker(cwd) {
	const env = buildEnv();
	const { stdout: contextOutput } = await exec("docker", ["context", "show"], { cwd, env, timeout: dockerTimeout });
	const context = contextOutput.trim();
	if (!context) throw new Error("Docker did not report an active context");
	const { stdout } = await exec(
		"docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "--", context],
		{ cwd, env, timeout: dockerTimeout },
	);
	const endpoint = stdout.trim();
	if (!endpoint.startsWith("unix:///") && !/^npipe:\/\/\/\/\.\/pipe\//i.test(endpoint)) {
		throw new Error("container execution requires a local Docker Unix socket or named pipe");
	}
	const argv = ["docker", "--context", context];
	return {
		argv,
		env,
		async call(args) {
			return exec(argv[0], [...argv.slice(1), ...args], { cwd, env, timeout: dockerTimeout });
		},
	};
}

async function discardContainer(docker, name) {
	try {
		await docker.call(["rm", "-f", "-v", "--", name]);
	} catch (error) {
		if (!String(error.stderr ?? "").includes(`No such container: ${name}`)) throw error;
	}
}

/** Run a locally installed image with only committed source and no host credentials. */
export async function runContainerEngine({
	cwd, argv, image, timeoutMs, log, validateOutcome, gitEnv, model, packages, onStdoutLine,
}) {
	const uid = windows ? 65_532 : process.getuid();
	const gid = windows ? 65_532 : process.getgid();
	if (uid === 0) throw new Error("container execution requires a non-root host user on POSIX");

	const worktree = await realpath(cwd);
	const hostEnv = gitEnv ?? await containerGitEnv(worktree, buildEnv());
	const head = (await git(worktree, ["rev-parse", "HEAD"], { env: hostEnv })).trim();
	await assertClean(worktree, head, hostEnv);
	let packageOptions;
	if (packages) {
		const lockfile = packages.kind === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
		const entry = await git(worktree, ["ls-tree", head, "--", lockfile], { env: hostEnv });
		if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) {
			throw new Error(`package relay requires a committed ${lockfile} file at the repository root`);
		}
		const lockText = await git(worktree, ["show", `${head}:${lockfile}`], {
			env: hostEnv, maxBuffer: 8 * 1024 * 1024,
		});
		packageOptions = { ...packages, lockText };
	}
	const docker = await localDocker(worktree);
	const { stdout: imageInfo } = await docker.call([
		"image", "inspect", "--format", '{{.Id}} {{if index .Config "Volumes"}}volumes{{else}}no-volumes{{end}}',
		"--", image,
	]);
	const [imageId, volumeMode] = imageInfo.trim().split(" ");
	if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || volumeMode !== "no-volumes") {
		throw new Error("container execution requires a local image without declared volumes");
	}
	const root = await mkdtemp(join(await realpath(tmpdir()), "gateweave-container-"));
	const checkout = join(root, "source");
	const metadata = join(root, "git");
	const patch = join(root, "changes.patch");
	const emptyConfig = join(root, "empty-config");
	const name = "gateweave-runner-" + randomUUID();
	const user = `${uid}:${gid}`;
	let relay;
	let containerPending = false;
	try {
		let packageHandler;
		if (packageOptions) {
			const storageDir = join(root, "packages");
			await mkdir(storageDir);
			packageHandler = await createPackageHandler({ ...packageOptions, storageDir });
		}
		await writeFile(emptyConfig, "");
		const snapshotEnv = {
			...buildEnv(),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: emptyConfig,
			GIT_ATTR_NOSYSTEM: "1",
		};
		await git(root, [
			...gitProtection, "-c", "core.autocrlf=false", "clone", "--no-checkout", "--no-hardlinks",
			"--no-recurse-submodules", "--separate-git-dir", metadata, "--", worktree, checkout,
		], { env: snapshotEnv });
		await unlink(join(checkout, ".git"));
		const snapshot = [
			...gitProtection, "-c", "core.autocrlf=false", "-c", `core.attributesFile=${emptyConfig}`,
			"--git-dir", metadata, "--work-tree", checkout,
		];
		await git(checkout, [...snapshot, "read-tree", "--reset", "-u", head], { env: snapshotEnv });

		// --mount uses CSV syntax. Quote the complete source field so commas in user paths work.
		const mount = `type=bind,"source=${checkout.replaceAll('"', '""')}",target=/workspace`;
		if (model || packageHandler) {
			relay = await startContainerRelay({
				docker, cwd: worktree, root, name, user, model, packageHandler, packageKind: packages?.kind, log,
			});
		}
		containerPending = true;
		await docker.call([
			"create", "--name", name, "--pull", "never", "--network", relay?.network ?? "none", "--read-only",
			"--no-healthcheck", "--ipc", "none",
			"--user", user, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
			"--pids-limit", "256", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
			"--mount", mount, "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
			"--env", "CODEX_HOME=/tmp", ...(relay ? ["--log-driver", "none", ...relay.engineArgs] : []),
			"--entrypoint", argv[0], "--", imageId, ...argv.slice(1),
		]);
		const outcome = await runProcess({
			argv: [...docker.argv, "start", "--attach", "--", name],
			cwd: worktree, env: docker.env, timeoutMs, onStdoutLine,
		});
		await discardContainer(docker, name);
		containerPending = false;
		if (relay) {
			outcome.stdout = relay.redact(outcome.stdout);
			outcome.stderr = relay.redact(outcome.stderr);
			if (outcome.code === 0 && !outcome.timedOut) relay.check();
		}
		if (outcome.code !== 0 || outcome.timedOut) return outcome;
		await validateOutcome?.(outcome);

		if (!(await lstat(checkout)).isDirectory()) throw new Error("container replaced the checkout root");
		// Frozen installs can create links inside wholly ignored dependency trees. Git does not stage them.
		const skipDirectory = packages ? await ignoredDependencyDirectories(checkout, snapshot, snapshotEnv) : undefined;
		await inspectSource(checkout, checkout, skipDirectory);
		await git(checkout, [...snapshot, "add", "-A"], { env: snapshotEnv });
		if (windows) {
			// Git for Windows can store a tracked symlink as a normal file on disk.
			const staged = await git(checkout, [
				...snapshot, "diff", "--cached", "--raw", "--no-renames", "--diff-filter=AMT", head, "--",
			], { env: snapshotEnv });
			if (/^:[0-9]+ 120000 /m.test(staged)) {
				throw new Error("container returned a changed symlink on Windows");
			}
		}
		await git(checkout, [
			...snapshot, "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
			`--output=${patch}`, head, "--",
		], { env: snapshotEnv });
		await assertClean(worktree, head, hostEnv);
		if ((await stat(patch)).size > 0) {
			await git(worktree, [...gitProtection, "apply", "--check", "--index", "--", patch], { env: hostEnv });
			await git(worktree, [...gitProtection, "apply", "--index", "--", patch], { env: hostEnv });
		}
		return outcome;
	} catch (error) {
		if (!relay) throw error;
		throw new Error(relay.redact(String(error.stderr || error.message)));
	} finally {
		if (containerPending) {
			await discardContainer(docker, name).catch((error) => {
				log(`could not remove Docker container ${name}: ${error.message}`);
			});
		}
		await relay?.close();
		await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
			const reason = relay ? relay.redact(error.message) : error.message;
			log(`could not remove container checkout ${root}: ${reason}`);
		});
	}
}
