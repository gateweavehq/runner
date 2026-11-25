// The environment an engine or a check starts with: the few variables the OS needs,
// plus what the team's configuration names. Nothing else crosses — in particular no Track key, no
// Cloudflare or GitHub token; the runner itself pushes and opens the pull request.

const BASE_PASS = [
	"PATH",
	"Path",
	"SYSTEMROOT",
	"SystemRoot",
	"WINDIR",
	"windir",
	"ComSpec",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"OS",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
];

const baseUpper = new Set(BASE_PASS.map((n) => n.toUpperCase()));

/**
 * Builds the child environment.
 * `pass`: names copied from the runner's environment. `set`: literal values from the configuration.
 */
export function buildEnv({ baseEnv = process.env, pass = [], set = {} } = {}) {
	const out = {};
	const seen = new Set();
	const wanted = new Set([...BASE_PASS.map((n) => n.toUpperCase()), ...pass.map((n) => n.toUpperCase())]);
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value === undefined || !wanted.has(key.toUpperCase())) continue;
		const upper = key.toUpperCase();
		if (seen.has(upper)) continue; // Windows lists the same variable under two casings
		seen.add(upper);
		out[key] = value;
	}
	for (const [key, value] of Object.entries(set)) out[key] = String(value);
	return out;
}

export { baseUpper };
