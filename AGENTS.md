# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It is the single source
of truth for how the project is built; tool-specific files only add to it.

## The project

gateweave-runner is a local program that works Gateweave Track issues with a local coding engine
(Codex or Claude Code) and opens pull requests. It runs on a person's own machine. Read
[README.md](README.md) before changing behavior.

## Repository map

| File | What lives there |
| --- | --- |
| `runner.mjs` | The poll loop, the job flow (claim, worktree, engine, publish, report), and the CLI |
| `config.mjs`, `runner.config.example.mjs` | Configuration parsing and its refusals; the example users copy |
| `pick.mjs` | Which searched issues a team may take (pure, no I/O) |
| `track.mjs` | The MCP client for Track's `/mcp` and the `/api/work-runs` calls |
| `work-runs.mjs` | Scoped work: claim, saved state, replayed reports, inspect and resume |
| `env.mjs`, `process.mjs`, `git.mjs` | The scrubbed engine environment, process trees, git helpers |
| `container.mjs`, `model-relay.mjs`, `model-relay-sidecar.cjs`, `model-policy.mjs`, `package-policy.mjs` | Offline container isolation and its two relays |
| `cloud.mjs` | The Docker Cloud sandbox engine |
| `slots.mjs`, `slots-cli.mjs` | The local admission gate and its CLI |
| `routing.mjs` | Routing advice |
| `review-*.mjs` | Continuing after a GitHub review |
| `*.test.mjs` | Tests, one per module |

## Commands

Requirements: Node 24.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the one dependency |
| `npm test` | Run every test with `node --test` |
| `node --test <file>` | Run one test file |
| `node runner.mjs --once --dry-run` | One poll that changes nothing (needs a config and a key) |

There is no build step and no linter. Docker-backed tests run only with
`TRACK_RUNNER_DOCKER_TEST=1`; without it they are reported as skipped, which is not a pass.

## Invariants

These are load-bearing. Breaking one breaks users' security, usually silently.

1. **The runner never merges** and never pushes to a base branch.
2. **Credentials stay out of the engine.** The Track key, the report token and any GitHub
   credential never enter an engine's environment, a container or a cloud sandbox. The
   configuration refuses to pass the names listed in `config.mjs`; keep that list complete.
3. **The runner never runs engine-modified code.** The engine runs setup and checks in its own
   sandbox; the runner reads the reports.
4. **Only trusted work is taken**: assigned to the runner's member, carrying the team's label,
   written by a workspace owner or admin.
5. **A cloud job never falls back to this machine.** If Docker Cloud cannot take it, the attempt
   waits in Track with the reason.
6. **Claims, logs and comments carry no command line, prompt, environment or secret.**
7. **A status change is verified.** Track can hold one as a proposal; the runner checks it moved.
8. **A launcher interruption never starts the same attempt again.**

## Code style

- Plain ES modules (`.mjs`), tabs, double quotes. No build step, no TypeScript.
- Comments explain why, not what. Match the tone and density of the file you are editing.
- Dependencies are pinned to exact versions; the runner has one.
- Keep modules small and I/O at the edges: `pick.mjs` is pure so its rules are testable.

## Testing

- Test behavior through public functions. Tests use a fake Track server, fake engines and local
  git remotes; none needs the network.
- Every bug fix gets a test that fails without the fix. Never weaken or skip a test to make a
  change pass.

## Git and pull requests

- `main` is protected: changes land through pull requests with a green CI run. Branch from
  `main` as `feat/...`, `fix/...`, `docs/...` or `chore/...`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), with a
  scope when it helps. Explain why in the body.
- Commits, pull requests, comments and release notes carry no AI attribution: no
  `Co-authored-by` trailer naming an AI, no "Generated with" line and no session link. If your
  tool adds them, take them out before you push.
- Never put a secret, a personal email, an account id or a path from your own machine into a
  file, a commit or a pull request.
- Fill in the pull request template. A bot asks first-time contributors to sign the
  [CLA](CLA.md) once.
