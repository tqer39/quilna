import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../../workers/crypto.mjs";
import { createHandler } from "../../workers/http.mjs";

const origin = "http://documents.test",
  url = "https://publisher.example.org/article";
const alice = await hash("document-test:alice"),
  bob = await hash("document-test:bob");
const aliasURL = url + "?ref=rss";
const script = (
  await build({
    entryPoints: ["tests/workers/document-transport-entry.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  })
).outputFiles[0].text;
/**
 * Start an isolated persistent policy Worker with synthetic users and source data.
 * Apply all document migrations, optionally seeding legacy data before management
 * migration. Return authenticated commands, DB access, fetch counts and restart;
 * the test after hook disposes the Worker and removes its temporary storage.
 */
async function fixture(t, { enabled = true, beforeMigration, outbound } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "quilna-policy-"));
  let fetches = 0;
  const options = convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-10-11",
    compatibilityFlags: ["global_fetch_strictly_public"],
    resourcePersistencePath: dir,
    durableObjects: {
      ACCOUNTS: { className: "AccountVault", useSQLite: true },
      DOCUMENTS: { className: "SourceDocument", useSQLite: true },
    },
    d1Databases: { DOCUMENT_ACCESS_DB: "policies" },
    bindings: {
      APP_ORIGIN: origin,
      DOCUMENTS_ENABLED: "true",
      DOCUMENT_ADMIN_ENABLED: String(enabled),
      DOCUMENT_ADMIN_OWNER_HASH: alice,
    },
    outboundService: async (r) => {
      assert.equal(r.url, url);
      fetches++;
      if (outbound) await outbound();
      return new Response(
        "<article><h1>Shared original</h1><p>" +
          "A synthetic document with explicit fixture permissions. ".repeat(
            20,
          ) +
          "</p></article>",
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const db = () => mf.getD1Database("DOCUMENT_ACCESS_DB");
  for (const name of [
    "0001_access.sql",
    "0002_source_aliases.sql",
    "0003_policy_management.sql",
    "0004_policy_history.sql",
  ]) {
    if (name === "0003_policy_management.sql" && beforeMigration)
      await beforeMigration(await db());
    await (
      await db()
    ).exec(
      (await readFile("migrations/documents/" + name, "utf8"))
        .replace(/^--.*$/gm, "")
        .replaceAll("\n", " "),
    );
  }
  const tokens = new Map();
  async function call(
    action,
    body,
    {
      user = "alice",
      csrf = tokens.get(user),
      account = user === "alice" ? alice : bob,
      headers = {},
    } = {},
  ) {
    const response = await mf.dispatchFetch(
      origin +
        (action === "session" ? "/api/session" : "/api/documents/" + action),
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "X-Test-Principal": user,
          ...(account ? { "X-Document-Account": account } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: response.status, value: await response.json() };
  }
  for (const user of ["alice", "bob"])
    tokens.set(
      user,
      (await call("session", undefined, { user })).value.csrfToken,
    );
  return {
    call,
    db,
    fetches: () => fetches,
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(options);
    },
  };
}
function input() {
  const expires = Date.now() + 3600000;
  return {
    url,
    enabled: true,
    expires,
    evidence: "Synthetic publisher permits fixture-only reuse",
    members: [alice],
    aliases: [
      {
        url: aliasURL,
        enabled: true,
        expires,
        evidence: "Explicit fixture alias approval",
        policyRevision: 1,
      },
    ],
  };
}
const update = (p, patch = {}) => ({
  id: p.id,
  expectedRevision: p.managementRevision,
  enabled: p.enabled,
  expires: p.expires,
  evidence: p.evidence,
  members: p.members,
  aliases: p.aliases,
  ...patch,
});
async function create(f, data = input()) {
  const r = await f.call("admin-create", data);
  assert.equal(r.status, 200, JSON.stringify(r.value));
  return r.value.policy;
}

test("adding a member reuses the same immutable body; revocation is effective and survives restart", async (t) => {
  const f = await fixture(t);
  let p = await create(f);
  assert.equal(p.managementRevision, 1);
  assert.equal(p.policyRevision, 1);
  const first = await f.call("acquire", { url, audience: "shared" });
  assert.equal(first.status, 200);
  assert.equal(
    (await f.call("acquire", { url, audience: "shared" }, { user: "bob" }))
      .status,
    404,
  );
  const changed = await f.call(
    "admin-update",
    update(p, { members: [alice, bob] }),
  );
  assert.equal(changed.status, 200);
  p = changed.value.policy;
  assert.equal(p.managementRevision, 2);
  assert.equal(p.policyRevision, 1);
  const second = await f.call(
    "acquire",
    { url: aliasURL, audience: "shared" },
    { user: "bob" },
  );
  assert.equal(second.status, 200);
  assert.equal(second.value.reused, true);
  assert.deepEqual(second.value.version, first.value.version);
  assert.equal(f.fetches(), 1);
  const revoked = await f.call("admin-update", update(p, { members: [alice] }));
  assert.equal(revoked.status, 200);
  p = revoked.value.policy;
  await f.restart();
  assert.equal(
    (
      await f.call(
        "read",
        { url, audience: "shared", versionId: first.value.version.id },
        { user: "bob" },
      )
    ).status,
    404,
  );
  const retained = await f.call("read", {
    url,
    audience: "shared",
    versionId: first.value.version.id,
  });
  assert.equal(retained.status, 200);
  const { account, ...version } = retained.value;
  assert.equal(account, alice);
  assert.deepEqual(version, first.value.version);
  assert.deepEqual((await f.call("admin-read", { id: p.id })).value.policy, p);
});

test("concurrent policy edits use one atomic compare-and-swap; conflicts and storage errors retain the prior state", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  const attempts = await Promise.all([
    f.call("admin-update", update(p, { members: [alice, bob], aliases: [] })),
    f.call("admin-update", update(p, { enabled: false, members: [] })),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const winner = attempts.find((r) => r.status === 200).value.policy;
  assert.deepEqual(
    (await f.call("admin-read", { id: p.id })).value.policy,
    winner,
  );
  assert.equal((await f.call("admin-update", update(p))).status, 409);
  const db = await f.db();
  await db.exec(
    `CREATE TRIGGER fail_members BEFORE INSERT ON document_members BEGIN SELECT RAISE(ABORT, 'synthetic-storage-failure'); END;`,
  );
  assert.equal(
    (
      await f.call(
        "admin-update",
        update(winner, { enabled: true, members: [alice, bob], aliases: [] }),
      )
    ).status,
    502,
  );
  assert.deepEqual(
    (await f.call("admin-read", { id: p.id })).value.policy,
    winner,
  );
});

test("source/alias collisions roll back every field, and permission changes require explicit alias approval", async (t) => {
  const f = await fixture(t);
  let p = await create(f);
  const other = await create(f, {
    ...input(),
    url: "https://publisher.example.org/other",
    aliases: [],
  });
  const collision = await f.call(
    "admin-update",
    update(p, { members: [], aliases: [{ ...p.aliases[0], url: other.url }] }),
  );
  assert.equal(collision.status, 409);
  assert.deepEqual((await f.call("admin-read", { id: p.id })).value.policy, p);
  assert.equal(
    (await f.call("admin-create", { ...input(), url: aliasURL, aliases: [] }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.call("admin-create", {
        ...input(),
        url: "https://publisher.example.org/third",
      })
    ).status,
    409,
  );
  assert.equal((await f.call("admin-list", {})).value.policies.length, 2);
  assert.equal(
    (
      await f.call(
        "admin-update",
        update(p, { evidence: "Changed synthetic delivery terms" }),
      )
    ).status,
    409,
  );
  assert.deepEqual((await f.call("admin-read", { id: p.id })).value.policy, p);
  const changed = await f.call(
    "admin-update",
    update(p, {
      evidence: "Changed synthetic delivery terms",
      aliases: p.aliases.map((a) => ({ ...a, enabled: false })),
    }),
  );
  assert.equal(changed.status, 200);
  p = changed.value.policy;
  assert.equal(p.policyRevision, 2);
  assert.equal(p.aliases[0].policyRevision, 1);
  assert.equal(
    (await f.call("acquire", { url: aliasURL, audience: "shared" })).status,
    404,
  );
  const reapproved = await f.call(
    "admin-update",
    update(p, {
      aliases: p.aliases.map((a) => ({
        ...a,
        enabled: true,
        policyRevision: 2,
      })),
    }),
  );
  assert.equal(reapproved.status, 200);
  assert.equal(reapproved.value.policy.policyRevision, 2);
});

test("migration preserves old policies and does not silently reactivate an alias with stale approval", async (t) => {
  const id = "77777777-7777-4777-8777-777777777777",
    expires = Date.now() + 3600000;
  const f = await fixture(t, {
    beforeMigration: async (db) => {
      await db
        .prepare("INSERT INTO document_policies VALUES(?,?,2,1,?,?)")
        .bind(id, url, expires, "  Legacy synthetic permission  ")
        .run();
      await db
        .prepare("INSERT INTO document_members VALUES(?,?)")
        .bind(id, alice)
        .run();
      await db
        .prepare("INSERT INTO document_aliases VALUES(?,?,1,1,?,?)")
        .bind(aliasURL, id, expires, "Legacy alias permission")
        .run();
    },
  });
  const before = (await f.call("admin-read", { id })).value.policy;
  assert.equal(before.managementRevision, 1);
  assert.equal(before.policyRevision, 2);
  assert.equal(before.evidence, "  Legacy synthetic permission  ");
  assert.equal(before.aliases[0].policyRevision, 1);
  assert.equal(
    (await f.call("admin-update", update(before, { members: [alice, bob] })))
      .status,
    409,
  );
  assert.deepEqual((await f.call("admin-read", { id })).value.policy, before);
  assert.equal(
    (await f.call("admin-update", update(before, { aliases: [] }))).status,
    200,
  );
});

test("management is default-off, admin-only, account-bound and CSRF-protected", async (t) => {
  const off = await fixture(t, { enabled: false });
  assert.equal((await off.call("admin-status")).value.enabled, false);
  assert.equal((await off.call("admin-create", input())).status, 404);
  const f = await fixture(t);
  assert.equal((await f.call("admin-status")).value.enabled, true);
  assert.equal(
    (await f.call("admin-status", undefined, { user: "bob" })).value.enabled,
    false,
  );
  for (const opts of [
    { user: "bob" },
    { user: "nobody" },
    { csrf: null },
    { account: bob },
    { account: null },
    { headers: { Origin: "https://other.example.org" } },
  ]) {
    assert.notEqual((await f.call("admin-create", input(), opts)).status, 200);
  }
  for (const data of [
    { ...input(), owner: alice },
    { ...input(), members: [alice, alice] },
    { ...input(), aliases: [...input().aliases, ...input().aliases] },
    { ...input(), url: "https://127.0.0.1/article" },
    { ...input(), expires: 1 },
    { ...input(), evidence: "   " },
  ])
    assert.equal((await f.call("admin-create", data)).status, 400);
  assert.equal((await f.call("admin-list", {})).value.policies.length, 0);
  assert.equal(f.fetches(), 0);
});

test("session change while reading an admin request prevents dispatch", async () => {
  let authentications = 0,
    dispatched = 0;
  const handler = createHandler({
    authenticate: async () =>
      ++authentications === 1
        ? { subject: "document-test:alice", sessionId: "one" }
        : null,
  });
  const response = await handler(
    new Request(origin + "/api/documents/admin-create", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Document-Account": alice,
      },
      body: JSON.stringify(input()),
    }),
    {
      APP_ORIGIN: origin,
      ACCOUNTS: {
        idFromName: (id) => id,
        get: () => ({
          fetch: async () => {
            dispatched++;
            return new Response("{}");
          },
        }),
      },
    },
  );
  assert.equal(response.status, 401);
  assert.equal(dispatched, 0);
});

test("policy revocation during a publisher fetch blocks the pending response", async (t) => {
  let release, started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    outbound: async () => {
      started();
      await pending;
    },
  });
  const p = await create(f, { ...input(), members: [alice, bob] });
  const acquisition = f.call(
    "acquire",
    { url, audience: "shared" },
    { user: "bob" },
  );
  try {
    await ready;
    assert.equal(
      (await f.call("admin-update", update(p, { members: [alice] }))).status,
      200,
    );
  } finally {
    release();
  }
  assert.equal((await acquisition).status, 404);
  assert.equal(
    (await f.call("history", { url, audience: "shared" }, { user: "bob" }))
      .status,
    404,
  );
});

test("listing is bounded, cursor pages do not repeat policies, and capacity does not evict old permissions", async (t) => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    url: `https://publisher.example.org/${i}`,
  }));
  const f = await fixture(t, {
    beforeMigration: async (db) => {
      await db
        .prepare(
          `INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.url'),1,0,1,'Synthetic permission' FROM json_each(?)`,
        )
        .bind(JSON.stringify(rows))
        .run();
    },
  });
  const first = await f.call("admin-list", {});
  assert.equal(first.status, 200);
  assert.equal(first.value.policies.length, 20);
  assert.equal(first.value.policies[0].members, undefined);
  assert.equal(first.value.after, rows[19].id);
  const second = await f.call("admin-list", { after: first.value.after });
  assert.equal(second.value.policies[0].id, rows[20].id);
  const last = await f.call("admin-list", { after: rows[979].id });
  assert.equal(last.value.policies.length, 20);
  assert.equal(last.value.after, null);
  assert.equal((await f.call("admin-create", input())).status, 409);
  assert.equal(
    (
      await (
        await f.db()
      )
        .prepare("SELECT COUNT(*) AS count FROM document_policies")
        .first()
    ).count,
    1000,
  );
  assert.equal(
    (await f.call("admin-read", { id: rows[0].id })).value.policy
      .managementRevision,
    1,
  );
});

