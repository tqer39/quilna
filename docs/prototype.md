# CAA fixed-content textbook prototype

[English](prototype.md) | [日本語](prototype.ja.md)

This is a historical development log for the web prototype. Entries describe the implementation
and verification at each stage; see the [README](../README.md) for current entry points.

## Choices and scope

The existing repository contained only a README. AGENTS / .agents / .agents/skills did not exist.
A static TypeScript + Vite client was chosen instead of a separate npm package.
A runtime such as React was considered unnecessary for a single-section renderer.
Zod validates the textbook and storage formats, and the text is displayed as restricted Markdown.
Local npm dependencies and the lockfile are shared across all operating systems; no OS-specific packages are added.

The current goal is to be able to explain, in one's own words, why the first CAA RRset is selected.
This is a fixed-content textbook prototype; generating material from a topic is not implemented.
The 5/10/15/30-minute choices divide the same content into sessions and vary the amount of practice.
Time and difficulty are separate, and changing the time does not call AI.

## Official sources and semantics

The following were checked before implementation on 2026-10-10:

- [RFC 8659 §3](https://www.rfc-editor.org/rfc/rfc8659.html#section-3)
- [RFC 8659 §4](https://www.rfc-editor.org/rfc/rfc8659.html#section-4)
- [Let's Encrypt CAA](https://letsencrypt.org/docs/caa/)

The lookup in §3 proceeds from the requested name to its parents and stops at the first nonempty CAA RRset.
An RRset containing only iodef does not restrict issuance.
The issue property in §4.2 authorizes a CA; an empty issuer grants no authorization.
Permissions from issue records within the same RRset are additive. Parent and child RRsets are not combined.
The iodef property in §4.4 specifies a reporting destination.

The text, diagrams, and comprehension checks teach these relationships.
Diagrams and question grading share `evaluate`, and all four patterns are unit-tested.
Authorization under CAA policy does not guarantee successful issuance.
Only fixed examples with normal responses, non-wildcard names, flags 0, and issue / iodef are covered.
CNAME, unknown critical 128, issuewild, CA parameters, DNSSEC, and failures are not covered.
This cannot be used as a general-purpose CAA evaluator.

## History and resuming

`schemaVersion` represents the storage format; `bookId/version` represents the textbook edition.
The anonymous `userId` is a local ID, not a Google user.
Answers are appended, and only the resume position is updated. Answers from older editions are not replaced.
An old edition's resume position is not automatically applied to a new edition.
Timestamps are UTC ISO strings, not measurements of actual study time.
URL hashes and browser Back are supported. After saving, the resume button returns to the previous position.

## Local backlog

- Implement topic selection, official-source collection, generation, validation, and textbook review
- Google authentication, server-side user IDs, and history synchronization/deletion/export
- Block-ID migration during updates and resolution of multi-tab conflicts
- An in-textbook answer-history review list and storage of explanation exercises
- A UI for exporting/recovering corrupted history (overwriting is currently stopped)
- Management of sources, verification dates, and versions for generated updates
- Evaluation of practical skills, article writing, and explaining to others
- AWS / GCP / Sakura exercises and cost explanations; Mac / Windows / Linux verification
- Architecture, budget estimates, and measurements to meet JPY 500 per month, including AI but excluding exercise costs

This local static textbook incurs no operating or AI costs in this work.
It does not prove that the full service can operate for JPY 500 per month.
No external issue, push, PR, deployment, OAuth registration, or blog publication will be performed.

## Verification record

The following were run locally in Chromium on macOS arm64:

- lint (ESLint + Markdown), typecheck, and production build: passed
- Unit tests: 5 passed (lookup, diagram/question consistency, separation of history by version, storage failures)
- Browser tests: 5 each at desktop 1440×1000 / mobile 390×844, 10 passed in total
- Verified reading, diagram switching, incorrect answer → retry → correct answer, suppression of repeated clicks, reload, resuming partway through, and Back
- Verified every time choice, reading-mode switching, completion, a collapsible contents list, and no horizontal overflow
- Verified storage failure → retry, prevention of overwriting corrupted history, and continued reading when storage is disabled
- Verified keyboard diagram interactions and reduced motion
- Captured and visually inspected desktop/mobile PNGs of diagrams and key points
- Runtime npm audit: 0 findings

Follow-up investigation and limited fixes for the audit of all dependencies are recorded in the
[dependency audit record](dependency-audit.md).
After the fixes, 5 high-severity findings remain, with a single root cause in braces.
Production dependencies have 0 findings. No audit exclusions were applied.

Physical smartphones, Safari, Firefox, Windows, Linux, and screen readers have not been verified.
Google authentication, generation, cloud exercises, and measured costs are not implemented and are outside this verification.

## v1.1.0 textbook improvements

Following an additional request, the official RFC was rechecked on 2026-10-10.

- `scope` / `boundary`: comparison of five names—a parent, child, descendant, sibling, and descendant with its own RRset
- Controls for prohibiting all CAs or limiting CAs at the child, selecting the comparison CA, and setting the descendant's own RRset
- Four prediction questions added for descendants, siblings, independent RRsets, and the CA used for renewal
- Operational examples added for restricting the intended CA, prohibiting issuance for validation names, and renewal failure after CA migration
- Explicit limitations covering every requested SAN name, existing certificates, browser connections, and prevention of unauthorized issuance

`evaluateName` provides the shared decision for first-RRset lookup and CA authorization.
New and old diagrams, questions, and operational examples all use this function to calculate results.
Rather than squeezing the additions into 10 minutes, the estimated duration changed to 20–30 minutes, excluding explanation practice.
The 13 short blocks are split across multiple sessions according to the 5/10/15/30-minute estimates.

The textbook version is 1.1.0, and the textbook schema is version 2, which accepts the old format.
The previous textbook source is retained in `src/books/caa-v1.ts`.
The storage schema remains 1. New-edition attempts are appended without changing old-edition attempts.
Old resume positions are not automatically applied to the new edition, and the update is shown in the UI.
After saving an answer in the new edition, reading can resume at a position from that same edition.

The [design for growing a textbook through questions, conversation, and terms](growing-textbook.md) was also recorded.
No UI was implemented that makes these future features appear operational.

After the update, lint / typecheck / build, 9 unit tests, and 14 desktop/mobile browser tests were verified.
PNGs of the new scope and applications views are captured in `test-results/`.
Empty duplicate `@types/* 2` development-dependency directories appeared to come from synchronization.
The original data was moved to `/tmp/adaptive-textbook-preserved-types-1791604961993` and preserved.
There were no tracked changes by others.

## v1.2.0 Japanese wording and explanatory diagrams

The user pointed out that “01 / 最初の RRset が決める” (“01 / The first RRset decides”) did not explain
what “first” referred to or what it decided from the heading alone.
It changed to “01 / 発行判断に使う CAA レコードはどれ？” (“01 / Which CAA records are used for the issuance decision?”),
and the text defined an RRset as a set of DNS records with the same name, type, and class.
Short explanations were also added for certificate authorities and iodef, avoiding any implication that iodef guarantees notifications.

- Sequence diagram in 01: explains who queries, who responds, and who decides
- Flow diagram in 04: explains whether lookup continues or stops depending on whether a set exists
- Lookup view in 04: steps through candidate → query → selected set → decision under CAA
- DNS trees in 02 / 06: retain the comparison of configurations and scope by name

The sequence diagram uses top-to-bottom time order and distinguishes messages between the applicant, CA, and authoritative DNS
from the CA's internal processing.
It explicitly omits recursive resolvers, caches, repeated queries for parent names, and failures.
Authorization under CAA is not shown as completed issuance; domain-control validation and CA-specific requirements are separate.
The diagram does not make definitive claims about the exact order of checks or CP/CPS exceptions.

The flow's lookup display uses structured query results from `evaluateName`.
A new candidate appears only when moving to a parent; a child's iodef also stops lookup at that child.
Step numbers indicate the current interaction position and are not presented as a state-transition diagram.
Only static HTML/CSS and the existing deterministic logic are used. No dependencies such as Mermaid were added.

Diagram explanations and body text use normal HTML text instead of shrunken SVG text.
Mobile branches are stacked vertically. Arrows, time order, branches, and prose express the relationships.
Next, previous, and restart can be operated by keyboard, with no motion effects.
The material still has 13 blocks, with the estimate reassessed at 25–35 minutes.
If 30 minutes is insufficient, it suggests leaving the final section for the next session.

The textbook version is 1.2.0, with textbook schema 3. Sources for old editions 1.0.0 / 1.1.0 are retained.
The history storage format remains 1; answers from the new edition are appended without deleting older answers.
Term exploration and conversational features remain unimplemented.

lint / typecheck / build, 11 unit tests, and 16 desktop/mobile browser tests passed.
Mobile/desktop sequence / flow PNGs were captured and visually inspected.
RFC 8659 §1, §2.2, and §3–4 were rechecked on 2026-10-10.

## v1.3: integrating reading-mode choices into the text

The old UI's “grasp the basics / add an operational perspective” choice only showed or hid operational notes in 01 and 05.
It did not change questions, diagram evaluation, or order and was not a difficulty-adjustment feature.
The choice was removed. Why a parent-only audit misses cases was integrated into the lookup explanation in 04, and change-review cautions into the scope explanation in 05.
Everyone follows one common section, from the basic explanation through diagrams, questions, and operational examples.

The 5/10/15/30-minute choices remain as guidance for splitting study sessions.
Future difficulty adjustment based on understanding of individual concepts is a separate requirement and was not removed by this change.
The old v1.2 textbook and its answers are retained under their original versions.
History schema 1 reads the old difficulty as an optional field; new resume records no longer write this display state.

Verification: lint, typecheck, 11 unit tests, 18 browser tests (desktop/mobile), and build passed.
Verified retained old answers, the absence of difficulty in new history, and availability of operational notes after time changes and reloads.
Mac Chrome also confirmed that the reading-mode choice was gone while time selection and the operational notes in the text remained.

## v1.4: reducing the burden of reading and interaction

On smartphones, the DNS tree changed from a uniformly scaled SVG to a vertical HTML parent/child layout.
Names wrap at 16px and decisions at 14px. The desktop SVG and CAA semantics are retained.
Before the body, the UI now presents a short textbook name, notice of unimplemented features, time selection, and the current scope and endpoint; detailed prototype explanations, storage scope, and terminology open under the introduction.
The entry point to the first-time explanation remains available, without repeating the same long explanation at each block.
The save-status strip moved into normal layout so it does not cover the text.

Flow controls are placed immediately after the opening explanation, keeping settings, controls, and the current step adjacent.
The overall flow remains available in a collapsible view; the remaining operational explanation continues afterward without being removed.
Static explanations were added for IN, flags, SAN, and CP/CPS.

The 5/10/15/30-minute plans sum editorial estimates for each block to show a range from the start to an endpoint.
From the beginning, these are 01–02 / 01–04 / 01–06 / 01–13. Changing the time makes the current block the new starting point.
Range lines in the contents, endpoint labels, and a suggestion to pause at the endpoint were added. Content after the endpoint remains freely readable.
These are neither time guarantees nor completion judgments based on comprehension. Continuing to the next session's start saves the next block.
The new optional planStart field was added to history schema 1, which still reads older history. The old v1.3 material and answers are retained.
The resume button shows the previous block's name and explicitly states that diagram settings, scrolling, and displayed answers are not restored.

### Before/after measurements under the same conditions

Measurements used installed Chrome 155 on a Mac, headless, with empty storage.
This is distinct from directly operating the user's ordinary Chrome tabs.

| Metric | v1.3 | v1.4 |
| --- | --- | --- |
| Names in the DNS diagram at 390px | About 9.4px / 8.3px | 16px / 16px |
| Top of the block heading at 390px | About 712px | About 323px |
| Top of the block heading at 1440px | About 551px | About 332px |
| Distance from the flow heading to the next-step control at 390px | About 1894px | About 300px |
| Width of 06 at 320px | 324px (4px overflow) | 320px (no overflow) |

User testing and verification against every WCAG criterion have not been performed. Improved dimensions do not demonstrate more efficient learning.
Future checks will use the SRE user's reading, predictions, next-day explanation, and resuming to assess actual time and misunderstandings.

Verification: lint, typecheck, 12 unit tests, and build passed.
All 22 desktop/mobile browser tests and the same 22 tests in installed Mac Chrome passed.
Coverage includes keyboard use, reduced motion, storage failure/retry, old answers, resuming, and repeated time changes.
All 13 blocks at 320px/390px had no horizontal overflow, and smartphone DNS-tree names were confirmed at 16px.

## v1.5: in-place term explanations and choice-specific guidance

Dotted underlines in the body open short definitions, current context, concrete examples, and official sources for certificate authority, RRset, and iodef.
HTML term links also sit near diagrams, avoiding dependence on interaction with SVG text.
The term ID and textbook ID/version/block ID specify context, distinguishing an independent RRset's scope from parent/child lookup stopping rules.
These are static explanations. Opening one is not recorded as understanding or as an answer. No AI call is made.

Existing questions distinguish combining parent/child sets, propagation to siblings, descendant lookup, and authorization for a different CA according to the scenario and chosen answer.
Guidance asks the reader what to check for that choice; a single wrong answer is not used to characterize ability or thinking.
Even a correct answer allows inspection of the reason and diagram. The diagram shares evaluate's lookup, selected set, and decision and highlights the selected location.
Only queried names are shown; it does not depict further parent or sibling lookup after a set has been selected.

Term explanations and question diagrams open in native dialogs; close, Escape, and Back restore the original position and focus.
Forward can reopen an explanation. Opening and closing explanations does not change the textbook URL hash or answers.
Within the same tab, displayed answers persist across diagrams, previous/next navigation, and time changes. Retrying appends a new attempt.
Reloading or resuming later does not restore answer displays or diagram settings. The saved answers themselves remain.
The old v1.4 textbook is retained. History schema/storage keys are unchanged, and older answers retain their original versions.

Conversational AI, automatic generation, billing APIs, authentication, and synchronization remain unimplemented.
Automatic comprehension estimation, long-term restoration of displayed answers, and user testing remain future work.

Verification: lint, typecheck, 14 unit tests, build, and 28 desktop/mobile browser tests passed.
Checked 320px/390px/desktop, repeated term opening/closing, repeated close clicks, Escape, focus/scroll restoration, and Back/Forward.
Verified incorrect answer → choice-specific guidance → diagram → return → answer again, with guidance still available after storage failure.
All 28 tests also passed sequentially in installed Mac Chrome.
The initial parallel Chrome run timed out in two cases: screen capture and redisplaying history.
The four relevant cases passed sequential rechecks, and the complete sequential run passed, but the parallel timeout cause remains unidentified.
Ordinary real-Chrome tab interaction, user testing, and verification against every WCAG criterion have not been performed.

## v1.6: learning outcomes, four terms, and status colors

Only the opening block displays four goals: purpose and limitations, scope, the selected set and authorization decision, and operational cautions when making changes.
The three practical examples in section 10 remain; the goals are not repeated later while reading.
Learning outcomes are validated as Zod optional outcomes (3–4 items) in textbook schema 4.
The old v1.5 material is saved in src/books/caa-v1-5.ts; the answer-history schema is unchanged.
This is fixed simulated material and does not promise completion of real cloud operations or certificate issuance.

Let’s Encrypt, DNSSEC, resolver, and authoritative DNS explanations can be opened from the body and related diagrams.
After a short definition, context, example, and source, the reader may optionally open more detail.
Explanations do not contain further term popups, avoiding an endless chain of explanations.
They distinguish a CA example from a DNS provider, a resolver searching for an answer from authoritative DNS returning official records, and DNSSEC from CAA.
DNSSEC verifies origin and tampering using signatures; it does not encrypt communication or specify authorized CAs.
CAA does not guarantee successful issuance, universal prevention of misissuance, or revocation of existing certificates.

Primary sources checked on 2026-10-11:

- [About Let’s Encrypt](https://letsencrypt.org/about/): the role of a certificate authority
- [Let’s Encrypt CAA](https://letsencrypt.org/docs/caa/): specifying letsencrypt.org
- [RFC 9499 §6](https://www.rfc-editor.org/rfc/rfc9499.html#section-6)
  Definitions of resolver and authoritative server
- [RFC 4033 §3–4](https://www.rfc-editor.org/rfc/rfc4033.html#section-3)
  What DNSSEC does and does not provide

Shared status components are centralized in src/feedback.ts, and colors in semantic tokens in src/style.css.
Correct answers and successful saves are blue; incorrect answers and save errors are red; resume-position cautions after textbook updates are yellow.
No intermediate grade is added to binary-choice questions. Ungraded and disabled states are neutral.
Both CAA policy authorization and prohibition use neutral colors, labels, and reasons, so an intentional prohibition is not treated as an interaction error.
Icons are supplementary, with labels such as correct, incorrect, save error, and warning shown alongside them.
The existing body stays light; only status components respond to the OS dark setting. This is not a full dark theme.

Contrast in the actual CSS, calculated with WCAG's relative-luminance formula (text/background, border/background):

| Status | Light | Dark |
| --- | --- | --- |
| Blue success | 9.59 / 4.67 | 9.87 / 6.51 |
| Red error | 8.64 / 5.04 | 9.67 / 6.83 |
| Yellow warning | 7.68 / 4.24 | 11.06 / 7.18 |
| Neutral | 8.60 / 4.07 | 10.21 / 5.67 |

Automated checks require text contrast of at least 4.5 and borders of at least 3. The blue keyboard focus ring has 6.98 contrast against the body background, 3px thickness, and a white gap.
Labels that do not depend on color perception were checked, but a full WCAG audit, physical-device testing, and user testing have not been performed.

Verification targets lint, typecheck, 16 unit tests, build, 34 Chromium tests, and 34 installed-Chrome tests.
Checks cover 320px, 390px, and 1440px; light/dark settings; sources for all four terms; folding; keyboard/Escape; Back/Forward; and focus/scroll restoration.
They also cover preservation of answers and local history, the distinction between a correct prohibition answer and a policy prohibition, save failure, and retry.
Images and contrast-ratio JSON are saved in each test's test-results output. This is not verification through ordinary Chrome tabs.

## v1.7: predictions and reflections before interacting with diagrams

At the entry to 02, the reader chooses either to predict before viewing the diagram or to skip prediction and explore freely.
The decision and lookup trace are not shown initially. Choosing prediction first shows only the configuration and saves the answer and optional reason,
then opens the result and diagram. Free exploration does not force a quiz on every interaction.
Existing questions such as 03 remain as comprehension checks; duplicate questions are not mass-produced as extra blocks.

Shared CAA semantics run against the saved configuration: requested name, CA, parent/child records, and scenario.
The comparison stays fixed to the original snapshot. Changing settings during free exploration displays a yellow caution.
Correct/incorrect applies only to the prediction; a CAA prohibition stays neutral. An unanswered comparison is not graded.
After the result, the reader can optionally record what differed, how their understanding changed, and which explanation helped.
A comprehension self-report is a separate optional field; understanding is not automatically inferred from wrong answers or comments.

Three arrays were separated as compatible additions to history schema 1:

- diagramPredictions: textbook ID/version/block/user, attempt ID/time, configuration snapshot,
  prediction or null, optional reason
- diagramReveals: attempt ID and reveal timestamp, CAA decision, prediction correctness or null
- diagramReflections: attempt ID, reflection ID/time, three kinds of text, optional comprehension self-report

Missing arrays in old history default to empty, preserving old answers and resume positions.
Invalid added data stops loading without overwriting the original data.
On save failure, records remain in the same tab; retry saves the prediction, reveal, and reflection together.
Closing the tab before saving loses them. Unsaved text still being entered is not restored after reload either.

Saving a prediction and revealing its result are separate actions. After reload, the latest same-version prediction and whether its result was revealed are restored.
Back/Forward and returning from another block preserve the stage within the same tab, without silently overwriting saved text.
Adding a reflection or retrying appends a new ID. Past predictions from the same edition can be selected and reviewed.
Records from previous editions are kept but are not mixed into comparisons in this edition. The old v1.6 textbook is retained in source.
Block navigation keeps the existing URL behavior; prediction, reveal, and reflection actions do not change #explore.

Verification coverage expanded to 18 unit tests and 40 browser tests.
It compares predictions in every scenario with the same CAA decisions and checks unanswered null values, legacy history, and invalid added data.
E2E runs prediction → save → reload → reveal → different settings → reflection → Back/Forward → reload → retry.
It also checks save failure/retry, 320px/390px/1440px, keyboard use, unchanged URLs, and retention of original predictions, record counts, and old answers.
AI, real DNS/cloud operations, generated conversation, and automatic review when resuming are not implemented.

The [additional diagram presentation and drill-down exploration](visual-expression.md) is a design proposal.

Final results: lint, typecheck, 18 unit tests, build, 40 Chromium tests, and 40 installed-Chrome tests passed.
Both browsers used 2 workers. Screenshots were captured, and the smartphone diagram, red incorrect answers, blue correct answers, and dark status components were checked.
The local tmux adaptive-textbook-caa session remained alive, and 127.0.0.1:5173 was confirmed to return HTTP 200.
Ordinary Chrome user tabs, physical smartphones, physical Windows/Linux machines, a full dark theme, and a full WCAG audit remain unverified.

## v1.8: optional review on resuming and local improvements from questions

The direct resume-position button remains, with a separate optional review-before-resuming entry.
The reader can review the last section visited and unresolved questions, then answer one optional recall question or skip and continue.
Before answering, the correct answer, selected set, and previous key points are hidden; afterward, a reason and short summary are shown.
Correctness is recorded in recalls; comprehension self-reports are separate recallReports records. For a skip, answer/correct are null.
No previous history is fabricated for a first visit. An introduction check for a new edition does not reuse correctness or resume positions from the old edition.

Questions can be saved locally from each section's collapsible area and from term explanations, with section/term/textbook version/time/context.
Duplicate saves of the same question are suppressed. Resolved/unresolved changes are appended as events too.
Actual generation in step 5 is not connected. The user can save manual addition proposals describing the gap, official evidence, and verification date.
The ordinary UI does not show test fixtures, successful generation, or automatic source verification.

Additions are limited to explanations, explanations with fixed pre-issuance/lookup diagrams, and comprehension checks using existing CAA semantics.
Arbitrary JS/MDX/HTML is not executed; restricted Markdown and schemas for allowed components validate the content.
The diff preview shows the destination before applying, and the resulting text/allowed diagrams/fixed scenarios afterward.
Official URLs, verification dates, and evidence are shown together; the user must check a confirmation before choosing to apply.
A future, invalid, or more-than-30-day-old verification date, an unapproved source URL, or duplicate content, IDs, or headings puts the proposal on hold.
Freshness is based on the date recorded by the user, not proof of automatic retrieval. Types alone do not guarantee semantic correctness either.

Applying a proposal takes a Web Locks lock and compares the saved current edition with the proposal's source edition.
Only a successful save switches to a new +local.UUID version. Failure leaves the original material in place.
Canceled proposals, reapplication of applied proposals, and changes to the current edition in another tab are rejected, preserving old answers, original question context, and diagram snapshots.
Normal history saves use the same lock and merge existing history using stable record IDs.
Cross-device/browser synchronization, automatic semantic validation, and replacement with arbitrary textbooks are out of scope.

The following arrays were added compatibly to history schema 1: questions / proposals / proposalEvents / questionEvents /
bookRevisions /
recalls / recallReports. Missing arrays in old history default to empty, and invalid stored data is not overwritten.
Unsaved questions and proposals still being entered do not return after reload. On save failure, records remain in the same tab.
Reloading a question saved from a term explanation into the open section form explicitly warns that unsaved input will be discarded.
The original v1.7 fixed textbook is retained in src/books/caa-v1-7.ts.

The [generation connection and JPY 500 limit decisions](generation-connection.md) were recorded.
Real APIs, secret configuration, transmission, payments, OAuth, and deployment remain on hold until the user's approval and implementation of a budget server.
Drill-down was not added in this implementation.

Final verification: mise run lint, typecheck, 21 unit tests, and build passed.
58 Chromium tests and 58 installed-Chrome tests passed. Each browser used 2 workers with independent output destinations.
Verified optional recall, separation of skip/self-report, old-edition answers, manual diffs, reloading a new edition, save failure, and retry.
Two tabs applying concurrently produce only one edition. Applying from a stale screen after cancellation in another tab is also rejected.
Checks also covered added fixed diagrams/questions, holds for official sources and freshness, 320px/390px/1440px, and no external transmission.
Screenshots of resume review, manual diffs, and the smartphone question form were captured and visually checked.
tmux adaptive-textbook-caa and HTTP 200 from 127.0.0.1:5173 were confirmed.
Ordinary Chrome user tabs, physical smartphones, physical Windows/Linux machines, a full WCAG audit, and real AI generation remain unverified.

## Server with communication disabled, multiple-model boundaries, and N/P navigation

server/ was separated using Node's standard HTTP, fs, crypto, and Zod. No provider SDK or additional proxy was introduced.
The purpose-specific provider/model registry contains capabilities, price-check dates, costs, data conditions, and approval status; selections are unset.
The shared budget ledger implements atomic reservation, idempotency, one concurrent request, no retry, and retention of reservations for unknown outcomes.
Every destination remains disconnected. Stubs exist only in tests, preserving the reading UI's generation-not-connected notice and the user's manual application flow.
Because costs, exchange rates, taxes, fixed charges, and API availability remain unverified, this is not presented as a guarantee of actual JPY 500 monthly costs.
HTTP is loopback-only and checks Host/Origin/CSRF, JSON/schema, and size. External sources are not fetched.
No key discovery, configuration, real API transmission, deposits, or publication occurred. The [details](generation-connection.md) record the contract and remaining work.

N/n moves to the next block and P/p to the previous block through the existing navigation, URL, and save paths.
Navigation is suppressed at either end, on held-key repeat, during IME, with Ctrl/Meta/Alt, in inputs or editable content, and in term dialogs.
Keyboard navigation is also stopped while a proposal awaits application or during review. Back/Forward during application is reconciled after completion.
A checkbox disables single-character shortcuts; if saving fails, the UI shows that the setting applies only to the current tab.
The header's **読書設定** dialog contains this checkbox and explains browser-local history, lack of cross-device synchronization, and data removal when browser storage is cleared.
Normal reading has no permanent local-history or save-success panel. Pending writes, failed writes and explicit retries remain visible; successful retry clears the error only after persistence succeeds.
The shortcut preference retains its existing storage key and per-tab fallback, including its failure notice when reopening settings. Escape, browser Back and the close button return focus to the settings trigger.
Focus moves to the heading, and existing smartphone buttons remain available. Automatic restoration of unsaved input was not added.

Final verification: lint, frontend/adapter contract typecheck, build, 21 textbook unit tests, and 13 server tests passed.
The server JavaScript is checked with Zod runtime schemas and Node tests.
Checks covered idempotency after restart, unset prices/conditions, model switching and the shared limit, no fallback, unknown reservations, and month boundaries.
They also covered corrupted ledgers, leftover locks, source mismatch, stale evidence, arbitrary-code rejection, and localhost Host/Origin/CSRF.
66 Chromium tests and 66 installed-Chrome tests passed. Each used 2 workers and a separate output directory.
Verified N/P, Back/Forward, retained answers, save failures, suppression in inputs/IME/modals, disabling the setting, and pending application.
Layout checks included 320px/390px/1440px, and smartphone screenshots of the N/P hint were captured and checked.
The production server was not left running. Temporary HTTP test servers were stopped; only the existing reading Vite server remains.
Physical smartphones, Windows/Linux persistence, power loss, a full WCAG audit, and real provider requests remain unverified.

## Preparing OpenAI / Anthropic communication code, with real communication disabled

Because the user chose both companies as the first providers, gpt-6-luna / claude-haiku-5-5 were recorded in the candidate registry.
Official model names, prices, JSON schemas, counting, and retention conditions were checked on 2026-10-11.
Both HTTP transports use the same minimal payload and JSON schema and count the full prompt/schema after reserving the budget.
Generation runs once, without retries, with redirects rejected and only fixed endpoints allowed. Keys are explicit arguments only; they are neither discovered nor configured.
The normal server does not register transports and also rejects prepared transports. Candidates are disabled, with purpose selections unset.
Thinking tokens in usage are not double-counted. Anthropic cache input is included, and settlement uses integers and conservative unit prices.
This spent value records an upper bound on cost in yen; it is not reconciled against an invoice.
Refusals, truncated output, invalid JSON/code/sources return no proposal but record costs. Unknown usage or timeouts retain the reservation.
Even counting requires external transmission. Real transmission remains stopped because counting charges and an upper bound on estimation error have not been established.
The [connection decision and remaining setup](generation-connection.md) distinguish approval of transmitted text, retention conditions, costs, and key configuration.

Verification: lint, typecheck, build, 21 textbook unit tests, and 32 server tests, including 19 new transport-mock tests, passed.
Without real networking, the new tests covered both providers' counting/generation bodies, non-disclosure of secrets, reservation before sending, duplicate suppression, usage breakdown,
failures/redirects/size/abort, refusals/invalid output, and the common budget.
66 Chromium tests and 66 installed-Chrome tests passed. Existing QA and image capture at 320px/390px/1440px also passed.
Real API acceptance, generation quality, account availability, billing conditions, physical smartphones, and physical Windows/Linux machines remain unverified.

## Users' own BYOK settings screen, simulation only

The specification changed so that service users configure their own LLM keys; it does not assume a shared operator key.
The header opens simulated OpenAI / Anthropic registration, checking, replacement, deletion, re-registration, and candidate-model selection.
At this stage, real authentication and encrypted storage were not implemented, so real key fields were disabled and empty. Settings were metadata in memory only.
State is separated by simulated user A/B and provider, controlling repeated clicks, cancellation, user changes, deletion during processing, and stale completions.
Failures preserve the original settings. Return, Escape, Back, and Forward cancel processing.
localStorage history is unchanged, and reload returns to an unregistered state. A simulated check is not shown as a successful real connection.
The [remaining storage, encryption-secret, authentication, deletion, and budget work](byok.md) was recorded.
AI charges are included in the user's JPY 500 monthly operating budget even with BYOK.

Verification: mise run lint, typecheck, build, 26 textbook/BYOK unit tests, and 32 server tests passed.
72 Chromium tests and 72 installed-Chrome tests passed, including layouts at 320px/390px/1440px.
Each browser had 6 new BYOK UI tests covering no external transmission, disabled inputs, no localStorage persistence, user separation, deletion/re-registration,
failures/cancellation/repeated clicks/return, and reload. N/P, textbook answers, saves, and application still work when opening/closing the screen.
The previous query across all h2 elements also matched hidden dialogs, so it was limited to headings in the textbook body.
Screenshots were captured. Real key storage/connection, production user separation, and real API generation were not performed.

## Preparing encrypted Workers storage and per-user APIs

In addition to the mock UI, AES-256-GCM storage and registration/replacement/deletion/model-change/check APIs were implemented.
The user subject selects a dedicated SQLite Durable Object, with checks for a fixed owner, revision, CSRF, size, and operation count.
Ciphertext AAD includes owner/provider/revision/keyVersion, preventing decryption for another user or after tampering.
Deletion and re-registration do not revive old requests, and stale in-flight generation results are not returned. Neither keys nor ciphertext are returned to the browser.
The budget follows one per-user path combining OpenAI/Anthropic, subtracting fixed costs and margin from JPY 500.
Deletion, restart, and month boundaries do not release unknown reservations; keys are resolved only after the reservation is persisted.

The production entry stops with 503 when authentication is not configured. Test principals exist only in a separate entry and cannot be enabled by production configuration or headers.
Google signature/issuer/audience/expiration/nonce verification components and a typed API client are ready,
but login start/callback/session issuance/logout and UI integration remain. Google registration alone does not enable real key entry.
The screen remains a simulation with disabled real-key fields. Real keys, real APIs, OAuth registration, secret configuration, and cloud-resource creation were not performed.
The [API contract and preparation for a real environment](workers-byok.md) record specific steps and unfinished work.

Verification: lint, typecheck, frontend/Workers builds, 29 textbook/API-client unit tests, 32 server tests, and 16 Workers tests passed.
Actual Miniflare/workerd SQLite tests covered restart retention, isolation, concurrent replacement, deletion, missing encryption keys, budgets, and unknown reservations.
Signature checks used temporarily generated test keys only. External fetch was prohibited; no real Google/LLM communication occurred.
72 Chromium tests and 72 installed-Chrome tests passed, including existing QA at 320px/390px/1440px.
Workers delivery at 390px/1440px also confirmed disabled real-key entry and stopped APIs, and screenshots were captured.
The temporary Workers preview was stopped after verification; only the existing reading Vite server remains.
Physical Windows/Linux machines, power loss, backup/PITR, real authentication, actual billing, and an upper bound on operating costs remain unverified.

## Local integration of Google login, sessions, and logout

Code connected login start, Google code exchange and signature verification, callback, expiring sessions, cancellation, and logout.
state/nonce/PKCE S256 are bound to a browser-specific DO flow lasting 10 minutes; callbacks are atomically claimed once before transmission.
Only hashes of opaque sessions are stored, with Secure/HttpOnly/SameSite=Lax/__Host- cookies.
Logging in again in the same browser revokes the previous session; late callbacks after cancellation/logout cannot create sessions.
The implementation includes a fixed one-hour expiry, alarm cleanup, operation CSRF, and rejection of duplicate callbacks or invalid state.
Google scope is openid only, with no offline grant requested. Google tokens are neither stored nor returned to the UI.

A UI using real API status/start/cancel/logout/stored metadata was added separately from the simulated-user fields.
When unconfigured, the API stops and the login button is disabled. Even when authenticated, real-key fields remain empty/disabled and the real sender remains stopped.
Logout/expiration clears metadata and discards delayed redirects after cancellation or old responses.
Login does not synchronize localStorage reading history to the Google user.
The [minimal external-configuration order and URL decisions](workers-byok.md) record origin/callback, Google client, bindings, and secrets.
At this stage the public URL was undecided. OAuth registration, real grants, obtaining/configuring real secrets, real Google/LLM communication, and deployment were not performed.

Verification: lint, typecheck, frontend/Workers builds, 33 frontend unit tests, 32 server tests, and 23 Workers tests passed.
Using test-only providers and temporary encryption keys, real SQLite tests covered restart retention, multiple users, CSRF/state/nonce/PKCE,
callback replay, cancellation, expiration, re-login, rejection of old cookies after logout, and unknown save acknowledgments.
Google exchange code also used mocked transmission/verification functions to check fixed endpoints, PKCE, nonce, limits, and no retry.
After fixing a browser fetch-binding bug, 82 Chromium tests and 82 installed-Chrome tests passed.
Coverage includes existing reading, diagrams, answers, and resuming, plus 10 additional UI tests per browser and smartphone/desktop image capture.
Production cookie delivery, Google endpoint acceptance, session recovery, and operating costs remain unverified.

## Service name and planned URL

Naming differences introduced during development were aligned to “TsumikiText (積み木テキスト)” in line with publication approval.
The repository name adaptive-textbook and existing localStorage/lock keys are retained for compatibility.
The Dev publication destination is tsumiki-text.tqer39.workers.dev, restricted to the owner. A production custom domain is out of scope.
Neither has been created or published. This is neither a guarantee of domain availability nor authorization to purchase one.
The [configuration examples and minimal external-setup order](workers-byok.md) were updated; kazokubi was excluded from the changes.
Access configuration, OAuth registration, secret configuration, real APIs, domain purchases, push/PR/deploy were not performed.

## Better Auth 1.7.7 and authentication-only D1

Custom OAuth/session handling was replaced with Better Auth 1.7.7, and an authentication-only D1 was added.
The AccountVault DO for encrypted BYOK storage and per-user budgets remains. Verified user.id/session.id are converted into a principal.
Google scopes are openid email. Profile access is not requested, and OAuth tokens are removed by a pre-save hook.
The public plugin/verification APIs supplement signature/nonce binding, while a D1 attempt epoch and extra session fields prevent revival after cancellation/logout.
See [authentication DB, configuration, and verification scope](better-auth.md). External configuration and real transmission remain unperformed.

Verification: mise run lint, typecheck, frontend/Workers builds, 33 frontend tests, 32 server tests, and 24 Workers tests passed.
82 Chromium tests and 82 installed-Chrome tests also passed, including existing QA at 320px/390px/1440px.
Temporary Workers delivery verified disabled real-key entry and auth/session 503 at 390px/1440px, then stopped after screenshots were captured.
Production CPU use, Google acceptance, cookie delivery, and prices remain unverified.

## Preparing owner-only Dev publication (2026-10-12)

In line with approval for Dev publication, display names, titles, and remaining old names were aligned to TsumikiText (積み木テキスト).
wrangler.dev.jsonc targets tsumiki-text only, using direct upload without GitHub push/PR.
Before Google configuration, only a preparation-stage login entry is shown. PRIVATE_DEV=true authenticates every asset first,
serving no textbook bundle to anonymous visitors and stopping history/BYOK APIs. Only the owner's single email is allowlisted for Google.
The [publication preparation and concrete handoff](dev-publication.md) record authentication state, the Free-plan check, and remaining secret input.
At this point, publication awaits confirmation of the Free plan. Real Google/secret input and Access configuration have not been performed either.
