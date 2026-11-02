# Quilna: Apple Native Prototype

[English](README.md) | [日本語](README.ja.md)

A minimal macOS / iOS app built with a shared Swift 6 core and SwiftUI.
It has no external Swift package dependencies and vendors the official SQLite 3.54.1 C source.
Both macOS and iOS use the same FTS5 and corrected WAL implementation, with dynamic extension loading disabled.
The source, license, and verified hashes are recorded in `Sources/CSQLite/PROVENANCE.json`.
The minimum deployment targets are macOS 14 / iOS 17.
Apple's on-device translation requires macOS 15 / iOS 18 or later and the appropriate language data.

## Available features

- Switching between the information collection and textbook tabs.
- Adding and unsubscribing from HTTPS RSS 2.0 / Atom feeds, with updates at launch, on return to the foreground, and on demand.
- Original articles and summaries, bookmarks, and a SQLite cache that survives fetch failures.
- Japanese translation and storage through Apple Translation. Originals and translations are displayed separately; translations are retained for retry if saving fails.
- A fixed Japanese textbook, “Models and Agents,” with 3 sections and an estimated reading time of 5–10 minutes.
- A table of contents, reading view, one multiple-choice question per section, and explanations that address the reasons behind each choice.
- SQLite answer history separated by textbook ID and version, reloadable after an app restart.
- Save-failure feedback, answers retained on screen, and save retries.
- Corrupted history and unknown storage formats are never automatically reinitialized.

Correct/incorrect feedback describes the answer to each question. It does not claim to assess overall understanding or retention.
AI textbook generation and synchronization between devices are not connected.
The app does not execute arbitrary HTML / JavaScript or model-generated code.

## Information collection and translation

The button for adding Apple Developer News subscribes to the actual official RSS feed.
For another feed, enter its HTTPS URL. URLs with embedded credentials are rejected.
Updates use ETag / Last-Modified conditions, and articles retain their IDs when saved.
Displayed content is the article or summary supplied by the feed; the app does not fetch full articles from the original website.
Collection runs at launch, on return to the foreground, and through manual actions. A continuously polling service is not implemented.

Originals, bookmarks, and Japanese translations are stored on this device.
The list combines the latest 2,000 articles with saved bookmarks, up to 2,000 bookmarks.
The search field operates independently of that list limit and searches all articles stored in SQLite.
It searches original titles, summaries, and bodies, plus the titles and bodies of saved Japanese translations that match the current source.
Feed and bookmark filters are applied before the 50-result limit.
Results are ordered by when they were saved or updated. The load-more button retrieves the next 50 in the same order.
Search results can open details, including originals and saved Japanese translations, for articles older than the normal 2,000-article list.
Bookmarked article snapshots are retained after unsubscribing from a feed.
Translations are tied to the article ID, source text being translated, and target language; a result for an old source cannot overwrite a translation for a new source.
When the source changes, the Japanese translation for the old source is not displayed as current in either search or article details.

Search input is treated as up to 8 ANDed terms separated by Unicode whitespace, with a limit of 128 Unicode scalars after normalization.
Each term is a literal substring search, without inferred meaning. Full-width and half-width forms, hiragana and katakana,
and uppercase and lowercase ASCII letters are treated as equivalent; phonetic, spelling, or other semantic variations are not inferred.
TAB, line breaks, CRLF, NEL, and full-width spaces are also separators. One- and two-character terms are supported.

Pressing the translation button opens the OS language-download interface when needed.
On macOS 26.4 / iOS 26.4 or later, `lowLatency` is explicitly selected. No external LLM API is used for translation.
Apple's translation process is unavailable in the iOS Simulator, and the app displays that limitation.
Current Japanese translations that are already saved can still be displayed in the Simulator and on macOS 14 / iOS 17.
RSS, bookmarks, and textbook behavior are validated in the Simulator; actual translation is validated on the Mac.

Direct retrieval of posts from X users is not connected.
LocalRSS is a plugin for saving existing RSS feeds; fetching from X requires a separate provider.
An X Premium subscription is not treated as a free X API allowance. X authentication and API purchases are not performed automatically.

## Run on macOS

Use an environment with Swift / Xcode already installed. No additional dependencies are downloaded.
Specifying a test data directory avoids writing to existing Application Support data.

