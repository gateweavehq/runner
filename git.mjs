// The git operations the runner needs, kept in one place so the worktree rules are testable.
// The runner pushes and opens pull requests with the repository's own configured identity (git and
// gh on this machine); it never sets one itself.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(repo, args, { timeout = 120_000, maxBuffer = 1024 * 1024, env } = {}) {
	const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { timeout, maxBuffer, env });
	return stdout;
}

/** Git can stage or publish container changes without invoking configured host hooks or filters. */
export async function containerGitEnv(repo, env) {
	const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/^git_/i.test(name)));
	const names = await git(repo, ["config", "--includes", "--name-only", "--list", "-z"], { env: clean });
	// Git for Windows treats a child of the NUL device as an invalid path.
	const overrides = new Map([
		["core.hooksPath", process.platform === "win32" ? "NUL" : "/dev/null"],
		["core.fsmonitor", "false"],
	]);
	for (const name of names.split("\0")) {
		const filter = /^filter\..+\.(clean|smudge|process|required)$/i.exec(name);
		if (filter) overrides.set(name, filter[1].toLowerCase() === "required" ? "false" : "");
	}
	clean.GIT_CONFIG_COUNT = String(overrides.size);
	let index = 0;
	for (const [name, value] of overrides) {
		clean[`GIT_CONFIG_KEY_${index}`] = name;
		clean[`GIT_CONFIG_VALUE_${index}`] = value;
		index++;
	}
	return clean;
}

/**
 * Adds a worktree for an issue. The branch is `branch`, started from `startPoint` (for example
 * `origin/main`). A branch left by an earlier run — a push that failed after the commits were
 * made — is reused as it is, so its commits are preserved and the engine continues from them;
 * `git worktree add -b` would fail on the name and lose the retry.
 * Returns "created" or "reused".
 */
export async function ensureWorktree(repo, dir, branch, startPoint, options) {
	const checkout = options?.noCheckout ? ["--no-checkout"] : [];
	let exists = true;
	try {
		await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], options);
	} catch {
		exists = false;
	}
	if (exists) {
		await git(repo, ["worktree", "add", ...checkout, dir, branch], options);
		return "reused";
	}
	await git(repo, ["worktree", "add", ...checkout, "-b", branch, dir, startPoint], options);
	return "created";
}

export async function removeWorktree(repo, dir, options) {
	await git(repo, ["worktree", "remove", "--force", dir], { timeout: 60_000, ...options });
}
