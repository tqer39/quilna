# Textbook files and private answers

[English](textbook-sharing.md) | [日本語](textbook-sharing.ja.md)

## Browser workflow

Open **設定 → 受け取った教材 → 教材ファイルの取り込み・読書へ**, or `/?view=textbooks`.
Select a compatible JSON file, inspect its edition, learning goal, section list, source excerpts/URLs and sender-reported review, then explicitly import or cancel.
Import does not subscribe to a source, download the source, contact a model or send a file to another person.
The browser keeps a separate imported library with the original book identity and version.
An identical record can be imported again; different content under the same original book/version is refused without overwriting it.

Open a retained edition to read its paragraphs, prerequisites, worked examples, questions and explanations.
Reading hides the import instructions, file controls and library. **教材一覧へ戻る** restores them and returns focus to the originating edition; it also works during an answer-history read, and a late read cannot reopen a closed reader.
The return control stays available while scrolling. Completing an answer save restores its control's focus when the same reader is still active and focus has not moved elsewhere.
The contents links move focus to the selected section; evidence disclosures show the exact quoted passage and source link.
Text remains plain text, including imported markup; source links open only on an explicit click.
Answer choices and outcomes are saved under the exact immutable record, separately from the fixed CAA demo and every other imported edition.
A failed answer write retains the selection for an explicit retry.
If existing answers cannot be read, the textbook remains readable while new answers are disabled until a successful retry.
Reload retains books and answers. The `book` URL parameter identifies the exact retained edition, and contents links add `#shared-section-<id>` for a section. Direct URLs, Back/Forward and reload restore that edition and heading without fetching a source. Missing editions are reported in the current library; these URLs do not publish or synchronize a textbook. The whole book remains available, but no separate per-section resume preference is stored.
Answer history pages 20 attempts at a time, starting with the most recent page; older pages remain available.
Visible answer dates use Japanese date/time formatting in the browser's local timezone. Stored ISO timestamps and each `time` element's `datetime` remain unchanged.

In **教材ファイルを書き出す**, review the chosen edition and excerpts, check the confirmation and download the file.
Export uses the retained archive text and never reads the answer database, account/session stores, notes or existing demo history.
It includes the learning goal, selected source excerpts and their metadata, questions, explanations and the sender's generation/review labels.
These text fields can themselves contain personal or licensed material: inspect them before giving the file to someone else.
The download does not send it to a recipient. A recipient's answers remain in that recipient's browser and are absent from re-export.

Source-to-textbook generation is still unconnected in the browser ([Issue #7](https://github.com/tqer39/quilna/issues/7)).
This reader accepts the existing portable textbook-file contract and re-exports accepted files; it does not turn collected articles or the fixed CAA demo into a generated textbook.
Hosted sharing links, collaborative editing and a shared results dashboard are not implemented.
Owner usability acceptance and a live, end-to-end creator/recipient workflow remain unfinished ([Issue #30](https://github.com/tqer39/quilna/issues/30)).

## File contract and validation

The version-1 envelope retains `format: "TsumikiText"`, `schemaVersion: 1` and a canonical base64 `record` for compatibility with the existing portable format.
The immutable record preserves its original UUID, positive integer version, creation time, exact request/draft/review bytes and distinct generator/reviewer invocation identities.
Numeric source and creation dates use seconds since 2001-01-01, including fractional seconds.
Missing source dates/URLs are displayed as unknown rather than invented.

The complete UTF-8 file is bounded to 540,000 bytes; the decoded record to 400,000 bytes; request, draft and review to 48,000, 96,000 and 120,000 bytes respectively.
All nested JSON rejects unknown fields, duplicate decoded keys and nesting beyond 32 levels.
Invalid UTF-8, unsupported schemas, noncanonical base64, invalid identities/links, duplicate questions/options, forward prerequisites, broken quote references and digest mismatches are refused.
The draft has 1–8 lessons from 1–3 retained sources. Every explanation, example, question and choice must have an exact quote in its selected source excerpt.
The sender's review must cover every lesson and all six known checks successfully, with hashes matching the exact request/draft bytes.
These are structural and content-link checks: a hash is not a signature, an exact quote need not substantiate a claim, and a file can forge a successful review.
The UI identifies the review as sender-reported; importing does not independently verify correctness, provider use, identity or redistribution rights.
Unknown extra fields are refused, including fields that might otherwise conceal answers or credentials inside opaque payloads.

## Local retention and verification

`quilna.shared-textbooks.v1` is a separate IndexedDB database with imported editions and recipient-only answers.
By default the library is shared within one browser profile/origin; different people need separate profiles. The opt-in [account libraries](source-document-catalog.md#account-bound-browser-libraries-opt-in) also scope imported books and recipient answers, while logging out retains them for that account. This does not change the exported file or grant synchronization.
It is not synchronized between devices or included in the article-library backup. Keep the original textbook files as well.
Reading retained data assumes the app has loaded; offline startup installation is not provided.

Import checks identity conflicts and the 100-edition capacity inside one transaction.
Answers append transactionally after rechecking the retained edition, with a 10,000-answer limit per exact record.
Capacity, read/write failure, corrupt retained data and unsupported database versions preserve the previous records and report failure; no automatic eviction or reset is performed.
Deletion and answer-history backup are not provided by this workflow.

`tests/shared-textbook.test.ts` checks the format and adversarial nested payloads.
`tests/browser/shared-textbooks.spec.ts` uses disposable profiles and synthetic version-1 data for preview/cancel, two-recipient answer isolation, exact re-export/reload, concurrent conflict/capacity, corruption, failed storage/retry, stale file reads, markup and narrow-width behavior.
The synthetic record is derived from the existing native-format fixture; its successful sender checks are test data, not model-quality or fresh native-runtime evidence.
Run the maintained [browser checks](browser-validation.md); the existing native development and owner-acceptance gates remain unchanged.
