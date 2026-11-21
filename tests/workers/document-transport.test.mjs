import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../../workers/crypto.mjs";
import { publicDocuments } from "../../workers/public-documents.mjs";

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
async function fixture(
  t,
  {
    enabled = true,
    publicEnabled = false,
    publicRateLimit = 1000,
    outbound,
  } = {},
) {
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
    d1Databases: {
      DOCUMENT_ACCESS_DB: "document-access",
      AUTH_DB: "document-auth",
    },
    ratelimits:
      publicEnabled && publicRateLimit !== null
        ? {
            PUBLIC_DOCUMENT_RATE_LIMITER: {
              namespace_id: "9001",
              simple: { limit: publicRateLimit, period: 60 },
            },
          }
        : undefined,
    bindings: {
      APP_ORIGIN: origin,
      DOCUMENTS_ENABLED: String(enabled),
      PUBLIC_DOCUMENTS_ENABLED: String(publicEnabled),
      GOOGLE_ALLOWED_EMAIL: "alice@example.test",
    },
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
  const auth = await mf.getD1Database("AUTH_DB");
  await auth.exec(
    (await readFile("migrations/auth/0001_better_auth.sql", "utf8")).replaceAll(
      "\n",
      " ",
    ),
  );
  await auth
    .prepare(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
    )
    .bind("alice", "Admin", "alice@example.test", 1, 0, 0)
    .run();
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const db = () => mf.getD1Database("DOCUMENT_ACCESS_DB");
  for (const file of [
    "0001_access.sql",
    "0002_source_aliases.sql",
    ...(publicEnabled
      ? [
          "0003_policy_management.sql",
          "0004_policy_history.sql",
          "0005_publications.sql",
          "0006_publication_management.sql",
        ]
      : []),
  ])
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
        .bind(policyId, await hash(`better-auth:${user}`))
        .run();
  }
  return {
    call,
    db,
    grant,
    prepareTopic: async (
      body,
      { csrf = tokens.get("alice"), account, headers = {} } = {},
    ) => {
      const response = await mf.dispatchFetch(
        origin + "/api/topic-textbooks/preparations",
        {
          method: "POST",
          headers: {
            Origin: origin,
            "X-Test-Principal": "alice",
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "X-Library-Account": account ?? (await hash("better-auth:alice")),
            ...headers,
          },
          body: JSON.stringify(body),
        },
      );
      return { status: response.status, value: await response.json() };
    },
    publicRead: (
      path = "/api/public/documents?url=" + encodeURIComponent(url),
      options,
    ) => mf.dispatchFetch(origin + path, options),
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

async function publish(
  f,
  { revision = 1, expires = Date.now() + 3600000 } = {},
) {
  await (
    await f.db()
  )
    .prepare(
      "INSERT INTO document_publications(policy_id,policy_revision,enabled,expires,evidence) VALUES(?,?,1,?,?)",
    )
    .bind(
      policyId,
      revision,
      expires,
      "Synthetic permission for anonymous fixture delivery only",
    )
    .run();
}

test("匿名閲覧の制限・設定障害・未入力フォームはDBへ到達せず、HTMLでも制限を示す", async () => {
  let databaseAccesses = 0;
  const base = {
    APP_ORIGIN: origin,
    PUBLIC_DOCUMENTS_ENABLED: "true",
    get DOCUMENT_ACCESS_DB() {
      databaseAccesses++;
      throw Error("DBへ到達してはいけません");
    },
  };
  for (const [limiter, expectedStatus] of [
    [undefined, 503],
    [
      {
        limit: async () => {
          throw Error("制限サービスの障害");
        },
      },
      503,
    ],
    [{ limit: async () => ({ success: "true" }) }, 503],
    [{ limit: async () => ({ success: false }) }, 429],
  ]) {
    for (const path of ["/api/public/documents", "/public/documents"]) {
      const response = await publicDocuments(
        new Request(origin + path + "?url=" + encodeURIComponent(url)),
        Object.create(base, {
          PUBLIC_DOCUMENT_RATE_LIMITER: { value: limiter },
        }),
      );
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("ETag"), null);
      if (response.status === 429) {
        assert.equal(response.headers.get("Retry-After"), "60");
        if (path === "/public/documents") {
          assert.match(
            response.headers.get("Content-Security-Policy"),
            /default-src 'none'/,
          );
          assert.match(await response.text(), /アクセスが集中しています/);
        } else
          assert.deepEqual(await response.json(), {
            status: "document-rate-limit",
          });
      }
    }
  }
  let limitCalls = 0;
  const form = await publicDocuments(
    new Request(origin + "/public/documents"),
    Object.create(base, {
      PUBLIC_DOCUMENT_RATE_LIMITER: {
        value: {
          limit: async () => {
            limitCalls++;
            return { success: false };
          },
        },
      },
    }),
  );
  assert.equal(form.status, 200);
  assert.equal(limitCalls, 0);
  assert.equal(databaseAccesses, 0);
});

