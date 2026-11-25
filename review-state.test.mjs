import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readReviewState, writeReviewState } from "./review-state.mjs";

const workspace = "https://track.example/gateweave";
const team = "ENG";
const issue = "ENG-152";
const original = {
	prUrl: "https://github.example/org/fixtures/pull/1",
	branch: "runner/eng-152",
	head: "a".repeat(40),
	processedReviewIds: ["1", "PRR_fixture"],
};

async function stateDirectory(t) {
	const dir = await mkdtemp(join(tmpdir(), "runner-review-state-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("round trips state independently per Track deployment, team and issue", async (t) => {
	const dir = await stateDirectory(t);
	const secondHost = "https://other.example/gateweave";
	assert.equal(await readReviewState(dir, workspace, team, issue), null);
	await writeReviewState(dir, workspace, team, issue, original);
	await writeReviewState(dir, secondHost, team, issue, { ...original, processedReviewIds: ["2"] });
	await writeReviewState(dir, workspace, "OPS", issue, { ...original, processedReviewIds: ["3"] });
	await writeReviewState(dir, workspace, team, "ENG-153", { ...original, processedReviewIds: ["4"] });

	assert.deepEqual(await readReviewState(dir, workspace, team, issue), original);
	assert.deepEqual((await readReviewState(dir, secondHost, team, issue)).processedReviewIds, ["2"]);
	assert.deepEqual((await readReviewState(dir, workspace, "OPS", issue)).processedReviewIds, ["3"]);
	assert.deepEqual((await readReviewState(dir, workspace, team, "ENG-153")).processedReviewIds, ["4"]);
	assert.equal(await readReviewState(dir, workspace, team, "ENG-154"), null);
	const files = await readdir(join(dir, "reviews"));
	assert.equal(files.length, 4);
	assert.ok(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
});

test("atomically replaces a record with the new head and processed reviews", async (t) => {
	const dir = await stateDirectory(t);
	const updated = { ...original, head: "b".repeat(40), processedReviewIds: ["1", "PRR_fixture", "2"] };
	await writeReviewState(dir, workspace, team, issue, original);
	const replacing = writeReviewState(dir, workspace, team, issue, updated);
	for (const state of await Promise.all(Array.from({ length: 8 }, () => readReviewState(dir, workspace, team, issue)))) {
		assert.deepEqual(state, state.head === original.head ? original : updated);
	}
	await replacing;
	assert.deepEqual(await readReviewState(dir, workspace, team, issue), updated);
	const files = await readdir(join(dir, "reviews"));
	assert.equal(files.length, 1);
	assert.deepEqual(JSON.parse(await readFile(join(dir, "reviews", files[0]), "utf8")), updated);
});

test("rejects malformed writes and leaves the previous cursor intact", async (t) => {
	const dir = await stateDirectory(t);
	await writeReviewState(dir, workspace, team, issue, original);
	for (const altered of [
		{ ...original, reviewBody: "must never be stored" },
		{ ...original, prUrl: "https://secret@github.example/org/fixtures/pull/1" },
		{ ...original, prUrl: original.prUrl + "?token=secret" },
		{ ...original, head: "short" },
		{ ...original, branch: "runner/../outside" },
		{ ...original, processedReviewIds: ["1", "1"] },
		{ ...original, processedReviewIds: [7] },
		{ ...original, processedReviewIds: Array(1) },
	]) {
		await assert.rejects(writeReviewState(dir, workspace, team, issue, altered), /^Error: Invalid review state$/);
	}
	assert.deepEqual(await readReviewState(dir, workspace, team, issue), original);
	assert.equal((await readdir(join(dir, "reviews"))).length, 1);
});

test("throws on corrupt persisted state instead of permitting a first use", async (t) => {
	const dir = await stateDirectory(t);
	await writeReviewState(dir, workspace, team, issue, original);
	const [name] = await readdir(join(dir, "reviews"));
	const file = join(dir, "reviews", name);
	for (const corrupt of ['{"secret":"unterminated', "[]", JSON.stringify({ ...original, other: "bad" })]) {
		await writeFile(file, corrupt);
		await assert.rejects(readReviewState(dir, workspace, team, issue), /^Error: Invalid review state$/);
	}
	await writeFile(file, "x".repeat(1024 * 1024 + 1));
	await assert.rejects(readReviewState(dir, workspace, team, issue), /^Error: Could not read review state$/);
});
