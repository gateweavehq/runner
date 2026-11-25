// A review cursor belongs to one Track deployment, team and issue. The runner processes one
// turn at a time, and replacing a synced file keeps reads atomic.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_STATE_BYTES = 1024 * 1024;
const fields = ["prUrl", "branch", "head", "processedReviewIds"];

function stateFile(stateDir, workspace, teamSlug, issueId) {
	const identity = [workspace, teamSlug, issueId];
	if (!identity.every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)) {
		throw new Error("Invalid review state identity");
	}
	const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
	return join(stateDir, "reviews", key + ".json");
}

function validPullRequestUrl(value) {
	if (typeof value !== "string" || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.href === value &&
			!url.username && !url.password && !url.search && !url.hash &&
			/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(url.pathname);
	} catch {
		return false;
	}
}

function validBranch(branch) {
	return typeof branch === "string" && branch.length > 0 && branch.length <= 240 &&
		branch !== "@" && !branch.startsWith("-") && !branch.endsWith(".") &&
		!branch.includes("..") && !branch.includes("@{") &&
		!/[\s~^:?*\[\\\x00-\x1f\x7f]/u.test(branch) &&
		branch.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function validateRecord(record) {
	if (record === null || typeof record !== "object" || Array.isArray(record) ||
		Object.keys(record).length !== fields.length || !fields.every((name) => Object.hasOwn(record, name))) {
		throw new Error("Invalid review state");
	}
	const { prUrl, branch, head, processedReviewIds } = record;
	if (!validPullRequestUrl(prUrl) || !validBranch(branch) ||
		typeof head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head) ||
		!Array.isArray(processedReviewIds) || processedReviewIds.length > 10_000) {
		throw new Error("Invalid review state");
	}
	const ids = [...processedReviewIds];
	if (!ids.every((id) => typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) ||
		new Set(ids).size !== ids.length) {
		throw new Error("Invalid review state");
	}
	return { prUrl, branch, head, processedReviewIds: ids };
}

/** Missing state permits first use. Malformed state throws instead of replaying a review. */
export async function readReviewState(stateDir, workspace, teamSlug, issueId) {
	const file = stateFile(stateDir, workspace, teamSlug, issueId);
	let contents;
	try {
		const entry = await lstat(file);
		if (!entry.isFile() || entry.size > MAX_STATE_BYTES) throw new Error("Invalid review state file");
		contents = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw new Error("Could not read review state");
	}
	try {
		if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error("Review state is too large");
		return validateRecord(JSON.parse(contents));
	} catch {
		throw new Error("Invalid review state");
	}
}

export async function writeReviewState(stateDir, workspace, teamSlug, issueId, record) {
	const file = stateFile(stateDir, workspace, teamSlug, issueId);
	const contents = JSON.stringify(validateRecord(record)) + "\n";
	if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw new Error("Review state is too large");
	const directory = dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.review-${randomUUID()}.tmp`);
	let created = false;
	try {
		const handle = await open(temporary, "wx", 0o600);
		created = true;
		try {
			await handle.writeFile(contents, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
		created = false;
	} finally {
		if (created) await unlink(temporary).catch(() => {});
	}
}
