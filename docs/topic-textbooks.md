# Reusable topic textbooks

[English](topic-textbooks.md) | [日本語](topic-textbooks.ja.md)

## Direction and implementation status

The owner's clarification on 2026-11-17 in [Issue #7](https://github.com/tqer39/quilna/issues/7) makes reusable technical knowledge the purpose of textbooks.
An article can lead to “explore this topic with this textbook”; the textbook teaches the underlying topic and can serve readers arriving from different articles.
Stable technical material can remain fixed between deliberate revisions. Reading an article or receiving an RSS update must not require generating a new textbook.

This page specifies the browser direction and separates implementation from acceptance. Following the owner’s 2026-11-17 usability rejection of the suggestion/reason workflow, article text links directly to retained theme textbooks. Textbook creation is separate asynchronous work in [Issue #202](https://github.com/tqer39/quilna/issues/202); readers do not quote an article to request a textbook. The [version-2 file workflow](textbook-sharing.md#file-contract-and-validation) and local correction/withdrawal records remain available. Live authoring and owner usability acceptance remain incomplete.
The existing CAA lesson is a fixed demo; imported version-1 textbook files remain readable through the same file workflow.
OpenAI was selected for the next generation integration, and the owner requested secure creation of a new key.
Key setup, sending scope, model selection and a concrete live-run spending allowance are not yet complete.
No live-generation result is claimed. The existing [budget and sending controls](generation-connection.md) still apply.
The first implementation stays within the current browser library and its existing account isolation. Reuse across articles does not enable cross-user delivery, a hosted shared catalog or pooled generation costs.
Explicit file sharing remains subject to the existing content-sharing checks in #30; public availability of a source does not grant redistribution rights.

## Reading to deeper understanding

1. Read an article normally.
2. Follow a linked technical term directly to its retained textbook in another tab.
3. Inspect that textbook's scope, prerequisites and sources, and read its explanations or optional questions.
4. Reuse the same edition and private answers from other articles.
5. Close the tab to return to the original article position. Following a link does not mark learning as complete.

## Links in article text

The current linking vocabulary is the theme name in each validated, retained version-2 textbook. Names match literally, without case sensitivity for Latin text and without matching part of a Latin or Katakana word. Punctuation-only names are excluded; single-letter Latin names do not match the prefix of `C#` or `C++`. This literal matching does not infer a technical meaning or synonyms. Link only the first occurrence of each term, up to 30 per article. Existing source links and code are excluded. Matching does not fetch a source, create a book, send article text or save a relevance reason.

Use the latest eligible retained edition per textbook; exclude withdrawn editions, unreadable maintenance records and corrections whose replacement cannot be verified. A withdrawal applies to its recorded edition: an earlier retained edition remains eligible unless separately excluded. A name shared by different textbooks, including a currently unavailable destination, opens a filtered textbook list so the reader chooses the destination. Names never merge topic IDs or answer histories. The link contains only the edition or theme name, opens with no referrer, and preserves article text, selection (including its direction), highlights, code scrolling, focused controls and reading position. These states also survive a highlight refresh. A committed new import notifies open readers; aborted or duplicate imports do not. If every matching destination is excluded, the filtered list explains this and offers access to all retained books. Missing textbooks leave ordinary text. Unreadable metadata withholds links and leaves the article readable.

These derived links are not saved article-to-textbook records and are not included in backups or provider input. Existing personal mappings and their source snapshots remain unchanged.

## Earlier explicit article mappings

The earlier optional mapping tools remain for existing personal records; they are not required to follow a linked term. Open **深掘りできる教材** in the article tools, select **教材を関連づける**, choose a saved version-2 textbook and enter a required reason. The preview shows its learning goal and opens its full scope, prerequisites and sources in another tab. No suitable file means no available choice; importing a file is explicit. Version-1 books remain readable but are not choices for these topic links.

**教材を読む（別タブ）** opens the exact retained edition without sending the referring article in the URL or referrer. Closing that tab returns to the original article position. Multiple articles reuse the same edition and its private answers without a generation request. **この記事との関連づけを外す** removes only that article's link, retaining the textbook, answers and other links. These explicit records are separate from the derived word links.

The separate, library-scoped `quilna.article-textbooks.v1` database retains the article ID/title/URL, original-or-translated representation, language, body fingerprint and first 1,000 Unicode code points, plus exact textbook/topic identity, file digest, reason, creation time and revision. Changing the body, language or original/translated representation reports a difference without moving the saved link. Limits are 20 links per article, 20,000 total and 2,000 UTF-16 units per reason. Saving compares revisions in one write transaction; failure retains the draft. A conflicting reason requires reloading and explicitly choosing to continue the draft before overwriting it. If another tab deleted the link, that choice prepares recreation; if it created the same link first, it retains that record's creation time. Different source or textbook identities cannot be adopted into the existing draft. Drafts survive article switches within the open page, but not reload or page closure. Normal close calls, close events and `InvalidStateError` discard the cached connection. The next read or explicit retry can reopen it; reopening preserves stored records and never automatically replays a failed write. Cached connections are checked before being supplied to backup/restore, so a known closed connection is refused before restore writes to other stores. This does not make multi-database restore atomic against failures occurring later.

New link drafts capture the reading when creation begins; reason edits keep the recorded source. Changing the reading while choices load or a draft remains open never silently replaces it. A mismatch warning appears before saving. To use the current reading, cancel a new draft and start again, or cancel the reason edit before removing and recreating an existing link.

Private links are excluded from textbook JSON exports and provider input. They are included in [reader-library backups](browser-rss.md#library-backup-and-recovery), which are personal files. Keep textbook JSON files separately: library backup does not contain those books or their answer history. A restored link with a missing or different file shows an unavailable-edition message; it does not reconstruct or replace the book. An unknown link-database version or layout is refused without changing it. Library export/restore also fails in that case instead of silently creating an incomplete backup that omits links.

## Separate content from its entry points

- A topic identifies a learning subject with a stable opaque ID and a human-readable name. Create or select it explicitly; matching labels are candidates for reuse, not permission to merge topics or histories automatically.
- A textbook has its own identity and immutable editions. Its learning goal, prerequisites, explanations, examples and questions describe the topic.
- The textbook's evidence consists of retained, identified source material that supports its teaching claims. A referring article is not automatically evidence for every explanation or answer.
- A derived word link is navigation to a retained edition. Earlier explicit mappings also retain a private reason and referring-article snapshot; following a word link does not create such a record.
- Personal answers, notes, progress, reflections, earlier confirmed links and referring-article records remain private to the current library and outside reusable content, textbook-file exports and provider input, as in the existing file workflow.

Updating or removing a referring article must not silently replace a textbook, move an answer to a new edition, delete learning history or grant source-sharing rights.
Changing a textbook's explanation or answer creates a deliberate new edition with the previous edition and its history retained.
Existing links keep their selected edition. If an edition has a known correction, show the correction and an explicit action to open the replacement edition; do not silently redirect or transfer answers.
Mark a withdrawn edition as unsuitable for continued learning, retain its historical record, and avoid suggesting it for new links.
Existing version-1 files require article-source excerpts and exact quotations; keep that format and its validation intact.
Version 2 defines a separate topic request without article fields while retaining the old format. Do not fabricate a referring article or quotations to fit version 1, or silently convert existing files.

## Preparing and maintaining a textbook

Reuse an existing suitable textbook before proposing new content.
OpenAI can help prepare a missing topic or a deliberate revision after the destination, exact submitted material and costs are agreed.
Article text, personal annotations and answer history are not implicitly approved input because an article led to a topic.
The topic, learning goal and separately selected public evidence are candidate inputs; their final scope still requires agreement.
Key creation alone does not authorize a request, payment, deposit, publication or a shared operator key.

### Persistent execution foundation

`workers/topic-job-queue.mjs` and the internal `TopicTextbookJobs` Durable Object retain approved generation/review-stage requests independently of a browser connection. This is infrastructure for #202, not the completed authoring experience: the browser entry point, automatic evidence preparation, generate→review→edition pipeline, recovery controls and owner acceptance remain incomplete. The old excerpt form below is not adopted as the new entry point.

The object has its own SQLite storage/alarm, separate from RSS collection. Its internal binding accepts enqueue/read/refresh/retry/cancel/resume/remove commands and metadata lists of 20 jobs per page. These commands have no public browser route. A future authenticated gateway must enforce account/CSRF checks and sending/cost approval, never accepting a browser-selected internal owner. Before live generation, dispatch must also recheck account eligibility/revocation independently of the originating session; this gate is not implemented yet and the production account object still has no provider configuration. Production configurations do not add the binding/migration and remain disabled. Later enablement requires `TOPIC_TEXTBOOK_JOBS` bound to class `TopicTextbookJobs`, a new SQLite-class migration, `TOPIC_TEXTBOOK_JOBS_ENABLED=true` and an approved provider configuration in the account object. A flag alone neither connects a provider nor approves spending.

The exact request/model/cost approval and alarm commit before dispatch. A repeated ID with identical input returns the retained job; changed input/model/approval conflicts. Limits are 200 retained jobs and 20 queued/running jobs per owner. Bounded input/result JSON is split below the storage value limit. Unknown layouts and corrupt fragments fail without deleting data. An unreadable individual job is withheld while other readable jobs continue. The queue does not read the credential store or automatically gather personal answers/annotations. It bounds `requestRaw` rather than classifying its contents; the future preparation/gateway layer must validate the approved topic/source material. States are `queued`, `running`, `complete`, `rejected`, `held` and `cancelled`; `complete` describes one validated provider stage, not a reviewed/published textbook. An attempt and a 60-second recovery alarm persist before provider work. Re-delivery or recovery of a running job only looks up its account ledger, never dispatching generation again. Unknown results remain held, including a crash before dispatch can be proved. An explicit result refresh can recover a later ledger result without resending. A manual lookup during the original running attempt retains its recovery alarm. Disabling retains jobs and stops new dispatch while disabled, without cancelling work already sent. If an alarm runs while disabled, the queued work needs an explicit resume by ID (or an identical repeated enqueue) after re-enabling to schedule it again. A queued job can be explicitly cancelled without dispatch and then removed; cancellation of already-started work is refused. No automatic generation/review retry is added.

An explicit retry requires a newly confirmed quote for the same logical input/model and a ledger lookup showing no record or proof of no dispatch and zero usage. It preserves the operation ID and the existing budget engine's duplicate protection; paid failures and unknown usage cannot be retried this way. Explicit removal is limited to complete/rejected/cancelled job receipts, freeing their queue capacity without changing the account ledger, charges, saved textbooks or answers. Queued/running/held receipts cannot be removed. Browser controls for these internal operations remain incomplete.

An approved job is independent of the originating browser session; logout does not cancel it. The generation service still checks the current credential before dispatch and retains its existing budget/quote protections. `TOPIC_TEXTBOOK_JOBS_ENABLED` stops new background dispatch separately from the browser credential-input gate; read-only result lookup stays available.

Local tests cover transactional failures, duplicates/conflicts, owner isolation, interruption, result-save recovery, delayed results, corrupt/future storage, capacity, explicit retry/removal and paging. A SQLite-backed Workers fixture uses the real alarm after restart with no browser or manual alarm hook; a persisted fixture instance marker proves execution happened after restart, and duplicate enqueue plus another restart retain the same result/budget with one generation-stage call. Provider data and credentials are synthetic and outbound network calls are refused. This is not real-model quality, browser usability or hosted-operation acceptance.

### Earlier authoring prototype

The earlier authoring prototype exposes **テーマの教材を作る** in the signed-in textbook library. This excerpt-based form and its receipts are existing implementation, not acceptance of the asynchronous workflow requested in #202.
Choose a new topic or explicitly reuse an existing topic ID, enter the learning goal and paste one to three public-source excerpts (up to 6,000 UTF-8 bytes each). No article, note or answer history is selected automatically, and source URLs are not fetched.
Preview the exact topic, goal, excerpts, model, data conditions and per-stage maximum cost before confirming generation. Review is a separate confirmed request with its own quote; a successful operation does not imply a passing review. A rejected review cannot be saved as a textbook and is not automatically retried.
Only an accepted, explicitly saved candidate becomes an immutable local edition with its source snapshots and review. Its deterministic book identity supports repeated local saving without another provider call or changing existing answers.

The account-scoped `quilna.topic-generation.v1` IndexedDB database holds at most 200 operation receipts, including exact approved input, quotes and request IDs. The logical request, model and candidate are immutable. A receipt must commit before dispatch. One review receipt per generation is enforced across tabs; no automatic generation/review retry occurs. If lookup finds no retained generation or review, the owner may explicitly reconfirm its current quote with the same operation ID and unchanged content/model. The previous quote is retained (up to 20 changed quotes; identical quotes do not consume this limit). Quote approval is excluded from logical-operation identity, so an older racing submission returns the same retained operation rather than creating a second paid operation. Changing content or model still conflicts. A rejected operation can be explicitly rerun with that same ID only when the host recorded proof of no dispatch and zero usage (`knownUnsent`), exposed by lookup as `retryable: true`. Paid failures, dispatched zero-usage failures, negative reviews and unknown outcomes are never made retryable by a client flag. The explicit `retryUnsent` confirmation is excluded from logical identity, and a new reservation replaces only the confirmed-unsent record in the same ledger transaction.
After interruption or reload, **保存した結果を確認** uses the same operation IDs for a read-only lookup, including when generation is disconnected. Stopping the wait does not cancel external work or waive charges. Deleting receipts is explicit and warns that unrecovered results will lose their local lookup reference; it does not cancel backend work, release holds or delete saved textbooks. Receipts are browser/account-local and are not included in article backups.
Unsupported receipts fail closed without deleting stored data; use a compatible app version instead of silently discarding them. CSRF is refreshed for each explicit operation, and token-only expiry does not invalidate the account or reload other tabs.
The normal deployment remains disconnected. Browser and transport tests use synthetic responses, not evidence of live lesson quality, real-key configuration or owner acceptance.

Check the proposed content's factual support, prerequisites, worked examples, unambiguous questions and supported answers before making an edition available.
Retain the actual source snapshots and review result; do not label model-provided URLs as verified evidence.
Stable concepts need no periodic regeneration solely because another article mentions them.
Correct factual defects and review version-dependent claims against current primary sources when maintaining an edition.
Keep the existing manual question/addition workflow and old learning history; a fixed edition can still receive a reviewed improvement.

## Local correction and withdrawal records

For a retained version-2 textbook, open **教材の訂正・撤回を記録**. Record the reason and the evidence for the judgment (each at most 2,000 UTF-16 units). These are the current library reader's private records, not authenticated publisher announcements. No source is fetched and no provider or publisher is contacted. The record is excluded from textbook JSON exports and article backups; it is lost if that library's browser storage is erased.

A correction selects an already retained higher version with the same textbook and topic IDs. The exact source and replacement edition IDs and digests are retained. A withdrawn target cannot be selected. Existing article links keep their old edition and show the record; **訂正先の版を読む** opens the replacement only after an explicit click. Textbook bytes, sources, old answers and article links are not rewritten or transferred.
Article entries open the replacement in a separate tab without a referrer. If the replacement is later withdrawn or cannot be verified, the old edition shows that problem and withholds the replacement link.

A withdrawn edition remains readable as history with a warning, but is excluded from new article-link choices. Answer storage checks withdrawal in the same transaction as the append, so a stale open reader cannot append another answer after withdrawal commits. Article links use a separate database: withdrawal concurrent with a link's final validation can leave a historical link, which displays the warning instead of moving or deleting it. Existing reasons can still be edited and links removed.

The existing `quilna.shared-textbooks.v1` database moves from IndexedDB schema 1 to 2, retaining `books` and `answers` and adding `notices`. File format versions 1 and 2 do not change. Unknown layouts/versions are refused without reset; older app builds cannot open the upgraded database. Records bind the immutable edition digest, a fresh revision UUID, kind, reason, evidence, reader attribution, update time and optional replacement. Writes compare the expected revision in one transaction; deletion and recreation cannot satisfy an old revision. Failures preserve the input and stored records, and an explicit reload discards the input in favor of the latest record. Account-specific library naming and session invalidation apply to these records too.
An unreadable notice is retained and prevents new answers and new article links for that edition; other editions remain available. Use a compatible app version to inspect an unknown format. The app does not ignore or delete the record to resume answering, because it may contain a withdrawal. The text and earlier answers remain readable, and the textbook file can still be exported.
An explicit reload keeps editing and saving disabled until both the retained record and replacement choices have been checked. Notice and focus signals received during an operation are processed afterward. New article-link drafts retain their source and reason while withdrawn choices are removed; a selected edition that is no longer eligible cannot be saved as a new link.

## Browser acceptance

- Two different articles can open the same textbook edition without regenerating it; a later RSS update leaves its content and answers intact.
- Reuse follows explicit topic identity, not equal labels; separate topics with the same name and distinct users' libraries are not merged.
- A reader can follow a technical term directly to its textbook without opening suggestions, quoting the article or saving a reason, then return to the original article position.
- A textbook teaches its topic independently of either article, while its factual claims and questions retain appropriate evidence.
- Old CAA-demo history, imported version-1 files and their answers survive the addition of the new workflow and any migration failure.
- A correction identifies the replacement edition, preserves the old link and answers, and requires an explicit choice to open the replacement. Withdrawn editions do not appear as new recommendations.
- Missing content, generation failures, save failures and unknown billing outcomes remain explicit and recoverable without overwriting retained editions.
- Reading and questions work without an API call. Any generation path requires the established approval, budget, cancellation and duplicate-send controls.
- Validate desktop, narrow screens, keyboard navigation, immutable versions and private answer separation, then obtain the owner's usability acceptance.

These conditions refine #7; they do not close #7, [#30](https://github.com/tqer39/quilna/issues/30) or the [browser-first gate](product-development.md).
