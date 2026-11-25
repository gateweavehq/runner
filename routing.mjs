// Routing advice. A repository's configured capabilities decide where its
// jobs would run: independent, portable work prefers Docker Cloud, while private source, secrets,
// services bound to this machine or account, and work that needs a person stay local or on an
// approved runner. The runner only records the advice and still runs every job here: nothing
// moves until the pilot's records have been reviewed. A job the advice sends to Docker Cloud is
// never quietly treated as local: the log and the gate's history both say what was advised.
// Node 24, no dependencies.

export const ROUTING_SOURCES = ["public", "private"];
export const ROUTING_NEEDS = ["secrets", "host-services", "interactive"];

const NEED_REASONS = {
	secrets: "it needs secrets that stay on this machine",
	"host-services": "it needs services bound to this machine or account",
	interactive: "it needs a person at the machine",
};

/**
 * Where a team's job would run, and why, in plain words. `routing` is the team's validated
 * setting; without one nothing is assumed, and the job stays local.
 */
export function adviseRoute(routing) {
	if (!routing) {
		return { advice: "local", cloudEligible: false, reasons: ["the repository's capabilities are not configured"] };
	}
	const reasons = [];
	if (routing.source === "private") reasons.push("its source is private");
	for (const need of routing.needs) reasons.push(NEED_REASONS[need]);
	if (reasons.length) return { advice: "local", cloudEligible: false, reasons };
	return {
		advice: "cloud",
		cloudEligible: true,
		reasons: ["public source, and it needs no secrets, host services or person"],
	};
}

/**
 * One line for the log: what was advised, and where the job really runs. Only a team with
 * `isolation: "cloud"` runs in Docker Cloud; for every other team the advice is advice only.
 */
export function describeRoute(route, { isolation } = {}) {
	const where = route.advice === "cloud" ? "Docker Cloud" : "local";
	const runs = isolation === "cloud" ? "it runs in Docker Cloud" : "advise only, it runs here";
	return `routing advice ${where} (${route.reasons.join("; ")}); ${runs}`;
}
