---
name: independent-review
description: "Independently review Quilna changes or reproduce a reported regression, including asynchronous races and non-destructive storage failure. Use for requested review or regression investigation, not to require a separate model call for every edit."
---

# Independent Review

Work from this checkout's Git root and follow [the repository instructions](../../../AGENTS.md).
Use **Workflow and acceptance criteria** and **Example specification** in [the harness guide](../../../harness/README.md) for the review contract and output format.
The current [Review type](../../../harness/task.go) is authoritative; do not invent reviewer fields.

## Choose the requested role

- **Review:** inspect the agreed diff, relevant callers, fixed criteria, and recorded check evidence. Leave source and tests unchanged.
- **Reproduce:** add a focused regression in the permitted test scope, then hand the frozen reproducer to implementation. Keep this distinct from the read-only review.
- **Repair:** route concrete findings to a separate implementation execution and host checks through the existing harness. Do not repair while claiming to be the independent reviewer.

For independent executions, give the reviewer the request, acceptance criteria, relevant source, and check evidence without prescribing a verdict.
Identify whether roles use separate executions of the same model or different providers; do not infer that independence proves correctness.

## Investigate observable failure

Follow the existing test conventions rather than introducing a second test framework:

- Async/cache/search races: [UI search regressions](../../../apple/Tests/TextbookUITests/FeedReaderSearchTests.swift) and [independent native regressions](../../../apple/Tests/TextbookUITests/NativeSearchIndependentRegressionTests.swift).
- Corrupted or migrating indexes: [independent shadow-schema regressions](../../../apple/Tests/TextbookCoreTests/SearchShadowIndependentRegressionTests.swift) and [search tests](../../../apple/Tests/TextbookCoreTests/FeedLibrarySearchTests.swift).
- Runner state, stopping, and stale evidence: [harness tests](../../../harness/harness_test.go).

Use causal gates for races, including a loader that ignores cancellation when that is the reported boundary.
Observe both delayed success and delayed non-cancellation failure after a newer request; account for repeated identities when relevant.
For refusal or migration, compare saved values and schema before/after as required by the existing tests.
Show that a regression fails for the reported reason before repair when reproducible; preserve its assertions during repair.

## Decide from current evidence

Findings need a concrete trigger, affected source location, observable consequence, and proportionate correction.
Distinguish a source defect, a broken measurement, and an external prerequisite. A lack of new evidence is not evidence of a pass.
Check that runtime/build/test evidence belongs to the reviewed source and that test controls were not weakened.
Use the guide's structured verdict when acting as a harness reviewer; otherwise report findings and verification limits in the requested review format.
Do not turn an unresolved failed or interrupted model review into an approval, or rerun costly checks merely to obtain a preferred outcome.
