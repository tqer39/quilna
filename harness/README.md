# Development Harness

[English](README.md) | [日本語](README.ja.md)

A minimal Go implementation of a development loop restricted to trusted local specifications.
Its process, state, and usage allowance are separate from the product's collection, textbook-generation, and synchronization services.
It uses Go 1.27.3, Git, and `/usr/bin/sqlite3`, with no additional Go dependencies.
The initial supported platforms are macOS / Linux. Windows is not supported.

## Workflow and acceptance criteria

The loop runs optional `implement` → `checks` → independent `review` → `repair` when needed → revalidation.
Repairs are limited to 2 cycles. All commands run serially, and separate runs against the same workspace are mutually exclusive.
Parallel development uses a separate worktree for each owner, with integration handled as a separate task.

A run becomes `accepted` only when all of the following hold:

- The frozen specification, code hash, and validation evidence agree.
- Every check finishes with exit code 0 and leaves the code unchanged.
- The reviewer returns `approve` with no findings for that same code hash.
- The reviewer leaves the code unchanged.

For command-based review, the caller ensures independence by selecting a separate owner or trusted reviewer.
This CLI does not prove that the reviewer's judgment is correct or that the same person was not assigned both roles.
Passing fixed tests does not guarantee the semantic quality of a textbook.

## Run

```bash
cd harness
GOCACHE=/private/tmp/adaptive-harness-gocache \
  go build -o /private/tmp/textbook-harness ./cmd/harness
/private/tmp/textbook-harness run -task /absolute/path/task.json -state /absolute/path/state
/private/tmp/textbook-harness status -state /absolute/path/state -run RUN_ID
/private/tmp/textbook-harness stop -state /absolute/path/state -run RUN_ID
/private/tmp/textbook-harness resume -state /absolute/path/state -run RUN_ID
```

`run` prints its generated ID to stderr and returns the result as JSON on stdout.
Run and resume commands return exit code 0 only on acceptance. Status / stop return 0 when the read or request succeeds.
In `status`, `codeHash` identifies the code covered by the evidence, `currentCodeHash` identifies the current files, and `stale` indicates a difference.
Even an accepted run cannot resume successfully after its code or evidence changes.

The workspace must be a canonical absolute path to a checkout root matching Git's top-level directory.
Registering a subdirectory of the same worktree as another workspace is rejected.
Place state outside the workspace, or in a Git-ignored, untracked directory.
Treat the SQLite ledger, logs, and locks as confidential. State directories are created with mode 0700 and files with mode 0600.
Workspace exclusion uses `/tmp/adaptive-harness-locks-UID` across all state directories.
No files are written into Git's administrative area.

## Example specification

This is a contract example. Supply the executables and replace the paths with absolute paths.
Do not put secrets in strings in the command arrays. The specification is stored in the ledger.

```json
{
  "version": 1,
  "name": "reader-offline-search",
  "workspace": "/absolute/path/isolated-worktree",
  "goal": "保存済み記事をオフラインで検索できる",
  "acceptance": ["通信なしで一致記事を表示する", "既存の閲覧動作が通る"],
  "implement": {
    "command": ["/absolute/path/implementation-agent"],
    "timeoutSeconds": 120
  },
  "checks": [
    {
      "command": ["/absolute/path/trusted-test-runner"],
      "timeoutSeconds": 120
    }
  ],
  "review": {
    "kind": "command",
    "command": ["/absolute/path/independent-reviewer"],
    "timeoutSeconds": 120
  },
  "repair": {
    "command": ["/absolute/path/repair-agent"],
    "timeoutSeconds": 120
  },
  "maxRepairCycles": 2,
  "timeoutSeconds": 900,
  "logLimitBytes": 65536,
  "maxOperations": 16
}
```

`implement` and `repair` are optional. `repair` is required when the repair-cycle limit is at least 1.
Unknown fields, duplicate JSON keys, out-of-range numbers, and trailing JSON values are rejected.
The runtime specification is frozen with the SHA-256 of its normalized JSON and checked against the original file each time.
The versioned code hash covers paths and modes of Git-tracked and non-ignored untracked files. Regular-file bodies use fixed-length SHA-256 digests, so arbitrary binary contents cannot be confused with file-record boundaries.
It includes deletions and changes to symlink targets. Ignored build artifacts and secrets are excluded.
Checkpoints made with an older encoding safely become stale and must be validated again; ledgers are not migrated or reset.
This identifies code snapshots; it does not monitor temporary changes that are reverted during a process.

Each command receives JSON on stdin containing `goal`, `acceptance`, `codeHash`, `taskHash`,
`findings`, and `evidence`. Reviewer stdout must use only this format:

