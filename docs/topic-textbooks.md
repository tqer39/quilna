# Reusable topic textbooks

[English](topic-textbooks.md) | [日本語](topic-textbooks.ja.md)

## Direction and implementation status

The owner's clarification on 2026-11-17 in [Issue #7](https://github.com/tqer39/quilna/issues/7) makes reusable technical knowledge the purpose of textbooks.
An article can lead to “explore this topic with this textbook”; the textbook teaches the underlying topic and can serve readers arriving from different articles.
Stable technical material can remain fixed between deliberate revisions. Reading an article or receiving an RSS update must not require generating a new textbook.

This page specifies the browser direction and separates implemented steps from remaining acceptance. The [version-2 file workflow](textbook-sharing.md#file-contract-and-validation) supports standalone topic textbooks with independent source snapshots. Readers can now manually connect articles to retained topic editions; a browser authoring flow is available for injected test connections, while live authoring, automatic suggestions, correction/withdrawal metadata and owner usability acceptance remain incomplete.
The existing CAA lesson is a fixed demo; imported version-1 textbook files remain readable through the same file workflow.
OpenAI was selected for the next generation integration, and the owner requested secure creation of a new key.
Key setup, sending scope, model selection and a concrete live-run spending allowance are not yet complete.
No live-generation result is claimed. The existing [budget and sending controls](generation-connection.md) still apply.
The first implementation stays within the current browser library and its existing account isolation. Reuse across articles does not enable cross-user delivery, a hosted shared catalog or pooled generation costs.
Explicit file sharing remains subject to the existing content-sharing checks in #30; public availability of a source does not grant redistribution rights.

## Reading to deeper understanding

1. Read an article without entering a learning workflow.
2. Optionally open a small set of relevant topics, with a reason that connects each topic to the article.
3. Preview the textbook's scope, prerequisites, evidence and available edition before opening it.
4. Read the same retained edition regardless of the referring article; answer optional comprehension questions with private history.
5. Return to the original article and reading position. Neither opening a textbook nor following a link marks learning as complete.

For example, two articles discussing certificate issuance can lead to the same CAA textbook.
An article mentioning asynchronous processing may lead to an independently maintained introduction to asynchronous processing.
These examples do not claim that such links or a general topic catalog already exist.
Irrelevant suggestions must be dismissible, and topic links must support keyboard navigation and narrow screens without crowding article text.
When no suitable textbook exists, show that absence truthfully; do not invent a generated book or start a paid request automatically.

## Manually connecting retained editions

Open **深掘りできる教材** in the article tools, select **教材を関連づける**, choose a saved version-2 textbook and enter a required reason. The preview shows its learning goal and opens its full scope, prerequisites and sources in another tab. No suitable file means no available choice; importing a file is explicit. Version-1 books remain readable but are not choices for these topic links.

**教材を読む（別タブ）** opens the exact retained edition without sending the referring article in the URL or referrer. Closing that tab returns to the original article position. Multiple articles reuse the same edition and its private answers without a generation request. **この記事との関連づけを外す** removes only that article's link, retaining the textbook, answers and other links. There are no automatic suggestions in this step.

The separate, library-scoped `quilna.article-textbooks.v1` database retains the article ID/title/URL, original-or-translated representation, language, body fingerprint and first 1,000 Unicode code points, plus exact textbook/topic identity, file digest, reason, creation time and revision. Changing the body, language or original/translated representation reports a difference without moving the saved link. Limits are 20 links per article, 20,000 total and 2,000 UTF-16 units per reason. Saving compares revisions in one write transaction; failure retains the draft. A conflicting reason requires reloading and explicitly choosing to continue the draft before overwriting it. If another tab deleted the link, that choice prepares recreation; if it created the same link first, it retains that record's creation time. Different source or textbook identities cannot be adopted into the existing draft. Drafts survive article switches within the open page, but not reload or page closure. Normal close calls, close events and `InvalidStateError` discard the cached connection. The next read or explicit retry can reopen it; reopening preserves stored records and never automatically replays a failed write. Cached connections are checked before being supplied to backup/restore, so a known closed connection is refused before restore writes to other stores. This does not make multi-database restore atomic against failures occurring later.

New link drafts capture the reading when creation begins; reason edits keep the recorded source. Changing the reading while choices load or a draft remains open never silently replaces it. A mismatch warning appears before saving. To use the current reading, cancel a new draft and start again, or cancel the reason edit before removing and recreating an existing link.

Private links are excluded from textbook JSON exports and provider input. They are included in [reader-library backups](browser-rss.md#library-backup-and-recovery), which are personal files. Keep textbook JSON files separately: library backup does not contain those books or their answer history. A restored link with a missing or different file shows an unavailable-edition message; it does not reconstruct or replace the book. An unknown link-database version or layout is refused without changing it. Library export/restore also fails in that case instead of silently creating an incomplete backup that omits links.

## Separate content from its entry points

- A topic identifies a learning subject with a stable opaque ID and a human-readable name. Create or select it explicitly; matching labels are candidates for reuse, not permission to merge topics or histories automatically.
- A textbook has its own identity and immutable editions. Its learning goal, prerequisites, explanations, examples and questions describe the topic.
- The textbook's evidence consists of retained, identified source material that supports its teaching claims. A referring article is not automatically evidence for every explanation or answer.
- An article-to-textbook link records why the topic is relevant, the referring article/version and the destination textbook/edition. A suggestion remains distinct from a reader-confirmed link.
- Personal answers, notes, progress, reflections, confirmed links, dismissed suggestions and referring-article records remain private to the current library and outside reusable content, textbook-file exports and provider input, as in the existing file workflow.

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

In the textbook library, open **テーマの教材を作る** while signed into an account library.
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

## Browser acceptance

- Two different articles can open the same textbook edition without regenerating it; a later RSS update leaves its content and answers intact.
- Reuse follows explicit topic identity, not equal labels; separate topics with the same name and distinct users' libraries are not merged.
- A reader can inspect the reason for a link, distinguish suggestions from confirmed links, reject an irrelevant suggestion and return to the original article position.
- A textbook teaches its topic independently of either article, while its factual claims and questions retain appropriate evidence.
- Old CAA-demo history, imported version-1 files and their answers survive the addition of the new workflow and any migration failure.
- A correction identifies the replacement edition, preserves the old link and answers, and requires an explicit choice to open the replacement. Withdrawn editions do not appear as new recommendations.
- Missing content, generation failures, save failures and unknown billing outcomes remain explicit and recoverable without overwriting retained editions.
- Reading and questions work without an API call. Any generation path requires the established approval, budget, cancellation and duplicate-send controls.
- Validate desktop, narrow screens, keyboard navigation, immutable versions and private answer separation, then obtain the owner's usability acceptance.

These conditions refine #7; they do not close #7, [#30](https://github.com/tqer39/quilna/issues/30) or the [browser-first gate](product-development.md).
