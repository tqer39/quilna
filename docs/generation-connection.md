# Decisions for connecting live generation (disconnected)

[English](generation-connection.md) | [日本語](generation-connection.ja.md)

The current working features are question saving, the owner's manual additions, diff review, and applying local lesson versions.
AI generation is disconnected. The normal UI contains no successful-generation fixtures or candidates presented as if automatically generated.
No external submissions, API calls, charges, key retrieval, OAuth registrations, or deployments were performed.
An existing Codex login or visible API settings are not treated as permission for the textbook service to send requests or incur charges.
Secret files, key values, and tokens were not searched. Availability of API accounts remains unverified.
The design is BYOK: service users configure their own keys. A shared operator-owned LLM key is not assumed.
The [BYOK mock screen and storage design](byok.md) have been implemented and documented. Real-key entry is disabled.

## Current textbook direction — 2026-11-17

The owner selected OpenAI for the next integration and requested secure creation of a new API key; setup is pending.
The intended product is [reusable topic textbooks](topic-textbooks.md), with article-to-topic entry points and stable editions that can serve multiple articles.
This supersedes treating a new article as a requirement to generate an article-specific textbook. It does not enable live calls or change the existing BYOK and monthly-budget boundaries.
The exact submitted material, model and live-run spending allowance remain unagreed. Key creation is separate from permission to send or incur charges.
The secure key-setup flow requires a separately confirmed local secret destination; no destination has been confirmed or key written. Never put a key in chat, source control, browser storage, URLs or logs.
This development setup does not enable service users' real-key input or bypass the pending per-user encrypted-storage integration.
The earlier proposal and communication-off implementation below retain their original fixed-CAA scope; they are not a completed implementation of the new workflow.

### Prepared topic generation and review boundary

The local browser-generation branch now prepares `server/topic-textbook-format.mjs` and `server/openai-topic-textbook-transport.mjs` for version-2 topic requests. They share the file parser's source, citation, prerequisite and question validation. The wire draft uses an array for option evidence, rejects duplicate option IDs and normalizes it once before computing candidate digests. The review wire output contains only section checks; the server attaches the exact retained request/draft digests rather than asking the model to copy them. A negative review remains negative and cannot be imported as an accepted textbook. Embedded JSON with a UTF-8 BOM retains its original-byte digest, including for older imported files. These structural checks do not prove factual quality.

The transport requires an explicitly supplied model, reasoning effort, credential (a string or a host-only asynchronous resolver) and HTTP sender. Each generation/review stage counts the complete prompt and output schema through the fixed OpenAI input-token endpoint, then makes at most one Responses request with strict JSON output, `store: false`, no tools, no streaming and no automatic retry or redirect. Model/tier/usage mismatches remain unconfirmed. A complete bounded response with validated usage retains that usage even when output is invalid, refused, incomplete or cancelled; cancelled output is not returned as a candidate. Oversized, malformed or otherwise unconfirmed responses cannot provide verified usage and must retain their budget reservation until reconciliation. Resource caps are 32,000 input tokens, 16,000 output tokens and 192,000 response bytes. The existing CAA transport keeps its smaller caps. See the official [input-token endpoint](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count) and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

Generation and review are separate requests without shared conversation state; this does not guarantee different models or semantic correctness. Exact model identifiers and applicable prices must be approved by the registry/budget integration before live activation; aliases resolving to a different response model remain unconfirmed. The test-only label describes caller-provided synthetic injection, not a network sandbox.

