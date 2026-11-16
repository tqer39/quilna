# Reusable topic textbooks

[English](topic-textbooks.md) | [日本語](topic-textbooks.ja.md)

## Direction and implementation status

The owner's clarification on 2026-11-17 in [Issue #7](https://github.com/tqer39/quilna/issues/7) makes reusable technical knowledge the purpose of textbooks.
An article can lead to “explore this topic with this textbook”; the textbook teaches the underlying topic and can serve readers arriving from different articles.
Stable technical material can remain fixed between deliberate revisions. Reading an article or receiving an RSS update must not require generating a new textbook.

This page specifies the next browser workflow, not an implemented catalog or accepted experience.
The existing CAA lesson is a fixed demo; imported version-1 textbook files remain readable through the [file workflow](textbook-sharing.md).
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

## Separate content from its entry points

- A topic identifies a learning subject with a stable opaque ID and a human-readable name. Create or select it explicitly; matching labels are candidates for reuse, not permission to merge topics or histories automatically.
- A textbook has its own identity and immutable editions. Its learning goal, prerequisites, explanations, examples and questions describe the topic.
- The textbook's evidence consists of retained, identified source material that supports its teaching claims. A referring article is not automatically evidence for every explanation or answer.
- An article-to-textbook link records why the topic is relevant, the referring article/version and the destination textbook/edition. A suggestion remains distinct from a reader-confirmed link.
- Personal answers, notes, progress, reflections, confirmed links, dismissed suggestions and referring-article records remain private to the current library and outside reusable content, file exports and provider input, as in the existing file workflow.

Updating or removing a referring article must not silently replace a textbook, move an answer to a new edition, delete learning history or grant source-sharing rights.
Changing a textbook's explanation or answer creates a deliberate new edition with the previous edition and its history retained.
Existing links keep their selected edition. If an edition has a known correction, show the correction and an explicit action to open the replacement edition; do not silently redirect or transfer answers.
Mark a withdrawn edition as unsuitable for continued learning, retain its historical record, and avoid suggesting it for new links.
Existing version-1 files require article-source excerpts and exact quotations; keep that format and its validation intact.
Do not make a topic textbook fit that format by fabricating a referring article or quotations. Any new portable format requires an explicit compatible contract and tests before implementation.

## Preparing and maintaining a textbook

Reuse an existing suitable textbook before proposing new content.
OpenAI can help prepare a missing topic or a deliberate revision after the destination, exact submitted material and costs are agreed.
Article text, personal annotations and answer history are not implicitly approved input because an article led to a topic.
The topic, learning goal and separately selected public evidence are candidate inputs; their final scope still requires agreement.
Key creation alone does not authorize a request, payment, deposit, publication or a shared operator key.

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