test(
  "匿名閲覧はDBに触れる前に共通の流量枠を確認し、未設定時も配信しない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true, publicRateLimit: 1 });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    assert.equal((await f.publicRead()).status, 200);
    await (await f.db()).exec("DROP TABLE document_publications");
    const responses = await Promise.all([
      f.publicRead(),
      f.publicRead("/public/documents?url=" + encodeURIComponent(url)),
    ]);
    // 窓の境界をまたいでも、同時要求の少なくとも一方はDBの故障より先に拒否する。
    const limited = responses.filter((r) => r.status === 429);
    assert.ok(limited.length > 0);
    for (const response of limited) {
      assert.equal(response.headers.get("Retry-After"), "60");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("ETag"), null);
    }
    const unavailable = await fixture(t, {
      publicEnabled: true,
      publicRateLimit: null,
    });
    assert.equal((await unavailable.publicRead()).status, 503);
    assert.equal(unavailable.calls(), 0);
  },
);

test(
  "一般公開は独立した許可と取得済み共有版を要し、匿名の再検証で同じ版を再利用する",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true });
    await f.grant(["alice"]);
    await f.call("acquire", { body: { url, audience: "private" } });
    assert.equal((await f.publicRead()).status, 404);
    await publish(f);
    // 個人版があっても、公開先の共有版を作成したことにはならない。
    assert.equal((await f.publicRead()).status, 404);
    assert.equal(f.calls(), 1);
    const acquired = await f.call("acquire", {
      body: { url, audience: "shared" },
    });
    assert.equal(acquired.status, 200);
    const response = await f.publicRead();
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, no-cache, must-revalidate",
    );
    const value = await response.json();
    assert.equal(value.versionId, acquired.value.version.id);
    assert.equal(value.documentId, acquired.value.version.documentId);
    assert.equal(value.sourceURL, url);
    assert.equal(value.account, undefined);
    assert.equal(value.scope, undefined);
    const etag = response.headers.get("ETag");
    const extra = await f.publicRead(undefined, {
      headers: { "X-Test-Withdraw-Public": "additional-fields" },
    });
    assert.equal(extra.status, 200);
    assert.equal(extra.headers.get("ETag"), etag);
    assert.deepEqual(await extra.json(), value);
    const revalidated = await f.publicRead(undefined, {
      headers: {
        "If-None-Match": `W/${etag}`,
        Cookie: "another-user=untrusted",
      },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), "");
    await f.restart();
    const restarted = await f.publicRead();
    assert.equal((await restarted.json()).versionId, value.versionId);
    assert.equal(f.calls(), 2);
    // 閲覧は購読や会員資格を作らず、取得元への通信も増やさない。
    assert.equal(
      (await f.call("read", { user: "bob", body: { url, audience: "shared" } }))
        .status,
      404,
    );
    // 本文を読んだ後の取消でも、304や本文を配信しない。
    const revoked = await f.publicRead(undefined, {
      headers: {
        "If-None-Match": etag,
        "X-Test-Withdraw-Public": "after-read",
      },
    });
    assert.equal(revoked.status, 404);
    assert.equal(revoked.headers.get("ETag"), null);
    assert.deepEqual(await revoked.json(), { status: "document-unavailable" });
  },
);