```bash
swift run --package-path apple \
  --scratch-path /private/tmp/quilna-swift-build \
  --cache-path /private/tmp/quilna-swift-cache \
  Quilna --data-directory /private/tmp/quilna-native-qa
```

When launched normally without a data directory, the app uses
`TsumikiText/answers.sqlite` and `TsumikiText/feed-library.sqlite` under its Application Support directory.
These legacy directory and bundle identifiers are retained across the Quilna rename so existing data stays available.
Feed fetches contact the subscribed sources. Secrets and API keys are not handled.
The prototype does not yet have distribution settings for DB encryption, App Sandbox, signing, or notarization.
Swift's memory safety does not replace those OS permission and distribution settings.

Generate an unsigned `.app` for local checks with:

```bash
sh apple/scripts/build-macos-app.sh
open apple/.build/native/Quilna.app --args \
  --data-directory /private/tmp/quilna-native-qa
```

Artifacts are written to `apple/.build/native/`.
This is not an App Store distribution or a Developer ID-signed app.

## Build for the iOS Simulator

The shared `Quilna-iOS` scheme in `apple/Quilna.xcodeproj`
uses the same `TextbookUI` and `TextbookCore` as a local Swift Package.

```bash
xcodebuild -project apple/Quilna.xcodeproj \
  -scheme Quilna-iOS -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /private/tmp/quilna-ios-build \
  CODE_SIGNING_ALLOWED=NO build
```

Successful builds and interactive checks in the Simulator / on physical devices are reported separately.
Installation on a physical device, signing, and Apple account configuration are not performed.

## Automated validation

```bash
swift test --package-path apple \
  --scratch-path /private/tmp/quilna-swift-build \
  --cache-path /private/tmp/quilna-swift-cache
```

Tests cover answer persistence, textbook-version separation, saving the same answer again, rejection of conflicting overwrites,
write failures and retries, preservation of corrupted data, and table-of-contents navigation during a save.
They also cover RSS / Atom character encodings, entity references, link resolution, reload after saving,
fetches during unsubscription, delayed translation-cache responses, and cross-connection races between source updates and translation saves.
Dates are stored as seconds from `Date.timeIntervalSinceReferenceDate` in SQLite REAL values,
avoiding fractional-second rounding caused by conversion to another time origin.

## The 100 ms database-read budget

Calls to the local article database, `feed-library.sqlite`, must finish in under 100 ms,
measured from the start of the call through receipt of Swift results.
Passing on averages alone is insufficient: the maximum across each operation's 30 first and repeated measurements must remain below 100 ms.
Measurements include SQL execution, conversion to strings / URLs / dates, and time waiting for actor execution.

```bash
mise run apple:benchmark
# JSONを保存する場合（出力先の親ディレクトリは事前に用意する）
sh apple/scripts/benchmark-db.sh /absolute/path/result.json
```

The release build is measured against a dedicated temporary DB containing 100,000 articles, 100 subscriptions, and 10,000 older bookmarks.
Articles include Japanese text in approximately 2 KB of body and summary content, tied timestamps, and missing timestamps.

- Fetching the latest 2,000 articles, 1,000 articles for a feed, and 2,000 older bookmarked articles.
- Fetching 100 subscriptions, checking bookmark status, and fetching the Japanese translation corresponding to the source.
- Fetching subscriptions, recent articles, and bookmarks together as the three queries used by the screen.

Output includes every measurement, the first sample, p50 / p95 / p99, the maximum, and OS / SQLite versions.
The gate is not passed by reducing the data count, omitting result bodies, or substituting cached search results.
Personal saved databases are not used, and the synthetic data is deleted after measurement.

The current baseline measures reads without write contention. DB connection, integrity checks, initial import,
network fetching, translation execution, and screen rendering are timed separately.
The OS page cache is not flushed, so the first sample is not described as a fully cold disk read.
Waiting behind long writes on the same actor and limits on a physical iPhone require separate validation.
Full-text search uses the same 100 ms budget, with stricter write-contention conditions checked by the dedicated gate below.

## The 100 ms full-text search gate

