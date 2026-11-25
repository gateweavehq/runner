// Loads and checks the runner's configuration file. The file is an ES module whose default export
// is the configuration; see runner.config.example.mjs.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLOUD_DEFAULTS } from "./cloud.mjs";
import { adviseRoute, ROUTING_NEEDS, ROUTING_SOURCES } from "./routing.mjs";

export class ConfigError extends Error {}

const DEFAULTS = {
	pollSeconds: 60,
	dailyLimit: 5,
	worktreesDir: "~/gateweave-runner-worktrees",
	stateDir: "~/.gateweave-runner",
	logDir: "~/.gateweave-runner/logs",
	pauseFile: "~/.gateweave-runner/PAUSE",
	branchPrefix: "runner",
};

const TEAM_DEFAULTS = {
	base: "main",
	remote: "origin",
	pickupStatuses: ["Todo"],
	inProgressStatus: "In Progress",
	reviewStatus: "In Review",
	todoStatus: "Todo",
	setup: [],
	checks: [],
	env: { pass: [], set: {} },
	isolation: "worktree",
	untrusted: false,
	engineTimeoutMinutes: 45,
};

// Names the engine must never inherit, whatever the configuration's `env.pass` says.
// The runner's own Track key is forbidden by its configured env name as well.
const FORBIDDEN_EXACT = new Set([
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GITHUB_PAT",
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"KUBECONFIG",
	"DOCKER_HOST",
	"DOCKER_CONFIG",
	"DOCKER_TLS_VERIFY",
	"SSH_AUTH_SOCK",
	"NPM_TOKEN",
]);
const FORBIDDEN_PREFIXES = ["CLOUDFLARE_", "AWS_", "AZURE_", "GOOGLE_APPLICATION_CREDENTIALS"];

export function forbiddenEnvName(name, keyEnv) {
	const upper = name.toUpperCase();
	if (upper === keyEnv.toUpperCase()) return `the runner's own Track key (${name})`;
	if (FORBIDDEN_EXACT.has(upper)) return name;
	if (FORBIDDEN_PREFIXES.some((p) => upper.startsWith(p))) return name;
	if (upper.startsWith("GATEWEAVE_")) return name;
	return null;
}

// The admission gate's configuration; absent means the defaults in slots.mjs apply.
const SLOTS_DEFAULTS = {
	dir: "~/.codex-jobs/.slots",
	maxHeavy: 1,
	reserveGib: 2,
	mode: "advise",
};

export function expandHome(path) {
	if (typeof path !== "string" || !path) throw new ConfigError(`bad path: ${path}`);
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function validateSlots(raw) {
	if (raw === undefined || raw === null) return { ...SLOTS_DEFAULTS };
	if (typeof raw !== "object") throw new ConfigError("slots must be an object");
	const slots = { ...SLOTS_DEFAULTS, ...raw };
	if (!["advise", "enforce"].includes(slots.mode)) throw new ConfigError(`slots.mode must be "advise" or "enforce", not ${slots.mode}`);
	for (const name of ["maxHeavy", "reserveGib"]) {
		if (!Number.isFinite(slots[name]) || slots[name] <= 0) throw new ConfigError(`slots.${name} must be a positive number`);
	}
	slots.dir = expandHome(slots.dir);
	return slots;
}

// what a repository needs, from which the routing advice follows. Every field is
// spelled out: an unknown one is refused, so a misspelt need never makes a job look portable.
function validateRouting(key, raw) {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`teams.${key}.routing must be an object`);
	const { source, needs = [], ...unknown } = raw;
	const extra = Object.keys(unknown);
	if (extra.length) throw new ConfigError(`teams.${key}.routing does not take ${extra.join(", ")}`);
	if (!ROUTING_SOURCES.includes(source)) {
		throw new ConfigError(`teams.${key}.routing.source must be ${ROUTING_SOURCES.map((name) => `"${name}"`).join(" or ")}`);
	}
	if (!Array.isArray(needs) || needs.some((need) => !ROUTING_NEEDS.includes(need))) {
		throw new ConfigError(`teams.${key}.routing.needs may list only ${ROUTING_NEEDS.join(", ")}`);
	}
	return { source, needs: [...new Set(needs)] };
}

