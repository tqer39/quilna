import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  authKeys,
  referenceKeys,
  validateConfiguration,
  syncCloudAuth,
} from "../../scripts/sync-cloud-auth.mjs";

const environment = () => ({
  GITHUB_REPOSITORY: "tqer39/quilna",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  CONFIRM_WORKER: "quilna-private",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  QUILNA_APP_ORIGIN: "https://quilna-private.example.workers.dev",
  QUILNA_OWNER_EMAIL: "owner@example.invalid",
  GOOGLE_CLIENT_ID: "123-example.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-only-google-secret",
  BETTER_AUTH_SECRET: "test-only-signing-key-".repeat(3),
  CLOUDFLARE_API_TOKEN: "test-only-cloudflare-token",
  ...Object.fromEntries(
    referenceKeys.map((key) => [`OP_REF_${key}`, `op://vault/item/${key}`]),
  ),
});
const settings = () => ({
  bindings: [
    { name: "PRIVATE_DEV", type: "plain_text", text: "true" },
    {
      name: "APP_ORIGIN",
      type: "plain_text",
      text: environment().QUILNA_APP_ORIGIN,
    },
    {
      name: "GOOGLE_ALLOWED_EMAIL",
      type: "plain_text",
      text: "owner@example.invalid",
    },
    { name: "AUTH_DB", type: "d1", id: "test-db" },
    { name: "UNRELATED_SECRET", type: "secret_text" },
  ],
});
function service({
  before = settings(),
  after,
  failAt,
  echo = "",
  status = 500,
} = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === failAt) return new Response(echo, { status });
    let result;
    if (calls.length === 1) result = before;
    else if (calls.length === 2) result = {};
    else
      result = after ?? {
        bindings: [
          ...before.bindings.filter((b) => !authKeys.includes(b.name)),
          ...authKeys.map((name) => ({ name, type: "secret_text" })),
        ],
      };
    return Response.json({ success: true, result });
  };
  return { calls, fetcher };
}

test("untrusted triggers, targets, debug runs and unresolved references fail closed", () => {
  validateConfiguration(environment());
  for (const change of [
    { GITHUB_REF: "refs/pull/63/merge" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REPOSITORY: "attacker/quilna" },
    { CONFIRM_WORKER: "other-worker" },
    { RUNNER_DEBUG: "1" },
    { CLOUDFLARE_ACCOUNT_ID: "../../other" },
    { QUILNA_APP_ORIGIN: "https://attacker.invalid" },
    { OP_REF_GOOGLE_CLIENT_SECRET: "plaintext-secret" },
    { OP_REF_BETTER_AUTH_SECRET: "" },
  ])
    assert.throws(() => validateConfiguration({ ...environment(), ...change }));
});

test("invalid or unresolved values cause no network calls", async () => {
  for (const change of [
    { GOOGLE_CLIENT_SECRET: "" },
    { GOOGLE_CLIENT_SECRET: "op://vault/item/secret" },
    { GOOGLE_CLIENT_ID: "invalid" },
    { BETTER_AUTH_SECRET: "short" },
    { CLOUDFLARE_API_TOKEN: "bad\ntoken" },
    {
      GOOGLE_CLIENT_SECRET: "x".repeat(40),
      BETTER_AUTH_SECRET: "x".repeat(40),
    },
  ]) {
    const fake = service();
    await assert.rejects(
      syncCloudAuth({ ...environment(), ...change }, fake.fetcher),
    );
    assert.equal(fake.calls.length, 0);
  }
});

test("only the three auth keys are patched; values stay out of URLs and other bindings survive", async () => {
  const before = settings();
  before.bindings.push({
    name: "GOOGLE_CLIENT_ID",
    type: "plain_text",
    text: "old-client",
  });
  const fake = service({ before });
  await syncCloudAuth(environment(), fake.fetcher);
  assert.equal(fake.calls.length, 3);
  const write = fake.calls[1];
  assert.equal(write.method, "PATCH");
  assert.equal(
    write.url,
    `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/scripts/quilna-private/secrets-bulk`,
  );
  const payload = JSON.parse(write.body);
  assert.deepEqual(Object.keys(payload.secrets), authKeys);
  for (const key of authKeys)
    assert.deepEqual(payload.secrets[key], {
      name: key,
      type: "secret_text",
      text: environment()[key],
    });
  assert.ok(!write.body.includes(environment().CLOUDFLARE_API_TOKEN));
  for (const call of fake.calls) {
    assert.equal(call.redirect, "error");
    for (const key of referenceKeys)
      assert.ok(!call.url.includes(environment()[key]));
  }
});

