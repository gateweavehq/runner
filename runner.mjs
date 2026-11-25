#!/usr/bin/env node
// gateweave-runner: picks up Track issues assigned to its agent member and works them with a local
// engine (Codex or Claude Code) on this machine. See README.md.
//
//   node runner.mjs [--config runner.config.mjs] [--once] [--dry-run]

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.mjs";
import { runContainerEngine } from "./container.mjs";
import { buildEnv } from "./env.mjs";
import { containerGitEnv, ensureWorktree, git, removeWorktree } from "./git.mjs";
import { creatorAllowed, ownerOrAdminEmails, pickCandidates, statusMatches } from "./pick.mjs";
import { engineArgv, parseCheckReports, runProcess } from "./process.mjs";
import { findPendingReview } from "./review-github.mjs";
import { GIB, samplePeak, SlotsGate } from "./slots.mjs";
import { readReviewState, writeReviewState } from "./review-state.mjs";
import { adviseRoute, describeRoute } from "./routing.mjs";
import { CloudUnavailableError, prepareCloud, runCloudEngine } from "./cloud.mjs";
import { TrackMcp } from "./track.mjs";
import { claimScopedWork, findScopedWork, inspectScopedWork, replayWorkRunReports, resumeScopedWork } from "./work-runs.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = { config: join(HERE, "runner.config.mjs"), once: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--config") args.config = argv[++i];
		else if (argv[i] === "--inspect-work" || argv[i] === "--resume-work") {
			const option = argv[i];
			const key = argv[++i];
			if (!/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(key ?? "")) throw new Error(`${option} takes a Track issue key`);
			if (option === "--inspect-work") args.inspectWork = key;
			else args.resumeWork = { key, attemptId: argv[++i] };
		}
		else if (argv[i] === "--once") args.once = true;
		else if (argv[i] === "--dry-run") args.dryRun = true;
		else throw new Error(`unknown argument: ${argv[i]}`);
	}
	if (args.inspectWork && args.resumeWork) throw new Error("Run --inspect-work before --resume-work");
	return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reviewPrUrl = /^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/i;

export class Runner {
	#peakSampling = null;

	constructor(config, {
		track, log, dryRun = false, now = () => new Date(), runGh = execFileAsync, modelFetch, packageFetch,
		slots = null,
		cloud = { prepare: prepareCloud, run: runCloudEngine },
	}) {
		this.config = config;
		this.track = track;
		this.log = log;
		this.dryRun = dryRun;
		this.now = now;
		this.runGh = runGh;
		this.modelFetch = modelFetch;
		this.packageFetch = packageFetch;
		this.slots = slots;
		this.cloud = cloud;
	}

	paused() {
		return existsSync(this.config.pauseFile);
	}

	async dailyCount() {
		const day = this.now().toISOString().slice(0, 10);
		try {
			const state = JSON.parse(await readFile(join(this.config.stateDir, "state.json"), "utf8"));
			return state.day === day ? state.count : 0;
		} catch {
			return 0;
		}
	}

	async bumpDailyCount() {
		const day = this.now().toISOString().slice(0, 10);
		const count = (await this.dailyCount()) + 1;
		await mkdir(this.config.stateDir, { recursive: true });
		const file = join(this.config.stateDir, "state.json");
		const tmp = `${file}.tmp`;
		await writeFile(tmp, JSON.stringify({ day, count }));
		await rename(tmp, file);
		return count;
	}