test("audit snapshots survive restart, preserve revoked members, and never disclose history to readers", async (t) => {
  const f = await fixture(t);
  const p = await create(f, { ...input(), members: [alice, bob] });
  const changed = await f.call(
    "admin-update",
    update(p, { enabled: false, members: [] }),
  );
  assert.equal(changed.status, 200);
  await f.restart();
  const history = await f.call("admin-history", { id: p.id });
  assert.equal(history.status, 200);
  assert.deepEqual(
    history.value.entries.map((e) => [e.revision, e.actor, e.kind]),
    [
      [2, alice, "update"],
      [1, alice, "create"],
    ],
  );
  assert.equal(history.value.before, null);
  assert.deepEqual(
    (await f.call("admin-revision", { id: p.id, revision: 1 })).value.policy,
    p,
  );
  assert.deepEqual(
    (await f.call("admin-read", { id: p.id })).value.policy,
    changed.value.policy,
  );
  for (const [action, body] of [
    ["admin-history", { id: p.id }],
    ["admin-revision", { id: p.id, revision: 1 }],
  ]) {
    for (const opts of [
      { user: "bob" },
      { user: "nobody" },
      { account: null },
      { csrf: null },
    ])
      assert.notEqual((await f.call(action, body, opts)).status, 200);
  }
  const db = await f.db();
  await assert.rejects(
    db
      .prepare("UPDATE document_policy_history SET actor=? WHERE policy_id=?")
      .bind(bob, p.id)
      .run(),
  );
  await assert.rejects(
    db
      .prepare("DELETE FROM document_policy_history WHERE policy_id=?")
      .bind(p.id)
      .run(),
  );
  assert.equal(f.fetches(), 0);
});