test("missing worker and wrong owner/private settings never write", async () => {
  const missing = service({ failAt: 1, status: 404 });
  await assert.rejects(syncCloudAuth(environment(), missing.fetcher));
  assert.equal(missing.calls.length, 1);
  for (const name of [
    "PRIVATE_DEV",
    "APP_ORIGIN",
    "GOOGLE_ALLOWED_EMAIL",
    "AUTH_DB",
  ]) {
    const before = settings();
    before.bindings = before.bindings.filter((b) => b.name !== name);
    const fake = service({ before });
    await assert.rejects(syncCloudAuth(environment(), fake.fetcher));
    assert.equal(fake.calls.length, 1);
  }
});

test("remote errors cannot echo credentials and mutations are never automatically retried", async () => {
  for (const failAt of [1, 2, 3]) {
    const fake = service({ failAt, echo: environment().GOOGLE_CLIENT_SECRET });
    await assert.rejects(
      syncCloudAuth(environment(), fake.fetcher),
      (error) => {
        assert.ok(!error.message.includes(environment().GOOGLE_CLIENT_SECRET));
        if (failAt > 1) assert.match(error.message, /Changes may have applied/);
        return true;
      },
    );
    assert.equal(fake.calls.length, failAt);
  }
});

test("post-write binding drift and missing auth bindings are reported as unverified", async () => {
  for (const removed of ["UNRELATED_SECRET", "GOOGLE_CLIENT_ID"]) {
    const after = {
      bindings: [
        ...settings().bindings,
        ...authKeys.map((name) => ({ name, type: "secret_text" })),
      ].filter((b) => b.name !== removed),
    };
    const fake = service({ after });
    await assert.rejects(
      syncCloudAuth(environment(), fake.fetcher),
      /not verified/,
    );
  }
});

function assertNoRunExpressions(workflow) {
  // Track the indentation of the explicit run keys used in this workflow.
  // Indented continuation lines are shell content, even when they contain ':'.
  let runIndent = null;
  for (const line of workflow.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = /^ */.exec(line)[0].length;
    if (runIndent !== null && indent > runIndent) {
      assert.doesNotMatch(line, /\$\{\{/);
      continue;
    }
    runIndent = null;
    const run = /^( *(?:- +)?)run:(.*)$/.exec(line);
    if (run) {
      runIndent = run[1].length;
      assert.doesNotMatch(run[2], /\$\{\{/);
    }
  }
}

test("shell expression guard catches multiline scripts without rejecting adjacent env values", () => {
  const expression = "${{ steps.onepassword.outputs.GOOGLE_CLIENT_SECRET }}";
  for (const script of [
    `  - name: Apply\n    run: |\n      echo ready\n      echo: ${expression}`,
    `  - name: Apply\n    run: >-\n      echo\n      ${expression}`,
    `  - run: |+\n      echo ready\n\n      echo ${expression}`,
    `  - run: echo\n      ${expression}`,
    `  - run: echo ${expression}`,
    `  - run: 'echo\n      ${expression}'`,
  ]) {
    assert.throws(() => assertNoRunExpressions(`steps:\n${script}\n`), script);
  }
  assertNoRunExpressions(
    `steps:\n  - run: |\n      node scripts/sync-cloud-auth.mjs --apply\n    env:\n      GOOGLE_CLIENT_SECRET: ${expression}\n`,
  );
  assertNoRunExpressions(
    `steps:\n  - name: Apply\n    run: node scripts/sync-cloud-auth.mjs --apply\n    env:\n      GOOGLE_CLIENT_SECRET: ${expression}\n`,
  );
});

test("workflow credentials are environment-scoped, manual-only and not expanded into shell code", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/sync-cloud-auth.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /environment: quilna-private/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /pull_request:|push:|schedule:|export-env: true|upload-artifact/,
  );
  assert.equal((workflow.match(/OP_SERVICE_ACCOUNT_TOKEN: /g) ?? []).length, 1);
  assertNoRunExpressions(workflow);
});
