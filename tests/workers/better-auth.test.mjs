import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { encode } from "../../workers/crypto.mjs";
const origin = "https://app.test";
const ring = () =>
  JSON.stringify({
    active: "test",
    keys: { test: encode(crypto.getRandomValues(new Uint8Array(32))) },
  });
async function fixture(
  t,
  {
    entry = "tests/workers/better-auth-entry.mjs",
    missing = {},
    migrate = true,
    documents = false,
    articleResponse,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "textbook-better-auth-"));
  const script = (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "esm",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const wrong = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "ephemeral-test",
    alg: "RS256",
    use: "sig",
  };
  const flows = new Map(),
    calls = [];
  let release, waiting;
  let behavior = "ok";
  const config = {
    modules: true,
    script,
    compatibilityDate: "2026-10-11",
    compatibilityFlags: [],
    resourcePersistencePath: dir,
    durableObjects: {
      ACCOUNTS: { className: "AccountVault", useSQLite: true },
      ...(documents
        ? { DOCUMENTS: { className: "SourceDocument", useSQLite: true } }
        : {}),
    },
    d1Databases: {
      AUTH_DB: "offline-auth",
      ...(documents ? { DOCUMENT_ACCESS_DB: "document-access" } : {}),
    },
    bindings: {
      APP_ORIGIN: origin,
      ...(documents ? { DOCUMENTS_ENABLED: "true" } : {}),
      GOOGLE_CLIENT_ID: "dummy.apps.googleusercontent.com",
      GOOGLE_ALLOWED_EMAIL: "a@example.test",
      GOOGLE_CLIENT_SECRET: "DUMMY-GOOGLE-UNUSABLE-" + randomUUID(),
      BETTER_AUTH_SECRET: "DUMMY-UNUSABLE-" + randomUUID(),
      BYOK_ENCRYPTION_KEYRING: ring(),
      ...missing,
    },
    serviceBindings: {
      ASSETS: async (request) =>
        new URL(request.url).pathname === "/not-modified"
          ? new Response(null, { status: 304, headers: { "Content-Type": "text/html" } })
          : new Response(
          "<!doctype html><html><head></head><body>PRIVATE-READER-ASSET</body></html>",
          { headers: { "Content-Type": "text/html" } },
        ),
    },
    outboundService: async (request) => {
      const u = new URL(request.url);
      calls.push({ url: u.href });
      if (documents && u.href === "https://publisher.example.org/article")
        return articleResponse(request);
      if (u.href === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });
      if (u.href !== "https://oauth2.googleapis.com/token")
        throw Error("unexpected outbound (never live)");
      const body = new URLSearchParams(await request.text()),
        [owner, state] = body.get("code").split("|"),
        flow = flows.get(state);
      calls.at(-1).code = body.get("code");
      if (
        !flow ||
        createHash("sha256")
          .update(body.get("code_verifier"))
          .digest("base64url") !== flow.challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (behavior === "wait") {
        waiting?.();
        await new Promise((r) => {
          release = r;
        });
      }
      if (behavior === "redirect")
        return new Response("", {
          status: 302,
          headers: { Location: "https://evil.test" },
        });
      const now = Math.floor(Date.now() / 1000),
        nonce = behavior === "bad-nonce" ? "wrong" : flow.nonce;
      const id = await new SignJWT({
        sub: "dummy-" + owner,
        email:
          behavior === "claim-owner-email"
            ? "a@example.test"
            : owner + "@example.test",
        email_verified: behavior !== "unverified-email",
        nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "ephemeral-test" })
        .setIssuer(
          behavior === "bad-issuer"
            ? "https://evil.test"
            : "https://accounts.google.com",
        )
        .setAudience(
          behavior === "bad-audience"
            ? "wrong"
            : config.bindings.GOOGLE_CLIENT_ID,
        )
        .setIssuedAt(now)
        .setExpirationTime(behavior === "expired" ? now - 1 : now + 3600)
        .sign(behavior === "forged-signature" ? wrong.privateKey : privateKey);
      return Response.json({
        access_token: "DUMMY-ACCESS-MUST-NOT-PERSIST",
        refresh_token: "DUMMY-REFRESH-MUST-NOT-PERSIST",
        id_token: id,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email",
      });
    },
  };
  let mf = new Miniflare(convertV4MiniflareOptions(config));
  const db = () => mf.getD1Database("AUTH_DB");
  if (migrate) {
    const d = await db();
    for (const file of ["0001_better_auth.sql", "0002_app_guard.sql"])
      await d.exec(
        (await readFile("migrations/auth/" + file, "utf8")).replaceAll(
          "\n",
          " ",
        ),
      );
  }
  if (documents)
    await (
      await mf.getD1Database("DOCUMENT_ACCESS_DB")
    ).exec(
      (await readFile("migrations/documents/0001_access.sql", "utf8"))
        .replace(/^--.*$/gm, "")
        .replaceAll("\n", " "),
    );
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const browser = () => {
    const jar = new Map();
    return {
      jar,
      async api(path, method = "GET", body, csrf, headers = {}) {
        const r = await mf.dispatchFetch(origin + path, {
          method,
          redirect: "manual",
          headers: {
            Origin: origin,
            Cookie: [...jar]
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v}`)
              .join("; "),
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(csrf ? { "X-CSRF-Token": csrf } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        for (const cookie of r.headers.getSetCookie()) {
          const pair = cookie.split(";")[0],
            i = pair.indexOf("=");
          jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return {
          status: r.status,
          value: r.headers.get("Content-Type")?.includes("application/json")
            ? await r.json()
            : await r.text(),
          headers: r.headers,
        };
      },
    };
  };
  const start = async (b) => {
    const s = await b.api("/api/auth/status");
    assert.equal(s.status, 200, JSON.stringify(s.value));
    const r = await b.api("/api/auth/start", "POST", {}, s.value.csrfToken);
    assert.equal(r.status, 200, JSON.stringify(r.value));
    const url = new URL(r.value.authorizationUrl);
    flows.set(url.searchParams.get("state"), {
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
    });
    return url;
  };
  const callback = (u, owner = "a") =>
    "/api/auth/callback/google?" +
    new URLSearchParams({
      state: u.searchParams.get("state"),
      code: owner + "|" + u.searchParams.get("state"),
    });
  return {
    db,
    documentDB: () => mf.getD1Database("DOCUMENT_ACCESS_DB"),
    browser,
    start,
    callback,
    calls,
    script,
    behavior: (v) => {
      behavior = v;
    },
    waitToken: () =>
      new Promise((r) => {
        waiting = r;
      }),
    release: () => release?.(),
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(config));
    },
  };
}
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