```json
{"decision":"approve","codeHash":"64文字の小文字SHA-256","findings":[]}
```

`revise` and `reject` require at least one finding.
Unknown decisions, invalid JSON, mismatched hashes, and approval with findings are not accepted.
Repair input includes findings and references to validation evidence.
Codex repair receives up to 8 KiB each of stdout / stderr directly from the latest failed checks.
It also receives up to 4 KiB total of error / assertion lines from the same log so failures are not lost near the beginning of long result lists.
The source log's hash is verified, and diagnostics are passed as untrusted output.
When the latest checks pass, old compiler errors are not resent.
Codex review is instructed to use `revise` for findings that can be fixed within scope and `reject` for goals that cannot be achieved safely.
The harness does not reinterpret `reject` as a request for repair.
Implementation and repair owners may also run local preliminary checks when explicitly permitted by their frozen role instructions.
Preliminary checks are not acceptance evidence; the harness runs its fixed checks separately.
Preliminary checks inside an owner's environment cannot run when macOS development tools require temporary writes outside the sandbox.

## Fixed check controls

Before assigning implementation or repair, freeze the trusted check scripts, test fixtures and configuration:

```bash
/private/tmp/textbook-harness freeze-task \
  -task /absolute/path/task.json \
  -file /absolute/path/fixed-regression.spec.ts \
  -file /absolute/path/trusted-test-runner \
  -output /absolute/path/task.frozen.json
/private/tmp/textbook-harness run -task /absolute/path/task.frozen.json -state /absolute/path/state
```

`freeze-task` preserves the goal, criteria, commands, reviewer and limits, adding optional `protectedFiles` entries with canonical absolute paths, SHA-256 content hashes and file modes.
It creates a new private file (0600); it never overwrites an existing task or silently refreezes controls that have changed. The output parent must already exist.
List each control explicitly, including ignored or external wrappers, package scripts/lockfiles, test configuration and imported test helpers. The tool does not discover transitive dependencies or protect every file in a directory. Tasks without this field retain their prior behavior.
Up to 256 regular files, each at most 256 MiB, are supported. Missing files, symlinks, nonregular files and content/mode changes are refused. FIFO validation does not wait for a writer.
The engine checks controls before and after operations, during recovery and when inspecting existing evidence. A changed external control makes `status` stale even if the workspace code hash has not changed; resume refuses it without replaying checks. In-flight edits are recorded and blocked before the next operation can accept their changed test.
This is checkpoint change detection, not an OS write prohibition; changes reverted between checks are not detected. Logs/report artifacts are not implicitly frozen by this field.
See [browser validation](../docs/browser-validation.md) for the browser-only check selection and toolchain setup.

## Stop, resume, and evidence

The start of an operation is recorded in SQLite before the child process launches.
Logs, exit codes, start times, elapsed time, and code hashes before and after each operation are retained.
Log-file SHA-256 hashes are also stored in the ledger and checked for tampering before resumption.
SQLite uses FULL synchronization, explicit transactions, and exclusive locks.
The same run or workspace cannot be started twice. OS locks are released when the process exits.

Stop requests or signals send SIGKILL to the process group, handling grandchildren and inherited pipes as well.
Limits cover waiting time, operation count, total runtime, and output bytes per operation.
Ledger failures, log limits, timeouts, repair limits, and unexpected code changes stop the run.
Arbitrary code that leaves the process group, such as a child creating a separate session, is not contained.

- Verification that was cleanly stopped may run again if the code is unchanged.
- An operation is not automatically rerun after a crash when the old process's termination is unknown.
  After confirming the old process has exited, the user specifies `resume -reconcile-local`.
- Interrupted local editing is not resent. Only after the user reviews the diff may
  `resume -reconcile-local` proceed to checks without running the edit again.
- If submission to the model is uncertain, a new turn is not automatically sent.
  When saved thread / turn IDs exist, resumption only reads and reconciles a completed result.
  Missing IDs, incomplete or failed turns, and mismatches leave execution on hold.

Stopping does not guarantee cancellation of processing or usage consumption at the external service.
Elapsed time during a crash cannot be measured completely, but operations already started count as consumed.

## Codex app-server adapter

Disabled by default. Use the following format for `implement`, `review`, and `repair`,
and also pass `-allow-codex` to the CLI. Each role runs in a separate thread.

```json
{
  "kind": "codex",
  "codex": {
    "enabled": true,
    "binary": "/absolute/path/native-codex-binary",
    "home": "/absolute/path/configured-codex-home",
    "model": "利用者が選んだモデルID"
  },
  "timeoutSeconds": 120
}
```

