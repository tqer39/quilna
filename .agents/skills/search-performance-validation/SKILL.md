---
name: search-performance-validation
description: "Verify Quilna's article database and Japanese full-text search correctness and latency under write contention. Use for query, index, storage, concurrency, benchmark changes, or a requested 100 ms validation; not for documentation-only edits."
---

# Search Performance Validation

Work from this checkout's Git root and follow [the repository instructions](../../../AGENTS.md).
For browser changes, read **Local article search** in [the browser reader guide](../../../docs/browser-rss.md) and [browser validation](../../../docs/browser-validation.md). Use `npm run test:search-performance` and [the browser benchmark](../../../tests/performance/search.spec.ts): the current browser target is 200 ms from input to painted correct results, with initial loading/preparation separate. Never substitute native database timings for this claim. Keep both the untagged baseline and the dense-tag variant defined in that benchmark; report their separate sample counts and measurements.

Only when native work is authorized, read **The 100 ms database-read budget**, **The 100 ms full-text search gate**, and **Storage and search engine selection** in [the Apple guide](../../../apple/README.md).
The selected guide and executable benchmark define the corpus, query cases, sample counts, contention, timing boundaries, and success criteria; do not create a second checklist with different values.

## Use the existing gates

- Browser input-to-render search: [playwright.search.config.ts](../../../playwright.search.config.ts), backed by [search.spec.ts](../../../tests/performance/search.spec.ts).
- Ordinary article reads: [benchmark-db.sh](../../../apple/scripts/benchmark-db.sh), backed by [DatabaseReads.swift](../../../apple/Benchmarks/DatabaseReads.swift).
- Original/Japanese full-text search: [benchmark-search.sh](../../../apple/scripts/benchmark-search.sh), backed by [FullTextSearch.swift](../../../apple/Benchmarks/FullTextSearch.swift).
- Search contract and persistence regressions: [ArticleSearchTypes.swift](../../../apple/Sources/TextbookCore/ArticleSearchTypes.swift), [search tests](../../../apple/Tests/TextbookCoreTests/FeedLibrarySearchTests.swift), and [independent shadow tests](../../../apple/Tests/TextbookCoreTests/SearchShadowIndependentRegressionTests.swift).

Select gates affected by the change or requested verification. Run the existing script against its own synthetic fixture and save raw JSON to ignored/private task state with the source identity and command.
Do not use a personal article database as a benchmark fixture. Inspect concise summaries rather than loading every sample into model context.
Retained synthetic fixtures are optional diagnostics; follow the guide's retention switch and storage warning only when needed.

## Review correctness and every measured call

Use the benchmark's public API, oracle, full result materialization, pagination, snapshot, and writer-progress checks as the acceptance authority.
Verify actual successful writer commits for each measured contention group; a running writer task alone is insufficient.
Keep synchronization and diagnostics outside search timing only as specified by the maintained benchmark.
Check raw samples, including first calls and full traversal, rather than substituting an average, percentile, or reduced result set.

On failure, retain the failed output and identify whether evidence points to source behavior, measurement control, or an unresolved environmental factor.
Use targeted diagnostics before another acceptance attempt; do not discard outliers, silently relax the gate, or keep retrying until a run passes.
Treat a benchmark change separately: preserve the intended workload and obtain independent review of the measurement change before using it to accept an implementation.
If storage cannot meet the requirement, follow the guide's same-condition comparison and migration/rollback criteria; SQLite is not a fixed requirement.

Report passing and failing runs with their measurement scope. State initial preparation, cache state, excluded UI/network work, and unmeasured physical-device limits from the evidence.
A passing run is not a universal latency guarantee. Reuse old evidence only when its source, workload, measurement code, and artifacts still match the requested claim.