// a team whose engine runs in a Docker Cloud sandbox. It needs a scoped registration
// (only an admin's approval sends work to the cloud) and routing that advises the cloud, so
// private source, secrets or host-bound work can never be sent there by this setting alone.
function validateCloud(key, team) {
	if (!team.workRunRepository) throw new ConfigError(`teams.${key} runs in Docker Cloud only with workRunRepository set`);
	if (!adviseRoute(team.routing).cloudEligible) {
		throw new ConfigError(`teams.${key}.routing must advise Docker Cloud (public source, no needs) for isolation "cloud"`);
	}
	if ((team.env?.pass ?? []).length || Object.keys(team.env?.set ?? {}).length) {
		throw new ConfigError(`teams.${key} does not support env.pass or env.set in Docker Cloud`);
	}
	const raw = team.cloud ?? {};
	if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`teams.${key}.cloud must be an object`);
	const cloud = { ...CLOUD_DEFAULTS, ...raw };
	const unknown = Object.keys(raw).filter((name) => !(name in CLOUD_DEFAULTS));
	if (unknown.length) throw new ConfigError(`teams.${key}.cloud does not take ${unknown.join(", ")}`);
	if (!Number.isSafeInteger(cloud.cpus) || cloud.cpus < 1 || cloud.cpus > 16) {
		throw new ConfigError(`teams.${key}.cloud.cpus must be a whole number from 1 to 16`);
	}
	if (typeof cloud.memory !== "string" || !/^[1-9]\d{0,2}g$/.test(cloud.memory)) {
		throw new ConfigError(`teams.${key}.cloud.memory must be gigabytes, such as "8g"`);
	}
	if (typeof cloud.model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cloud.model)) {
		throw new ConfigError(`teams.${key}.cloud.model must name a Codex model`);
	}
	if (!["low", "medium", "high", "xhigh"].includes(cloud.effort)) {
		throw new ConfigError(`teams.${key}.cloud.effort must be low, medium, high or xhigh`);
	}
	if (typeof cloud.nodeVersion !== "string" || !/^v\d+\.\d+\.\d+$/.test(cloud.nodeVersion)) {
		throw new ConfigError(`teams.${key}.cloud.nodeVersion must be a Node release, such as "v24.22.3"`);
	}
	if (!Array.isArray(cloud.allow) || cloud.allow.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))) {
		throw new ConfigError(`teams.${key}.cloud.allow must list host names`);
	}
	if (!Number.isSafeInteger(cloud.pollSeconds) || cloud.pollSeconds < 10 || cloud.pollSeconds > 600) {
		throw new ConfigError(`teams.${key}.cloud.pollSeconds must be from 10 to 600`);
	}
	return cloud;
}

export async function loadConfig(path) {
	const file = resolve(path);
	let mod;
	try {
		mod = await import(pathToFileURL(file).href);
	} catch (error) {
		throw new ConfigError(`cannot load ${file}: ${error.message}`);
	}
	const raw = mod.default ?? mod;
	return validateConfig(raw);
}