test("history persistence failure rolls back the entire edit; a losing concurrent edit adds no event", async (t) => {
  const f = await fixture(t),
    p = await create(f);
  const db = await f.db();
  await db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON document_policy_history BEGIN SELECT RAISE(ABORT, 'synthetic-history-failure'); END;",
  );
  assert.equal(
    (await f.call("admin-update", update(p, { members: [], enabled: false })))
      .status,
    502,
  );
  assert.deepEqual((await f.call("admin-read", { id: p.id })).value.policy, p);
  assert.equal(
    (await f.call("admin-history", { id: p.id })).value.entries.length,
    1,
  );
  await db.exec("DROP TRIGGER fail_history;");
  const results = await Promise.all([
    f.call("admin-update", update(p, { members: [], enabled: false })),
    f.call("admin-update", update(p, { members: [alice, bob] })),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const history = (await f.call("admin-history", { id: p.id })).value.entries;
  assert.deepEqual(
    history.map((e) => e.revision),
    [2, 1],
  );
  assert.deepEqual(
    (await f.call("admin-revision", { id: p.id, revision: 2 })).value.policy,
    results.find((r) => r.status === 200).value.policy,
  );
});

test("first edit of a legacy policy retains an honestly labelled baseline; history is bounded and corrupt detail is refused", async (t) => {
  const id = "77777777-7777-4777-8777-777777777777";
  const f = await fixture(t, {
    beforeMigration: async (db) => {
      await db
        .prepare("INSERT INTO document_policies VALUES(?,?,1,0,1,?)")
        .bind(id, url, "Legacy fixture permission")
        .run();
      await db
        .prepare("INSERT INTO document_members VALUES(?,?)")
        .bind(id, bob)
        .run();
    },
  });
  const p = (await f.call("admin-read", { id })).value.policy;
  assert.deepEqual((await f.call("admin-history", { id })).value.entries, []);
  assert.equal(
    (await f.call("admin-update", update(p, { members: [] }))).status,
    200,
  );
  const baseline = (await f.call("admin-revision", { id, revision: 1 })).value;
  assert.deepEqual(baseline.policy, p);
  assert.equal(baseline.entry.actor, null);
  assert.equal(baseline.entry.kind, "baseline");
  const db = await f.db();
  await db
    .prepare(
      `INSERT INTO document_policy_history(policy_id,management_revision,actor,recorded,kind,snapshot)
    SELECT policy_id,j.value,actor,recorded,kind,json_set(snapshot,'$.management_revision',j.value)
    FROM document_policy_history,json_each(?) j WHERE policy_id=? AND management_revision=2`,
    )
    .bind(JSON.stringify(Array.from({ length: 22 }, (_, i) => i + 3)), id)
    .run();
  const first = (await f.call("admin-history", { id })).value;
  assert.equal(first.entries.length, 20);
  assert.equal(first.before, 5);
  const second = (await f.call("admin-history", { id, before: first.before }))
    .value;
  assert.deepEqual(
    second.entries.map((e) => e.revision),
    [4, 3, 2, 1],
  );
  assert.equal(second.before, null);
  assert.deepEqual(Object.keys(first.entries[0]).sort(), [
    "actor",
    "kind",
    "recorded",
    "revision",
  ]);
  await db
    .prepare(
      "INSERT INTO document_policy_history VALUES(?,25,?,?,'update','{}')",
    )
    .bind(id, alice, Date.now())
    .run();
  assert.equal(
    (await f.call("admin-revision", { id, revision: 25 })).status,
    502,
  );
});

const lifecycleCommand = (action, expectedRevision, extra = {}) => ({
  action,
  expectedRevision,
  operationId: crypto.randomUUID(),
  reason: "Synthetic lifecycle administration",
  ...extra,
});

test("authenticated lifecycle routes withdraw, restore and permanently purge retained bodies across restart", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  const target = {
    audience: "shared",
    policyId: p.id,
    managementRevision: p.managementRevision,
  };
  const original = await f.call("acquire", { url, audience: "shared" });
  assert.equal(original.status, 200);
  const preview = await f.call("admin-document-preview", { target });
  assert.equal(preview.status, 200, JSON.stringify(preview.value));
  assert.equal(preview.value.versionCount, 1);
  const change = (command) =>
    f.call("admin-document-change", { target, command });
  assert.equal((await change(lifecycleCommand("withdraw", 0))).status, 200);
  assert.equal((await f.call("read", { url, audience: "shared" })).status, 404);
  assert.equal((await change(lifecycleCommand("restore", 1))).status, 200);
  assert.equal((await f.call("read", { url, audience: "shared" })).status, 200);
  assert.equal((await change(lifecycleCommand("withdraw", 2))).status, 200);
  const purge = lifecycleCommand("purge", 3, {
    expectedCatalogRevision: preview.value.catalogRevision,
  });
  const deleted = await change(purge);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.value));
  assert.equal(deleted.value.current.status, "deleted");
  assert.equal(deleted.value.current.bytes, 0);
  await f.restart();
  const retry = await change(purge);
  assert.equal(retry.status, 200);
  assert.equal(retry.value.replayed, true);
  assert.equal(
    (await f.call("acquire", { url, audience: "shared" })).status,
    404,
  );
  assert.equal(f.fetches(), 1);
});