An injected topic contract now shares the Node budget service and its `FileLedger` with CAA additions. An explicitly injected `AccountVaultCore.proposeTopic` also uses the owner-bound Workers ledger adapter, encrypted-credential lease and the same CAA budget. It inspects the actual adapter before reserving, resolves the secret only after the durable reservation, refuses candidates issued by another account ledger and withholds an in-flight response if its credential revision changes. A credential failure reported before counting or generation is known to be unsent and records zero usage rather than an unknown hold; credential-resolution failures use `credential-unavailable`, distinct from revocation/cancellation. While a credential lease has not released its secret, the core can also confirm no dispatch on a service timeout, rejects with zero usage, and prevents late resolution from reaching the provider. After secret release, uncertain outcomes retain their reservations. The existing CAA path likewise records zero usage when its own pre-dispatch credential resolution fails; provider failures after handing over the secret remain conservative unknown holds. Deleting a key does not delete paid retained drafts: the same owner can explicitly recover a stored operation through `lookupTopic`, without a credential, active generation configuration or new dispatch. This lookup preserves pending/unknown holds and rejects changed operation input. The owner-bound read path is covered with the in-memory transaction test double; real Durable Object SQL persistence and HTTP dispatch for this workflow remain unverified and unconnected. Generation and review reserve separately before dispatch, share busy/unknown holds, and account for confirmed usage even when output is invalid or a review is negative. The current registry keeps its smaller 8,000-input/2,000-output ceilings; the transport resource caps do not increase these limits. Review requires the exact request/candidate bytes and the server-issued generation invocation from the same ledger. An operation digest binds immutable input independently of current price/model configuration, so Node replay retains the original invocation and result even after configuration changes or price confirmation expires. The account core checks current credentials before a new proposal; its independent owner-bound lookup retrieves retained results after those credentials/configuration are removed. Read-only ledger snapshots do not create or rewrite the file. Static transport configuration is checked before reserving; provider refusal, incomplete output, input limits and cancellation retain their bounded outcome labels. A rejected or held operation is not resent. A new attempt needs a new request identity; the wire requires `approvedPublicText: true` for every operation, but that field alone is not proof of human confirmation and the preview/confirmation UI remains unconnected. `reserved` means processing or a retained reservation, not completion. A completed review carries a separately computed `allChecksPassed` flag; operation completion is not a passing review. The portable ledger envelope preserves existing CAA records. Synthetic service/transport regressions and coexistence with completed CAA records were checked on the pinned Node runtime. The current token ceilings have not been validated against real generation and review of a usable textbook. The file format's larger structural bounds do not promise that every accepted textbook fits those ceilings; appropriate per-model limits and content evaluation remain activation conditions.

This remains a prepared, injected boundary. Normal startup, browser settings, authenticated HTTP/Workers dispatch, live per-user credential configuration, reading/save UI and live content evaluation remain to be connected. The topic-specific core configuration defaults to null and accepts only explicitly injected test-only adapters; production construction does not enable it. The resource caps are not a spending allowance or a monthly-budget guarantee. No model, sending scope, credential destination or live request is approved by these tests.

## Earlier connection proposal and required prior owner approval

The owner selected OpenAI and Anthropic as the initial providers. Model choices for each purpose and live requests are not yet approved.
A registry and adapter boundary support choosing multiple providers/models for each purpose.
OpenAI Responses API / gpt-6-luna and Anthropic Messages API / claude-haiku-5-5 are low-cost candidates.
Official API model pages were retrieved on 2026-10-11 to confirm API names, Responses support, and Structured Outputs support.
A subagent-model listing was not used as evidence. Availability and billing settings for the real accounts remain unverified.
Generation uses an approved JSON schema and Zod validation; arbitrary JS/MDX/SVG code is not executed.
Being a candidate does not mean the connection exists or has been tested.

The requested approval would cover only one selected public technical question, minimal relevant excerpts from the fixed lesson, and official evidence.
The destination would be the OpenAI or Anthropic API selected by the owner for that request.
Answer history, wrong answers, self-reports, impressions, anonymous IDs, and learning timestamps are not sent.
Because free-form questions may contain private information, a preview of the request body and the owner's selection are required.
Questions containing internal personal/company names, secrets, actual DNS configuration, or logs are not sent unchanged.
Live connection remains on hold until sending/retention conditions and the owner-managed API account have been confirmed.

According to the OpenAI data documentation reviewed, API data is normally not used for training, and standard abuse-monitoring logs are retained for 30 days.
Responses store=false reduces application-state retention; it is not an unconditional no-retention guarantee.
Zero Data Retention eligibility/settings have not been confirmed and are not promised here.
A free API is not considered unconditional permission to send private information either.
Anthropic's Commercial API normally deletes inputs/outputs within 30 days, with exceptions for contracts, abuse, legal requirements, and other conditions.
Structured Outputs has feature-specific ZDR conditions and schema caching of up to 24 hours after last use.
The owner's workspace contract and ZDR applicability remain unverified. Neither provider is treated as guaranteeing unconditional non-retention.