The dedicated full-text search gate creates 100,000 original articles of approximately 2 KB each,
with 100,000 corresponding fresh Japanese translations of approximately 2 KB each.
Fixed search cases are measured 30 times in each of three states: normal operation, an uncommitted write held
at the public API's `beforeCommit` hook, and continuous writes of originals and translations.
The measurements include the first API call, actor waiting time, and complete materialization of 50 article bodies
and translations as Swift values. Every sample must be strictly below 100 ms.
During continuous writes, one bounded commit wait between the 15th and 16th searches establishes actual writer progress
inside each 30-search interval. This synchronization is outside search timing; a stopped writer, write error, or timeout fails the gate.
Successful commit timestamps must fall strictly inside every interval. This avoids mistaking fast searches that finish before one normal commit for a stopped writer.
Samples also record whole-process CPU time, including concurrent writer work; this diagnostic does not replace wall-clock latency or distinguish I/O from scheduling.
Set `TSUMIKI_SEARCH_KEEP_FIXTURE=1` to retain the synthetic database for targeted diagnostics; its private temporary path appears in `diagnosticDatabaseDirectory`.
The retained database can occupy several GB and can be removed after diagnosis. Normal runs remove the fixture automatically.

```bash
sh apple/scripts/benchmark-search.sh
# JSONを保存する場合
sh apple/scripts/benchmark-search.sh /absolute/path/result.json
```

Initial index creation and backfilling existing articles are treated as search-index preparation and timed separately from searches.
The gate also checks oracle agreement, traversal of every page, and retention of the searchable text.
It does not impose an early candidate cap, use a result cache, or exclude outliers.
It is not a universal hard real-time guarantee for physical iPhones or every device and workload.

In an earlier Mac measurement on 2026-10-22, all 6,197 calls across normal operation, write contention, and full-page traversal
finished in under 100 ms, with a maximum of 47.35 ms. Continuous writing completed 7,170 commits.
The initial backfill took approximately 82 seconds and is recorded separately from search latency.
One subsequent verification failed at 198.56 ms during a held write; that failure is retained rather than excluded.
The dedicated reader now requests a 64 MiB page cache and up to 2,147,418,112 bytes of memory-mapped file access,
subject to SQLite's effective limit. These are per-connection I/O settings, not cached search results;
their effect must pass the same unchanged gate. The mapping limit is virtual address space, not a preallocation of resident RAM.
Memory use and performance on physical iPhones still require measurement.
All measurements and validation status are saved outside Git in
`.local-state/fulltext-search/2026-10-22/report.json` and `search.json`.
Interactive search checks of the final macOS and iOS Simulator binaries passed with synthetic data,
including original/translated text, older article details, kana normalization, filtering, clearing, paging, errors, and orphan bookmark deletion.
Performance on a physical iPhone remains unmeasured.

The native navigation regression procedure is: search, cancel, return to the sidebar, choose Bookmarks,
search and clear there, then return to All and search again. The content search field must remain accessible,
including empty and error states and after opening article details. iOS explicitly uses the always-visible
navigation-bar drawer placement; macOS keeps automatic placement. This checks the filter-navigation issue
found during runtime QA; a passing build alone does not prove this behavior.

## Storage and search engine selection

SQLite is the current implementation choice. The requirement is correct searches in under 100 ms on the target devices and workloads; keeping SQLite is not a requirement.
If that budget cannot be met, compare query/index/connection changes, a dedicated search index, and replacing the database using the same corpus, concurrency, result correctness, and timing boundaries.
Measure alternatives on macOS and physical iPhones, including offline operation, memory/storage use, index preparation, security, and operational cost.
Choose the storage and search components separately when appropriate. Verify data migration, preservation of originals/translations/bookmarks/history, and rollback before switching.
The development harness's ledger is a separate component; changing the article/search store does not automatically require changing that ledger.

## Structure

- `Sources/TextbookCore`: Feed parsing and HTTP fetching, article / translation / answer models, and SQLite storage.
- `Sources/TextbookUI`: Shared macOS / iOS information-collection and textbook screens, on-device translation, and save state.
- `Sources/Quilna`: macOS entry point and the test data-directory argument.
- `iOS`: iOS entry point.
- `Tests`: Regression tests for the core and UI state transitions during saves.

SQLite is implemented in C; Swift's type checking alone does not guarantee its internal safety.
DB handles stay inside their actors, and SQL values are bound as parameters.
The existing web prototype and the connection status of the textbook-generation API are unchanged.
