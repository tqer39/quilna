# Paper bibliographic sources

[English](paper-sources.md) | [日本語](paper-sources.ja.md)

## Browser workflow

**設定 → 論文の出典 → 論文を検索・DOIから確認** opens `/?view=papers`.
Enter a literal DOI or an HTTPS `doi.org`/`dx.doi.org` resolver URL, then explicitly press **DOIをCrossrefへ送って確認**.
The page discloses the provider and transmitted identifier before dispatch.
It previews selected bibliographic facts without automatically saving them.
**この書誌情報を保存** retains an immutable observation in this browser profile.
Opening an older observation never replaces it with a newer provider response.
The page accepts DOI registrant prefixes of 4–9 digits and non-whitespace printable ASCII suffixes up to 2,048 characters; unsupported inputs fail locally.
Resolver URLs with credentials, non-default ports, queries or fragments are refused; use a literal DOI for suffixes containing `?` or `#`.

Stored facts include the normalized DOI, titles, supplied author names/ORCIDs, work type, supplied version label, container titles, publisher and its registered primary URL, volume/issue/pages/article number, publication dates, creation/deposit/index dates and supplied relationship/update records.
Partial dates retain their original precision. Missing facts display as **不明** rather than being inferred.
The endpoint and capture timestamp identify the observation; deposit/index timestamps are metadata events, not proof of a revised full text.
Relationship and update records are shown without fetching their targets or merging a preprint with a published version.
Missing update records do not establish that no correction/retraction exists.
The registered publisher URL is displayed as text; the DOI resolver opens only after the reader follows its link.
Source-provided strings are text, never mounted HTML.

**書誌キーワード** accepts 1–200 characters of bibliographic terms (no line breaks/control characters).
**キーワードをCrossrefへ送って検索** explicitly sends the query, after disclosing that Crossref records its contents and IP address.
This searches bibliographic metadata, not full text. Only the first 20 provider items are requested; the provider's total and identical DOI duplicate count are shown.
Refine the query for more results; there is no paging, automatic continuation or persisted query history.
Results show selected titles/authors/type/container/publisher/publication dates with missing facts marked unknown.
**このDOIをCrossrefへ送って詳細を確認** performs the separate DOI lookup above; list summaries cannot be saved as observations.
A pending/failed/cancelled search keeps the last successful results labeled with their original query. Input changes and selection invalidate late completions, even if transport ignores cancellation.
Search summaries and queries disappear on reload; saved observations remain.

The page does not store/display abstracts, obtain PDFs/full text, select source excerpts or invoke textbook generation/review.
Those parts of [Issue #31](https://github.com/tqer39/quilna/issues/31) and the connected [generation workflow](https://github.com/tqer39/quilna/issues/7) remain unfinished.
Bibliographic retrieval does not establish claim correctness, peer review, full-text version identity or permission to redistribute publisher content.

## Provider, terms and request limits

The adapter uses Crossref's public single-record `GET https://api.crossref.org/works/{encoded DOI}` and explicitly submitted list `GET https://api.crossref.org/works` endpoints.
The list uses [`query.bibliographic`, `rows=20` and `select`](https://github.com/CrossRef/rest-api-doc) limited to `DOI,title,author,type,container-title,publisher,published`; there is no `query.title`, contact parameter or API key.
No registration, API key, paid subscription or email is configured.
It omits credentials and referrers, refuses redirects and sends only the DOI or bounded bibliographic query/field selection with an `Accept: application/json` header.
It does not contact a DOI resolver, publisher, another registration agency or a search endpoint automatically.
The [official retrieval documentation](https://www.crossref.org/documentation/retrieve-metadata/) says public requests still log IP addresses and request contents.
The [REST API documentation](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) permits reuse of almost all metadata but warns that abstracts may retain publisher/author copyright.
The work response can include an abstract; its JSON is received in memory before field selection.
The adapter selects bibliographic facts and excludes abstracts, references, arbitrary response fields and article content from storage, display and export.
Local observations have no automatic expiry or background update. Provider availability and live-source acceptance have not been established by the offline fixtures.

As checked on 2026-11-03 JST, the [official July 2026 limit update](https://community.crossref.org/t/refining-rest-api-limits-for-improved-stability-and-reliability/16137) specifies 5 single-record requests/second for the public pool, and 1 list request/second.
Both operations share a conservative minimum one-second gap, including across account-library changes.
A Web Lock serializes same-origin tabs in one browser profile; localStorage retains the next permitted attempt across reloads.
Advertised limit/interval headers can extend the gap. `Retry-After` can extend it further; 429/503 impose at least 60 seconds.
There are no automatic retries, polling or queued bulk requests. A reader retries explicitly after the boundary.
These browser controls do not coordinate different profiles, origins or people sharing an IP; the provider remains authoritative.
If CORS does not expose optional rate headers, the conservative local defaults apply. A blocked cross-origin request fails without a proxy or fallback.
Each request has a 16-second deadline and a 1,000,000-byte response cap; invalid UTF-8, wrong DOI, malformed dates and oversized selected arrays fail without saving a partial result.

The authenticated Worker permits `https://api.crossref.org` in `connect-src` only on the root `?view=papers` document.
Other reader pages and login retain their existing policy. No authentication or deployment setting is enabled by this change.

## Local snapshots and files

The separate IndexedDB database `quilna.papers.v1` stores at most 1,000 observations, with 20-item library pages.
A SHA-256 digest of the selected facts identifies an observation; changed facts under the same DOI become a separate observation.
Saving identical facts reuses the first retained capture time rather than overwriting it. Concurrent saves compare/add atomically.
The digest detects conflicts; it is not a provider signature or authenticity guarantee.
Capacity, transaction failure, damaged records and a newer database schema refuse the operation without eviction/reset.

**この記録をファイルに保存** exports only that observation as `QuilnaPaper`, schema version 1.
**保存した書誌ファイルを確認** validates a bounded UTF-8 JSON file and previews it before an explicit save, without contacting Crossref.
Unknown fields/versions, changed digests/endpoint bindings and malformed facts are rejected.
Re-export retains the chosen observation's facts and capture time; imports never silently substitute a newer deposit.
These files contain no article library, answers, notes, account identity or credentials and are separate from article backups and [textbook files](textbook-sharing.md).
By default the library is shared within one browser profile; different people need separate profiles. Opt-in [account libraries](source-document-catalog.md#account-bound-browser-libraries-opt-in) also scope retained paper records, without adding account identity to exports. The Crossref rate limit remains shared across accounts in that profile.
There is no cloud synchronization, automatic deletion or snapshot-management UI.

## Verification scope

Synthetic fixtures cover field selection, partial dates, deposited version/relationship records, request bounds, list validation/deduplication, query encoding, shared list/DOI rate responses, late success/failure cancellation, immutable saves and separate-profile file exchange.
The built reader runtime uses real local authentication with offline Google/provider responses to check page-specific CSP and explicit keyword/DOI dispatch.
These are not live Crossref availability/CORS tests, real-source licensing approval, owner usability acceptance or completion of paper-to-textbook generation.
