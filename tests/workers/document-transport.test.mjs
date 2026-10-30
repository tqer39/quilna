import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../../workers/crypto.mjs";

const origin = "http://documents.test",
  url = "https://publisher.example.org/article";
const policyId = "77777777-7777-4777-8777-777777777777";
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
async function fixture(t, { enabled = true, outbound } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "quilna-documents-"));
  let calls = 0;
  const options = {
    modules: true,
    script,
    compatibilityDate: "2026-10-11",
    compatibilityFlags: ["global_fetch_strictly_public"],
    resourcePersistencePath: dir,
    durableObjects: {
      ACCOUNTS: { className: "AccountVault", useSQLite: true },
      DOCUMENTS: { className: "SourceDocument", useSQLite: true },
    },
    d1Databases: { DOCUMENT_ACCESS_DB: "document-access" },
    bindings: { APP_ORIGIN: origin, DOCUMENTS_ENABLED: String(enabled) },
    outboundService: async (request) => {
      calls++;
      assert.equal(request.url, url);
      assert.equal(request.headers.get("Cookie"), null);
      assert.equal(request.headers.get("Authorization"), null);
      if (outbound) return outbound(request);
      return new Response(
        "<article><h1>Source document</h1><p>" +
          "Public original with sufficient evidence. ".repeat(20) +
          "</p><pre>  const value = 42;\n</pre></article>",
        { headers: { "Content-Type": "text/html", ETag: '"v1"' } },
      );
    },
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const db = () => mf.getD1Database("DOCUMENT_ACCESS_DB");
  for (const file of ["0001_access.sql", "0002_source_aliases.sql"])
    await (
      await db()
    ).exec(
      (await readFile("migrations/documents/" + file, "utf8"))
        .replace(/^--.*$/gm, "")
        .replaceAll("\n", " "),
    );
  const tokens = new Map();
  async function call(
    action,
    { user = "alice", body, csrf = tokens.get(user), headers = {} } = {},
  ) {
    const path =
      action === "session" ? "/api/session" : "/api/documents/" + action;
    const response = await mf.dispatchFetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: origin,
        "X-Test-Principal": user,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      value: await response.json(),
      headers: response.headers,
    };
  }
  for (const user of ["alice", "bob"])
    tokens.set(user, (await call("session", { user })).value.csrfToken);
  async function grant(members = ["alice", "bob"]) {
    const d = await db();
    await d
      .prepare(
        "INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
      )
      .bind(
        policyId,
        url,
        Date.now() + 3600000,
        "Synthetic publisher permits fixture-only reuse",
      )
      .run();
    for (const user of members)
      await d
        .prepare(
          "INSERT INTO document_members(policy_id,owner_hash) VALUES(?,?)",
        )
        .bind(policyId, await hash(`document-test:${user}`))
        .run();
  }
  return {
    call,
    db,
    grant,
    alias: async (
      address = url + "?utm_source=approved",
      expires = Date.now() + 3600000,
    ) => {
      await (
        await db()
      )
        .prepare(
          "INSERT INTO document_aliases(alias_url,policy_id,policy_revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
        )
        .bind(
          address,
          policyId,
          expires,
          "Synthetic evidence: same original and delivery terms",
        )
        .run();
      return address;
    },
    calls: () => calls,
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
    },
  };
}