## Hard monthly ceiling of ¥500

The ¥500 covers all product operations, including AI, for the owner alone; hands-on exercise costs are separate.
With BYOK, all of a person's providers are combined, while budgets are isolated between users. Shared infrastructure cost allocation is unresolved.
See the [local implementation and disconnected components](workers-byok.md) for Workers per-user ledgers and encrypted storage.
The current browser-only prototype makes no paid API calls.
Separately from the browser, a localhost server with communication disabled and a budget-reservation ledger have been implemented.
Google login is unnecessary for development. The server is localhost-only, checks Origin, uses CSRF protection, and never returns secrets to the browser.
The owner chooses how to configure keys securely. Keys are not stored in repositories/localStorage/logs/URLs.

Controls required before sending:

1. Accept only reservations where monthly spent + reserved + fixed operating costs + safety margin remain at or below ¥500.
2. Make reservations/updates through a persistent server ledger and exclusive transactions. Allow one concurrent operation.
3. Start with a candidate input ceiling of 8000 tokens, a billable-output ceiling of 2000 tokens, and no tool calls.
4. Set automatic retries to zero, including SDK retries. Each retry needs a new reservation; request IDs prevent duplicate sends.
5. Retain reservations after timeouts, cancellation, or unknown outcomes until actual usage is confirmed; do not release them automatically.
6. Do not send if ceilings on price, exchange rate, tax, payment fees, or operating costs cannot be established.
7. Stop generation when the ceiling is reached, price updates are unconfirmed, or the ledger fails. Reading and local question saving remain available.

At the official standard prices checked on 2026-10-11, gpt-6-luna short-context pricing was $0.10 input / $0.50 output per million tokens.
8000 input + 2000 output tokens cost $0.0018 at standard short-context rates. No additional paid tools are used.
An example reservation using long-context cache-write input ceilings of $0.25 and output of $0.75 is at most $0.0035.
At a hypothetical planning conversion of ¥200/$ with a 20% margin, this is ¥0.84, rounded up to a ¥1 reservation.
¥200/$ is not a statement of the current exchange rate. If the yen-denominated payment ceiling is unknown, this example does not permit live sending.
For example, setting aside ¥200 for fixed operations and another ¥100 safety margin leaves at most ¥200 for AI reservations.
Actual operating costs and applicable taxes/prices have not been confirmed, so neither a monthly generation count nor real operation within ¥500 is guaranteed.
Budget reservations, the ledger, and both providers' HTTP transports are implemented with communication off and were tested only with network mocks.
Anthropic Haiku 5.5 short-context pricing was also $0.10 input / $0.50 output per million tokens, rising to $0.50/$2.50 above 100K.
Reservations use the long-context one-hour cache-write input ceiling of $1.00 and output of $2.50, totaling $0.013 at the same token limits.
At the hypothetical conversion above, that is ¥3.12 (3120 milli-yen in the ledger). No cache-control is sent, and lower actual charges are not credited in advance.
Candidate prices were checked on 2026-10-11. Account-specific applicable prices and initial deposits require separate confirmation.
Official price metadata alone cannot authorize sending; missing cost ceilings, retention conditions, purpose selection, or sending approval stops processing.
All normal startup paths currently remain disconnected. There is no display or promise that the ¥500 monthly guarantee has been achieved.

## Initial deposits and work possible before connection

For new OpenAI API accounts, the initial prepaid purchase had a $5 minimum and $10 default. Auto-recharge was enabled by default when configured.
Purchased credits expire after one year and are generally non-refundable. Existing balances/free credits were not checked.
The owner's Anthropic contract and initial deposit amount also remain unverified.
Initial deposits differ from actual monthly usage, but are not automatically excluded from the ¥500 cash-spending constraint.
If the actual payment exceeds ¥500 in yen, connection stays on hold unless the owner separately approves an initial-deposit allowance.
Prepaid balances and auto-recharge limits are not immediate usage ceilings, and stopping can be delayed, so a separate reservation ledger is necessary.