	/** One poll across every mapped team; returns the first issue detail worth running, or null. */
	async findWork() {
		const workspace = await this.track.call("get_workspace", { workspace: this.config.workspace });
		const allowedEmails = ownerOrAdminEmails(workspace);
		for (const [teamKey, team] of Object.entries(this.config.teams)) {
			const found = await this.track.call("search_issues", {
				workspace: this.config.workspace,
				team: teamKey,
				assignee: "me",
				status: team.pickupStatuses,
				archived: false,
				intake: false,
				limit: 50,
			});
			for (const summary of pickCandidates({
				issues: found?.issues ?? [],
				team: teamKey,
				label: team.label,
				pickupStatuses: team.pickupStatuses,
			})) {
				const detail = await this.track.call("get_issue", { workspace: this.config.workspace, key: summary.key });
				if (team.reviewRepository && statusMatches(detail, team.reviewStatus)) continue;
				if (!creatorAllowed(detail, allowedEmails)) {
					this.log(`${summary.key}: creator is not an owner or admin; skipping`);
					continue;
				}
				const scopedRequest = team.workRunRepository &&
					await findScopedWork(this.config, team, detail.key, this.track);
				if (team.workRunRepository && !scopedRequest) continue;
				return { teamKey, team, detail, scopedRequest };
			}
		}
		for (const [teamKey, team] of Object.entries(this.config.teams)) {
			if (!team.reviewRepository) continue;
			const scope = {
				workspace: this.config.workspace, team: teamKey, assignee: "me", archived: false, intake: false,
			};
			const found = await this.track.call("search_issues", { ...scope, status: [team.reviewStatus], limit: 50 });
			for (const summary of pickCandidates({
				issues: found?.issues ?? [], team: teamKey, label: team.label, pickupStatuses: [team.reviewStatus],
			})) {
				const followup = await this.#findReview(teamKey, team, summary.key);
				if (!followup) continue;
				const detail = await this.track.call("get_issue", { workspace: this.config.workspace, key: summary.key });
				if (!creatorAllowed(detail, allowedEmails) || !summary.assignee || detail.assignee !== summary.assignee ||
					!pickCandidates({ issues: [detail], team: teamKey, label: team.label, pickupStatuses: [team.reviewStatus] }).length) continue;
				const scopedRequest = team.workRunRepository &&
					await findScopedWork(this.config, team, detail.key, this.track);
				if (team.workRunRepository && !scopedRequest) continue;
				return { teamKey, team, detail, followup, scopedRequest };
			}
		}
		return null;
	}

	async resumeWork(key, attemptId) {
		const teamKey = key.slice(0, key.lastIndexOf("-"));
		const team = this.config.teams[teamKey];
		if (!team?.workRunRepository) throw new Error(`${key}: this team has no scoped runner mapping`);
		const resume = await resumeScopedWork(this.config, team, key, attemptId);
		const workspace = this.config.workspace;
		const detail = await this.track.call("get_issue", { workspace, key });
		if (detail?.key !== key || !pickCandidates({ issues: [detail], team: teamKey, label: team.label,
			pickupStatuses: [...team.pickupStatuses, team.inProgressStatus] }).length) {
			throw new Error(`${key}: the issue is waiting for an eligible status and runner label`);
		}
		const board = await this.track.call("get_workspace", { workspace });
		if (!creatorAllowed(detail, ownerOrAdminEmails(board))) throw new Error(`${key}: the issue creator is not an owner or admin`);
		this.log(await inspectScopedWork(this.config, key, attemptId));
		await this.run({ teamKey, team, detail, resume });
	}

