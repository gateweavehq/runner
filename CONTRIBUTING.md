# Contributing to gateweave-runner

Thanks for helping out! This guide covers how to get a working setup and what we look for in a
pull request. Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

Issues labelled [good first issue](https://github.com/gateweavehq/runner/labels/good%20first%20issue)
are small, and each says where to look and when it's done. Say in the issue that you're taking
one, so nobody does it twice, and ask there if you get stuck. For anything large, open an issue
first.

## Setup

You need Node 24 and `git`. The runner has one dependency.

```sh
npm ci
npm test          # every *.test.mjs, with node's built-in test runner
```

`npm test` skips the Docker-backed tests and reports them as skipped. To include them, set
`TRACK_RUNNER_DOCKER_TEST=1` (needs a local Docker daemon, the host `tar` command and the
`node:24-bookworm-slim` image) and, for the pnpm relay, `TRACK_RUNNER_PNPM_DOCKER_TEST=1` (see
the README's Tests section). Run one file with `node --test runner.test.mjs`.

The README explains what the runner does and how each feature fits together. Read its sections
on the engine's environment and on isolation before changing `env.mjs`, `config.mjs`,
`container.mjs` or `cloud.mjs`.

## Contributor License Agreement

The runner is open source under the AGPL-3.0. The maintainer also offers Gateweave projects under
other terms, such as hosted services and commercial licenses, and these help fund the work. So
that every contribution can be part of both, contributors sign the [CLA](CLA.md) once, and it
covers every Gateweave project. You keep the copyright to your work.

A bot asks you to sign on your first pull request. To sign, reply with the sentence it gives you.

## Before you open a pull request

```sh
npm test
```

Fill in the pull request template: it asks how you tested the change and whether it touches the
engine's environment, isolation or what leaves the machine.

## Guidelines

- **Keep changes focused.** One pull request should cover one concern.
- **Test behavior, not implementation.** The tests drive the runner against a fake Track server,
  fake engines and real local git remotes. Add a test for every bug fix and every new option. A
  fix gets a test that fails without it. Never weaken or skip a test to make a change pass.
- **Secrets stay out of the engine.** Anything that widens what an engine's environment, a
  container or a cloud sandbox receives needs a test and a note in the pull request.
- **Never print or log a key.** Log lines and comments name tasks and reasons, never a command
  line, prompt, environment or secret.
- **No dependencies without a reason.** Dependencies are pinned to exact versions.
- **Match the surrounding code.** Plain ES modules, tabs, no build step.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`. Add a scope when it helps, for example
`fix(slots): release a claim when its process is gone`.

## Working with AI coding agents

You are welcome to use one. [AGENTS.md](AGENTS.md) gives agents the project's commands,
invariants and conventions. You remain responsible for the change: review it, run `npm test`, and
make sure you can explain it in review.

## Reporting bugs

Open an issue using the bug report form: the steps to reproduce, what you expected, and what
happened. Report security problems privately, as described in [SECURITY.md](SECURITY.md), never
in a public issue.
