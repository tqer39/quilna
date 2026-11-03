# Development tooling

[English](development-tooling.md) | [日本語](development-tooling.ja.md)

## Shared development standards

This repository adopts [dev-standards](https://github.com/tqer39/dev-standards) with a `node-npm` primary component and explicitly declared Go/Swift companion packages.
See the [language decision](decisions/0001-language.md) for the boundaries of each check.
Mixed-package support and duplicate verification-task rejection were merged into `main` in [source PR #13](https://github.com/tqer39/dev-standards/pull/13).
`.standards/cli-source.json` pins the adopted `0.4.2` source to the merge commit. Build that commit; the setup does not depend on a release tag or the PR branch.

For a fresh checkout, clone the source separately and build its CLI using the pinned Go toolchain:

```bash
git clone --branch main https://github.com/tqer39/dev-standards.git ../dev-standards
cd ../dev-standards
git checkout --detach da61121476f3e6758a3e729e010d30d190408bc3
mise trust
mise run build
cd ../quilna
../dev-standards/bin/dev-standards sync
mise trust
mise run bootstrap
mise run standards:prepare
```

Use your actual checkout directory instead of `../quilna` when it differs.
Check `.standards/lock.json` against the source CLI's `version` output before syncing; a mismatched bundle is not an implicit update.
The CLI cache is private and ignored by Git. The Node.js and Go pins remain in mise; Swift/Xcode must be available on macOS.
Combined verification currently runs on macOS because of the Swift companion.
The existing browser/Go Linux jobs and Apple CI remain unchanged.

```bash
mise run standards:version
mise run standards:verify
mise run standards:finish
```

`standards:verify` runs browser lint, formatting checks, unit/server tests and build, then Go formatting/vet/race tests and Swift package tests/macOS build.
It does not run browser E2E, Workers tests, iOS builds, native UI acceptance, or performance benchmarks.
Existing tasks and CI retain those checks. Browser formatting is scoped to `src/`, `server/`, and `workers/`; Markdown remains checked by the existing documentation and Markdown lint rules.
Codex hooks request configuration/verification checks; a new checkout still needs the CLI cache and the app's normal project/hook trust configuration.

Edit `.standards/mise.project.toml`, `.standards/tasks.project.toml`, `.standards/agents.local.md`, and `.standards/*.local` as appropriate.
Do not directly edit managed output such as root `mise.toml`, `AGENTS.md`, or `.gitignore`.
After changing canonical sources:

```bash
./.standards/cache/dev-standards plan --output .standards/plans/update.json
# Review the plan; exit code 1 means changes are proposed.
./.standards/cache/dev-standards apply --plan .standards/plans/update.json
mise run standards:prepare
```

The initial companion declaration is retained in `.standards/companions.json`; subsequent plans read the declarations in `.standards/repository.yml`.
The local maintenance host is enrolled separately. A clone does not enable a schedule, and adopting a merged source commit does not prove automatic updates have succeeded.

## Local agent telemetry

[agent-telemetry](https://github.com/tqer39/agent-telemetry) observes Claude/Codex development sessions, independently of application code.
Use its README to set up the local Docker stack and Desktop/CLI client settings once per host.
If that stack and the client settings are already configured, this checkout needs no additional exporter or transcript copy.
The current repository remote identifies sessions as `project="quilna"`, including Codex worktrees.

```bash
mise run telemetry:check
```

This reads Collector health and the count of indexed Quilna sessions from local Prometheus.
It fails if the services are unavailable or no matching sessions have been indexed; this is an optional local diagnostic, not a CI dependency.
It does not prove that every Desktop OTLP signal arrives or that the current chat has already been indexed.
Open [local Grafana](http://127.0.0.1:3000), then choose **Agent Telemetry → Agent Sessions** and the `quilna` project.
The ports remain bound to localhost; client prompt logging stays disabled.
The indexer reads local transcripts and exports aggregates; raw conversations, tool results and commands must not be copied into this repository or sent to Loki.
After first changing Desktop telemetry settings, fully quit and reopen the affected apps.