Before approval for billing/sending, the following were implemented locally with external communication disabled:

- Persistent budget ledger, atomic reservations, monthly periods, one concurrent operation, retained unknown reservations, and duplicate-send prevention.
- Request previews, owner selection, input/output limits, schema validation, and a failure path that leaves lessons unchanged.
- A server checking localhost/Origin/CSRF/request sizes, and an adapter contract for replacing transports.
- Offline stubs and both providers' HTTP mocks testing limits, races, timeouts, no retries, and no secret exposure.

At this stage the adapter displays disconnected status; prepared transports, API keys, payments, and live requests are not enabled.
For that earlier fixed-CAA workflow, the pending decision was: "Which provider/model may receive the public technical question shown in the preview?" The current topic-workflow sending scope remains to be agreed as described above.
Permission for an initial deposit and for live sending are separate approvals after reviewing the yen amount and request body.
After that decision, the owner must check API project/access permissions, configure payment and disable auto-recharge if needed,
and use authentication/encrypted storage that lets users safely register/manage their own keys through the service's settings screen.
The design does not assume an operator-configured shared LLM key or ask users to paste keys into chat.
Existing credentials, Codex logins, and billing accounts are not searched or repurposed.

## Contracts and limitations of the communication-off implementation

server/registry.mjs keeps candidates disabled; model choices for terminology explanations, lesson additions, and evidence checks are unconfigured.
Each registry entry contains provider/model, purpose, input/output limits, structured-output capability, data conditions/approval status,
price, and price-verification date. The current public contract supports only disabled/test-only modes, with no route to enable live sending.
server/adapter.ts is a thin typed boundary. No provider SDK, LiteLLM Proxy, or AI SDK has been introduced.
If a compatible endpoint or SDK replaces it later, the ledger, limits, and source checks remain outside the adapter.
There is no automatic fallback to another provider or parallel sending on failure. Stubs are limited to tests/server.

The ledger is .local-state/generation/budget.json (Git-ignored, created with mode 0600).
Before sending, it creates an exclusive directory, validates the schema, fsyncs a temporary file, atomically renames it, and fsyncs the directory.
Integer reservations use the shared 500000 milli-yen budget across all providers after fixed costs/safety margin; per-provider limits can also be set.
Running/unknown operations block new executions across all providers and are never automatically released at month boundaries.
Request IDs and hashes of payload/model/source prevent duplication. Question bodies, secrets, and provider exceptions are not retained in the ledger.
Successful proposal JSON and source quotations are stored locally. Even invalid output records confirmed costs as spent.
Changes to price/FX/cost conditions within the same month also place processing on hold. Corrupt ledgers and leftover locks are not automatically reset.
Manual cost-reconciliation/lock-recovery tools after abnormal termination are unimplemented. Never delete reservations and resend unconditionally.
Persistence, including fsync, was checked on Mac Studio; physical Windows/Linux machines and power-loss fault injection remain unverified.

HTTP listens only on 127.0.0.1:5274, requires an exact Host match, and allows only Origin `http://127.0.0.1:5173`.
GET /session supplies a temporary CSRF token; POST /proposals checks that token, JSON, body limits, and the input schema.
Additional input fields such as learning history and keys are rejected. CORS allows only the permitted origin; responses use no-store.
There is no external source-fetching/SSRF path; only server-held snapshots of designated official URLs are referenced.
Sources require verification timestamps within 30 days and not in the future, and generated quotations must occur in the snapshot body.
A quotation match does not prove semantic correctness. Source retrieval and integration into the current schema remain unimplemented.
Returned JSON is limited to explanations, two fixed diagrams, and four existing CAA scenarios; JS/MDX/arbitrary diagram code is rejected.
Because the reading UI is disconnected, it shows no generation button or generated stub results and preserves the owner's manual application path.

