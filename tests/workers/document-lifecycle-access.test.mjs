import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: ["workers/document-lifecycle-access.mjs"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { documentLifecycleAccess, lifecycleRequest } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const owner = "a".repeat(64),
  other = "b".repeat(64);
const id = "12345678-1234-4234-8234-123456789abc";
const url = "https://publisher.example.org/article";
function fixture(beforeRead = async () => {}) {
  let reads = 0;
  const current = {
    id,
    source_url: url,
    revision: 2,
    enabled: 0,
    expires: 1,
    evidence: "Current source permission",
    management_revision: 2,
    management_updated: 1000,
    members: "[]",
    aliases: "[]",
  };
  const old = {
    ...current,
    revision: 1,
    enabled: 1,
    expires: 999999,
    management_revision: 1,
    evidence: "Original source permission",
  };
  const env = {
    APP_ORIGIN: "https://app.example.org",
    DOCUMENT_ADMIN_ENABLED: "true",
    DOCUMENT_ADMIN_OWNER_HASH: owner,
    DOCUMENT_ACCESS_DB: {
      withSession(mode) {
        assert.equal(mode, "first-primary");
        return {
          prepare(sql) {
            return {
              bind(...args) {
                return {
                  async first() {
                    reads++;
                    await beforeRead(reads);
                    assert.equal(args[0], id);
                    if (sql.startsWith("SELECT id FROM document_policies"))
                      return { id };
                    if (sql.includes("FROM document_policy_history"))
                      return {
                        revision: 1,
                        actor: owner,
                        recorded: 1000,
                        kind: "create",
                        snapshot: JSON.stringify(old),
                      };
                    return structuredClone(current);
                  },
                };
              },
            };
          },
        };
      },
    },
  };
  return { env, current, old, reads: () => reads };
}
const shared = { audience: "shared", policyId: id, managementRevision: 1 };

test("ordinary readers cannot inspect lifecycle targets, while private targets are bound to the configured manager", async () => {
  const f = fixture();
  await assert.rejects(
    documentLifecycleAccess(f.env, other, shared),
    /document-unavailable/,
  );
  assert.equal(f.reads(), 0);
  assert.deepEqual(
    await documentLifecycleAccess(f.env, owner, { audience: "private", url }),
    { audience: "private", url, scope: `private:${owner}` },
  );
  await assert.rejects(
    documentLifecycleAccess(f.env, owner, {
      audience: "private",
      url,
      owner: other,
    }),
  );
  await assert.rejects(
    documentLifecycleAccess(f.env, owner, {
      ...shared,
      scope: `private:${other}`,
    }),
  );
  assert.equal(f.reads(), 0);
});

test("historical scopes remain manageable after permission expiry, but cannot be restored as current grants", async () => {
  const f = fixture();
  assert.deepEqual(await documentLifecycleAccess(f.env, owner, shared), {
    audience: "shared",
    url,
    scope: `shared:${id}:1`,
  });
  await assert.rejects(
    documentLifecycleAccess(f.env, owner, shared, {
      restore: true,
      now: () => 2000,
    }),
    /document-unavailable/,
  );
  f.current.enabled = 1;
  f.current.expires = 10000;
  await assert.rejects(
    documentLifecycleAccess(f.env, owner, shared, {
      restore: true,
      now: () => 2000,
    }),
    /document-unavailable/,
  );
  assert.deepEqual(
    await documentLifecycleAccess(
      f.env,
      owner,
      { ...shared, managementRevision: 2 },
      { restore: true, now: () => 2000 },
    ),
    { audience: "shared", url, scope: `shared:${id}:2` },
  );
});

test("corrupt historical snapshots are refused instead of redirecting management to another scope", async () => {
  const f = fixture();
  f.old.id = "22345678-1234-4234-8234-123456789abc";
  await assert.rejects(
    documentLifecycleAccess(f.env, owner, shared),
    /document-invalid/,
  );
});

test("preview cannot carry a mutation and changes cannot inject a raw scope or account", () => {
  assert.equal(
    lifecycleRequest.safeParse({ action: "preview", target: shared }).success,
    true,
  );
  assert.equal(
    lifecycleRequest.safeParse({
      action: "preview",
      target: shared,
      command: {},
    }).success,
    false,
  );
  assert.equal(
    lifecycleRequest.safeParse({ action: "change", target: shared }).success,
    false,
  );
  assert.equal(
    lifecycleRequest.safeParse({
      action: "preview",
      target: shared,
      owner: other,
    }).success,
    false,
  );
});

for (const boundary of ["manager-revoked", "permission-expired"]) {
  test(`management rechecks ${boundary} while the current policy read is pending`, async () => {
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture(async (count) => {
      if (count === 1) {
        enter();
        await pending;
      }
    });
    f.current.enabled = 1;
    f.current.expires = 3000;
    let now = 2000;
    const result = documentLifecycleAccess(
      f.env,
      owner,
      { ...shared, managementRevision: 2 },
      { restore: true, now: () => now },
    );
    const rejection = assert.rejects(result, /document-unavailable/);
    await entered;
    if (boundary === "manager-revoked") f.env.DOCUMENT_ADMIN_OWNER_HASH = other;
    else now = 3000;
    release();
    await rejection;
  });
}
