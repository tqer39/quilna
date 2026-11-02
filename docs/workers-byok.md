# Per-user BYOK on Workers (real input and communication off)

[English](workers-byok.md) | [日本語](workers-byok.ja.md)

In addition to the mock screen, encrypted storage, APIs, and per-user budgets have been implemented for Workers.
They are tested with SQLite Durable Objects in local Miniflare/workerd.
Live authentication, encryption keys, storage bindings, and sending conditions remain unconfigured. Real input remains disabled.
No shared operator-owned LLM key is used. User-supplied LLM keys and system encryption secrets are separate.

## Run locally

```bash
npm ci
npm run workers:local
```

This serves dist on 127.0.0.1:8787, and /api/session returns 503 auth-unconfigured.
It is a different origin from the existing 127.0.0.1:5173, so localStorage history does not migrate automatically.
The command uses Miniflare directly and does not read Wrangler account settings, .env, or .dev.vars.
It rejects external fetches and does not enable authentication, key entry, or provider requests. Stop it with Ctrl+C.
The storage directory .local-state/worker-dev is Git-ignored. Normal off-mode startup creates no credentials.

```bash
npm run workers:build
npm run test:workers
```

The Workers bundle is written to .local-state/worker-build; no deploy is performed.
Tests use disposable dummy strings, encryption keys, and test signatures, discarding temporary SQLite storage afterward.
Test signatures do not work with Google. Tests create no real-service keys, OAuth grants, or persistent permissions.

## Production and test authentication boundaries

Authentication has been replaced with Better Auth 1.7.7 plus an authentication-only D1 database. AccountVault DO storage/budgets are preserved.
Missing configuration fails closed; real-key entry and the live sender are disabled. Environment variables/headers cannot select test identities.
The Google callback is an exact match for APP_ORIGIN plus `/api/auth/callback/google`.
See the [current authentication design, database, and external setup steps](better-auth.md).
The custom LoginState DO, AUTH_SESSIONS, and AUTH_STATE_KEYRING have been removed from the current configuration.

## Credential APIs

APP_ORIGIN must match exactly; same-origin GET requests also check Fetch Metadata.
The authenticated subject's hash selects each user's DO, and its stored owner is pinned.
Passing userId/owner to an API cannot change ownership. DOs are called only through internal bindings.
Changes require a per-session CSRF token with a one-hour lifetime, 20 operations/minute, JSON, byte limits, and a strict schema.
Verification/generation counts share the same mutation rate limit. Responses use no-store and return no exception bodies or secrets.

| Method / path | Operation |
| --- | --- |
| GET /api/session | CSRF metadata; currently realKeyInputEnabled=false |
| GET /api/credentials/{provider} | Registration revision, candidate model, and status only |
| POST /api/credentials/{provider} | New registration |
| PUT /api/credentials/{provider} | Replacement with an expected revision |
| PATCH /api/credentials/{provider} | Select candidate model and reset verification status |
| DELETE /api/credentials/{provider} | Delete active ciphertext and retain a tombstone revision |
| POST /api/credentials/{provider}/check | Check the approved public CAA verification text through the shared budget path |
| GET /api/budget | The user's spent/held amounts and 500000 milli-yen ceiling |
| POST /api/proposals | Resolve the user's credential after reservation and validate a lesson proposal |

Only openai/anthropic providers are accepted. Registration/replacement takes requestId(UUID), expectedRevision, model, and key.
Deletion takes only requestId and expectedRevision. Model selection additionally takes model, but no key.
Verification takes requestId, expectedRevision, and approvedPublicText=true. Verification text is fixed public text on the server.
Keys are limited to 10–500 ASCII characters; destinations, arbitrary endpoints, and other user IDs are not accepted.
Registration/replacement/deletion requestIds are idempotent; reuse with different contents is rejected.
Replaying an old registration after deletion cannot resurrect it, and only one concurrent replacement of a revision can commit.
If a successful write's response is lost, recheck status/revision instead of declaring failure and blindly resending with a new ID.

src/credential-client.ts also provides a typed client. It sends no key mutation requests without session permission,
and requires same-origin requests, rejected redirects, no retries, metadata validation, and no key storage.
It is connected to the real session's stored-metadata display. Mutation inputs remain disabled; the separate mock UI operates only in memory.
The production handler has credentialsEnabled=false and no generation registration; test success is never displayed as a successful live connection.

