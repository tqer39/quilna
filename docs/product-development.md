# Product development sequence

[English](product-development.md) | [日本語](product-development.ja.md)

## Browser first

The owner's decision on 2026-10-24 is tracked in [Issue #41](https://github.com/tqer39/quilna/issues/41).
Complete all agreed product features in the browser first, then iterate until the owner explicitly judges the full browser experience easy to use.
Both feature completion and explicit usability acceptance are required before moving to iOS, macOS or another interface, one platform at a time.
Record the browser feature checklist in Issue #41; a successful RSS slice or fixed lesson is not completion of the whole product.
Keep macOS/iOS feature development, native UI experiments, packaging/distribution, device performance work and native model evaluations on hold until both gates are satisfied.
Preserve existing native code, PRs and dated evidence; unfinished native issues remain open.
Existing CI and necessary security maintenance may still validate native code and the Go harness.

## Reading, curiosity and connections

Implementation and acceptance are tracked in [Issue #72](https://github.com/tqer39/quilna/issues/72) for viewer designs and [Issue #73](https://github.com/tqer39/quilna/issues/73) for highlights and connections.

The owner's priority clarification on 2026-10-27 makes RSS reading and subscriptions to news and SNS feeds the product's center.
Translation and read-aloud support reading; their controls and development work must remain secondary to collecting and reading articles.
Use the reader locale as the translation default and allow changing it in settings, without making language or audio setup a prerequisite for reading.

The following is the intended UI and implementation order, not a claim that highlighting, extraction or a knowledge graph already works:

| Step | Main experience | Acceptance condition |
| --- | --- | --- |
| Subscribe and read | Put subscriptions, unread articles, source filters, search and saved articles in the main navigation. Keep article text central. | A user can add a source, find a new item, read, save and reopen it without entering a learning or audio flow. Show missing content, collection failures and unsupported sources explicitly. |
| Notice something worth exploring | Allow selecting and saving a passage with a short note. Offer a small number of optional learning points or questions beside the text. | Each suggestion leads to its supporting passage and source. Users can dismiss suggestions and read uninterrupted. No forced quiz or textbook generation. |
| Connect what was read | Show related saved passages and previously read articles, with an explanation such as a shared concept, a reference or a user-created connection. | Users can inspect the evidence, correct or remove a connection, and return to the relevant passage. Distinguish suggested connections from user-confirmed ones. |
| Explore relationships | Open a focused relationship map from an article, passage or concept, then expand nearby connections on request. | Selecting a connection shows its reason and sources. Provide an equivalent list and keyboard navigation; do not require navigating a large graph to read an article. |

News and SNS subscriptions belong in the same collection experience, but support must be explicit per source.
Use RSS/Atom when available; services that need authentication, an API or payment remain unconnected until their adapter and prerequisites are handled.
Do not imply that pasting any SNS URL establishes an ongoing subscription.

Start learning support with user-selected passages, notes and explicit links; then add source-backed suggestions and a relationship view using those records.
Preserve article identity, the quoted passage and its source version so a refreshed article or a translated view does not silently move a highlight or its evidence.
A shared tag alone can justify a related-topic suggestion, not a factual claim that two articles support or contradict one another.
Show inferred relationships as suggestions and retain their supporting passages; allow users to hide them.
Separate read/unread, saved, highlighted and explicitly recorded learning states. Opening an article is not evidence of learning or understanding.
Preserve existing browser-local translation preferences; external analysis or translation services require a separate decision before sending article text.

The first implementation slice is reading and persistent highlights, followed by source-backed related-item cards and then a focused relationship map.
Validate each slice with the owner in the browser. Textbook generation remains available as a later, optional deepening path from selected material rather than the default destination after reading.
Read-aloud improvements must not displace these priorities, except when fixing a defect that blocks reading or risks saved data.

## Acceptance loop

1. Start browser acceptance with subscriptions, an article list, reading, saving and reopening. Then validate highlights, learning cues, evidence-backed connections and their relationship view. Connect selected sources to optional textbook generation, contents/diagrams, questions/explanations and saved learning progress afterward.
2. Record the app/source version, browser/viewport and the owner's concrete observations.
3. Reproduce and repair usability blockers, verify the affected behavior, then ask the owner to try the changed flow again.
4. Continue browser work until every agreed browser feature is implemented and the owner explicitly accepts its usability. Record completion and the accepted scope before moving to one native platform at a time.

Automated tests, CI, benchmarks and model reviews support verification; they cannot establish the owner's usability judgment.
Keep lesson/version identity and private answer history intact, and show actual save failures with a retry path.
Distinguish implemented behavior from simulations and disconnected features, including real-key entry, authentication and live generation.
Do not represent a fixed sample lesson as completion of the full generated-textbook product.

## Work ordering

- Address security and data-loss problems first, including [security maintenance](security-maintenance.md).
- Use Issue #41 for browser usability and concrete feedback. Validate the [collection entry in #48](https://github.com/tqer39/quilna/issues/48) first; repair blocking defects before optional additions.
- Prioritize subscriptions and reading, then highlights and source-backed connections as described above. Continue the source-to-textbook-to-comprehension workflow in [Issue #7](https://github.com/tqer39/quilna/issues/7) as an optional deepening path on the browser.
- Preserve source-aware sharing in [Issue #30](https://github.com/tqer39/quilna/issues/30) and paper discovery in [Issue #31](https://github.com/tqer39/quilna/issues/31) as follow-ups to the learning flow.
- Keep native-only work deferred until all agreed browser features are complete and the owner accepts the browser experience.

This sequencing decision does not authorize paid provider calls, new credentials, publication or merging unrelated PRs.
Browser acceptance is currently pending. Do not infer it from an implementation report or a successful automated check.
