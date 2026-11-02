# Owner-only Dev publication and configuration

[English](dev-publication.md) | [日本語](dev-publication.ja.md)

The service is now Quilna (クイルナ), with canonical domain [quilna.page](https://quilna.page).
Domain registration, DNS connection, and migration of the deployed environment have not been performed.
[Issue #53](https://github.com/tqer39/quilna/issues/53) tracks that operational work; the [naming decision](branding.md) records the investigation and adoption judgment.
The record below describes the owner-only Dev deployment under the previous name at `https://tsumiki-text.tqer39.workers.dev`.
Google authentication setup is pending, so the login button is disabled. This is not a successful live-login verification.
This is a fixed CAA lesson prototype; lesson generation, cloud history sync, and live LLM requests are unimplemented/disabled.

## Configuration files

The public repository tracks only wrangler.dev.example.jsonc.
Enter the real account ID, D1 ID, and allowed email in the ignored wrangler.dev.jsonc.
Check published resource IDs in Cloudflare Dashboard. Never paste secret values into chat/repositories/logs.
Do not deploy the example unchanged when local configuration is missing; placeholders do not identify real resources.
The root wrangler.jsonc is for localhost/off mode.

```bash
cp wrangler.dev.example.jsonc wrangler.dev.jsonc
# ignoredの設定を対象account/既存D1 ID/本人メールに置き換える
npm run build
npx wrangler deploy --config wrangler.dev.jsonc --dry-run
# 資源変更/公開の承認後だけdry-runを外す
```

PRIVATE_DEV=true and assets.run_worker_first=true are required.
Without an owner session, the root serves only the login entry page, and lesson HTML/JS returns 401.
Unconfigured Google auth/BYOK/session APIs return 503. Real-key entry and the live sender are always disabled.
Authenticated assets receive no-store and CSP headers; logout/revocation returns the user to the login entry page.
Publishing source on GitHub does not remove application authentication. History remains browser-local.

## Created resources and verification

On 2026-10-12, after publication approval and the owner's confirmation of Workers Free, only the following resources were created.
Existing service settings, paid plans, custom domains, and Access were not changed.

- Worker: tsumiki-text. DO binding: ACCOUNTS / AccountVault, with the v1 SQLite migration.
- D1: tsumiki-text-auth-dev, bound to AUTH_DB with migrations 0001/0002 applied.
- On that date, D1 user/session counts were zero, and the Worker Secret list was empty.

At the public URL, the root returned HTTP200, lesson HTML/JS returned 401, and authentication/personal-settings APIs returned 503.
At 320px/390px/1440px, the setup-pending message and disabled login were shown, without horizontal scrolling or JavaScript errors.
Local screenshots are in test-results/dev-public and are not included in public Git.
At PR creation, the 2026-10-17 code-audit fixes had not been redeployed to Dev.
This test alone does not guarantee actual Free-tier CPU/shared allowances/costs or backup recovery.

## Authentication setup handoff

Use the [owner-only authentication input steps](owner-only-setup.md).
The Google Web client's scopes are openid email only. No profile/Drive/Gmail/offline grant is requested.
Only the owner is a test user; the application also checks signatures, nonce, and verified email.

After connecting the domain, update APP_ORIGIN and the Google redirect URI together.

```text
https://quilna.page/api/auth/callback/google
```

GOOGLE_CLIENT_ID is a public variable; GOOGLE_CLIENT_SECRET is the dedicated client's Secret.
BETTER_AUTH_SECRET protects authentication cookies/state; BYOK_ENCRYPTION_KEYRING encrypts stored LLM keys with AES-GCM.
These have separate purposes, and there is no shared operator-owned LLM key. Enter them in the target Worker's Variables and Secrets.
Generating/registering real secrets, Google grants, and live LLM requests are not part of this PR creation.
Live-environment verification remains necessary for successful owner login, owner/other-user authorization, cookie delivery, and cancellation/logout.