## Encryption and persistence

workers/crypto.mjs uses AES-256-GCM, a random 96-bit nonce, and owner/provider/revision/keyVersion as AAD.
Only the nonce and ciphertext of the key are stored. Keys are handled as non-extractable Web Crypto keys.
The master keyring is supplied separately from storage as BYOK_ENCRYPTION_KEYRING.
It contains an active version and up to four versions of 32-byte base64 keys. Missing/invalid configuration or decryption failure stops processing.
Reading old versions and writing with the new active version are implemented. Production verification of full migration, old-key removal, and recovery remains.
Idempotency fingerprints use purpose-separated HMAC derived with HKDF. Neither keys nor fingerprints are returned to the browser.
Immediate zeroization of every JavaScript copy is not promised. No module-wide per-user key cache is created.

Persistence is confirmed through DO transactions and sync before proceeding to the external-send boundary.
Storage failures roll back transactions; an unknown acknowledgment after commit requires rechecking the revision.
Deletion removes active ciphertext; re-registration never rewinds revisions. In-flight results for an old revision are not displayed.
This differs from provider-side revocation and immediate backup/PITR erasure.
Recovery procedures preserving deletion, retention limits, and backup restore tests remain unimplemented/unverified.

## ¥500 per person per month

Budgets are stored in each user's DO and combine that person's OpenAI/Anthropic charges.
The design does not fit all BYOK users into one ¥500 operating budget.
Processing proceeds only if the person's AI costs, applicable fixed operating costs, and margin can be reserved within ¥500.
Allocation of shared infrastructure costs and ceilings on actual personal charges remain undecided, so this is not a live ¥500 operating guarantee.
Requests are persisted in SQLite budget_records, reusing the shared ledger schema and GenerationService.
Reservation, settlement, unknown outcomes, stopping on same-month policy changes, month transitions, and idempotency are preserved.
Secrets are decrypted only after reservation. No proposal is returned if deletion/replacement changes the lease revision.
Confirmed costs remain recorded; unknown costs retain their reservations. Deleting a key never deletes the budget.
Processing stops at 20000 budget records or 2000 credential-change history entries. Operational retention/reconciliation/aggregation extensions remain necessary.

Connection checks are not assumed free and use the same usage reservations as generation. Currently, only network mocks are used.
Token-counting charges, upper bounds on estimation errors, price/tax/exchange-rate/fixed-cost ceilings,
official-source retrieval, cost reconciliation, and recovery of unknown reservations remain unresolved.
There is no cross-provider automatic retry/fallback. See [generation connection decisions](generation-connection.md).

## Preparing owner-only Dev publication

The service is Quilna (クイルナ), with canonical domain `https://quilna.page`.
The existing Dev deployment is recorded separately; domain registration, DNS connection, and deployment migration have not been performed.
A production custom domain, paid plans, live LLM requests, and GitHub push/PR are outside this scope.
See [publication settings and safe handoff](dev-publication.md) and [owner-only input steps](owner-only-setup.md).

## Verification and limitations

Workers JavaScript is checked with Zod runtime schemas and Node/Miniflare tests.
Frontend/API client/adapter contracts are checked with TypeScript; this does not mean all Workers JavaScript was statically type-checked.
Only test principals, test signatures, dummy keys, and mock generation were used.
Live Google login, real keys, provider requests, deposits, secret configuration, Cloudflare account use, deploys, and publication were not performed.
Physical Windows/Linux machines, power loss, production backups/PITR, and operational billing ceilings remain unverified.

Workers development dependencies are shared repository-local npm dependencies (Wrangler/Miniflare/esbuild), with no global install.
Tests use the same Miniflare 5 alpha version required by this Wrangler version and the official package's compatibility conversion API.
The lockfile is saved. Hardware testing was limited to Mac Studio; native workerd OS/architecture constraints need separate confirmation.
The existing five high-severity markdownlint-related findings remain. A fixed braces release was not available; no audit exclusions or forced downgrades were applied.
The [existing audit record](dependency-audit.md) documents affected paths and scope.

Official references (checked 2026-10-11):

- [SQLite DO transactions/storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Miniflare Durable Objects](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/)
