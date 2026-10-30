import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  authWorkerFixture as fixture,
  authFixtureOrigin as origin,
} from "../fixtures/auth-worker.mjs";
test("Better Auth D1 Google login: minimum scopes, verified IDs, encrypted state, no OAuth token storage and restart", async (t) => {
  const f = await fixture(t),
    a = f.browser(),
    u = await f.start(a);
  assert.deepEqual(u.searchParams.get("scope").split(" ").sort(), [
    "email",
    "openid",
  ]);
  assert.equal(u.searchParams.get("access_type"), "online");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("nonce"));
  assert.equal(
    u.searchParams.get("redirect_uri"),
    origin + "/api/auth/callback/google",
  );
  const r = await a.api(f.callback(u));
  assert.equal(
    r.headers.get("location"),
    "/?auth=success",
    JSON.stringify(r.value),
  );
  assert.ok(r.headers.getSetCookie().some((c) => c.includes("session_token")));
  assert.equal((await a.api("/api/auth/status")).value.authenticated, true);
  assert.equal((await a.api("/api/session")).value.realKeyInputEnabled, false);
  const db = await f.db(),
    accounts = (await db.prepare("SELECT * FROM account").all()).results;
  assert.equal(accounts.length, 1);
  for (const key of ["accessToken", "refreshToken", "idToken"])
    assert.equal(accounts[0][key], null);
  const sessions = (await db.prepare("SELECT * FROM session").all()).results;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].userId, accounts[0].userId);
  assert.ok(sessions[0].appBrowser);
  assert.equal(sessions[0].ipAddress, null);
  assert.equal(sessions[0].userAgent, null);
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM verification").first()).n,
    0,
  );
  await f.restart();
  assert.equal((await a.api("/api/auth/status")).value.authenticated, true);
  assert.equal((await a.api("/api/budget")).value.limitMilliYen, 500000);
});

