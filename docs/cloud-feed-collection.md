# Cloud feed collection

[English](cloud-feed-collection.md) | [日本語](cloud-feed-collection.ja.md)

## Required behavior and current scope

On 2026-10-24 the owner required collection while the PC sleeps or is powered off, not only while a browser page is open (Issue #61).
The implementation uses the existing authenticated Cloudflare Worker and one account's `AccountVault` Durable Object.
It is disabled in the default local configuration. A dedicated owner-only Worker was published after approval on 2026-10-24. On 2026-10-27 JST, owner Google login succeeded and a 15-minute collection schedule was started for one public feed.
The local alarm tests and published setup screen do not establish a continuously running collection service. No billing change or real provider key was performed.

In **設定 → PCを閉じている間の収集**, explicitly start/update cloud subscriptions at 15, 30 or 60 minutes.
The operation unions this browser's subscriptions with the existing cloud subscriptions, with at most 50 distinct feeds and 16 KB of URL data.
Adding another local subscription requires **設定を更新**; it does not silently upload the new subscription.
**クラウド収集を停止** preserves pending results. Logging out does not stop an already configured collection job.
Unavailable authentication, an unconfigured runtime, conflicting settings, fetch failures and full storage are reported instead of claiming successful collection.
Each registered source shows its last successful cloud fetch separately from the browser's last imported copy and the next scheduled fetch.
A source with no successful cloud fetch says so explicitly. An unchanged RSS response advances the cloud success time without creating a new snapshot; a later failure retains the previous success time alongside the retry warning.

Cloud requests support public HTTPS publisher domains, rather than a fixed list of three hosts. The authenticated `/api/feeds/fetch` route uses the same policy for RSS discovery and article HTML, bounded to 20 requests per account per minute. Article revalidation accepts only the bounded, URL-scoped validators described in [source reuse](browser-rss.md#source-reuse-and-saved-body-versions); a matching `304` carries no HTML. Scheduled RSS delivery remains unchanged.
URL credentials, nonstandard ports, literal/alternative IP forms, local/reserved names and the application's own hostname are rejected. Redirects are validated again and URL fragments are removed.
Workers uses global `fetch` with the required [`global_fetch_strictly_public` compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).
Cloudflare documents public-Internet routing even for the Worker's own zone, instead of the default path that can bypass origin security controls. This implementation relies on that platform boundary; it does not pin DNS itself or use VPC/private-origin bindings.
The separate local Node endpoint continues to validate DNS responses and pin a public address to the TLS connection. The offline Workers preview forbids outbound traffic.
Sites that require login or script rendering, deny server requests, or do not serve a supported response may still fail with an explicit error; supporting arbitrary publisher domains is not a guarantee of successful extraction from every site.
It does not forward browser cookies or authorization. Responses are limited to 2 MB with a 12-second deadline and three redirects; XML entities/DOCTYPE are rejected, while discovery HTML remains inert in the browser.

## Persistence and delivery

The Durable Object stores the subscription schedule, last success, failure count, retry deadline and pending RSS response snapshots.
An [alarm](https://developers.cloudflare.com/durable-objects/api/alarms/) wakes the object without browser traffic.
Cloudflare documents at-least-once alarm execution, so the collector persists a 60-second acquisition lease before network I/O and only commits a response against the same configuration revision and lease.
Each alarm acquires at most two due feeds; a recovery alarm is written in the same transaction before fetching.
Failures retry after 5, 10, 20, 40 and then 60 minutes. Pausing or changing configuration invalidates in-flight responses.
Unchanged response hashes do not create another pending snapshot; successful acquisition still advances the schedule.
This is periodic collection, not a guarantee that every post is seen before a publisher removes it from its feed.

Pending snapshots use bounded chunks and metadata in durable storage transactions, separate from credential/budget keys.
Limits are 100 responses, 20 MB of UTF-8 response content and 110 KB of metadata per account; capacity can be reached by any limit.
Reaching capacity stops scheduling without deleting old results. A successful browser acknowledgement frees space and resumes scheduling.
Stored responses are untrusted source data; full RSS parsing and text extraction happen in the browser.
The next visible, online browser downloads at most five pending responses per pass, commits each to IndexedDB, then acknowledges their IDs.
Pending work is checked after 15 seconds; otherwise status is checked after 60 seconds while the page is visible.
Connection failures, timeouts and transient HTTP errors (408, 429, 5xx) retry status/import checks after 30, 60, 120, 240 and then 300 seconds, including a failed first connection or acknowledgement. A successful pass resets this backoff. Authentication/configuration, account-validation, malformed-state and local storage failures require explicit recovery instead of automatic retries. Configuration and discard requests are never replayed automatically.
Storage failures, navigation or lost responses retain unacknowledged server copies for retry. Acknowledgements are idempotent.
Malformed XML or damaged stored snapshots remain pending with their feed URL, acquisition time and reason in Settings.
They do not block healthy snapshots: each pass attempts up to five results that have not already failed in this page, and successful local saves are acknowledged separately.
While only failed results remain, the browser checks status every 60 seconds without repeatedly downloading them. Reloading or **取り込めない取得結果を再試行** retries them.
An item removed by another browser between status and download is skipped without stopping other imports.
Each failed result has **この取得結果を削除**. It requires a confirmation explaining the permanent loss of that unimported cloud copy; cancelling preserves it.
This explicit discard uses a separate authenticated, CSRF-protected endpoint accepting one ID, with the same owner isolation and transactional deletion as acknowledgements.
A failed discard shows an error and remains retryable; a successful discard can release a capacity pause. Saved browser articles and subscriptions are unaffected.
Network, account-validation and IndexedDB failures still stop the current pass and preserve unacknowledged results.
The interval selector reflects the saved cloud interval on reopen; background status checks preserve an interval the user is currently editing.

Merging keeps read/saved flags, stable saved copies, imported originals, translations and manual tags.
Older cloud snapshots cannot replace more recently fetched local feed/article content.
The cloud is a delivery queue, not a complete backup or multi-device article/history sync: a result is removed after one browser acknowledges it.
Browser-local articles and marks remain local after logout; a shared browser profile is not an account-isolated local library.
The cloud queue contains RSS-provided content. Fetching the linked article's full text, translation and speech still happen when using the browser.

## Publication checkpoint — 2026-10-24

The owner explicitly approved creation and publication of the dedicated environment, without a paid-plan change.
The Dashboard showed Workers Free and 1,358/100,000 daily shared requests before publication.
Created `quilna-private-auth` in APAC, applied `0001_better_auth.sql` and `0002_app_guard.sql`, and verified that no migrations remained.
Published [quilna-private](https://quilna-private.tqer39.workers.dev/) from public source `540a99db516bebd7e1c80c5795e760309cf5cbe2` (same tree as local `c888c6e28c9945652a67c480ff28fde1a081b364`).
Worker version `e0258954-546c-4312-a102-b04bc010eefc` received 100% of traffic.

Live checks found HTTP 200 with only the setup-pending page at `/` and `/?view=feeds`, HTTP 401 for the app JavaScript, and HTTP 503 `auth-unconfigured` for auth/session/collection/feed-fetch APIs. All checked responses used `Cache-Control: no-store`.
The deployed version confirmed `PRIVATE_DEV=true`, `global_fetch_strictly_public`, D1/DO bindings and asset routing through the Worker; the Dashboard confirmed preview URLs disabled.
No authentication secrets or Google client ID were configured. The selected owner's email is configured privately, without including it in this record.
Real owner login, rejection of another real account, authenticated edge acquisition and PC-off collection remain unverified. The owner must enter authentication secrets directly; do not send them through chat.

## Authentication and collection check — 2026-10-27 JST

PR #66 was merged after owner approval, and the main-branch [initial authentication sync](https://github.com/tqer39/quilna/actions/runs/40355960337) succeeded.
The exact Google callback URI was saved after approval. A real owner login reached the reader, which fetched 20 articles from Zenn and accepted a 15-minute cloud collection schedule.
With the reader page unloaded until 01:35 JST, reopening it showed the next cloud fetch at 01:50 with no fetch error. The browser's imported-copy timestamp remained 01:20, consistent with unchanged responses not creating another snapshot.
At that checkpoint the deployed UI did not expose the cloud's last successful fetch timestamp directly.
The timestamp display was subsequently published from `1e37648b279bb08909cb3c162691cd27f124be96` as Worker version `40912471-d0cc-4140-b8df-2af36854036b`, with 100% traffic. Both source-commit CI workflows succeeded.
Post-deployment metadata confirmed unchanged bindings (including the three authentication secrets), runtime flags and asset routing; the Dashboard still showed Workers Free. The authenticated reader displayed the last cloud success separately from the browser's imported-copy timestamp.
With the reader unloaded, cloud success advanced from 01:50:16.857 to 02:05:17.052 JST, before the page was reopened at 02:05:29.891. The browser's imported-copy timestamp stayed at 01:50 and the next cloud fetch became 02:20. This directly confirms a successful cloud fetch without the reader page running, including the unchanged-response case.
Physical PC shutdown, long-running collection and rejection of another real Google account have not been verified.
Authentication setup is now managed through the [1Password sync workflow](onepassword-cloud-auth.md), rather than manual secret entry in the dashboard. The dated 2026-10-24 record above describes the earlier state.

## Activation and validation

On 2026-10-24 the owner selected a **new owner-only Cloudflare environment**.
Use `wrangler.cloud.example.jsonc` for the proposed `quilna-private` Worker and a new `quilna-private-auth` D1 database.
This is a separate deployment; the older `tsumiki-text` resources and domain setup are not deployment targets for this change.
Copy the example to ignored `wrangler.cloud.jsonc`, replacing the account ID, workers.dev subdomain, newly created D1 ID and the one approved Google email.
The example's identifiers are placeholders, not provisioned resources. Never deploy the example unchanged.
Keep `PRIVATE_DEV="true"`, `assets.run_worker_first=true` and `preview_urls=false` so static files also pass through owner authentication.
Keep `compatibility_flags=["global_fetch_strictly_public"]`; never enable `global_fetch_private_origin`. `security:check` and `workers:build` reject missing/conflicting routing flags in the tracked configs and any existing ignored owner configs, including environment overrides.
These checks also reject owner-only configs that bypass the Worker for static assets or enable preview URLs. Verify the deployed flag/asset settings after publication; local validation does not inspect a later Dashboard edit.
Set the Google Web client's exact redirect URI to `APP_ORIGIN + /api/auth/callback/google`.
Use the [1Password sync workflow](onepassword-cloud-auth.md) to set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BETTER_AUTH_SECRET` as secrets on the approved Worker. Preserve these bindings on subsequent deployments.
RSS collection does not require a BYOK encryption keyring or an LLM provider key. Real-key entry and live AI sending remain disabled.
See [owner-only authentication](owner-only-setup.md) for verified-email enforcement and the auth migrations.

```bash
cp wrangler.cloud.example.jsonc wrangler.cloud.jsonc
# Replace placeholders in the ignored file; never commit owner-specific settings.
npm run security:check
npm run build
npx wrangler deploy --config wrangler.cloud.jsonc --dry-run
```

A dry run checks bundling/configuration without uploading the Worker; it does not verify remote resources or Google login.
Before actual provisioning/publication, confirm the selected account's current Workers plan and shared usage, then obtain approval for this target.
The initial operating proposal is Workers Free with two feeds at a 30-minute interval (96 scheduled feed fetches/day before retries/manual refreshes).
The application caps pending data at 100 snapshots/20 MB and pauses when full; these are storage bounds, not a monetary spending cap.
[Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) and [SQLite Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/) have account-wide quotas; exceeding free limits fails operations.
Free eligibility does not establish that this account is currently on Free or that real authentication fits its CPU limit.
Do not switch to a paid plan automatically. Actual costs, CPU and shared usage remain deployment checks.

After approval, create the dedicated D1, apply `0001_better_auth.sql` then `0002_app_guard.sql`, set secrets, and deploy only this config.
Verify anonymous asset/API rejection, real owner login, rejection of another account, logout and storage persistence before enabling a collection schedule.
Then close all Quilna browser tabs and check a later persisted collection timestamp and imported articles after reopening; keep this live evidence separate from local alarm tests.
Stop via **クラウド収集を停止** to preserve queued results. Setting `RSS_COLLECTION_ENABLED="false"` disables the service on redeployment without deleting storage.

The existing Better Auth session verifies the account; callers cannot select a different owner.
Collection changes/acknowledgements require the account session's CSRF token. Snapshot reads are scoped to the verified owner.
Browser requests include the account identity observed in status so a login change cannot apply an in-flight operation to a different account.
`RSS_COLLECTION_ENABLED="true"` enables the collector in a configured Worker. It is absent/false in the default offline environment.
The existing `AccountVault` binding and migration are reused; no new D1 table, cron trigger or credential/provider connection is required.
Activation still requires a reviewed deployment target, authentication configuration, operating limits/cost review and deployment authorization.
Do not describe a local Miniflare result as PC-off production verification.

Run `npm run workers:build`, `npm run test:workers`, `npm run test:browser` and the browser checks documented in [browser validation](browser-validation.md).
The local runtime test uses real Durable Object storage/alarms and a synthetic outbound RSS response. It waits without browser requests, then checks collection, restart persistence, ownership and CSRF.
Core tests cover failed writes, duplicate alarm delivery, in-flight pause, durable backoff, capacity and acknowledgement recovery, redirects and response limits.
Browser tests cover importing after reopen, lost acknowledgement, newer local content, failed local saves, start/stop, stale revisions and an unavailable service.
Recovery regressions cover a malformed result before healthy articles, five failed results before another batch, concurrent removal, explicit retry, cancelled/failed/successful discard, and interval selection across reload/status checks.
Public-domain tests use synthetic responses from an unlisted publisher and another-domain redirect, including discovery HTML. They verify URL/redirect refusal, credential non-forwarding, the collection API/alarm and configuration gates; Miniflare fixtures do not prove Cloudflare edge routing or live publisher acceptance.
Broader live edge routing checks, long-running operation, complete backup/multi-device sync and owner usability acceptance remain outstanding.