test(
  "公開の取消・期限・世代変更はETag一致時にも確認し、別名や任意操作では公開しない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    const etag = (await f.publicRead()).headers.get("ETag");
    const conditional = () =>
      f.publicRead(undefined, { headers: { "If-None-Match": etag } });
    const db = await f.db();
    for (const [change, restore] of [
      [
        "UPDATE document_publications SET enabled=0",
        "UPDATE document_publications SET enabled=1",
      ],
      [
        "UPDATE document_policies SET enabled=0",
        "UPDATE document_policies SET enabled=1",
      ],
      [
        "UPDATE document_publications SET expires=1",
        `UPDATE document_publications SET expires=${Date.now() + 3600000}`,
      ],
      [
        "UPDATE document_policies SET expires=1",
        `UPDATE document_policies SET expires=${Date.now() + 3600000}`,
      ],
      [
        "UPDATE document_publications SET policy_revision=2",
        "UPDATE document_publications SET policy_revision=1",
      ],
    ]) {
      await db.exec(change);
      const denied = await conditional();
      assert.equal(denied.status, 404);
      assert.equal(denied.headers.get("Cache-Control"), "no-store");
      assert.equal(denied.headers.get("ETag"), null);
      await db.exec(restore);
      // 配信再開には現在の公開条件を明示的に承認し直す。
      await db.exec(
        "UPDATE document_publications SET source_revision=(SELECT publication_revision FROM document_policies WHERE id=policy_id)",
      );
      assert.equal((await conditional()).status, 304);
    }
    const alias = await f.alias();
    assert.equal(
      (
        await f.publicRead(
          "/api/public/documents?url=" + encodeURIComponent(alias),
        )
      ).status,
      404,
    );
    for (const suffix of [
      "&url=" + encodeURIComponent(url),
      "&action=acquire",
      "&versionId=anything",
      "&scope=private:any",
    ])
      assert.equal(
        (
          await f.publicRead(
            "/api/public/documents?url=" + encodeURIComponent(url) + suffix,
          )
        ).status,
        400,
      );
    assert.equal(
      (await f.publicRead(undefined, { method: "POST" })).status,
      404,
    );
    assert.equal(f.calls(), 1);
  },
);

