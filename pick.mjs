// The pure half of picking work: which searched issues a team will take. Kept free of I/O so the
// rules are testable. Only issues assigned to the runner (the search is already
// scoped to assignee "me"), in a pickup status, carrying the team's label, not archived or in
// intake, and — for the first version — written by a workspace owner or admin.

const norm = (s) => String(s ?? "").toLowerCase();

/** Whether an issue's status (name or key) is the wanted one, case-insensitively. */
export function statusMatches(issue, wanted) {
	const target = norm(wanted);
	return norm(issue?.statusName) === target || norm(issue?.status) === target;
}

/** The emails of the workspace's owners and admins, lowercased. */
export function ownerOrAdminEmails(workspace) {
	const members = workspace?.members ?? [];
	return new Set(
		members
			.filter((m) => m && (m.role === "owner" || m.role === "admin") && typeof m.email === "string")
			.map((m) => m.email.toLowerCase()),
	);
}

/**
 * Whether an issue detail may be taken: creator is an owner or admin (the first version's rule).
 * Creators that are not people ("Track", "GitHub", "Request form", "Email") are not emails and
 * never qualify.
 */
export function creatorAllowed(detail, allowedEmails) {
	const creator = detail?.creator;
	if (typeof creator !== "string" || !creator.includes("@")) return false;
	return allowedEmails.has(creator.toLowerCase());
}

/**
 * Filters search_issues summaries down to candidates worth a get_issue. `team` is the team key the
 * search was scoped to; `label` the label the team requires; `pickupStatuses` names or keys.
 */
export function pickCandidates({ issues, team, label, pickupStatuses }) {
	const wanted = new Set((pickupStatuses ?? []).map(norm));
	return (issues ?? []).filter((issue) => {
		if (!issue || typeof issue.key !== "string") return false;
		if (issue.archived || issue.intake) return false;
		if (!(issue.labels ?? []).includes(label)) return false;
		const status = norm(issue.statusName) || norm(issue.status);
		const key = norm(issue.status);
		return wanted.has(status) || wanted.has(key);
	});
}
