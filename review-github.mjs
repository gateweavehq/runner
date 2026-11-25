// GitHub review discovery is read-only. Only a human with current repository write access
// can request another run on the exact pull request and commit recorded by the runner.
const loginPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const repoPattern = /^[a-z0-9][a-z0-9_-]{0,79}\/[a-z0-9_.-]{1,100}$/i;
const shaPattern = /^[a-f0-9]{40}$/i;
const states = new Set(["CHANGES_REQUESTED", "COMMENTED"]);
const writePermissions = new Set(["write", "maintain", "admin"]);

function sameRepository(value, expected) {
	return typeof value === "string" && value.toLowerCase() === expected;
}

function matchesPullRequest(pull, { number, repo, base, branch, head }) {
	return pull?.number === number &&
		pull.state === "open" &&
		pull.merged !== true &&
		pull.base?.ref === base &&
		pull.head?.ref === branch &&
		pull.head?.sha === head &&
		pull.head.repo?.fork === false &&
		sameRepository(pull.base.repo?.full_name, repo) &&
		sameRepository(pull.head.repo.full_name, repo);
}

function reviewCandidate(review, head, seen) {
	return Number.isSafeInteger(review?.id) && review.id > 0 &&
		!seen.has(String(review.id)) &&
		states.has(review.state) &&
		review.commit_id === head &&
		typeof review.body === "string" && review.body.trim().length > 0 &&
		typeof review.submitted_at === "string" && Number.isFinite(Date.parse(review.submitted_at)) &&
		review.user?.type === "User" &&
		typeof review.user.login === "string" && loginPattern.test(review.user.login);
}

async function readJson(runGh, options, endpoint, args = []) {
	try {
		const { stdout } = await runGh("gh", ["api", "--hostname", "github.com", ...args, endpoint], options);
		return JSON.parse(stdout);
	} catch {
		// A failure to read the PR, reviews or a permission must not start a run.
		return null;
	}
}

/** Find the first unseen submitted review on the runner's pinned PR head, or return null. */
export async function findPendingReview({
	cwd, repo, base, branch, number, head, seenReviewIds = [], runGh, env,
}) {
	if (typeof repo !== "string" || !repoPattern.test(repo) || /\/(?:\.|\.\.)$/.test(repo) ||
		!Number.isSafeInteger(number) || number <= 0 ||
		typeof head !== "string" || !shaPattern.test(head) ||
		typeof base !== "string" || !base || typeof branch !== "string" || !branch ||
		(!Array.isArray(seenReviewIds) && !(seenReviewIds instanceof Set)) ||
		typeof runGh !== "function") return null;

	const options = { cwd, env, timeout: 30_000 };
	const expected = { number, repo: repo.toLowerCase(), base, branch, head: head.toLowerCase() };
	const pullPath = `repos/${repo}/pulls/${number}`;
	if (!matchesPullRequest(await readJson(runGh, options, pullPath), expected)) return null;

	// The REST API yields reviews chronologically. Preserve that order across all pages.
	const pages = await readJson(runGh, options, `${pullPath}/reviews?per_page=100`, ["--paginate", "--slurp"]);
	if (!Array.isArray(pages) || !pages.every(Array.isArray)) return null;
	const seen = new Set(Array.from(seenReviewIds, String));
	const permissions = new Map();
	for (const page of pages) {
		for (const review of page) {
			if (!reviewCandidate(review, expected.head, seen)) continue;
			const { login } = review.user;
			const key = login.toLowerCase();
			if (!permissions.has(key)) {
				const permission = await readJson(
					runGh, options, `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
				);
				permissions.set(key, writePermissions.has(permission?.permission));
			}
			if (!permissions.get(key)) continue;
			if (!matchesPullRequest(await readJson(runGh, options, pullPath), expected)) return null;
			return {
				id: review.id, login, body: review.body, state: review.state,
				commit: review.commit_id, submittedAt: review.submitted_at,
			};
		}
	}
	return null;
}