export function validateConfig(raw) {
	if (!raw || typeof raw !== "object") throw new ConfigError("the configuration is not an object");
	const { track, workspace, teams } = raw;
	if (!track?.url) throw new ConfigError("track.url is required (for example https://track.gateweave.com)");
	if (!track?.keyEnv) throw new ConfigError("track.keyEnv is required: the name of the environment variable holding the agent member's key");
	if (typeof workspace !== "string" || !workspace) throw new ConfigError("workspace is required (the workspace slug)");
	if (!teams || typeof teams !== "object" || !Object.keys(teams).length) {
		throw new ConfigError("teams is required: at least one team key mapped to a repository");
	}

	const config = {
		...DEFAULTS,
		...raw,
		track: { url: track.url.replace(/\/+$/, ""), keyEnv: track.keyEnv },
		workspace,
		worktreesDir: expandHome(raw.worktreesDir ?? DEFAULTS.worktreesDir),
		stateDir: expandHome(raw.stateDir ?? DEFAULTS.stateDir),
		logDir: expandHome(raw.logDir ?? DEFAULTS.logDir),
		pauseFile: expandHome(raw.pauseFile ?? DEFAULTS.pauseFile),
		slots: validateSlots(raw.slots),
		teams: {},
	};

	for (const [key, team] of Object.entries(teams)) {
		if (!team?.repo) throw new ConfigError(`teams.${key}.repo is required`);
		if (team.isolation === "cloud") {
			// A Docker Cloud team's engine is Codex in the sandbox, chosen by `cloud`, not a local command.
			if (team.engine !== undefined) throw new ConfigError(`teams.${key}.engine does not apply in Docker Cloud; set cloud.model`);
		} else {
			if (!Array.isArray(team.engine?.command) || !team.engine.command.length) {
				throw new ConfigError(`teams.${key}.engine.command is required (an argv array; "{prompt}" marks where the prompt goes)`);
			}
			if (team.engine.command.includes("{prompt}") === false && !team.engine.command.some((a) => typeof a === "string" && a.includes("{prompt}"))) {
				// A command without the prompt placeholder would run the same thing for every issue.
				throw new ConfigError(`teams.${key}.engine.command must carry "{prompt}"`);
			}
		}
		const merged = { ...TEAM_DEFAULTS, ...team };
		merged.repo = expandHome(team.repo);
		if (merged.workRunRepository !== undefined &&
			(typeof merged.workRunRepository !== "string" ||
				!/^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/i.test(merged.workRunRepository))) {
			throw new ConfigError(`teams.${key}.workRunRepository must name a GitHub repository as owner/repo`);
		}
		if (merged.workRunRepository) merged.workRunRepository = merged.workRunRepository.toLowerCase();
		if (merged.reviewRepository !== undefined &&
			(typeof merged.reviewRepository !== "string" ||
				!/^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/i.test(merged.reviewRepository))) {
			throw new ConfigError(`teams.${key}.reviewRepository must name a GitHub repository as owner/repo`);
		}
		merged.routing = validateRouting(key, team.routing);
		if (!["worktree", "container", "cloud"].includes(merged.isolation)) {
			throw new ConfigError(`teams.${key}.isolation must be "worktree", "container" or "cloud"`);
		}
		if (merged.isolation === "cloud") merged.cloud = validateCloud(key, merged);
		else if (team.cloud !== undefined) throw new ConfigError(`teams.${key}.cloud applies only with isolation "cloud"`);
		if (typeof merged.untrusted !== "boolean") {
			throw new ConfigError(`teams.${key}.untrusted must be a boolean`);
		}
		if (merged.untrusted) {
			throw new ConfigError(`teams.${key} is untrusted and cannot run with the local runner yet`);
		}
		if (!Array.isArray(merged.pickupStatuses) || !merged.pickupStatuses.length) {
			throw new ConfigError(`teams.${key}.pickupStatuses must name at least one status`);
		}
		if (typeof merged.label !== "string" || !merged.label) {
			throw new ConfigError(`teams.${key}.label is required: the label a person puts on an issue the runner may take`);
		}
		const envNames = [...(merged.env?.pass ?? []), ...Object.keys(merged.env?.set ?? {})];
		if (merged.isolation === "container") {
			const image = merged.container?.image;
			if (typeof image !== "string" || !/^[a-z0-9][a-z0-9._/:@-]*$/i.test(image)) {
				throw new ConfigError(`teams.${key}.container.image must name a locally installed Docker image`);
			}
			if (envNames.length > 0) {
				throw new ConfigError(`teams.${key} does not support env.pass or env.set with container isolation`);
			}
			const packages = merged.container.packages;
			if (packages !== undefined && packages !== "npm" && packages !== "pnpm") {
				throw new ConfigError(`teams.${key}.container.packages must be "npm" or "pnpm"`);
			}
			if (merged.container.model !== undefined) {
				const { name, maxRequests = 8 } = merged.container.model ?? {};
				if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(name)) {
					throw new ConfigError(`teams.${key}.container.model.name must identify a model`);
				}
				if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) {
					throw new ConfigError(`teams.${key}.container.model.maxRequests must be an integer from 1 to 100`);
				}
				merged.container = { ...merged.container, model: { name, maxRequests } };
			}
		}
		for (const name of envNames) {
			const why = forbiddenEnvName(name, track.keyEnv);
			if (why) throw new ConfigError(`teams.${key}.env may not pass ${name}: ${why}`);
		}
		config.teams[key] = merged;
	}
	return config;
}
