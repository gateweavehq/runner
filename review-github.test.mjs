import assert from "node:assert/strict";
import { test } from "node:test";
import { findPendingReview } from "./review-github.mjs";

const repo = "Acme/ops";
const head = "a".repeat(40);
const stale = "b".repeat(40);
const number = 5;
const branch = "runner/eng-1";
const base = "main";
const submittedAt = "2026-11-19T14:00:00Z";
const path = `repos/${repo}/pulls/${number}`;
const reviewsPath = `${path}/reviews?per_page=100`;
const permissionPath = (login) => `repos/${repo}/collaborators/${login}/permission`;

function pull(overrides) {
	return {
		number, state: "open",
		head: { ref: branch, sha: head, repo: { full_name: "acme/ops", fork: false } },
		base: { ref: base, repo: { full_name: "acme/ops" } },
		...overrides,
	};
}

function review(id, overrides) {
	return {
		id, state: "CHANGES_REQUESTED", body: "Please fix the test.", commit_id: head,
		submitted_at: submittedAt, user: { login: "writer", type: "User" },
		...overrides,
	};
}

function fixture({ pr = pull(), reread = pr, pages = [[review(10)]], permissions = { writer: "write" } } = {}) {
	const calls = [];
	const cwd = "runner-worktree";
	const env = { PATH: "fixture" };
	let reads = 0;
	async function runGh(command, args, options) {
		assert.equal(command, "gh");
		assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
		assert.deepEqual(options, { cwd, env, timeout: 30_000 });
		const endpoint = args.at(-1);
		calls.push(endpoint);
		let value;
		if (endpoint === path) {
			value = reads++ === 0 ? pr : reread;
		} else if (endpoint === reviewsPath) {
			assert.deepEqual(args.slice(3, -1), ["--paginate", "--slurp"]);
			value = pages;
		} else {
			const login = Object.keys(permissions).find((permissionLogin) => permissionPath(permissionLogin) === endpoint);
			if (!login || permissions[login] === null) throw new Error("GitHub permission unknown");
			value = { permission: permissions[login] };
		}
		return { stdout: JSON.stringify(value) };
	}
	return { calls, find: (overrides) => findPendingReview({ cwd, env, repo, number, base, branch, head, runGh, ...overrides }) };
}

test("findPendingReview checks eligible reviews across pages with current GitHub access", async () => {
	const discarded = { login: "guest", type: "User" };
	const ready = review(22, { state: "COMMENTED", body: "  Keep the review text.\n" });
	const local = fixture({
		pages: [[
			review(1, { body: "   \n" }),
			review(2, { state: "APPROVED" }),
			review(3, { state: "DISMISSED" }),
			review(4, { state: "PENDING" }),
			review(5, { commit_id: stale }),
			review(6, { user: { login: "automation", type: "Bot" } }),
			review(7, { user: { login: "automation[bot]", type: "User" } }),
			review(8, { submitted_at: null }),
			review(9, { submitted_at: "unsubmitted" }),
			review(10),
			review("15"),
			review(0),
			review(Number.MAX_SAFE_INTEGER + 1),
			review(11, { user: discarded }),
			review(12, { user: { login: "Guest", type: "User" } }),
		], [ready, review(23)]],
		permissions: { guest: "read", writer: "maintain" },
	});

	assert.deepEqual(await local.find({ seenReviewIds: ["10"] }), {
		id: 22, login: "writer", body: ready.body, state: "COMMENTED", commit: head, submittedAt,
	});
	assert.deepEqual(local.calls, [path, reviewsPath, permissionPath("guest"), permissionPath("writer"), path]);
});

test("findPendingReview accepts the write-capable permissions for changes requested", async () => {
	for (const permission of ["write", "maintain", "admin"]) {
		const local = fixture({ permissions: { writer: permission } });
		assert.equal((await local.find())?.state, "CHANGES_REQUESTED");
		assert.deepEqual(local.calls, [path, reviewsPath, permissionPath("writer"), path]);
	}
});

test("findPendingReview declines unrelated, closed, stale, or fork pull requests before reviews", async () => {
	for (const pr of [
		pull({ number: 6 }),
		pull({ state: "closed" }),
		pull({ merged: true }),
		pull({ base: { ...pull().base, ref: "release" } }),
		pull({ base: { ...pull().base, repo: { full_name: "different/ops" } } }),
		pull({ head: { ...pull().head, ref: "different-branch" } }),
		pull({ head: { ...pull().head, sha: stale } }),
		pull({ head: { ...pull().head, repo: null } }),
		pull({ head: { ...pull().head, repo: { full_name: "contributor/ops", fork: true } } }),
		pull({ head: { ...pull().head, repo: { full_name: repo, fork: true } } }),
	]) {
		const local = fixture({ pr });
		assert.equal(await local.find(), null);
		assert.deepEqual(local.calls, [path]);
	}
});

test("findPendingReview refuses unknown permissions, malformed pages, and a PR that moves during discovery", async () => {
	for (const permission of ["read", "triage", "none", null]) {
		const local = fixture({ permissions: { writer: permission } });
		assert.equal(await local.find(), null);
		assert.deepEqual(local.calls, [path, reviewsPath, permissionPath("writer")]);
	}
	const malformed = fixture({ pages: { reviews: [review(10)] } });
	assert.equal(await malformed.find(), null);
	assert.deepEqual(malformed.calls, [path, reviewsPath]);

	const moved = fixture({ reread: pull({ head: { ...pull().head, sha: stale } }) });
	assert.equal(await moved.find(), null);
	assert.deepEqual(moved.calls, [path, reviewsPath, permissionPath("writer"), path]);
});

test("findPendingReview refuses unvalidated GitHub path input", async () => {
	const local = fixture();
	for (const overrides of [
		{ repo: "https://github.com/a/b" }, { repo: "a/.." }, { repo: "a/%2E%2E" },
		{ number: 0 }, { number: "5" }, { head: "HEAD" }, { seenReviewIds: null },
	]) {
		assert.equal(await local.find(overrides), null);
	}
	assert.deepEqual(local.calls, []);
});
