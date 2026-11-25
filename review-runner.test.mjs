import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfig } from "./config.mjs";
import { git } from "./git.mjs";
import { Runner } from "./runner.mjs";

test("review follow-up uses the original PR branch and persists handled reviews across restarts", async (t) => {
	const tmp = await mkdtemp(join(tmpdir(), "runner-review-"));
	t.after(() => rm(tmp, { recursive: true, force: true }));
	const repo = join(tmp, "repo");
	const remote = join(tmp, "remote");
	const engine = join(tmp, "engine.mjs");
	const repository = "owner/repo";
	const branch = "runner/eng-1";
	const ref = `refs/heads/${branch}`;
	const prNumber = 17;
	const prUrl = `https://github.com/${repository}/pull/${prNumber}`;
	const prPath = `repos/${repository}/pulls/${prNumber}`;
	const reviewer = "test-reviewer";
	const editFeedback = "Please add the second line to the proof file.";
	const verifyFeedback = "Please verify the proof file without changing it.";
	const remoteGit = async (args) => (await git(remote, args)).trim();
	const remoteHead = () => remoteGit(["rev-parse", ref]);

	await mkdir(repo);
	await mkdir(remote);
	await git(remote, ["init", "--bare", "-b", "main"]);
	await git(repo, ["init", "-b", "main"]);
	await git(repo, ["config", "user.name", "Review Test"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "core.autocrlf", "false"]);
	await git(repo, ["commit", "--allow-empty", "-m", "initial"]);
	await git(repo, ["remote", "add", "origin", remote]);
	await git(repo, ["push", "origin", "main"]);
	const baseHead = await remoteGit(["rev-parse", "main"]);

	await writeFile(engine, `
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [prompt] = process.argv.slice(2);
const proof = "review-proof.txt";
if (prompt.includes(${JSON.stringify(editFeedback)})) {
	assert.ok(prompt.includes(${JSON.stringify(`Review feedback from ${reviewer}:`)}));
	assert.equal(readFileSync(proof, "utf8"), "initial edit\\n");
	writeFileSync(proof, "initial edit\\nreview edit\\n");
} else if (prompt.includes(${JSON.stringify(verifyFeedback)})) {
	assert.equal(readFileSync(proof, "utf8"), "initial edit\\nreview edit\\n");
} else {
	assert.equal(existsSync(proof), false);
	writeFileSync(proof, "initial edit\\n");
}
`);
	const config = validateConfig({
		track: { url: "https://track.example.com", keyEnv: "TRACK_FIXTURE_KEY" },
		workspace: "gateweave",
		stateDir: join(tmp, "state"),
		worktreesDir: join(tmp, "worktrees"),
		teams: {
			ENG: {
				repo,
				label: "run",
				engine: { command: [process.execPath, engine, "{prompt}"] },
				reviewRepository: repository,
			},
		},
	});
	const issue = {
		key: "ENG-1",
		title: "Write proof",
		creator: "owner@example.com",
		assignee: "runner@example.com",
		labels: ["run"],
	};
	let status = "Todo";
	const changes = [];
	const comments = [];
	const track = {
		async call(name, args) {
			assert.equal(args.workspace, config.workspace);
			switch (name) {
				case "get_workspace":
					return { members: [{ email: issue.creator, role: "owner" }] };
				case "search_issues":
					assert.equal(args.team, "ENG");
					assert.equal(args.assignee, "me");
					return { issues: args.status.includes(status) ? [{ ...issue, statusName: status }] : [] };
				case "get_issue":
					assert.equal(args.key, issue.key);
					return { ...issue, statusName: status };
				case "update_issue":
					assert.equal(args.key, issue.key);
					status = args.status;
					changes.push(status);
					return {};
				case "add_comment":
					assert.equal(args.key, issue.key);
					comments.push(args.body);
					return {};
				default:
					assert.fail(`Unexpected Track call: ${name}`);
			}
		},
	};
	const reviews = [];
	const review = (id, body, commit) => ({
		id,
		state: "CHANGES_REQUESTED",
		body,
		commit_id: commit,
		submitted_at: "2026-11-19T12:00:00Z",
		user: { login: reviewer, type: "User" },
	});
	const json = (body) => ({ stdout: JSON.stringify(body) });
	const ghCalls = [];
	let permission = "read";
	const runGh = async (command, args) => {
		assert.equal(command, "gh");
		ghCalls.push(args);
		if (args[0] === "pr" && args[1] === "list") return json([]);
		if (args[0] === "pr" && args[1] === "create") {
			assert.equal(args[args.indexOf("--head") + 1], branch);
			assert.equal(args[args.indexOf("--base") + 1], "main");
			return { stdout: `${prUrl}\n` };
		}
		switch (args.at(-1)) {
			case prPath:
				return json({
					number: prNumber,
					html_url: prUrl,
					state: "open",
					head: { ref: branch, sha: await remoteHead(), repo: { full_name: repository, fork: false } },
					base: { ref: "main", sha: baseHead, repo: { full_name: repository } },
				});
			case `${prPath}/reviews?per_page=100`:
				assert.ok(args.includes("--paginate") && args.includes("--slurp"));
				return json([reviews]);
			case `repos/${repository}/collaborators/${reviewer}/permission`:
				return json({ permission });
			default:
				assert.fail(`Unexpected gh call: ${args.join(" ")}`);
		}
	};
	const logs = [];
	const startRunner = () => new Runner(config, { track, runGh, log: (message) => logs.push(message) });
	const runOne = async (runner) => {
		const work = await runner.findWork();
		assert.ok(work, logs.join("\n"));
		await runner.run(work);
		assert.equal(status, "In Review", logs.join("\n"));
	};

	await runOne(startRunner());
	const initialHead = await remoteHead();
	assert.equal(await remoteGit(["show", `${initialHead}:review-proof.txt`]), "initial edit");
	assert.ok(comments.some((body) => body.includes(prUrl)));
	assert.deepEqual(changes, ["In Progress", "In Review"]);

	reviews.push(review(31, editFeedback, initialHead));
	assert.equal(await startRunner().findWork(), null);
	assert.ok(ghCalls.some((args) => args.at(-1) === `repos/${repository}/collaborators/${reviewer}/permission`));
	assert.deepEqual(changes, ["In Progress", "In Review"]);
	assert.equal(await remoteHead(), initialHead);

	permission = "write";
	await runOne(startRunner());
	const followupHead = await remoteHead();
	assert.equal(await remoteGit(["rev-parse", `${followupHead}^`]), initialHead);
	assert.equal(await remoteGit(["show", `${followupHead}:review-proof.txt`]), "initial edit\nreview edit");
	assert.equal(await remoteGit(["rev-parse", "main"]), baseHead);
	assert.equal(ghCalls.filter(([group, action]) => group === "pr" && action === "create").length, 1);
	assert.equal(await startRunner().findWork(), null);

	// This review leaves the head unchanged, so a restarted runner must remember its ID.
	reviews.push(review(32, verifyFeedback, followupHead));
	await runOne(startRunner());
	assert.equal(await remoteHead(), followupHead);
	assert.equal(await startRunner().findWork(), null);
	assert.deepEqual(changes, ["In Progress", "In Review", "In Progress", "In Review", "In Progress", "In Review"]);
	assert.equal(comments.filter((body) => body.includes(`Pull request: ${prUrl}`)).length, 3);

	// The remote may move after discovery. The runner must preserve that head and return to review.
	reviews.push(review(33, verifyFeedback, followupHead));
	const runner = startRunner();
	const work = await runner.findWork();
	assert.ok(work);
	await remoteGit(["update-ref", ref, baseHead, followupHead]);
	await runner.run(work);
	assert.equal(await remoteHead(), baseHead);
	assert.equal(status, "In Review");
	assert.ok(comments.some((body) => body.includes("the PR branch changed before the review could run")));
});