test("verified Better Auth user/session IDs select isolated vaults; logout, expiry and cookie tampering deny access", async (t) => {
  const f = await fixture(t),
    a = f.browser(),
    b = f.browser();
  await a.api(f.callback(await f.start(a), "a"));
  await b.api(f.callback(await f.start(b), "b"));
  const acsrf = (await a.api("/api/session")).value.csrfToken,
    bcsrf = (await b.api("/api/session")).value.csrfToken;
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    model: "gpt-6-luna",
    key: "DUMMY-NOT-A-KEY-" + randomUUID(),
  };
  assert.equal(
    (await a.api("/api/credentials/openai", "POST", input, acsrf)).status,
    200,
  );
  assert.equal((await b.api("/api/credentials/openai")).value.state, "deleted");
  assert.equal(
    (
      await b.api(
        "/api/credentials/openai",
        "POST",
        { ...input, userId: "a" },
        bcsrf,
      )
    ).status,
    409,
  );
  assert.equal(
    (await b.api("/api/credentials/openai", "POST", input, acsrf)).status,
    403,
  );
  const cookieNames = [...a.jar.keys()].filter((k) =>
    k.includes("session_token"),
  );
  assert.equal(cookieNames.length, 1);
  const saved = new Map(a.jar);
  a.jar.set(cookieNames[0], "forged");
  assert.equal((await a.api("/api/budget")).status, 401);
  a.jar.clear();
  for (const [k, v] of saved) a.jar.set(k, v);
  const c = (await a.api("/api/auth/status")).value.csrfToken;
  assert.equal((await a.api("/api/auth/logout", "POST", {}, c)).status, 200);
  assert.equal((await a.api("/api/credentials/openai")).status, 401);
  for (const [k, v] of saved) a.jar.set(k, v);
  assert.equal((await a.api("/api/credentials/openai")).status, 401);
  assert.equal((await b.api("/api/budget")).status, 200);
  const db = await f.db();
  await db
    .prepare("UPDATE session SET expiresAt=?")
    .bind(Date.now() - 1)
    .run();
  assert.equal((await b.api("/api/budget")).status, 401);
});
test("origin, prelogin/vault CSRF, state, encrypted cookie and callback reuse are rejected", async (t) => {
  const f = await fixture(t),
    a = f.browser(),
    b = f.browser();
  const status = await a.api("/api/auth/status");
  assert.equal((await a.api("/api/auth/start", "POST", {}, "bad")).status, 503);
  assert.equal(
    (
      await a.api("/api/auth/start", "POST", {}, status.value.csrfToken, {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  const u = await f.start(a);
  await b.api("/api/auth/status");
  assert.equal(
    (await b.api(f.callback(u))).headers.get("location"),
    "/?auth=failed",
  );
  assert.equal(
    (await a.api(f.callback(u) + "&state=duplicate")).headers.get("location"),
    "/?auth=failed",
  );
  const outcomes = await Promise.all([
    a.api(f.callback(u)),
    a.api(f.callback(u)),
  ]);
  assert.deepEqual(outcomes.map((r) => r.headers.get("location")).sort(), [
    "/?auth=failed",
    "/?auth=success",
  ]);
  assert.equal(
    f.calls.filter((c) => c.code === "a|" + u.searchParams.get("state")).length,
    1,
  );
  const v = await f.start(b);
  const stateCookie = [...b.jar.keys()].find((k) => k.includes("oauth_state"));
  assert.ok(stateCookie);
  assert.ok(!b.jar.get(stateCookie).includes(v.searchParams.get("nonce")));
  b.jar.set(stateCookie, "tampered");
  assert.equal(
    (await b.api(f.callback(v, "b"))).headers.get("location"),
    "/?auth=failed",
  );
  assert.equal((await b.api("/api/auth/status")).value.authenticated, false);
});
test("nonce/issuer/audience/expiry/signature failures and redirect refusal never create sessions", async (t) => {
  const f = await fixture(t),
    a = f.browser();
  for (const behavior of [
    "bad-nonce",
    "bad-issuer",
    "bad-audience",
    "expired",
    "forged-signature",
    "redirect",
  ]) {
    f.behavior(behavior);
    const u = await f.start(a);
    assert.equal(
      (await a.api(f.callback(u))).headers.get("location"),
      "/?auth=failed",
      behavior,
    );
    assert.equal((await a.api("/api/auth/status")).value.authenticated, false);
  }
  assert.equal(
    (await (await f.db()).prepare("SELECT count(*) AS n FROM session").first())
      .n,
    0,
  );
  assert.ok(
    f.calls.every(
      (c) =>
        c.url === "https://oauth2.googleapis.com/token" ||
        c.url === "https://www.googleapis.com/oauth2/v3/certs",
    ),
  );
});
test("cancel and logout while code exchange is in flight prevent a late callback from creating a session", async (t) => {
  const f = await fixture(t),
    a = f.browser();
  for (const action of ["cancel", "logout"]) {
    const u = await f.start(a);
    f.behavior("wait");
    const signal = f.waitToken(),
      pending = a.api(f.callback(u));
    await signal;
    const csrf = (await a.api("/api/auth/status")).value.csrfToken;
    assert.equal(
      (await a.api("/api/auth/" + action, "POST", {}, csrf)).status,
      200,
    );
    f.release();
    assert.equal((await pending).headers.get("location"), "/?auth=failed");
    assert.equal((await a.api("/api/auth/status")).value.authenticated, false);
    assert.equal(
      (
        await (
          await f.db()
        )
          .prepare("SELECT count(*) AS n FROM session")
          .first()
      ).n,
      0,
    );
    f.behavior("ok");
  }
});
test("re-login, expired attempts and provider cancellation revoke old flows without retry", async (t) => {
  const f = await fixture(t),
    a = f.browser(),
    old = await f.start(a),
    next = await f.start(a);
  assert.equal(
    (await a.api(f.callback(old))).headers.get("location"),
    "/?auth=failed",
  );
  assert.equal(
    (
      await a.api(
        "/api/auth/callback/google?" +
          new URLSearchParams({
            state: next.searchParams.get("state"),
            error: "access_denied",
          }),
      )
    ).headers.get("location"),
    "/?auth=cancelled",
  );
  const expired = await f.start(a);
  await (
    await f.db()
  )
    .prepare("UPDATE app_auth_attempt SET expires=?")
    .bind(Date.now() - 1)
    .run();
  assert.equal(
    (await a.api(f.callback(expired))).headers.get("location"),
    "/?auth=failed",
  );
  const u = await f.start(a);
  await a.api(f.callback(u));
  const saved = new Map(a.jar);
  const newer = await f.start(a);
  assert.equal((await a.api("/api/budget")).status, 401);
  await a.api(f.callback(newer));
  for (const [k, v] of saved) a.jar.set(k, v);
  assert.equal((await a.api("/api/budget")).status, 401);
});
test("production rejects missing DB/secret/schema and cannot enable credentials or choose a test identity", async (t) => {
  for (const missing of [
    { BETTER_AUTH_SECRET: "" },
    { GOOGLE_CLIENT_ID: "" },
  ]) {
    const f = await fixture(t, { entry: "workers/index.mjs", missing }),
      a = f.browser();
    assert.equal((await a.api("/api/auth/status")).status, 503);
    assert.equal(
      (
        await a.api("/api/credentials/openai", "POST", {}, "fake", {
          "X-Test-Principal": "test-a",
        })
      ).status,
      503,
    );
    assert.equal(f.calls.length, 0);
  }
  const noSchema = await fixture(t, {
    entry: "workers/index.mjs",
    migrate: false,
  });
  assert.equal((await noSchema.browser().api("/api/auth/status")).status, 503);
  const f = await fixture(t, {
      entry: "workers/index.mjs",
      missing: { CREDENTIALS_ENABLED: "true", AUTH_MODE: "test" },
    }),
    a = f.browser();
  await a.api(f.callback(await f.start(a)));
  assert.equal(
    (
      await a.api(
        "/api/credentials/openai",
        "POST",
        {},
        (await a.api("/api/session")).value.csrfToken,
      )
    ).status,
    503,
  );
  assert.equal(f.script.includes("X-Test-Principal"), false);
});

test("current browser epoch is checked even if an old session row remains; DB failure never falls back to cookies", async (t) => {
  const f = await fixture(t),
    a = f.browser();
  await a.api(f.callback(await f.start(a)));
  const db = await f.db();
  await db.prepare("UPDATE app_auth_browser SET epoch=epoch+1").run();
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM session").first()).n,
    1,
  );
  assert.equal((await a.api("/api/credentials/openai")).status, 401);
  await db.exec("DROP TABLE session;");
  assert.equal((await a.api("/api/auth/status")).status, 503);
  assert.equal((await a.api("/api/budget")).status, 503);
});

test("D1 atomic browser start limit holds at 20 per minute across guard instances", async (t) => {
  const f = await fixture(t),
    a = f.browser();
  await a.api("/api/auth/status");
  const db = await f.db(),
    c = await db.prepare("SELECT * FROM app_auth_browser").first();
  const { AuthGuard } = await import("../../workers/auth-guard.mjs");
  for (let i = 0; i < 20; i++)
    await new AuthGuard(db).advance(c.id, c.csrf, true);
  await assert.rejects(new AuthGuard(db).advance(c.id, c.csrf, true));
  assert.equal(
    (await db.prepare("SELECT starts FROM app_auth_browser").first()).starts,
    20,
  );
});

test("production owner-only login accepts only the configured verified Google email before provisioning", async (t) => {
  const f = await fixture(t, { entry: "workers/index.mjs" }),
    a = f.browser(),
    other = f.browser();
  const own = await f.start(a);
  assert.equal(
    (await a.api(f.callback(own))).headers.get("location"),
    "/?auth=success",
  );
  const denied = await f.start(other);
  assert.equal(
    (await other.api(f.callback(denied, "b"))).headers.get("location"),
    "/?auth=failed",
  );
  assert.equal(
    (await other.api("/api/auth/status")).value.authenticated,
    false,
  );
  const db = await f.db();
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM user").first()).n,
    1,
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM account").first()).n,
    1,
  );
  const status = await other.api("/api/auth/status");
  assert.equal(
    (
      await other.api(
        "/api/auth/start",
        "POST",
        { userId: "owner", email: "a@example.test", emailVerified: true },
        status.value.csrfToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await other.api("/api/budget", "GET", undefined, undefined, {
        "X-User-ID": "owner",
        "X-Test-Principal": "test-a",
      })
    ).status,
    401,
  );
  f.behavior("unverified-email");
  const wrong = await f.start(other);
  assert.equal(
    (await other.api(f.callback(wrong, "a"))).headers.get("location"),
    "/?auth=failed",
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM session").first()).n,
    1,
  );
  await db.prepare("UPDATE user SET emailVerified=0").run();
  assert.equal((await a.api("/api/budget")).status, 401);
});
test("missing owner configuration fails closed and a stored email mismatch denies an existing session", async (t) => {
  const unset = await fixture(t, {
    entry: "workers/index.mjs",
    missing: { GOOGLE_ALLOWED_EMAIL: "" },
  });
  assert.equal((await unset.browser().api("/api/auth/status")).status, 503);
  assert.equal(unset.calls.length, 0);
  const f = await fixture(t, { entry: "workers/index.mjs" }),
    a = f.browser();
  await a.api(f.callback(await f.start(a)));
  const db = await f.db();
  await db.prepare("UPDATE user SET email=?").bind("other@example.test").run();
  assert.equal((await a.api("/api/credentials/openai")).status, 401);
});

test("private Dev exposes only a pending login page when unconfigured, blocks assets/history/BYOK, and never returns reader content", async (t) => {
  const f = await fixture(t, {
      entry: "workers/index.mjs",
      missing: { PRIVATE_DEV: "true", BETTER_AUTH_SECRET: "" },
    }),
    a = f.browser();
  const page = await a.api("/");
  assert.equal(page.status, 200);
  assert.match(page.value, /Quilna/);
  assert.match(page.value, /設定準備中/);
  assert.match(page.value, /<button id="login" disabled/);
  assert.ok(!page.value.includes("PRIVATE-READER-ASSET"));
  assert.match(
    page.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  for (const path of ["/assets/app.js", "/index.html"])
    assert.equal((await a.api(path)).status, 401);
  for (const path of [
    "/api/session",
    "/api/credentials/openai",
    "/api/history",
  ])
    assert.equal((await a.api(path)).status, 503);
  assert.equal(f.calls.length, 0);
});
test("private Dev serves no-store reader assets only to the verified owner and blocks them after logout", async (t) => {
  const f = await fixture(t, {
      entry: "workers/index.mjs",
      missing: { PRIVATE_DEV: "true" },
    }),
    a = f.browser();
  assert.ok(!(await a.api("/")).value.includes("PRIVATE-READER-ASSET"));
  await a.api(f.callback(await f.start(a)));
  const page = await a.api("/");
  assert.match(page.value, /PRIVATE-READER-ASSET/);
  assert.match(page.value, /private-dev/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.ok(!page.headers.get("content-security-policy").includes("unsafe-inline"));
  const cached = await a.api("/not-modified");
  assert.equal(cached.status, 304);
  assert.equal(cached.value, "");
  const head = await a.api("/", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.value, "");
  const csrf = (await a.api("/api/auth/status")).value.csrfToken;
  await a.api("/api/auth/logout", "POST", {}, csrf);
  assert.ok(!(await a.api("/")).value.includes("PRIVATE-READER-ASSET"));
  assert.equal((await a.api("/assets/app.js")).status, 401);
});

test("real verified sessions gate shared document reuse and logout during acquisition suppresses delivery", { timeout: 20000 }, async (t) => {
  let enter,
    release,
    slow = false;
  const entered = new Promise((r) => {
      enter = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  t.after(() => release());
  const f = await fixture(t, {
      documents: true,
      articleResponse: async (request) => {
        assert.equal(request.headers.get("Cookie"), null);
        if (slow) {
          enter();
          await gate;
        }
        return new Response(
          "<article><h1>Verified source</h1><p>" +
            "Original source evidence. ".repeat(20) +
            "</p></article>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    }),
    a = f.browser(),
    b = f.browser(),
    anon = f.browser();
  await a.api(f.callback(await f.start(a), "a"));
  await b.api(f.callback(await f.start(b), "b"));
  const acsrf = (await a.api("/api/session")).value.csrfToken;
  const bcsrf = (await b.api("/api/session")).value.csrfToken;
  const astatus = await a.api("/api/documents/status"),
    bstatus = await b.api("/api/documents/status");
  assert.equal(astatus.value.enabled, true);
  assert.notEqual(astatus.value.account, bstatus.value.account);
  const url = "https://publisher.example.org/article",
    body = { url, audience: "shared" };
  assert.equal(
    (await anon.api("/api/documents/acquire", "POST", body, acsrf)).status,
    401,
  );
  assert.equal(
    (await b.api("/api/documents/acquire", "POST", body, acsrf)).status,
    403,
  );
  const db = await f.documentDB(),
    id = randomUUID();
  await db
    .prepare("INSERT INTO document_policies VALUES(?,?,1,1,?,?)")
    .bind(
      id,
      url,
      Date.now() + 3600000,
      "Synthetic publisher explicitly permits test reuse",
    )
    .run();
  for (const account of [astatus.value.account, bstatus.value.account])
    await db
      .prepare("INSERT INTO document_members VALUES(?,?)")
      .bind(id, account)
      .run();
  const first = await a.api("/api/documents/acquire", "POST", body, acsrf);
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const second = await b.api("/api/documents/acquire", "POST", body, bcsrf);
  assert.deepEqual(second.value.version, first.value.version);
  assert.equal(f.calls.filter((c) => c.url === url).length, 1);
  slow = true;
  const pending = a.api(
    "/api/documents/acquire",
    "POST",
    { ...body, force: true },
    acsrf,
  );
  await entered;
  const logoutCsrf = (await a.api("/api/auth/status")).value.csrfToken;
  assert.equal(
    (await a.api("/api/auth/logout", "POST", {}, logoutCsrf)).status,
    200,
  );
  release();
  const ended = await pending;
  assert.equal(ended.status, 401);
  assert.equal(ended.value.version, undefined);
  assert.equal(
    (await b.api("/api/documents/read", "POST", body, bcsrf)).status,
    200,
  );
});