test(
  "公開機能は既定で無効で、読書画面は入力と本文をHTMLとして実行しない",
  { timeout: 20000 },
  async (t) => {
    const disabled = await fixture(t);
    assert.equal((await disabled.publicRead()).status, 404);
    const f = await fixture(t, { publicEnabled: true });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    const page = await f.publicRead(
      "/public/documents?url=" + encodeURIComponent(url),
    );
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("Content-Security-Policy"),
      /default-src 'none'/,
    );
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    assert.match(await page.text(), /Public original with sufficient evidence/);
    const attack = await f.publicRead(
      "/public/documents?url=" +
        encodeURIComponent('"><script>alert(1)</script>'),
    );
    assert.equal(attack.status, 404);
    const text = await attack.text();
    assert.ok(!text.includes("<script>"));
    assert.ok(text.includes("&lt;script&gt;"));
    const head = await f.publicRead(undefined, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  },
);

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
      .bind(policyId, await hash("better-auth:bob"))
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
      .bind(await hash("better-auth:alice"))
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
      .prepare(
        "INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
      )
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
test(
  "教材の資料準備は認証・CSRF付きで公開保存版だけを読み、再起動でも元サイトを再取得しない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true });
    await f.grant();
    await f.call("acquire", { body: { url, audience: "shared" } });
    assert.equal(f.calls(), 1);
    const before = await f.prepareTopic({ topic: "original" });
    assert.equal(before.status, 200);
    assert.equal(before.value.inspected, 0);
    await publish(f);
    const prepared = await f.prepareTopic({ topic: "original" });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
    assert.equal(prepared.value.sources.length, 1);
    assert.equal(prepared.value.sources[0].source.url, url);
    assert.equal(
      prepared.value.sources[0].source.excerpt.includes("Public original"),
      true,
    );
    assert.equal(
      (await f.prepareTopic({ topic: "original" }, { csrf: "wrong" })).status,
      403,
    );
    assert.equal(
      (await f.prepareTopic({ topic: "original" }, { account: "b".repeat(64) }))
        .status,
      403,
    );
    await f.restart();
    assert.deepEqual(
      (await f.prepareTopic({ topic: "original" })).value.sources,
      prepared.value.sources,
    );
    await (
      await f.db()
    )
      .prepare("UPDATE document_publications SET enabled=0")
      .run();
    assert.equal(
      (await f.prepareTopic({ topic: "original" })).value.sources.length,
      0,
    );
    assert.equal(f.calls(), 1);
  },
);
test(
  "公開目録の資料準備を5件ずつ進め、未取得の原文を探索だけで取りに行かない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    const db = await f.db();
    for (let n = 1; n <= 5; n++) {
      const id = `${n}1111111-1111-4111-8111-111111111111`;
      await db
        .prepare(
          "INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
        )
        .bind(
          id,
          `${url}/${n}`,
          Date.now() + 3600000,
          "Synthetic source permission",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO document_publications(policy_id,policy_revision,enabled,expires,evidence) VALUES(?,1,1,?,?)",
        )
        .bind(id, Date.now() + 3600000, "Synthetic public permission")
        .run();
    }
    const first = await f.prepareTopic({ topic: "original" });
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.equal(first.value.inspected, 5);
    assert.equal(first.value.unavailable, 5);
    assert.equal(first.value.sources.length, 0);
    assert.equal(typeof first.value.after, "string");
    const second = await f.prepareTopic({
      topic: "original",
      after: first.value.after,
    });
    assert.equal(second.status, 200);
    assert.equal(second.value.inspected, 1);
    assert.equal(second.value.after, null);
    assert.equal(second.value.sources.length, 1);
    await db
      .prepare("DELETE FROM document_publications WHERE policy_id=?")
      .bind("11111111-1111-4111-8111-111111111111")
      .run();
    await db
      .prepare("DELETE FROM document_policies WHERE id=?")
      .bind("11111111-1111-4111-8111-111111111111")
      .run();
    const exactlyFive = await f.prepareTopic({ topic: "original" });
    assert.equal(exactlyFive.value.inspected, 5);
    assert.equal(exactlyFive.value.after, null);
    assert.equal(exactlyFive.value.sources.length, 1);
    assert.equal(f.calls(), 1);
  },
);
test(
  "実workerdで日本語の複数文字と一文字の漢字のテーマを分割して資料を準備する",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, {
      publicEnabled: true,
      outbound: async () =>
        new Response(
          "<article><h1>税と非同期処理の公開資料</h1><p>" +
            "税は公共サービスを支えます。非同期処理は完了を待つ間に別の仕事を進めます。".repeat(
              20,
            ) +
            "</p></article>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    const tax = await f.prepareTopic({ topic: "税について" });
    assert.equal(tax.status, 200, JSON.stringify(tax.value));
    assert.equal(tax.value.sources.length, 1);
    assert.deepEqual(tax.value.sources[0].matchedTerms, ["税"]);
    const asyncTopic = await f.prepareTopic({ topic: "非同期処理の仕組み" });
    assert.equal(asyncTopic.status, 200, JSON.stringify(asyncTopic.value));
    assert.equal(asyncTopic.value.sources.length, 1);
    assert.equal(
      asyncTopic.value.sources[0].matchedTerms.some(
        (word) => [...word].length > 1,
      ),
      true,
    );
    assert.equal(f.calls(), 1);
  },
);
test(
  "資料準備のHTTP制限は20ページで429を返し、通常の文書操作を止めない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    for (let n = 0; n < 20; n++)
      assert.equal((await f.prepareTopic({ topic: "original" })).status, 200);
    const limited = await f.prepareTopic({ topic: "original" });
    assert.equal(limited.status, 429);
    assert.equal(limited.value.status, "rate-limit");
    assert.equal(
      (await f.call("read", { body: { url, audience: "shared" } })).status,
      200,
    );
    assert.equal(f.calls(), 1);
  },
);
test(
  "公開許可と元の共有許可の期限が切れた資料は準備一覧に含めない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    const db = await f.db();
    await db
      .prepare("UPDATE document_publications SET expires=?")
      .bind(Date.now() - 1)
      .run();
    assert.equal(
      (await f.prepareTopic({ topic: "original" })).value.inspected,
      0,
    );
    await db
      .prepare("UPDATE document_publications SET expires=?")
      .bind(Date.now() + 3600000)
      .run();
    await db
      .prepare("UPDATE document_policies SET expires=?")
      .bind(Date.now() - 1)
      .run();
    await db.exec(
      "UPDATE document_publications SET source_revision=(SELECT publication_revision FROM document_policies WHERE id=policy_id)",
    );
    assert.equal(
      (await f.prepareTopic({ topic: "original" })).value.inspected,
      0,
    );
    assert.equal(f.calls(), 1);
  },
);
test(
  "資料準備の共通枠を超えると429になり、匿名閲覧の枠を消費しない",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { publicEnabled: true, publicRateLimit: 1 });
    await f.grant();
    await publish(f);
    await f.call("acquire", { body: { url, audience: "shared" } });
    assert.equal((await f.prepareTopic({ topic: "original" })).status, 200);
    const refused = await f.prepareTopic({ topic: "original" });
    assert.equal(refused.status, 429);
    assert.equal(refused.value.status, "rate-limit");
    assert.equal((await f.publicRead()).status, 200);
    assert.equal(f.calls(), 1);
  },
);