	#reviewStateKey(teamKey, key) {
		return [this.config.stateDir, `${this.config.track.url}/${this.config.workspace}`, teamKey, key];
	}

	async #findReview(teamKey, team, key) {
		try {
			const record = await readReviewState(...this.#reviewStateKey(teamKey, key));
			const match = record && reviewPrUrl.exec(record.prUrl);
			const branch = `${this.config.branchPrefix}/${key}`.toLowerCase();
			if (!match || match[1].toLowerCase() !== team.reviewRepository.toLowerCase() || record.branch !== branch) return null;
			const review = await findPendingReview({
				cwd: team.repo, repo: team.reviewRepository, base: team.base, branch, number: Number(match[2]),
				head: record.head, seenReviewIds: record.processedReviewIds, runGh: this.runGh,
			});
			return review && { record, review };
		} catch {
			this.log(`${key}: could not verify GitHub review follow-up`);
			return null;
		}
	}

	async run(work) {
		const { teamKey, team, detail, resume } = work;
		let { followup } = work;
		const key = detail.key;
		const branch = `${this.config.branchPrefix}/${key}`.toLowerCase();
		let worktree = join(this.config.worktreesDir, key);
		let reviewDir;
		const env = buildEnv({ pass: team.env?.pass ?? [], set: team.env?.set ?? {} });
		const started = Date.now();
		const machine = hostname();

		this.log(`${key}: picked up (${teamKey}, ${detail.title})`);
		// where the job should run. Only a Docker Cloud team acts on it.
		const route = adviseRoute(team.routing);
		this.log(`${key}: ${describeRoute(route, team)}`);
		if (this.dryRun) {
			this.log(`${key}: dry run — would ${resume ? "check the retained checkout and request a new attempt" :
				followup ? "follow up on the existing PR" : "claim, run the engine and open a PR"}`);
			return;
		}

		// Track can hold a status change as a proposal (its proposals.ts): update_issue may answer
		// success while the issue stays in Todo. Claim only what actually moved, and count the
		// pickup only then, so a pending proposal or a dry run costs nothing.
		const modelConfig = team.isolation === "container" ? team.container?.model : undefined;
		const apiKey = process.env.OPENAI_API_KEY?.trim();
		if (modelConfig && !apiKey) throw new Error("OPENAI_API_KEY is required for container model relay");
		const model = modelConfig && { ...modelConfig, apiKey, fetchImpl: this.modelFetch };

		// every job asks the admission gate before it claims the issue. In advise mode the
		// claim is always written and the gate only logs what enforce would have decided; in
		// enforce mode a held job is skipped untouched and the next poll tries again. The claim
		// names the runner's own process, which works on the job until it releases the claim: a
		// claim with no process is taken for an interrupted launch after the launch timeout, and
		// the engine's process ends before the runner pushes and opens the pull request.
		//
		// Track can hold a status change as a proposal (its proposals.ts): update_issue may answer
		// success while the issue stays in Todo. Claim only what actually moved, and count the
		// pickup only then, so a pending proposal or a dry run costs nothing.
		let slotClaim = null;
		if (this.slots) {
			const holder = await this.slots.ownProcess();
			// A Docker Cloud job's heavy work runs in its sandbox: it takes no local heavy slot.
			const admission = await this.slots.acquire({
				klass: team.isolation === "cloud" ? "light" : "heavy", task: key, worktree, launcher: "runner", ...holder, route,
				dockerCloudEligible: route.cloudEligible,
			});
			if (!admission.admitted) {
				this.log(`${key}: the admission gate holds it — ${admission.reason}`);
				return;
			}
			if (admission.advisory) this.log(`${key}: advise — enforce would hold it: ${admission.advisory.reason}`);
			slotClaim = admission.claim;
		}
		let exitCode = null;
		let scoped = null;
		let claimed = false;
		let completed = false;
		let terminalReported = false;
		let containerOptions;
		let sandbox = null;
		const who = runnerName(team);
		try {
			if (team.workRunRepository) {
				scoped = await claimScopedWork({
					config: this.config, team, key, track: this.track, log: this.log, request: work.scopedRequest, resume,
				});
				if (!scoped) return;
				if (slotClaim) {
					await this.slots.linkAttempt(slotClaim.id, scoped.attemptId).catch((error) =>
						this.log(`${key}: could not note the Track attempt on the slot claim: ${error.message}`));
				}
			}
			if (team.isolation === "cloud") {
				// Made before the board moves, so a refusal leaves the issue as it was. The attempt
				// then waits in Track with the reason, a later poll tries again, and the job is never
				// run on this host instead.
				try {
					sandbox = await this.cloud.prepare({
						key, nonce: scoped?.attemptId ?? randomUUID(), settings: team.cloud, jobRoot: join(this.config.stateDir, "cloud"),
						log: this.log,
					});
				} catch (error) {
					if (!(error instanceof CloudUnavailableError)) throw error;
					this.log(`${key}: ${error.message}; it waits, and it does not run on this host`);
					await scoped?.wait("Waiting for Docker Cloud", error.budget ? "budget-limit" : "retry", error.message);
					return;
				}
			}
			if (resume) worktree = resume.checkpoint.worktree;
			claimed = await this.claimIssue({ key, team, branch, machine, followup, scoped });
			if (!claimed) {
				await scoped?.report("failed", "Track did not approve the issue's status change");
				return;
			}
			await scoped?.report("running", `${who} started`);
			if (followup) {
				const { record, review } = followup;
				followup = {
					review, record: { ...record, processedReviewIds: [...record.processedReviewIds, String(review.id)] },
				};
				await writeReviewState(...this.#reviewStateKey(teamKey, key), followup.record);
				await mkdir(this.config.worktreesDir, { recursive: true });
				reviewDir = await mkdtemp(join(resolve(this.config.worktreesDir), ".review-"));
				worktree = join(reviewDir, "checkout");
			}
			if (team.isolation === "container") {
				const hostEnv = Object.fromEntries(
					Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "OPENAI_API_KEY"),
				);
				containerOptions = { env: await containerGitEnv(team.repo, hostEnv) };
			}
			const outcome = await this.#workIssue({
				key, teamKey, team, detail, worktree, branch, env, containerOptions, model, followup, scoped, resume,
				slotClaimId: slotClaim?.id ?? null, sandbox,
			});
			exitCode = outcome.engineCode ?? null;
			completed = !scoped || (outcome.checks ?? []).every((check) => check.passed === true);
			await scoped?.report(completed ? "passed" : "failed",
				completed ? `${who} finished` : "A required check did not pass", outcome.prUrl);
			terminalReported = true;
			if (completed) await this.#finish({ key, team, detail, outcome, machine, started, scoped });
			else {
				const missed = (outcome.checks ?? []).filter((check) => check.passed !== true)
					.map((check) => `${check.name} (${check.passed === false ? "failed" : "not reported"})`);
				await this.#fail({ key, team, followup, scoped, error: new Error(`a required check did not pass: ${missed.join(", ")}`) });
			}
		} catch (error) {
			if (scoped && !terminalReported) {
				await scoped.report("failed", `The ${runnerNoun(team)} could not finish`).catch(() => {
					this.log(`${key}: could not save the failure report`);
				});
			}
			if (claimed) await this.#fail({ key, team, error, followup, scoped });
			else throw error;
		} finally {
			const clean = claimed && (!scoped || completed);
			if (clean && (!followup || reviewDir) && (team.isolation !== "container" || containerOptions)) {
				await this.#cleanup(worktree, branch, team, containerOptions);
			}
			if (reviewDir && clean) await rmdir(reviewDir).catch(() => {});
			await sandbox?.remove();
			await this.#releaseSlot(slotClaim, exitCode);
		}
	}

	async replayReports() {
		if (!this.dryRun && Object.values(this.config.teams).some((team) => team.workRunRepository)) {
			await replayWorkRunReports(this.config, this.track, this.log);
		}
	}

	/** Releases the gate claim with the engine's exit code when it is known. */
	async #releaseSlot(claim, code) {
		if (!claim || !this.slots) return;
		await this.slots.release(claim.id, { code }).catch((error) => this.log(`could not release the slot claim: ${error.message}`));
	}

	/** Moves the issue to In Progress and verifies it; on success comments and counts the pickup. */
	async claimIssue({ key, team, branch, machine, followup, scoped }) {
		const moved = await this.setStatus(key, team.inProgressStatus);
		if (!moved) {
			this.log(`${key}: status did not move to ${team.inProgressStatus} (a proposal may be waiting); skipping`);
			return false;
		}
		const pickup = scoped ? `The ${runnerNoun(team)} picked up the registered work request.` : followup
			? `The local runner picked up GitHub review ${followup.review.id} on ${followup.record.prUrl}.`
			: `Picked up by the local runner on ${machine} (engine: ${engineName(team)}). Branch \`${branch}\`.`;
		await this.track.call("add_comment", { workspace: this.config.workspace, key, body: pickup });
		await this.bumpDailyCount();
		return true;
	}

	/** update_issue, then get_issue: true only if the status really changed. */
	async setStatus(key, status) {
		await this.track.call("update_issue", { workspace: this.config.workspace, key, status });
		const detail = await this.track.call("get_issue", { workspace: this.config.workspace, key });
		return statusMatches(detail, status);
	}

	/** The final status move, noted on the issue when Track holds it as a proposal. */
	async #moveAndNote(key, status) {
		const moved = await this.setStatus(key, status);
		if (!moved) {
			this.log(`${key}: status did not move to ${status}; a proposal may be waiting`);
			await this.track.call("add_comment", {
				workspace: this.config.workspace,
				key,
				body: `The status move to ${status} is waiting as a proposal; approve it in Track and the board catches up.`,
			});
		}
	}

	async #workIssue({ key, teamKey, team, detail, worktree, branch, env, containerOptions, model, followup, scoped, resume, slotClaimId, sandbox }) {
		const gitOptions = containerOptions ?? { env };
		const wt = resume ? worktree : await this.#worktree(team, worktree, branch, containerOptions, followup?.record.head);
		if (resume && containerOptions) containerOptions.env = await containerGitEnv(wt, containerOptions.env);
		const base = resume?.checkpoint.baseHead ?? `${team.remote}/${team.base}`;
		await scoped?.checkpoint(wt, branch, base);
		const setup = team.setup ?? [];
		const prompt = buildPrompt({ detail, machine: workplace(team), setup, checks: team.checks ?? [], review: followup?.review, resume });
		const engine = await this.#runEngine(team, prompt, wt, env, containerOptions?.env, model, scoped?.checkLine, slotClaimId, sandbox, key);
		// The sampler sees the engine's tree once its process is gone, within one interval.
		if (this.#peakSampling) {
			const sampling = this.#peakSampling;
			this.#peakSampling = null;
			await sampling;
		}
		const reports = parseCheckReports(engine.stdout);
		const checks = checkResults(team.checks ?? [], reports);
		await scoped?.checks([...reports].flatMap(([name, passed]) =>
			checks.some((check) => check.name === name) ? [{ name, passed }] : []));
		if (engine.timedOut) throw new Error(`engine timed out after ${team.engineTimeoutMinutes} minutes`);
		if (engine.code !== 0) throw new Error(`engine exited ${engine.code}\n${tail(engine)}\n${tailErr(engine)}`);
		if (scoped && checks.some((check) => check.passed !== true)) return { checks, engineCode: engine.code };

		const dirty = await git(wt, ["status", "--porcelain"], gitOptions);
		if (dirty.trim()) {
			// Container output is already staged by applying its checked patch.
			if (team.isolation !== "container") await git(wt, ["add", "-A"], gitOptions);
			await git(wt, ["commit", "-m", `${key}: ${detail.title}`], gitOptions);
		}
		if (followup) {
			const { record } = followup;
			const head = (await git(wt, ["rev-parse", "HEAD"], gitOptions)).trim();
			if (head !== record.head) {
				// Check ancestry before using a lease to require the exact remote commit this turn reviewed.
				await git(wt, ["merge-base", "--is-ancestor", record.head, head], gitOptions);
				const ref = `refs/heads/${branch}`;
				await git(wt, ["push", `--force-with-lease=${ref}:${record.head}`, team.remote, `${head}:${ref}`], gitOptions);
				await writeReviewState(...this.#reviewStateKey(teamKey, key), { ...record, head });
			}
			return { prUrl: record.prUrl, checks, engineTail: tail(engine), engineCode: engine.code };
		}
		// A clean worktree can still contain commits from a run whose push or PR creation failed.
		const commits = await git(wt, ["rev-list", "--count", `${base}..HEAD`], gitOptions);
		if (commits.trim() === "0") {
			return { prUrl: null, checks: scoped ? checks : [], engineTail: tail(engine), engineCode: engine.code, note: "the branch has no commits to publish" };
		}
		await git(wt, ["push", "-u", team.remote, "HEAD"], gitOptions);
		const { url: prUrl, created } = await this.#openPr({ wt, key, detail, checks, machine: hostname(), branch, team, containerOptions });
		const match = team.reviewRepository && created && reviewPrUrl.exec(prUrl);
		if (match && match[1].toLowerCase() === team.reviewRepository.toLowerCase()) {
			const head = (await git(wt, ["rev-parse", "HEAD"], gitOptions)).trim();
			await writeReviewState(...this.#reviewStateKey(teamKey, key), { prUrl, branch, head, processedReviewIds: [] });
		}
		return { prUrl, checks, engineTail: tail(engine), engineCode: engine.code };
	}

	async #runEngine(team, prompt, cwd, env, gitEnv, model, onStdoutLine, slotClaimId = null, sandbox = null, key = null) {
		const timeoutMs = team.engineTimeoutMinutes * 60_000;
		const validateOutcome = (engine) => {
			if (engine.code === 0 && !engine.timedOut && team.setup?.length > 0) {
				const report = engine.stdout.split(/\r?\n/).findLast((line) => line.startsWith("RUNNER-SETUP:"));
				if (report?.trim() !== "RUNNER-SETUP: pass") {
					throw new Error("engine did not report successful setup");
				}
			}
			return engine;
		};
		if (team.isolation === "cloud") {
			return validateOutcome(await this.cloud.run({
				key, sandbox, worktree: cwd, prompt, timeoutMs, onStdoutLine, log: this.log,
			}));
		}
		const argv = engineArgv(team.engine.command, prompt);
		if (team.isolation === "container") {
			const packages = team.container.packages && {
				kind: team.container.packages, fetchImpl: this.packageFetch,
			};
			return runContainerEngine({
				cwd, argv, image: team.container.image, timeoutMs, log: this.log, validateOutcome, gitEnv,
				model, packages, onStdoutLine,
			});
		}
		// A local engine's tree is sampled while it runs, so peaks.json holds measurements,
		// not point samples. Container runs are not sampled — the engine's processes live inside
		// the container, outside the client's tree; they are not measured. Sampling is best-effort and never fails the job.
		const options = {
			argv,
			cwd,
			env,
			timeoutMs,
			onStdoutLine,
			// `codex exec` prints its progress, and so each check as it finishes, on stderr. Those lines
			// move only the check checkpoint; the results the runner acts on come from stdout.
			onStderrLine: onStdoutLine,
			onSpawn: this.slots
				? (pid) => {
						this.#peakSampling = samplePeak({ pid, klass: "heavy", gate: this.slots, claimId: slotClaimId, log: this.log }).catch((error) =>
							this.log(`peak sampling stopped: ${error.message}`),
						);
					}
				: undefined,
		};
		if (process.platform !== "win32") return validateOutcome(await runProcess(options));

		// Give the Windows sandbox a small writable root instead of the user's shared temp tree.
		const tempDir = await mkdtemp(join(resolve(this.config.worktreesDir), ".engine-temp-"));
		const engineEnv = { ...env };
		for (const name of Object.keys(engineEnv)) {
			if (/^(temp|tmp)$/i.test(name)) delete engineEnv[name];
		}
		try {
			const engine = await runProcess({ ...options, env: { ...engineEnv, TEMP: tempDir, TMP: tempDir } });
			return validateOutcome(engine);
		} finally {
			await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
				this.log(`could not remove engine temp directory ${tempDir}: ${error.message}`);
			});
		}
	}

	async #worktree(team, dir, branch, options, reviewHead) {
		await mkdir(this.config.worktreesDir, { recursive: true });
		let how;
		if (reviewHead) {
			await git(team.repo, ["fetch", team.remote, `refs/heads/${branch}`], options);
			const fetched = (await git(team.repo, ["rev-parse", "FETCH_HEAD"], options)).trim();
			if (fetched !== reviewHead) throw new Error("the PR branch changed before the review could run");
			const checkout = options ? ["--no-checkout"] : [];
			await git(team.repo, ["worktree", "add", ...checkout, "--detach", dir, reviewHead], options);
		} else {
			await git(team.repo, ["fetch", team.remote, team.base], { ...options, timeout: 120_000 });
			how = await ensureWorktree(team.repo, dir, branch, `${team.remote}/${team.base}`, {
				...options, noCheckout: team.isolation === "container",
			});
		}
		if (options) {
			// Conditional Git config can differ once the linked worktree exists.
			options.env = await containerGitEnv(dir, options.env);
			await git(dir, ["read-tree", "--reset", "-u", "HEAD"], options);
		}
		if (how === "reused") this.log(`${branch}: reusing the branch an earlier run left, commits preserved`);
		return dir;
	}

	async #openPr({ wt, key, detail, checks, machine, branch, team, containerOptions }) {
		const options = { cwd: wt, timeout: 120_000 };
		if (containerOptions) options.env = containerOptions.env;
		const { stdout: matches } = await this.runGh("gh", [
			"pr", "list", "--head", branch, "--base", team.base, "--state", "open", "--json", "url",
		], options);
		const existing = JSON.parse(matches)[0]?.url;
		if (existing) return { url: existing, created: false };

		const body = [
			`Works on ${detail.url ?? key}.`,
			"",
			`## What the ${runnerNoun(team)} did`,
			"",
			// A cloud team's repository is public, and its job did not run here: no machine name.
			team.isolation === "cloud" ? "- engine: Codex in a Docker Cloud sandbox" : `- machine: ${machine}`,
			`- branch: \`${branch}\``,
			"",
			"## Checks",
			"",
			...(checks.length
				? checks.map((c) => `- ${checkMark(c)} \`${c.name}\` (run by the engine inside its sandbox)`)
				: ["- none configured"]),
			"",
			`_Opened by the ${team.isolation === "cloud" ? "runner for a Docker Cloud run" : "local runner"}. It does not merge._`,
		].join("\n");
		const bodyFile = join(tmpdir(), `runner-pr-${key}-${Date.now()}.md`);
		await writeFile(bodyFile, body);
		try {
			const { stdout } = await this.runGh("gh", [
				"pr", "create",
				"--title", `${key}: ${detail.title}`,
				"--body-file", bodyFile,
				"--base", team.base,
				"--head", branch,
			], options);
			return { url: stdout.trim().split("\n").pop(), created: true };
		} finally {
			await rm(bodyFile, { force: true });
		}
	}

	async #finish({ key, team, detail, outcome, machine, started, scoped }) {
		const minutes = Math.round((Date.now() - started) / 60000);
		this.log(`${key}: finished in ${minutes} min — ${outcome.prUrl ?? outcome.note ?? "no pull request"}`);
		const lines = [scoped ? `${runnerName(team)} finished in ${minutes} min.` :
			`Finished in ${minutes} min on ${machine} (engine: ${engineName(team)}).`];
		if (outcome.prUrl) lines.push(`Pull request: ${outcome.prUrl}`);
		else lines.push(`No pull request: ${outcome.note ?? "nothing to open"}.`);
		if (!scoped && outcome.checks?.length) {
			lines.push("", "Checks (run by the engine inside its sandbox):", ...outcome.checks.map((c) => `- ${checkMark(c)} \`${c.name}\``));
		}
		if (!scoped && outcome.engineTail) lines.push("", "Engine output (tail):", "```", outcome.engineTail.slice(-1500), "```");
		await this.track.call("add_comment", { workspace: this.config.workspace, key, body: lines.join("\n") });
		await this.#moveAndNote(key, outcome.prUrl ? team.reviewStatus : team.todoStatus);
	}

	async #fail({ key, team, error, followup, scoped }) {
		this.log(`${key}: failed — ${error.message}`);
		try {
			const body = scoped ? `The ${runnerNoun(team)} could not finish this issue. See the local runner log.` :
				`The local runner could not finish this issue: ${String(error.message).slice(0, 800)}`;
			await this.track.call("add_comment", { workspace: this.config.workspace, key, body });
			await this.#moveAndNote(key, followup ? team.reviewStatus : team.todoStatus);
		} catch (commentError) {
			this.log(`${key}: could not report the failure to Track: ${commentError.message}`);
		}
	}

	async #cleanup(worktree, branch, team, options) {
		try {
			await removeWorktree(team.repo, worktree, options);
		} catch {
			this.log(`could not remove worktree ${worktree}; remove it by hand`);
		}
	}
}