The HTTP body-byte limit protects resources; it does not guarantee token counts.
After persisting a reservation, the complete prompt/schema is counted using OpenAI input_tokens or Anthropic count_tokens.
Only when the count plus model-specific margin is within the input ceiling is one generation request sent to that provider.
Counting also sends questions, excerpts, and sources externally, so the body preview and owner approval must come first.
Anthropic officially describes counting as free, but its result is an estimate; a strict upper bound on the difference from actual generation remains unverified.
OpenAI counting charges also remain unresolved. Processing stays blocked with tokenCountMargin=null / tokenCountTermsConfirmed=false.
The mock 256-token margin is a test value, not a guarantee of real-API upper bounds.
Checking usage only after sending cannot guarantee a prior cost ceiling; confirming the counting upper bound remains an activation condition.
Generation specifies a 2000 output ceiling, OpenAI reasoning none, and Anthropic thinking disabled / effort low.
usage.output_tokens includes thinking tokens and is not double-counted. Anthropic cached inputs are added from their separate breakdown.
Usage is multiplied by conservative registry unit prices and yen-conversion ceilings, rounded up to integers, and recorded as spent.
This is not an invoice-reconciled amount. Unknown usage/model/pricing tier or exceeded limits retain the reservation.
Refusals, truncated outputs, invalid JSON, and source mismatches still record costs when usage is known, but return no lesson proposal.
Late token-count results after a timeout do not trigger generation. There are no automatic retries, redirects, or fallbacks.
Real keys have not been registered/configured. The path remains disabled until secure per-user credential storage is connected.
The transport factory uses only an explicitly passed secret for the Authorization header and does not read environment variables.
Normal startup does not register the factory; GenerationService also rejects prepared transports.
Server code, key names, and ledgers are excluded from the frontend bundle.

## Earlier fixed-CAA setup and draft approval wording

The earlier proposal selected OpenAI / Anthropic candidates; the current next integration selects OpenAI as described above. Billing-project access and model availability remain unverified.
Models for terminology explanations, lesson additions, and evidence checks remain unselected.
There is no need to send account IDs or key values in chat. Existing OpenAI projects will not be searched either.
If there is no existing balance, confirm the yen amount of the initial deposit and how it fits the ¥500 constraint separately.
Real-key entry is enabled only after the server's per-user authentication/encrypted-storage path is complete.
The settings screen supports simulated operations only and never stores plaintext keys in localStorage/repositories/logs.
Before live sending, establish token-counting upper bounds/charges, yen-denominated cost ceilings, secure secret configuration, and source-snapshot retrieval.
Successful HTTP mocks do not verify real API acceptance or lesson quality. The UI connection from body preview to server,
and recovery that reconciles unknown reservations against billing records, are also unimplemented. The first small live request requires separate approval.

Draft approval wording:

> I authorize sending only the previewed public technical question, minimal related lesson excerpts, and official evidence
> to the provider/model I select for each purpose. Do not send learning history, IDs, or timestamps; I accept the explained API retention conditions.
> The ¥500 monthly limit includes all providers and fixed operating costs; stop sending if cost ceilings are unknown. Do not automatically retry
> or fall back to another provider. I will separately approve key configuration and initial deposits after reviewing the method and yen amount,
> and choose whether to apply lesson changes after reviewing the diff.

This is historical fixed-CAA draft wording, not an approval request for topic textbooks. It does not establish approval for sending/retention conditions, key configuration, or payment at this time; a topic request needs a new preview and agreed sending scope.

## Keep owner-controlled application separate after connection

Generated output is stored as a proposal with identified gaps and evidence; missing/mismatched/stale sources or invalid schemas place it on hold.
Retrieved source text is retained as evidence. A URL written by the model is not treated as verified.
A new lesson version is created only after diff review, cancellation/version-conflict checks, and the owner's choice to apply it.
Old answers, snapshots, and the originating question context are preserved for rewritten versions. Generation failures leave lessons unchanged.

Official references (checked 2026-10-11):

- [Pricing](https://developers.openai.com/api/docs/pricing)
- [API models and supported capabilities](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Data handling](https://developers.openai.com/api/docs/guides/your-data)
- [Initial deposits and prepaid billing](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing)

Official references for both providers' transports, counting, and usage (checked 2026-10-11):

- [OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting)
- [OpenAI reasoning and output limits](https://developers.openai.com/api/docs/guides/reasoning)
- [Anthropic Haiku 5.5 model and pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Anthropic Messages API contract](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic API data-retention conditions](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
