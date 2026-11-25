# Security policy

## Supported versions

gateweave-runner is in early development. Security fixes go into `main` and the latest release only.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/runner/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
We aim to reply within three working days, and will keep you updated while we work on a fix,
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- A credential (the Track key, the report token, a GitHub token) reaching an engine, a
  container, a cloud sandbox, a log, a comment or a pull request.
- An issue the runner should not take (not assigned to it, not labelled, not written by an owner
  or admin) being taken.
- An engine escaping its worktree, container or sandbox through something the runner sets up.
- The runner merging, pushing to a base branch, or running engine-modified code itself.
- The package relay or model relay serving anything outside the lockfile or the configured model.