test(
  "authenticated document routes preserve private separation, require origin/CSRF/account and reject owner/scope/content injection",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const body = { url, audience: "private" };
    const status = await f.call("status");
    assert.equal(status.value.enabled, true);
    assert.equal((await f.call("status", { user: "forged" })).status, 401);
    assert.equal((await f.call("acquire", { body, csrf: "bad" })).status, 403);
    assert.equal(
      (
        await f.call("acquire", {
          body,
          headers: { Origin: "https://evil.example.org" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("acquire", {
          body,
          headers: { "X-Document-Account": "wrong" },
        })
      ).status,
      403,
    );
    for (const extra of [
      { owner: "bob" },
      { scope: "shared:any" },
      { content: { text: "injected" } },
      { action: "read" },
    ])
      assert.equal(
        (await f.call("acquire", { body: { ...body, ...extra } })).status,
        400,
      );
    assert.equal(f.calls(), 0);
    const a = await f.call("acquire", { body });
    assert.equal(a.status, 200, JSON.stringify(a.value));
    const bRead = await f.call("read", {
      user: "bob",
      body: { ...body, versionId: a.value.version.id },
    });
    assert.equal(bRead.status, 404);
    const b = await f.call("acquire", { user: "bob", body });
    assert.equal(b.status, 200);
    assert.notEqual(a.value.document.id, b.value.document.id);
    assert.equal(f.calls(), 2);
    await f.restart();
    const again = await f.call("acquire", { body });
    assert.deepEqual(again.value.version, a.value.version);
    assert.equal(f.calls(), 2);
    assert.equal(again.headers.get("Cache-Control"), "no-store");
  },
);

test(
  "only exact approved source/member pairs share originals and policy revisions fence old versions",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const body = { url, audience: "shared" };
    const before = await f.call("read", { body });
    assert.equal(before.status, 404);
    await f.grant(["alice"]);
    assert.equal((await f.call("read", { user: "bob", body })).status, 404);
    assert.equal(
      (await f.call("acquire", { body: { ...body, url: url + "?private=1" } }))
        .status,
      404,
    );
    const a = await f.call("acquire", { body });
    assert.equal(a.status, 200, JSON.stringify(a.value));
    const denied = await f.call("read", { user: "bob", body });
    assert.equal(denied.status, 404);
    assert.equal(denied.value.status, before.value.status);
    assert.equal(f.calls(), 1);
    const db = await f.db();
    await db
      .prepare("INSERT INTO document_members VALUES(?,?)")
      .bind(policyId, await hash("document-test:bob"))
      .run();
    const b = await f.call("acquire", { user: "bob", body });
    assert.deepEqual(b.value.version, a.value.version);
    assert.equal(f.calls(), 1);
    await db.prepare("UPDATE document_policies SET revision=revision+1").run();
    assert.equal(
      (
        await f.call("read", {
          body: { ...body, versionId: a.value.version.id },
        })
      ).status,
      404,
    );
    const revised = await f.call("acquire", { body });
    assert.equal(revised.status, 200);
    assert.notEqual(revised.value.document.id, a.value.document.id);
    await db.prepare("UPDATE document_policies SET expires=1").run();
    assert.equal((await f.call("history", { body })).status, 404);
    assert.equal(f.calls(), 2);
  },
);

test(
  "grant withdrawal during acquisition returns no body and retry after a new grant succeeds",
  { timeout: 20000 },
  async (t) => {
    let enter, release;
    const entered = new Promise((r) => {
        enter = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    t.after(() => release());
    const f = await fixture(t, {
      outbound: async () => {
        enter();
        await gate;
        return new Response(
          "<article><p>" +
            "Revocation race evidence. ".repeat(20) +
            "</p></article>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await f.grant();
    const body = { url, audience: "shared" };
    const request = f.call("acquire", { body });
    await entered;
    const pending = await f.call("acquire", { user: "bob", body });
    assert.equal(pending.status, 202);
    assert.ok(pending.value.retryAt > Date.now());
    const db = await f.db();
    await db
      .prepare("DELETE FROM document_members WHERE owner_hash=?")
      .bind(await hash("document-test:alice"))
      .run();
    release();
    const denied = await request;
    assert.equal(denied.status, 404);
    assert.equal(denied.value.version, undefined);
    const b = await f.call("acquire", { user: "bob", body });
    assert.equal(b.status, 200);
    assert.equal(f.calls(), 2);
  },
);

test(
  "document commands respect the persisted per-account rate limit; disabled service acquires nothing",
  { timeout: 20000 },
  async (t) => {
    const disabled = await fixture(t, { enabled: false });
    assert.equal((await disabled.call("status")).value.enabled, false);
    assert.equal(
      (await disabled.call("acquire", { body: { url, audience: "private" } }))
        .status,
      503,
    );
    assert.equal(disabled.calls(), 0);
    const f = await fixture(t);
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await f.call("read", { body: { url, audience: "private" } })).status,
        404,
      );
    assert.equal(
      (await f.call("read", { body: { url, audience: "private" } })).status,
      429,
    );
    await f.restart();
    assert.equal(
      (await f.call("read", { body: { url, audience: "private" } })).status,
      429,
    );
    assert.equal(
      (
        await f.call("read", {
          user: "bob",
          body: { url, audience: "private" },
        })
      ).status,
      404,
    );
    assert.equal(f.calls(), 0);
  },
);

test(
  "a shared source grant does not authorize following a different redirect destination",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, {
      outbound: async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://publisher.example.org/unapproved" },
        }),
    });
    await f.grant();
    const result = await f.call("acquire", {
      body: { url, audience: "shared" },
    });
    assert.equal(result.status, 404);
    assert.equal(result.value.version, undefined);
    assert.equal(f.calls(), 1);
  },
);

test(
  "approved exact aliases reuse the canonical original across users and restart without fetching aliases",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const alias = await f.alias();
    const a = await f.call("acquire", {
      body: { url: alias, audience: "shared" },
    });
    assert.equal(a.status, 200, JSON.stringify(a.value));
    assert.equal(a.value.document.sourceURL, url);
    assert.deepEqual(a.value.resolution, {
      requestedURL: alias,
      sourceURL: url,
      scope: a.value.document.scope,
    });
    const b = await f.call("acquire", {
      user: "bob",
      body: { url, audience: "shared" },
    });
    assert.equal(b.status, 200);
    assert.deepEqual(a.value.version, b.value.version);
    assert.equal(a.value.reused, false);
    assert.equal(b.value.reused, true);
    assert.equal(f.calls(), 1);
    const unknown = await f.call("acquire", {
      body: { url: url + "?utm_source=not-approved", audience: "shared" },
    });
    assert.equal(unknown.status, 404);
    await f.restart();
    const read = await f.call("read", {
      body: { url: alias, audience: "shared" },
    });
    assert.equal(read.status, 200);
    assert.deepEqual(read.value, {
      ...a.value.version,
      account: a.value.account,
      resolution: a.value.resolution,
    });
    await (await f.db()).prepare("UPDATE document_aliases SET enabled=0").run();
    const denied = await f.call("read", {
      body: { url: alias, audience: "shared" },
    });
    assert.equal(denied.status, 404);
    assert.equal(denied.value.version, undefined);
    assert.equal(
      (await f.call("read", { body: { url, audience: "shared" } })).status,
      200,
    );
    assert.equal(f.calls(), 1);
  },
);

