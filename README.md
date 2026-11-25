# gateweave-runner

A small program that runs on your own machine and works [Gateweave Track](https://github.com/gateweavehq/track)
issues with a local coding engine (Codex or Claude Code). An issue assigned to an agent member
becomes a branch and a pull request without anything of yours leaving the machine. It is a
self-hosted runner, like CI's, for agents.

It polls Track's MCP server (`/mcp`) with the agent member's key, takes an issue, moves it to In
Progress (and verifies the move, because Track can hold a status change as a proposal), comments
that it picked the issue up, makes a git worktree of the mapped repository, and hands the issue
to the engine with a scrubbed environment. The engine runs setup and the repository's checks
inside its sandbox. The runner pushes the branch and opens a pull request whose body lists the
reported checks, comments with the link and what ran, and moves the issue to In Review. It never
merges. When an initial turn fails, it comments why and moves the issue back to Todo.

The runner is licensed under the AGPL-3.0 and has one runtime dependency (`yaml`).

## Quickstart

You need Node 24, `git`, and `gh` signed in (`gh auth login`), plus a Track workspace and an
engine on your `PATH` (`codex` or `claude`).

```sh
git clone https://github.com/gateweavehq/runner.git
cd runner
npm ci
cp runner.config.example.mjs runner.config.mjs   # git-ignored: it names your machines
# edit runner.config.mjs: your Track URL, workspace, repositories, engine and checks
export GATEWEAVE_TRACK_RUNNER_KEY="gwt_..."      # the agent member's key; see Setup below
node runner.mjs --once --dry-run                 # one poll; prints what it would do, changes nothing
node runner.mjs --once                           # one poll and at most one issue
node runner.mjs                                  # poll forever
```

In Track, make an agent member for the runner (workspace settings, Agents), label an issue with
the team's `label` (`local-runner` in the example) and assign it to that member. Only issues an
owner or admin wrote and that carry the label are taken. The sections after this overview are the
reference: Setup, Running, the engine's environment, and each optional feature.

## How it talks to Track

- **MCP at `/mcp`.** The runner is an MCP client of Track (`track.mjs`: initialize, then
  `tools/call`). It reads and searches issues, verifies and changes their status, and comments
  through the same tools any agent member has, authenticated with the member's key. The key acts
  as that member, in that one workspace.
- **The work-runs API at `/api/work-runs/…`.** For teams that opt in with `workRunRepository`,
  an owner or admin first registers an assignment's work with `POST /api/work-runs/register`
  (from Track's own origin, with their session). The runner then uses three endpoints with its
  member's key as a bearer token: `find` (which registration covers this issue), `claim` (take
  an attempt; the claim hands back the attempt id and a report token) and `report` (progress
  events and the final outcome, each carrying the token and a sequence number). A claim must
  come from the executor the registration names, the local runner or a Docker Cloud run, and a
  report cannot change the attempt's issue, workspace or repository.
- **Reports survive restarts.** The claim and the report sequence are saved in the state
  directory, and unacknowledged reports are replayed on later polls, even while the runner is
  paused. The report token stays with the launcher and never reaches an engine.

## Isolation modes

Each team in the configuration picks one `isolation` mode. Every mode takes only issues a
workspace owner or admin wrote and that carry the team's label.

| Mode | Where the engine runs | Network | Notes |
| --- | --- | --- | --- |
| `worktree` (default) | On your machine, as you, in a git worktree, inside the engine's own sandbox | Whatever the engine's sandbox allows | The environment is scrubbed: only what the OS needs plus the names and values you list. Credentials such as `GH_TOKEN` or `GATEWEAVE_*` are refused. |
| `container` | In a local Docker container with a read-only root and a writable source snapshot | None, unless you enable the model relay or the package relay | The runner keeps Git metadata and credentials on the host, applies a checked patch from the snapshot, and publishes from the host. See Offline container isolation. |
| `cloud` | In a Docker Agentic Platform cloud sandbox (`sbx --cloud`) | The npm registry and nodejs.org, plus hosts you allow | Only for public source that needs nothing from your machine, and only for work an admin registered for the cloud. See Docker Cloud runs. |

## What it never does

- It never merges a pull request, and it never pushes to a base branch: it publishes a
  `runner/<issue>` branch and opens a pull request.
- It never gives an engine the Track key, the report token or a GitHub credential, and it
  refuses a configuration that passes `GATEWEAVE_*`, `GH_TOKEN`, `GITHUB_TOKEN`, `CLOUDFLARE_*`,
  `AWS_*`, `AZURE_*`, `KUBECONFIG`, `DOCKER_*`, `SSH_AUTH_SOCK` or `NPM_TOKEN` into one.
- It never runs engine-modified code itself: the engine runs setup and the checks inside its own
  sandbox, and the runner only reads the reports.
- It never takes an issue that is not assigned to its agent member, does not carry the team's
  label, or was not written by a workspace owner or admin. Startup rejects `untrusted: true`.
- It never runs a job on this machine that was sent to Docker Cloud: if the cloud cannot take
  it, the attempt waits in Track with the reason.
- It never gives the engine an MCP server or other tools: the engine gets the issue text and the
  files. A gateway for the engine may come later.
- It never starts a second attempt on its own after a launcher interruption; a person
  reconciles the attempt first.
- It runs one runner per agent member for teams that claim work through issue status. The
  scoped reporting teams claim through a Track claim instead.

## Continue after a GitHub review

Set `reviewRepository: "owner/repo"` on a team to enable follow-ups on pull requests the runner
creates for that team after enabling the setting. Leave its state directory in place between runs.
An issue in the team's review status must still carry the label and be assigned to the runner.

A submitted GitHub review with a written summary can start one turn. The reviewer needs write
access, and the review must refer to the current commit on the runner's PR branch. The runner
checks permission through GitHub using its own `gh` login. A follow-up uses the same pull request,
counts toward the daily limit, and returns the issue to the review status when it finishes or
fails. After a failure, submit a new review to request another turn. Inline-only reviews,
ordinary PR comments, and reviews on branches advanced outside the runner are outside this flow.

## The admission gate

Local heavy work — runner jobs and hand-started Codex jobs alike — shares one machine, so one
lock decides who starts. Claims live as files in `~/.codex-jobs/.slots/` (configurable with
`slots.dir`), taken through a `mkdir` lock, so two starters racing for the last slot cannot both
win.

- **Classes**: `heavy` is installs, builds, test suites and verification; `light` is review,
  docs and issue prep. One heavy at a time by default (`slots.maxHeavy`); light jobs take no
  slot but are recorded.
- **Admission by measurement**: a second heavy claim is admitted only when available memory
  minus the class's *measured peak* stays above the reserve (`slots.reserveGib`, default 2).
  Available memory is `os.freemem()`, and the commit charge against the commit limit is checked
  too. Peaks come from `peaks.json`, filled by `samplePeak` while jobs run — never a point
  sample. It records two figures per job: the peak working set of its process tree, and how far
  the host's available memory fell since the job began. Admission subtracts the second once a
  job has measured it, because the tree's sum counts a page its processes share once per
  process, so the working set can be well above what a job takes from the host. The 2 GiB
  reserve keeps room for the OS and other work. A held job's reason says what
  the peak would leave ("available 7.0 GiB leaves 1.0 GiB after a heavy job's measured 6.0 GiB,
  below the 2.0 GiB reserve"). Container-isolated engine runs are not sampled (the processes
  live inside the container); their peaks are not recorded.
- **Reconciliation** runs on every acquire and status: a gone process, a process id reused with
  a different start time, a launch that never got a process, and claims older than a reboot all
  end as history entries (`history.jsonl`) with how they ended — cleanly with the exit code,
  interrupted, or stopped under pressure. Stopped-under-pressure worktrees are left as they are
  and nothing relaunches them.
- **Advise before enforce**: the default `advise` mode admits exactly as before and only logs
  what enforce would have decided, with the numbers. Switch `slots.mode` to `enforce` only
  after a pilot (>=20 launches or one week with no reap among
  would-be-admitted).

The runner asks the gate before it claims an issue; a held job is skipped untouched and the next
poll tries again. Its claim names the runner's own process, which holds it until the job is
done, push and pull request included. While a local engine runs, its process tree is sampled
every few seconds and the class peak is recorded, along with the claim's own peak.

The same gate serves hand launches through the CLI — call it before `codex exec` and after it
ends:

```
node slots-cli.mjs acquire --class heavy --task ENG-69 --launcher hand --worktree <path> [--pid <pid>] [--docker-cloud-ok]
node slots-cli.mjs attach --id <claimId> --pid <pid>
node slots-cli.mjs peak --pid <pid> --class heavy        # sample while the job runs
node slots-cli.mjs release --id <claimId> [--code <n>]   # after it ends
node slots-cli.mjs status [--json]                       # claims, memory, peaks, history
node slots-cli.mjs reap                                  # record a reap notice's memory
```

`acquire` prints one JSON line and exits 0 when admitted, 3 when held (the reason is in the
line, in plain words — never a command line, prompt, environment or secret). Options `--dir`,
`--mode`, `--reserve-gib`, `--max-heavy` override the defaults for one call. A job that could
run on Docker Cloud (public repository, no local credential needed) carries `--docker-cloud-ok`,
and a held reason then says it is eligible.

## Routing advice

Each team can say what its repository needs, and the runner works out where a job would run:

```js
routing: { source: "public", needs: [] }   // needs: "secrets", "host-services", "interactive"
```

A public repository that needs none of these is advised to Docker Cloud. Private source,
secrets that stay on this machine, services bound to this machine or account, and work that
needs a person stay local or on an approved runner. A team without `routing` assumes nothing
and stays local. Every field is spelled out, and an unknown field or need is refused, so a typo
never makes a job look portable.

Advice alone moves nothing: a job runs here, and the logs and history say so, unless its team
runs in Docker Cloud (next section). The advice and
its reasons go on the job's gate claim, with the admission decision, the Track attempt it works
for and its measured peak. Each ended claim's `history.jsonl` line keeps them, however the
claim ended. A cloud-advised job shows up as cloud-advised, never as a local one. The pilot
reviews the summary before any routing is switched on:

```
node slots-cli.mjs report [--since 2026-11-25] [--json]
```

It counts the launches, the advice and why jobs stayed local, what enforce would have held, how
claims ended and how many were interrupted (cloud-advised ones too), and the median and highest
peaks. A hand job carrying `--docker-cloud-ok` counts as cloud-advised on the launcher's word;
`peak --id <claimId>` records a hand job's own peak.

## Docker Cloud runs

A team with `isolation: "cloud"` runs its engine, Codex, in a Docker Agentic Platform cloud
sandbox (`sbx --cloud`) using the Codex sign-in that the sandbox's `codex` kit
carries. Everything else stays on this machine: the runner claims the work, makes the worktree,
commits, pushes, opens the pull request and reports to Track.

```js
CLOUD: {
  repo: "~/projects/site", label: "local-runner", workRunRepository: "acme/site",
  isolation: "cloud", routing: { source: "public", needs: [] },
  cloud: { cpus: 4, memory: "8g", model: "gpt-6.2-sol", effort: "medium", allow: [], pollSeconds: 60 },
  checks: [{ name: "test", command: "npm test" }],
},
```

- **Only what an admin sent to the cloud.** The team needs `workRunRepository`, and Track must
  have the work registered with `executor: "cloud"`. Track refuses a claim from the other
  executor: the local runner never picks up cloud work, and a cloud team never picks up local
  work. Startup also refuses a cloud team whose `routing` does not advise Docker Cloud, so
  private source, secrets, host services or work that needs a person are never sent there by
  this setting. A cloud team has no `engine` and no `env`.
- **What leaves the machine:** the worktree's tracked and untracked-but-not-ignored files as a
  tarball, and the prompt. Never the Track key, the report token or a GitHub credential. The
  sandbox reaches the npm registry and nodejs.org, plus the hosts in `cloud.allow`. Codex runs
  the setup and checks there and reports them as RUNNER-CHECK lines, as a local engine does.
  Its changes come back as a patch, applied to the host worktree.
- **When Docker Cloud cannot take the job** (no credit, no capacity, an error), the sandbox is
  asked for before the board moves. The attempt stays queued in Track with the reason
  (`budget-limit` when Docker names credit or billing, otherwise `retry`), and a later poll tries
  again, one launcher at a time. The job is never run on this machine instead. A
  launcher that dies while trying leaves the attempt waiting for an admin to reconcile it.
- **The sandbox is removed** however the job ends. Docker keeps a new sandbox for an hour, and
  the runner extends it to the engine's timeout plus 15 minutes. A runner that dies leaves it to
  that TTL; list
  and remove leftovers with `sbx --cloud ls` and `sbx --cloud rm <name>`. Sandboxes are named
  `gw-<issue>-<attempt>`, and their files are kept under `stateDir/cloud/`.
- **Cost:** Docker bills the sandbox's runtime to the account `sbx` is signed in to. A cloud job
  takes a light admission slot here, since its heavy work runs there.

The machine needs `sbx` signed in (`sbx login`), on the `PATH` or named by `SBX`.

## Setup (once)

1. **Node 24** (`node --version`), `git`, and `gh` (authenticated: `gh auth login`).
2. **An agent member in Track**: workspace settings, Agents — create one (for example
   `local-runner`), copy its key (`gwt_…`). It acts as itself, in that one workspace.
3. **The key in the environment**, never in a file the engine can read:
   `setx GATEWEAVE_TRACK_RUNNER_KEY "gwt_…"` (Windows) or export it in the shell you start the
   runner from. The runner refuses to start without it and never passes it to an engine.
4. **A configuration**: copy `runner.config.example.mjs` to `runner.config.mjs` next to this file
   (or anywhere; pass `--config`) and fill in your repositories, engines and checks. Keep
   `runner.config.mjs` out of git: it names your machines.
5. **Label discipline**: in Track, label an issue `local-runner` (the team's `label`) and assign it
   to the agent member. Only such issues, written by an owner or admin, are taken.

The Codex example uses `~/.codex-runner` as its own profile. Sign in once with `CODEX_HOME` set to
that directory, then start the runner. The example uses `workspace-write` and approval policy
`never`, so commands requiring approval fail within the unattended run. On Windows it selects
MXC, which requires a compatible Windows device.

## Running

```
node runner.mjs --once --dry-run   # one poll, prints what it would do, changes nothing
node runner.mjs --once             # one poll and one issue at most
node runner.mjs                    # poll forever (Ctrl-C stops; the current issue's worktree is removed)
```

- **Pause**: create the file `pauseFile` names (empty is enough); the runner idles until it is
  removed.
- **Daily limit**: `dailyLimit` pickups per local day, counted in `stateDir/state.json`.
- **Logs**: `logDir/runner-<date>.log` plus stdout.
- **Worktrees**: `worktreesDir/<ISSUE-KEY>`, removed after each run; the branch (`runner/<key>`)
  preserves the issue's commits. A retry can publish those commits with a clean worktree.

## The engine's environment

In `worktree` mode the engine runs as you and needs its own sandbox. It starts with only what
the OS needs (`PATH`, `SystemRoot`, `TEMP`, `HOME`/
`USERPROFILE`, locale) plus the names in `teams.<team>.env.pass` and the literal values in
`teams.<team>.env.set`. The configuration **refuses** to pass `GATEWEAVE_*`, `GH_TOKEN`,
`GITHUB_TOKEN`, `CLOUDFLARE_*`, `AWS_*`, `AZURE_*`, `KUBECONFIG`, `DOCKER_*`, `SSH_AUTH_SOCK`,
`NPM_TOKEN` and the runner's own key variable. A task that needs a real provider key or a staging
secret is not given one: finish without it or say what was lacking. `teams.<team>.setup`
runs inside the engine's sandbox before editing (for our repositories:
`pnpm install --frozen-lockfile`, `pnpm dev:setup`). A worktree never receives another checkout's
`.dev.vars`.

On Windows the runner gives each engine run a fresh `TEMP` and `TMP` directory under
`worktreesDir` and removes it when the engine exits. This applies even if those variables were
set in the runner environment or the team's configuration.

## Offline container isolation

Set a team's `isolation` to `"container"`, set
`container: { image: "your-offline-engine:version" }` and give `engine.command` the executable
and arguments as they exist inside that image. The image must already be installed on a local
Docker daemon. On Unix, use an ordinary non-root account to run the runner.

Setup, editing and checks share one container with a read-only root, a writable source snapshot,
and temporary scratch space. The container has no network, so preload anything the engine and
setup need in the image. This mode accepts no `env.pass` or `env.set`. The runner keeps Git
metadata and credentials on the host, applies a checked patch from the snapshot, and publishes
the branch and pull request from the host. Host Git commands run with hooks, filesystem monitors
and external Git filters disabled in this mode. Use a trusted image containing the offline engine.

## Container model relay

To enable the OpenAI Responses API for a container engine, set
`container.model: { name: "gpt-6.2-sol", maxRequests: 8 }` in the team's configuration and
give the host runner an `OPENAI_API_KEY`. The relay requires the locally installed
`node:24-bookworm-slim` image and a Docker version that supports isolated internal bridges.
The request limit defaults to eight per run. Failed upstream requests consume a slot.

The engine receives `RUNNER_MODEL_BASE_URL` and the temporary `RUNNER_MODEL_TOKEN`. Requests
can reach only the relay inside the per-run Docker network. The runner forwards Responses
requests for the configured model from the host. The provider key stays in the runner process.

For a Codex image, use this block together in the team's configuration. Docker supplies the
execution sandbox. The nested Linux workspace sandbox can require user namespaces that the
container does not grant.

```js
{
  isolation: "container",
  container: {
    image: "your-codex-image:version",
    model: { name: "gpt-6.2-sol", maxRequests: 8 },
  },
  engine: {
    command: [
      "codex", "-a", "never",
      "-c", 'model_provider="runner_relay"',
      "-c", 'model_providers.runner_relay.name="Gateweave runner"',
      "-c", 'model_providers.runner_relay.base_url="http://model-relay:8787/v1"',
      "-c", 'model_providers.runner_relay.env_key="RUNNER_MODEL_TOKEN"',
      "-c", 'model_providers.runner_relay.supports_websockets=false',
      "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "--sandbox", "danger-full-access", "--model", "gpt-6.2-sol", "{prompt}",
    ],
  },
}
```

## Container package relay

Set `container.packages` to `"npm"` for a root `package-lock.json` or `"pnpm"` for a root
`pnpm-lock.yaml`. When using pnpm, run `npm ci` on the host first
to install the runner's pinned YAML parser. The engine image needs its own npm or pnpm binary.

The runner reads the committed lockfile before opening the per-run Docker network. The relay
serves only versions present in that lockfile and verifies public npm tarball bytes against
their pinned SHA-512 integrity before returning them. It sets `npm_config_registry` and
`RUNNER_PACKAGE_REGISTRY` inside the engine. Use `npm ci --no-audit` or
`pnpm install --frozen-lockfile --registry="$RUNNER_PACKAGE_REGISTRY" --network-concurrency=8`
during setup. Private registries, dependency updates and
downloads from arbitrary hosts require a different setup.

The relay supports npm lockfile versions 2 and 3 and all documents in a pnpm version 9 lockfile.
Each tarball is limited to 64 MiB and verified in a temporary file outside the checkout before
the runner streams it to the engine. A run has a total download limit of 512 MiB and 2,048
upstream download attempts.

Keep generated `node_modules` directories in the repository's Git ignore rules so they stay out
of the published patch.

The package relay can run on its own or alongside the model relay. With neither relay enabled,
the container stays offline.

## Setup and checks in the engine's sandbox

The engine reports configured setup as `RUNNER-SETUP: pass` or `RUNNER-SETUP: fail`. The runner
requires the success report before publishing. The engine runs the checks as its last step and
reports each as `RUNNER-CHECK: <name> = pass|fail`. The pull request shows missing check reports
as "not reported". The engine's session timeout covers setup, editing and checks.

## Tests

```
npm ci
npm test
```

Set `TRACK_RUNNER_DOCKER_TEST=1` to include the container integration tests with a
local Docker daemon, host `tar` command, and the `node:24-bookworm-slim` image.
Set `TRACK_RUNNER_PNPM_DOCKER_TEST=1` to also exercise pnpm with a local
`gateweave-runner-pnpm-probe:12.4.2` image built from Node 24 with pnpm 12.4.2 installed.

Covers the environment scrub, the configuration checks, candidate filtering, the prompt
substitution, check-report parsing, status verification, dry-run quota, worktree reuse, SSE/JSON
parsing, and the Track MCP client against a fake server (handshake, session header, tools/call,
refused key, reconnect after a failed handshake). The review integration test exercises the
original PR branch and replay protection against a real local Git remote with mocked APIs. The
gate's tests (`slots.test.mjs`) run on simulated memory and processes: racing contenders, the
reserve, unclaimed load, measured peaks, stale and reused process ids, interrupted launches,
stopped-under-pressure marking, advise mode, release by claim id, and that status never carries
a command line or environment. They also cover what an ended claim's history keeps for the routing
pilot and the report over it. `routing.test.mjs` covers the routing advice, its configuration,
and the runner recording it for each job while still running the job here.

## Smoke test

For the first run on a machine, use `--once --dry-run`, then `--once` on a labelled test issue
in a throwaway repository with the intended Track agent member and GitHub login.

### Scoped run reporting

Set `workRunRepository` to the GitHub `owner/repo` for an opted-in team. The runner checks both
fetch and push remotes against that mapping. In Track, assign the issue to the runner and have
an owner or admin register it with `POST /api/work-runs/register` from the Track origin. The
body contains `workspace`, `issue`, `repository` and the team's Agents reporting `sourceId`.

The launcher claims the assignment before moving the board status. It saves the claim ID and
report sequence in its local state directory. Later polls replay unacknowledged reports even
when the runner is paused. The report token stays with the launcher and is recovered from the
same claim as needed. A launcher interruption never starts the same attempt again. Use
`node runner.mjs --inspect-work ENG-1` to read the recorded branch, base, change summary and
last reported check before reconciling or requesting another attempt. This command runs locally
and needs no Track key.

For a retained local worktree, review the previous attempt and any existing PR, and confirm the
executor has stopped. If Track still shows the attempt as active, a workspace admin records the
verified outcome through `POST /api/work-runs/reconcile`. Then run
`node runner.mjs --resume-work ENG-1 <previous-attempt-id>` for an attempt closed as failed or cancelled.
The command displays the prior evidence and claims one new attempt under the same work request.
It keeps the branch and worktree and uses the existing PR if one is open. A changed base, repository
mapping or runner capability leaves the request waiting with a local reason. An isolated container
checkout is discarded by the container runner and requires a separate recovery path.
