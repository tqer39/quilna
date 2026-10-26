# Change-aware CI validation

[English](ci-selection.md) | [日本語](ci-selection.ja.md)

Issue #45 tracks repeated platform builds for unrelated browser and documentation changes.
`Prototype checks` runs for every PR and main push, without workflow-level path filters. `workflow_dispatch` explicitly runs all platforms.
The read-only `main` ruleset inspection on 2026-10-24 found `workflow-result` as the required status context. The legacy branch-protection endpoint was not accessible to the connector.
This change preserves that context and does not change repository protection settings.

## Selection and required result

`scripts/ci-selection.mjs` compares PR head against its merge base with the event's base SHA, or the before/after commits for a main push.
Checkout fetches full history. Git errors and missing commit identifiers fail the selection job; they never become a documentation-only success.
A new branch, manual event or unknown event selects all platforms. Git output is NUL-delimited, and rename detection is disabled so both removed and added paths contribute.

| Changed files | Selected product checks |
| --- | --- |
| Markdown under `docs/`, root README, Apple/harness README pairs | None; maintained security/lint and selector regressions still run |
| `src/`, `server/`, `workers/`, `public/`, `tests/`, Web build/test config | Typecheck, unit/server, build, Worker tests, browser tests and the 200 ms search gate |
| `apple/` except README pairs | Swift tests/build and iOS simulator build |
| `harness/` except README pairs and Go dependencies | Go harness checks on Linux and macOS |
| Dependencies, runtime pins, scripts, workflows, skills, AGENTS, selector tests or any unrecognized path | All platforms |

Mixed changes union their selections. Go module/lock changes also select all platforms.
The always-run `checks` job retains pre-install policy checks, locked installation with hooks disabled, npm audit/signatures, repository lint/documentation checks and selector regressions.
Only its product steps are conditional. `security.yml`, including daily auditing, PR dependency review and Go vulnerability scanning, is unchanged.

The required `workflow-result` job uses `always()` and depends on selection, maintained checks and both platform jobs.
It accepts `skipped` only for a platform explicitly not selected. Failed, cancelled, missing or unexpectedly skipped selected jobs fail the required result.
Missing selection outputs fail it too. This keeps an intentionally skipped unrelated build distinct from a missing verification.
The workflow retains read-only permissions, immutable Action references and disabled checkout credential persistence.
For selected Web changes, it records the checked-out SHA before browser validation, runs both the functional suite and the untagged/dense-tag search gate, and uploads synthetic reports for 14 days. Uploads also run after a validation failure, provided source recording succeeded and the job was not cancelled. Documentation-only runs skip the browser artifacts; missing evidence after validation starts is an upload error. Personal databases and unrelated local state are excluded.

## Validation and limits

```bash
mise exec -- node --test tests/server/ci-selection.test.mjs
mise run lint
mise exec -- npm test
```

The regressions cover representative selections, mixed changes, renamed/deleted/newline-containing paths in a real temporary Git repository, base-only changes, invalid revisions and required-result failure/cancellation/skip behavior.
The selection regression also runs on documentation-only CI, without requiring a product build. A workflow-contract regression requires the functional/search steps and failure-evidence upload; the pre-integration workflow fails it because the search step is missing.
Changes to the selector or workflow themselves force all product checks. A green full-matrix PR does not prove a later documentation-only run's job count or duration.
After merging, compare an actual documentation-only run and a browser-only run with the previous workflow before claiming measured time savings.
PR #64 is stacked on the validated PR #63 branch (`codex/browser-reading-workflow`) so the CI diff preserves that product change's search gate and evidence upload. The application sources match PR #63. Neither PR is merged into main by this preparation; after #63 is integrated, retarget #64 to main and recheck the exact diff and required results before merging it.

- [GitHub required-check guidance](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Security maintenance](security-maintenance.md)
