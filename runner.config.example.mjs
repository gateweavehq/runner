// Example configuration for the local runner. Copy to runner.config.mjs (git-ignored by
// convention: it names your machines and repositories) and fill in. The Track key itself is NEVER
// in this file: it is read from the environment variable `keyEnv` names.

import { homedir } from "node:os";
import { join } from "node:path";

const codexProfile = join(homedir(), ".codex-runner");
const windowsSandbox = process.platform === "win32" ? ["-c", "windows.sandbox=mxc"] : [];

export default {
	track: {
		// Track's address, without /mcp.
		url: "https://track.gateweave.com",
		// The environment variable holding this agent member's key (made in Track's workspace
		// settings, Agents page). On Windows the runner reads it from the environment it was
		// started with; keep it out of every shell profile that engines inherit.
		keyEnv: "GATEWEAVE_TRACK_RUNNER_KEY",
	},
	workspace: "gateweave",

	// Where state and logs live.
	stateDir: "~/.gateweave-runner",
	logDir: "~/.gateweave-runner/logs",
	// Create this empty file to pause the runner; remove it to resume.
	pauseFile: "~/.gateweave-runner/PAUSE",
	worktreesDir: "~/gateweave-runner-worktrees",

	pollSeconds: 60,
	dailyLimit: 5,
	branchPrefix: "runner",

	// The admission gate: one lock for every local launcher, heavy/light classes,
	// admission by measured memory. `advise` admits as today and only logs what enforce would
	// have decided; switch to `enforce` only after a pilot (>=20 launches
	// or one week with no reap among would-be-admitted). The same directory serves the hand
	// launcher's slots-cli.mjs, so hand jobs and runner jobs share the one lock. The reserve is
	// what available memory must keep after a job's measured peak (see the README).
	slots: {
		dir: "~/.codex-jobs/.slots",
		mode: "advise", // "advise" | "enforce"
		maxHeavy: 1,
		reserveGib: 2,
	},

	teams: {
		ENG: {
			// The label a person puts on an issue the runner may take. Only issues a workspace
			// owner or admin wrote AND that carry this label are taken.
			label: "local-runner",
			repo: "~/repos/app",
			base: "main",
			// Optional scoped reporting. Require a Track-registered work request for this exact repository.
			// workRunRepository: "acme/app",
			// Optional. Continue newly opened pull requests after a verified GitHub review.
			// reviewRepository: "acme/app",
			// The engine, as argv. "{prompt}" is replaced by the issue's prompt, as ONE argument.
			engine: {
				command: [
					"codex", ...windowsSandbox, "-a", "never", "exec", "--sandbox", "workspace-write",
					"--ignore-user-config", "--ephemeral", "{prompt}",
				],
			},
			engineTimeoutMinutes: 45,
			// The engine runs setup inside its sandbox before editing.
			setup: ["pnpm install --frozen-lockfile"],
			// The repository's checks. The engine runs them inside its own sandbox as the last step
			// of its session and reports each as a RUNNER-CHECK line; the runner never executes
			// engine-modified code itself. Results go in the pull request's body.
			checks: [
				{ name: "check", command: "pnpm check" },
				{ name: "typecheck", command: "pnpm typecheck" },
			],
			// What crosses into the engine's environment. `pass` copies names from the
			// runner's own environment; `set` writes literal values. Credentials never: the
			// configuration refuses GH_TOKEN, GATEWEAVE_*, CLOUDFLARE_*, AWS_* and friends.
			env: { pass: ["PNPM_HOME"], set: { CODEX_HOME: codexProfile } },
			// worktree uses the engine's own sandbox. For an offline engine, container mode uses
			// container: { image: "your-offline-engine:version" } and takes no team env settings.
			// Both modes take only issues an owner or admin wrote and labelled.
			isolation: "worktree",
			untrusted: false,
			// Optional: what the repository needs. The runner records where a job would
			// run and still runs it here. source is "public" or "private"; needs lists any of
			// "secrets", "host-services" and "interactive". Without it, the job stays local.
			// routing: { source: "private", needs: [] },
		},
		// A team whose engine runs in a Docker Cloud sandbox. It takes
		// only work an admin registered for the cloud, needs public source with no needs, and has
		// no engine or env: Codex runs in the sandbox, and the runner pushes from here.
		// CLOUD: {
		// 	repo: "~/projects/site",
		// 	label: "local-runner",
		// 	workRunRepository: "acme/site",
		// 	isolation: "cloud",
		// 	routing: { source: "public", needs: [] },
		// 	cloud: { cpus: 4, memory: "8g", model: "gpt-6.2-sol", effort: "medium" },
		// 	engineTimeoutMinutes: 30,
		// 	checks: [{ name: "test", command: "npm test" }],
		// },
	},
};