/** How Track comments and reports name the executor, at the start of a sentence. */
function runnerName(team) {
	return team.isolation === "cloud" ? "Docker Cloud run" : "Local runner";
}

/** The same name inside a sentence: "the local runner", but "the Docker Cloud run". */
function runnerNoun(team) {
	return team.isolation === "cloud" ? "Docker Cloud run" : "local runner";
}

/** Where the engine works, for its prompt. A Docker Cloud job never runs on this machine. */
function workplace(team) {
	return team.isolation === "cloud" ? "a Docker Cloud sandbox" : hostname();
}

function engineName(team) {
	return team.isolation === "cloud" ? "Codex in Docker Cloud" : team.engine.command[0];
}

function buildPrompt({ detail, machine, setup, checks, review, resume }) {
	const description = (detail.description ?? "").slice(0, review ? 12_000 : 30_000);
	const lines = [
		`You are working in a git worktree of the repository on ${machine}, for Track issue ${detail.key}: ${detail.title}.`,
		"",
		description || "(no description)",
		"",
		...(resume ? ["Continue from the retained changes in this worktree. Review them first and run the required checks again.", ""] : []),
		...(review ? [
			"Address the submitted GitHub review on this PR within the scope of the issue.",
			`Review feedback from ${review.login}:`,
			review.body.slice(0, 8_000),
			"",
		] : []),
		"Make the change the issue asks for. Edit files only: do not commit, do not push, do not open pull requests, do not run git commands that change history.",
		"Stay inside this directory. Do not read credentials or files outside it.",
	];
	if (setup.length) {
		lines.push(
			"",
			"Before editing files, run these setup commands in order inside your sandbox.",
			"Stop if any command fails and include `RUNNER-SETUP: fail` in your final output.",
			"If every setup command succeeds, include `RUNNER-SETUP: pass` in your final output.",
			...setup.map((command) => `- ${command}`),
		);
	}
	if (checks.length) {
		lines.push(
			"",
			"Run each command in this directory, inside your sandbox. As each check finishes, report its result on its own line exactly as `RUNNER-CHECK: <name> = pass` or `RUNNER-CHECK: <name> = fail`:",
			...checks.map((c) => typeof c === "string" ? `- ${c}: ${c}` : `- ${c.name ?? c.command}: ${c.command}`),
			// `codex exec` prints only its final message on stdout, and the runner reads the results there.
			"When every check has finished, repeat each `RUNNER-CHECK` line, one per line, in your final output.",
			"",
		);
	}
	lines.push("When done, print a short summary: what you changed and what you ran.");
	return lines.join("\n");
}