Specify a native Codex executable as `binary`. npm wrappers that require Node on PATH are unsupported.
A model action may include optional `instructions`. Its final output is structured JSON in the form `{"summary":"変更内容"}`.
Validation commands are not assigned to the model; the frozen local `checks` run instead.
`home` is the CODEX_HOME specified by the user. An existing ChatGPT login can be used through the official CLI.
The harness does not read authentication files itself or write credentials to logs.
It does not log in, create subscriptions, search for API keys, or add funds.
If `account/read` does not return ChatGPT authentication, execution stops without falling back to API-key authentication.
This version's live adapter supports the personal Pro plans `pro` / `prolite` and stops conservatively for other plans.
The presence of ChatGPT authentication alone is not taken as proof of access to the selected model or remaining allowance.

The live adapter implements stdio initialize → initialized → account/read → allowance check → thread/start → turn/start.
New reviews are read-only; implementation and repair use workspace-write, with `networkAccess=false` required for child tools.
Connecting to the model service itself still uses the network.
A structured JSON schema is specified, and only a completed turn and its corresponding final output are accepted.
The saved-output `logLimitBytes` is separate from the limit on transient communication volume.
Protocol limits are 4 MiB per message, 64 MiB cumulative, and a waiting queue of 4 MiB / 1,000 messages; raw traffic is not saved.
Diagnostic-output limits, invalid JSON, and communication-limit failures have stop reasons distinct from ordinary interruptions.
All server requests for approval, additional tools, or user input are rejected, and execution stops.
Resume reconciles an existing turn through thread/read and does not send turn/start.
Recovery of model edits also requires user review of the diff and `-reconcile-local`.

Before each turn, the adapter checks ChatGPT authentication and the included allowance, stopping if additional credits are available or the remaining allowance is unknown.
Confirmed quota, model, provider, service tier, thread / turn, and token-usage metadata are stored as evidence.
Failure state, official error type, and HTTP status are stored; raw error messages are not.
The service tier is fixed to Standard. Purchases, adding funds, quota resets, and switching to API keys are not performed.
Usage is also constrained by maxOperations, repair cycles, and time.
Reading the remaining allowance does not reserve it or guarantee protection against concurrent use by other chats or a per-turn consumption ceiling.
Strict token and yen budget limits are not implemented; this is separate from the app's ¥500-per-month ledger.
A Claude adapter, API-billing path, automatic push, deployment, and signing are not implemented.

See [Live Codex Connection Validation](../docs/codex-live-validation.md) for reproduction steps and the scope of real-model validation.

## Permission and secret boundaries

This CLI does not replace an OS sandbox. A worktree is not security isolation either.
Use only trusted local specifications; fetched text and model output are not converted into commands.
Commands do not inherit API keys, proxies, shell initialization settings, or the parent's HOME.
They use a dedicated temporary HOME and fixed PATH. Specify required toolchains explicitly inside a trusted runner.
Known token formats are redacted in logs, but arbitrary secrets are not guaranteed to be detected or erased.
Do not configure commands that could read secrets.

Codex itself is on the trusted side and holds authentication.
CLI 0.148.0's read-only mode does not guarantee isolation from reading confidential files.
For production development, use a dedicated user / isolated environment without secrets and a dedicated Codex configuration.
The live smoke test uses a temporary Git workspace without secrets; only the trusted CLI handles authentication.
Provide an Xcode runner separately on the macOS side and keep signing / publication credentials away from validation agents.

## Validation and limitations

```bash
cd harness
GOCACHE=/private/tmp/adaptive-harness-gocache GOTMPDIR=/private/tmp \
  go test -race ./...
GOCACHE=/private/tmp/adaptive-harness-gocache GOTMPDIR=/private/tmp \
  go vet ./...
```

Regression tests cover offline check / review / repair and the live adapter path through a fake app-server process.
They cover stop / resume, double starts, code / specification / log tampering, grandchildren, pipes, output limits,
invalid reviews, repair limits, unknown model outcomes, and hash / time limits during recovery.
On 2026-10-22, implementation, independent review, and repair ran with Pro-authenticated `gpt-5.6-terra`.
Five separate threads, one repair cycle, and a fixed Unicode boundary test changing from failure to success were confirmed.
Results and failure limitations are recorded in [Live Connection Validation](../docs/codex-live-validation.md).
General review accuracy, long-running unattended operation, and allowance reservation remain unverified or unsupported.

The official specification was checked against the generated schema from local Codex CLI 0.148.0.

- [Go os/exec](https://pkg.go.dev/os/exec)
- [Scope of Go Process.Kill](https://pkg.go.dev/os#Process.Kill)
- [Codex app-server](https://developers.openai.com/codex/app-server)