test(
  "expired aliases, stale policy revisions and aliases colliding with another source cannot grant access",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const alias = await f.alias();
    const expired = await f.alias(url + "?expired=1", 1);
    assert.equal(
      (await f.call("acquire", { body: { url: expired, audience: "shared" } }))
        .status,
      404,
    );
    const db = await f.db();
    await db.prepare("UPDATE document_policies SET revision=2").run();
    assert.equal(
      (await f.call("acquire", { body: { url: alias, audience: "shared" } }))
        .status,
      404,
    );
    await db.prepare("UPDATE document_aliases SET policy_revision=2").run();
    await db
      .prepare("INSERT INTO document_policies VALUES(?,?,1,1,?,?)")
      .bind(
        "88888888-8888-4888-8888-888888888888",
        alias,
        Date.now() + 3600000,
        "Independent source without membership",
      )
      .run();
    assert.equal(
      (await f.call("acquire", { body: { url: alias, audience: "shared" } }))
        .status,
      404,
    );
    assert.equal(f.calls(), 0);
  },
);

test(
  "removing an alias while its canonical original is fetched prevents delivery and leaves canonical access usable",
  { timeout: 20000 },
  async (t) => {
    let enter, release;
    const entered = new Promise((r) => {
        enter = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    t.after(() => release());
    const f = await fixture(t, {
      outbound: async () => {
        enter();
        await gate;
        return new Response(
          "<article><p>" +
            "Exact source evidence. ".repeat(25) +
            "</p></article>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    await f.grant();
    const alias = await f.alias();
    const pending = f.call("acquire", {
      body: { url: alias, audience: "shared" },
    });
    await entered;
    await (await f.db()).prepare("DELETE FROM document_aliases").run();
    release();
    const denied = await pending;
    assert.equal(denied.status, 404);
    assert.equal(denied.value.version, undefined);
    assert.equal(
      (
        await f.call("acquire", {
          user: "bob",
          body: { url, audience: "shared" },
        })
      ).status,
      200,
    );
    assert.equal(f.calls(), 2);
  },
);