/** The configured checks with what the engine reported; `passed` is null when not reported. */
function checkResults(checks, reports) {
	return checks.map((check) => {
		const name = typeof check === "string" ? check : check.name ?? check.command;
		const command = typeof check === "string" ? check : check.command;
		const passed = reports.get(name);
		return { name, command, passed: passed === undefined ? null : passed };
	});
}

const checkMark = (c) => (c.passed === null ? "not reported" : c.passed ? "passed" : "FAILED");

const tail = (r) => (r.stdout ?? "").trim().split("\n").slice(-20).join("\n");
const tailErr = (r) => (r.stderr ?? "").trim().split("\n").slice(-10).join("\n");

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = await loadConfig(args.config);
	if (args.inspectWork) {
		console.log((await inspectScopedWork(config, args.inspectWork)) ?? `No local attempt for ${args.inspectWork}`);
		return;
	}
	const key = process.env[config.track.keyEnv];
	if (!key) throw new Error(`environment variable ${config.track.keyEnv} is not set (the agent member's Track key)`);

	await mkdir(config.logDir, { recursive: true });
	const day = new Date().toISOString().slice(0, 10);
	const logFile = join(config.logDir, `runner-${day}.log`);
	const log = (message) => {
		const line = `[${new Date().toISOString()}] ${message}`;
		console.log(line);
		appendFile(logFile, `${line}\n`).catch(() => {});
	};

	const track = new TrackMcp({ url: config.track.url, key });
	const slots = new SlotsGate({
		dir: config.slots.dir,
		mode: config.slots.mode,
		reserveBytes: config.slots.reserveGib * GIB,
		maxHeavy: config.slots.maxHeavy,
		log: (message) => log(`[slots] ${message}`),
	});
	const runner = new Runner(config, { track, log, dryRun: args.dryRun, slots });
	log(`runner starting against ${config.track.url}, workspace ${config.workspace}${args.dryRun ? " (dry run)" : ""}, admission gate ${config.slots.mode}`);
	for (const [teamKey, team] of Object.entries(config.teams)) {
		const relays = [];
		if (team.isolation === "container") {
			if (team.container.model) relays.push("model");
			if (team.container.packages) relays.push("packages");
		}
		const mode = team.isolation === "container"
			? relays.length ? ` (${relays.join(" and ")} relay)` : " (offline)"
			: "";
		log(`${teamKey}: isolation ${team.isolation}${mode}`);
	}

	if (args.resumeWork) {
		if (runner.paused()) throw new Error(`paused: ${config.pauseFile} exists`);
		if ((await runner.dailyCount()) >= config.dailyLimit) throw new Error(`daily limit ${config.dailyLimit} reached`);
		await runner.replayReports();
		await runner.resumeWork(args.resumeWork.key, args.resumeWork.attemptId);
		return;
	}

	for (;;) {
		try {
			await runner.replayReports();
			if (runner.paused()) {
				log(`paused: ${config.pauseFile} exists`);
			} else if ((await runner.dailyCount()) >= config.dailyLimit) {
				log(`daily limit ${config.dailyLimit} reached`);
			} else {
				const work = await runner.findWork();
				if (work) {
					// The pickup count moves inside run(), once the claim is verified and never on a dry run.
					await runner.run(work);
				} else {
					log("nothing assigned");
				}
			}
		} catch (error) {
			log(`poll failed: ${error.message}`);
		}
		if (args.once) break;
		await sleep(config.pollSeconds * 1000);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`runner: ${error.message}`);
		process.exit(1);
	});
}
