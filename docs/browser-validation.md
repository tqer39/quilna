# Browser development validation

[English](browser-validation.md) | [日本語](browser-validation.ja.md)

Use the browser checks for the current product phase. A successful check does not replace independent source review or the owner's usability acceptance in [the product sequence](product-development.md).

## Maintained checks

With the pinned Node runtime and installed lockfile dependencies, run from the checkout root:

```bash
mise exec -- npm run check:browser
```

This serial entry point stops on the first failure: `npm run lint` → `npm test` → `npm run build` → `npm run test:browser` → `npm run test:search-performance`.
Lint includes documentation and security-policy checks; build includes the TypeScript check. The individual commands remain available for targeted repair and fixed harness stages. This command does not install dependencies, invoke models, push, deploy, or build native apps.
Chromium must already be installed with the maintained Playwright version; installation is an explicit setup step (`npm exec --no -- playwright install chromium`).
Live vulnerability scanning remains separate (`npm run security:audit`), with registry signatures, dependency review and Go scanning in the existing workflows. Workers changes also require the existing Workers build/tests.

The functional suite owns `127.0.0.1:5197` and the performance suite owns `127.0.0.1:5199`. Both start Vite from the config's checkout, use `--strictPort`, and reject an already-running server. Never enable `reuseExistingServer` to work around a conflict: determine who owns the port and wait or stop only your own test process. The user's preview on port 5192 is separate.
Playwright uses disposable contexts, and fixtures populate only synthetic data in their own origin/profile. The server test suite also briefly reserves both test ports to check that unrelated servers are rejected before any test executes. Do not run it concurrently with either browser suite. Authentication/provider responses are mocked by the relevant tests. This is not live account, synchronization, translation-quality or physical-phone acceptance.
See the official [web-server behavior](https://playwright.dev/docs/test-webserver) and [JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter).

## Evidence and repair

Functional test results are written to `test-results/browser.json`, with failure traces under `test-results/chromium/`. Search test results are in `test-results/search.json`, with all measured samples in `.local-state/search-performance/results/**/measurements.json`.
These paths are overwritten by later invocations. Before repair or another run, retain failed logs and copy the relevant JSON/traces to an ignored, task-specific directory. Record the exact commands, runtime/browser versions, source hash and dependency identity. A Git commit alone is insufficient for a dirty checkout; retain a hash manifest covering changed and untracked source/config/test files too.

Use [the reader guide's search contract](browser-rss.md#local-article-search) without weakening its 200 ms gate, reducing its samples or discarding outliers. Initial database loading and preparation are separate. The baseline corpus has no tags; a separate dense-tag variant preserves the same text corpus and adds tag queries/filters. Neither measures a physical phone.
On failure, distinguish a product defect, a test-control defect and a missing prerequisite. Preserve the failure, fix its cause, and rerun affected checks. Reuse a prior successful check only when its source, controls, dependencies, environment and retained evidence still match. Do not repeat runs just to obtain a pass.

The CI web job runs the same maintained functional and search commands after its existing static/unit/build checks. It records the checked-out SHA and uploads the synthetic test results and measurements for 14 days, including failures after validation starts. The upload paths exclude personal databases and general `.local-state` contents. A missing or failed check is not an acceptance, even if an artifact upload succeeds. Native/Go jobs and the required workflow result are not removed by this change.

### Search diagnostics

When a search failure needs timing detail, run `node scripts/diagnose-search.mjs` after preserving the original failure. This creates an instrumented copy of the maintained benchmark under a new `.local-state/search-diagnostics/run-*/` directory; it does not edit the benchmark, application or acceptance results. It uses the same isolated port/profile and runs all 630 dense-tag samples for each design, retaining correctness, writer-progress and 200 ms assertions. It is a diagnostic experiment, not acceptance: tracing adds overhead, and the untagged baseline is not run.

The optional arguments select a design and CPU slowdown, for example `node scripts/diagnose-search.mjs editorial 4`. Allowed designs are `all` (default), `studio`, `editorial`, and `focus`; slowdown is `1` (default), `2`, or `4`. These are local experiments, not claims about equivalent physical devices. Do not run this alongside browser/server tests that own the same ports.

The copy records synchronous input-dispatch time, the remaining paint/correctness time, and a compressed Chromium trace. The manifest records source/dependency/control hashes and the generated copy; completion reports whether source hashes stayed unchanged and every expected trace is complete. Inspect `diagnosticError` and `traceDataLoss` before interpreting a trace. Compressed traces are capped at 128 MiB each; a partial or missing trace is diagnostic failure, never evidence that no pause occurred. Source-adapter drift fails explicitly rather than silently changing the workload. Only synthetic fixtures are profiled; no personal profile, credentials or account data are copied. See [Playwright CDP sessions](https://playwright.dev/docs/api/class-cdpsession).

If the maintained search gate fails in CI, its normal artifact is uploaded first. A separate four-minute diagnostic step then uses the default slowdown of 1, with traces in `search-diagnostics-<run>-<attempt>` retained for 14 days when the job is not cancelled. The original failure remains a failure even if diagnostics pass. The web job has a 25-minute total limit for installation, checks and diagnostics: a recorded dependency installation alone took 12m33s and exhausted the former 15-minute job budget during functional tests. This does not change the 200 ms search limit or per-test limits. Cancellation can prevent diagnostic upload, while already-uploaded normal evidence remains available.

## Existing harness integration

Use the existing [Go harness contract](../harness/README.md), not a new loop runner or an automatic-approve reviewer. Keep its frozen task, checks, distinct review execution, bounded repair, no-replay recovery and hash checks.
For a browser-only task, select the individual maintained commands above as trusted `checks`, in the same order. When relevant, add Workers checks. Each check should have its own operation/log so a failure can be passed to repair with the existing bounded diagnostics. Reserve `check:browser` for local convenience; do not also run its component commands in the same task.

The harness uses an isolated HOME and fixed PATH. Supply a trusted local wrapper with explicit absolute Node/npm paths and only the required toolchain PATH; otherwise npm's child commands may not find Node. Pass the already-installed Playwright browser cache explicitly as `PLAYWRIGHT_BROWSERS_PATH` so the disposable HOME does not trigger a missing-browser failure. Never copy credentials or personal configuration to satisfy this prerequisite. Keep the wrapper and task outside the model-editable scope and include their identity in the recorded controls. Use the harness’s `freeze-task` command to list the wrapper and relevant check/configuration files explicitly in `protectedFiles`; it verifies their content and mode at operation boundaries, including files outside the workspace code hash. This detects persistent changes, not transient edits reverted between checkpoints, and does not discover transitive dependencies. Follow the [fixed-controls contract](../harness/README.md#fixed-check-controls).

Choose allowed source paths, acceptance criteria, reviewer and operation/time/repair limits before dispatch. Do not assign check editing to repair, synthesize `approve` from test success, or infer model/spending authorization from this guide. No current browser run is independently accepted merely because the offline harness tests pass. The remaining native-oriented preparation helpers on other branches must not be imported wholesale into browser work.

## Local checkpoint

On 2026-10-24, the combined command passed lint, 42 unit tests, 50 server tests, build, 182 desktop/mobile browser tests and the 100,000-article search gate (270 samples, maximum 60.0 ms, 129 writer commits; initial loading/preparation 2,329 ms). Environment: macOS, Node 26.12.1, Chromium 156.0.8078.4. Two server-isolation regressions were then added and the unit/server suite passed again (42 + 52). Temporarily permitting server reuse caused both regressions to fail; restoring the refusal passed both. The earlier missing-document failure and unsafe-control failures were preserved. Final lint, actionlint and the live npm audit passed (zero reported vulnerabilities). Hosted CI/artifact upload and an independent browser-source harness review have not run for this local change.