test("lifecycle management requires manager, matching account, CSRF and a strict target without creating new sources", async (t) => {
  const f = await fixture(t);
  const target = { audience: "private", url };
  for (const opts of [
    { user: "bob" },
    { csrf: "wrong" },
    { account: null },
    { account: bob },
  ]) {
    const response = await f.call("admin-document-preview", { target }, opts);
    assert.notEqual(response.status, 200);
  }
  assert.equal(
    (
      await f.call("admin-document-preview", {
        target: { ...target, owner: bob },
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.call("admin-document-preview", { target, action: "change" }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.call("admin-document-change", {
        target,
        command: lifecycleCommand("withdraw", 0),
      })
    ).status,
    404,
  );
  assert.equal(f.fetches(), 0);
  const off = await fixture(t, { enabled: false });
  assert.equal(
    (await off.call("admin-document-preview", { target })).status,
    404,
  );
});

test("a manager can withdraw a historic scope after reader permission is revoked but cannot restore it", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  assert.equal(
    (await f.call("acquire", { url, audience: "shared" })).status,
    200,
  );
  const target = { audience: "shared", policyId: p.id, managementRevision: 1 };
  assert.equal(
    (await f.call("admin-update", update(p, { enabled: false, members: [] })))
      .status,
    200,
  );
  const withdraw = await f.call("admin-document-change", {
    target,
    command: lifecycleCommand("withdraw", 0),
  });
  assert.equal(withdraw.status, 200, JSON.stringify(withdraw.value));
  assert.equal(
    (
      await f.call("admin-document-change", {
        target,
        command: lifecycleCommand("restore", 1),
      })
    ).status,
    404,
  );
  const preview = await f.call("admin-document-preview", { target });
  assert.equal(preview.status, 200);
  assert.equal(preview.value.status, "withdrawn");
  assert.equal(preview.value.versionCount, 1);
  assert.equal(f.fetches(), 1);
});

test("an explicit retention deadline triggers the real source object's alarm without a reader request", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  assert.equal(
    (await f.call("acquire", { url, audience: "shared" })).status,
    200,
  );
  const target = { audience: "shared", policyId: p.id, managementRevision: 1 };
  const response = await f.call("admin-document-change", {
    target,
    command: lifecycleCommand("retention", 0, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const limit = Date.now() + 5000;
  let result;
  do {
    result = await f.call("admin-document-preview", { target });
    assert.equal(result.status, 200);
    if (result.value.status === "deleted") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < limit);
  assert.equal(result.value.status, "deleted");
  assert.equal(result.value.bytes, 0);
  assert.equal(result.value.operations.length, 2);
  await f.restart();
  assert.equal(
    (await f.call("acquire", { url, audience: "shared" })).status,
    404,
  );
  assert.equal(f.fetches(), 1);
});

test("reservation recovery requires permanent deletion and preserves other policy generations", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  const source = { url, audience: "shared" };
  assert.equal((await f.call("acquire", source)).status, 200);
  const next = await f.call(
    "admin-update",
    update(p, {
      evidence: "A new synthetic publisher permission generation",
      aliases: [],
    }),
  );
  assert.equal(next.status, 200);
  assert.equal((await f.call("acquire", source)).status, 200);
  const target1 = { audience: "shared", policyId: p.id, managementRevision: 1 };
  const target2 = { ...target1, managementRevision: 2 };
  const preview = (target) => f.call("admin-document-preview", { target });
  const initial = (await preview(target1)).value;
  assert.equal(initial.reservation.scopeCount, 2);
  const expected = {
    token: initial.reservation.token,
    revision: initial.reservation.revision,
  };
  const reconcile = (target, reservation) =>
    f.call("admin-document-reconcile", { target, reservation });
  assert.equal((await reconcile(target1, expected)).status, 409);
  const purge = async (target, before) => {
    assert.equal(
      (
        await f.call("admin-document-change", {
          target,
          command: lifecycleCommand("withdraw", before.revision),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call("admin-document-change", {
          target,
          command: lifecycleCommand("purge", before.revision + 1, {
            expectedCatalogRevision: before.catalogRevision,
          }),
        })
      ).status,
      200,
    );
  };
  await purge(target1, initial);
  const one = await reconcile(target1, expected);
  assert.equal(one.status, 200, JSON.stringify(one.value));
  assert.equal(one.value.reservation.reserved, true);
  assert.equal(one.value.reservation.scopeCount, 1);
  assert.equal(one.value.reservation.containsTarget, false);
  assert.equal((await f.call("read", source)).status, 200);
  const second = (await preview(target2)).value;
  await purge(target2, second);
  const expected2 = {
    token: second.reservation.token,
    revision: second.reservation.revision,
  };
  const two = await reconcile(target2, expected2);
  assert.equal(two.status, 200);
  assert.equal(two.value.reservation.reserved, false);
  await f.restart();
  assert.equal(
    (await reconcile(target2, expected2)).value.reservation.reserved,
    false,
  );
  const p2 = next.value.policy;
  assert.equal(
    (
      await f.call(
        "admin-update",
        update(p2, {
          evidence: "A third synthetic publisher permission generation",
          aliases: [],
        }),
      )
    ).status,
    200,
  );
  assert.equal((await f.call("acquire", source)).status, 200);
  assert.equal((await reconcile(target1, expected)).status, 409);
  assert.equal(
    (await preview({ ...target1, managementRevision: 3 })).value.reservation
      .scopeCount,
    1,
  );
  assert.equal(f.fetches(), 3);
});

for (const audience of ["shared", "private"]) {
  test(`${audience}: acquiring a permanently deleted source does not consume a recovered reservation`, async (t) => {
    const f = await fixture(t);
    const p = await create(f);
    const source = { url, audience };
    assert.equal((await f.call("acquire", source)).status, 200);
    const target =
      audience === "shared"
        ? { audience, policyId: p.id, managementRevision: 1 }
        : { audience, url };
    const before = (await f.call("admin-document-preview", { target })).value;
    for (const command of [
      lifecycleCommand("withdraw", 0),
      lifecycleCommand("purge", 1, {
        expectedCatalogRevision: before.catalogRevision,
      }),
    ])
      assert.equal(
        (await f.call("admin-document-change", { target, command })).status,
        200,
      );
    const released = await f.call("admin-document-reconcile", {
      target,
      reservation: {
        token: before.reservation.token,
        revision: before.reservation.revision,
      },
    });
    assert.equal(released.status, 200);
    assert.equal(released.value.reservation.reserved, false);
    const denied = await f.call("acquire", source);
    assert.equal(denied.status, 404);
    assert.equal(Object.hasOwn(denied.value, "deletion"), false);
    const after = await f.call("admin-document-preview", { target });
    assert.equal(after.status, 200);
    assert.equal(after.value.reservation.reserved, false);
    assert.equal(f.fetches(), 1);
  });
}
