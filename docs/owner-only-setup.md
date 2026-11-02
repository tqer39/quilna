# Authentication setup for owner-only Dev

[English](owner-only-setup.md) | [日本語](owner-only-setup.ja.md)

Initial login is allowed only when the email in a signature-verified Google ID token matches the owner's configured address
and email_verified=true. Public documentation does not include the real email; examples use `owner@example.invalid`.
Exactly one GOOGLE_ALLOWED_EMAIL is required. Missing/invalid settings stop authentication without falling back to allowing everyone.
Existing sessions are also checked against the configured verified email on every request. Client-supplied userId/email/verified flags are not trusted.
Ownership continues to use Better Auth's verified user.id, not the email as a vault identifier.

The service is Quilna (クイルナ), with canonical URL `https://quilna.page`.
Domain registration, DNS connection, and migration of the deployed environment have not been performed.
The examples below describe the configuration after migration, not currently applied settings.
See the [publication record](dev-publication.md) for the existing Dev deployment.
Dev has been published at the previous address. Because Google is unconfigured, only a setup-pending screen is served. Individual credentials and additional permissions require separate confirmation.
Replace the example with the actual allowed email before use.
Domain purchase and configuration are not performed as part of this rename. Existing Kazokubi domains/authentication/databases are not changed.

Verification: mock OAuth through the production entry point confirmed owner access, rejection of other accounts/unverified emails,
ignored client-supplied IDs, fail-closed behavior for missing settings, and rechecks of existing sessions. All 28 Workers tests passed.

## Items for owner approval

Approval for Dev publication and the owner's Free-tier confirmation were received; dedicated resources were created and published.
The remaining handoff covers secure secret entry.

- Canonical domain (connection pending): `https://quilna.page`.
- Initial viewing/login audience: only the owner, `owner@example.invalid`.
- Prepare owner-only application authentication and necessary OAuth/D1/DO resources. Do not add Access.
- Check rejection of other accounts before publication. Real-key entry and live AI requests remain disabled.

No shared settings across all Workers were changed. Google client/secret configuration has not been performed.

## Specific inputs after approving the destination

| Setting | Value/purpose | Destination |
| --- | --- | --- |
| APP_ORIGIN | Approved HTTPS origin without a trailing slash | Worker Variables |
| GOOGLE_ALLOWED_EMAIL | `owner@example.invalid` (owner-only authorization) | Worker Variables |
| GOOGLE_CLIENT_ID | Google Web OAuth client ID | Worker Variables |
| GOOGLE_CLIENT_SECRET | That Web client's secret | Worker Secret |
| BETTER_AUTH_SECRET | Strong random value of at least 32 characters; protects authentication cookies/state | Worker Secret |
| BYOK_ENCRYPTION_KEYRING | AES-256 keyring for LLM key storage | Worker Secret |

Configuration example to apply after connecting the domain:

```json
{
  "APP_ORIGIN": "https://quilna.page",
  "GOOGLE_ALLOWED_EMAIL": "owner@example.invalid"
}
```

The Google Web OAuth client's Authorized redirect URI must match exactly:

```text
https://quilna.page/api/auth/callback/google
```

The implementation requests only openid email, not profile/Drive/Gmail scopes or offline grants.
If the consent screen is prepared in Testing mode, register only the owner as a test user.
The application checks verified email too, rather than relying solely on Google's test-users setting.
Use the ID/secret pair from the same Web client. Do not mix a different host/path into the callback.

The owner enters secrets directly and securely in Cloudflare Dashboard, under the target Worker's Variables and Secrets.
Do not paste them into chat/repositories/URLs/logs. These instructions do not mean real secrets were generated, retrieved, or configured in this work.
The Better Auth secret and BYOK encryption key serve separate purposes; there is no setting for a shared operator-owned LLM key.
The BYOK keyring is JSON containing the active version and a 32-byte base64 key for each version. The owner also manages backups/rotation.
Never embed real keys in examples. The owner's LLM keys belong in the application's owner settings after safety verification.

## Database and pre-publication checks

1. Prepare authentication-only D1 and bind it to AUTH_DB. Put the real database_id in the target Worker's configuration.
   Apply migrations/auth/0001_better_auth.sql and 0002_app_guard.sql in that order.
2. Bind ACCOUNTS to the SQLite Durable Object AccountVault, applying the v1 migration in wrangler.jsonc.
   Authentication uses D1; BYOK/per-person budgets use DO. The old LoginState DO/AUTH_SESSIONS are unnecessary.
3. Confirm Workers Free/D1/SQLite DO eligibility, current free allowances, and stop/billing settings when limits are exceeded.
   Also check account-wide allowances, including usage by other services. Do not switch automatically to a paid plan.
   Include database/infrastructure costs in the owner's ¥500 monthly budget. Local tests alone do not guarantee compliance with free allowances or live CPU limits.
4. Verify owner-only Dev application authentication and fail-closed behavior before publication. Check real Google callbacks, cookies, cancellation/logout,
   rejection of other accounts, D1/DO storage/recovery, actual CPU/cold starts, and costs.
5. Review any change enabling real-key entry only after those checks. Live AI requests require further separate approval.

Dedicated D1/SQLite DO/Worker resources were created and published, and anonymous asset/API rejection and the setup-pending screen were checked at the live URL.
Real grants, secret configuration, push/PR, domain purchases, and live Google/AI requests were not performed.
See the [publication record](dev-publication.md) for publication results and database/version details.

- [Authentication implementation and verification scope](better-auth.md)
- [Cloudflare D1 pricing/free allowances](https://developers.cloudflare.com/d1/platform/pricing/)
- [Durable Objects pricing/free allowances](https://developers.cloudflare.com/durable-objects/platform/pricing/)
