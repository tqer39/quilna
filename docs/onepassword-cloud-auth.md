# Cloud authentication through 1Password

[English](onepassword-cloud-auth.md) | [日本語](onepassword-cloud-auth.ja.md)

## Scope

`sync-cloud-auth.yml` manually reads the approved credentials from 1Password and updates the existing `quilna-private` Worker's three authentication secrets.
It does not deploy application source, create a Worker, migrate D1, change plans, or start collection.
The workflow must first be reviewed and merged to `main`; merging and a live run remain separate actions.
Local mocked tests do not establish successful 1Password access, a live secret update, or Google login.

1Password is the source of truth; Cloudflare still stores encrypted runtime copies because the Worker needs them for login.
Changes in 1Password take effect after a successful manual sync, not immediately or on a schedule.
`BETTER_AUTH_SECRET` is a stable random signing key, not a new value for each run. Changing it invalidates existing sessions.

## One-time owner setup

1. Create a dedicated vault, for example `quilna-secrets`, and one or more items, for example `Quilna Auth` and `Quilna Cloudflare CI`.
   Use a separate vault rather than the built-in Personal/Private vault: service accounts cannot access those built-in vaults.
2. Store these fields in the items. The examples below are field labels, not secret values.

   | Field | Value |
   | --- | --- |
   | `GOOGLE_CLIENT_ID` | Quilna Web OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | The same client's secret |
   | `BETTER_AUTH_SECRET` | A separately generated, securely random string of at least 32 characters; 64 recommended |
   | `CLOUDFLARE_API_TOKEN` | A dedicated token permitting Worker settings reads and secret updates on the approved account/resource |

   Use the narrowest Cloudflare resource/permission scope available for these API operations. Do not use a global API key, unrelated app token, or grant billing/DNS/D1 write access.
   Configure concealed fields for secrets. Do not send values to chat or save them in Git, workflow YAML, artifacts, or plaintext files.
3. Create a new service account named `Quilna GitHub Actions` with **read items only** for that vault, without write/share/create-vault permissions or access to other vaults.
   Save its one-time token securely, outside the vault that this account can read. The owner completes credential creation and submission.
   If service accounts are unavailable in the current account, stop and check account capabilities; do not upgrade billing automatically.
4. In GitHub repository settings, create the Environment `quilna-private`.
   Restrict deployment branches to `main`, configure required owner review, and disable administrator bypass where available.
   For a sole owner who also starts the run, leave **Prevent self-review** off so that owner can approve the waiting job.
   Save only the bootstrap token as the Environment secret `OP_SERVICE_ACCOUNT_TOKEN`; do not make it a repository-wide secret.
5. Add the following Environment variables (non-secret configuration):

   | Variable | Value |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | The approved 32-character account ID |
   | `QUILNA_APP_ORIGIN` | The approved `https://quilna-private.<subdomain>.workers.dev` origin, without trailing slash |
   | `QUILNA_OWNER_EMAIL` | The already-approved owner's Google email |
   | `OP_REF_GOOGLE_CLIENT_ID` | `op://<vault-id>/<item-id>/<field-id>` for the client ID |
   | `OP_REF_GOOGLE_CLIENT_SECRET` | The reference for the Google secret |
   | `OP_REF_BETTER_AUTH_SECRET` | The reference for the stable session signing key |
   | `OP_REF_CLOUDFLARE_API_TOKEN` | The reference for the Cloudflare token |

   Prefer IDs in references to avoid rename/space ambiguity; copy references with 1Password's developer tools.
   The ASCII field labels above also work. Non-ASCII labels such as Japanese field names require field IDs.
   Only the references go in GitHub variables; credential values stay in 1Password.
6. Keep the Google application in Testing and add the owner's approved address as its test user.
   The Web client callback remains `APP_ORIGIN + /api/auth/callback/google`.

## Run and verify

After the reviewed workflow is on `main`, choose **Actions → Sync cloud authentication from 1Password → Run workflow**, select `main`, and enter `quilna-private` as confirmation.
Review the exact workflow commit and approve its protected Environment job.
The job loads the four references using a commit-pinned official action and pinned 1Password CLI, with the service account token limited to that step and environment export disabled.
Only the next sync step receives resolved values through environment variables; they are never interpolated into shell commands.
No dependency installation, build, test, artifact upload, or application code deployment runs after secrets are loaded.

The sync script checks the target's existing owner, origin, private mode and D1 binding before writing.
It uses Cloudflare's bulk secrets API to patch only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BETTER_AUTH_SECRET`, all as encrypted secrets, then checks their binding types and preservation of other bindings.
The client ID is not inherently secret, but using a secret binding allows these three values to be applied together.
For this workflow, omit `GOOGLE_CLIENT_ID` from Wrangler `vars` (including ignored owner configs) to avoid replacing its secret binding during later source deployments.
Other configuration, source, asset routing, preview settings and migrations are not written by this script.

Missing credentials, wrong branch, unexpected target settings or API errors stop the job.
Actions debug logging must be off. API response bodies and credential values are never printed or saved by the sync script; action masking is an additional defense, not permission to print secrets.
A timeout or failed post-write check can mean the update already applied. Inspect the target before retrying; the workflow does not retry writes or roll credentials back automatically.
Avoid concurrent manual/source deployments; GitHub concurrency only serializes this workflow's own runs.

After success, separately verify the setup page changes, owner login, rejection of other accounts, private static assets, and authenticated collection.
A successful sync does not prove the Google credential pair is valid or that collection works while the PC is off.

## References

- [1Password GitHub Actions](https://www.1password.dev/ci-cd/github-actions)
- [Service account setup and restrictions](https://www.1password.dev/service-accounts/get-started)
- [Cloudflare bulk secret updates](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/)
- [Secret reference syntax](https://www.1password.dev/cli/secret-reference-syntax)
- [Cloud reader implementation and validation (PR #63)](https://github.com/tqer39/quilna/pull/63)
