import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { encode } from "../../workers/crypto.mjs";
export const authFixtureOrigin = "https://app.test";
const ring = () =>
  JSON.stringify({
    active: "test",
    keys: { test: encode(crypto.getRandomValues(new Uint8Array(32))) },
  });
export async function authWorkerFixture(
  t,
  {
    entry = "tests/workers/better-auth-entry.mjs",
    missing = {},
    migrate = true,
    documents = false,
    documentManagement = false,
    articleResponse,
    sourceResponses = {},
    origin = authFixtureOrigin,
    server = {},
    assets,
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
    ...server,
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
      ASSETS:
        assets ??
        (async (request) =>
          new URL(request.url).pathname === "/not-modified"
            ? new Response(null, {
                status: 304,
                headers: { "Content-Type": "text/html" },
              })
            : new Response(
                "<!doctype html><html><head></head><body>PRIVATE-READER-ASSET</body></html>",
                { headers: { "Content-Type": "text/html" } },
              )),
    },
    outboundService: async (request) => {
      const u = new URL(request.url);
      calls.push({ url: u.href });
      if (Object.hasOwn(sourceResponses, u.href))
        return sourceResponses[u.href](request);
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
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
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
    for (const file of [
      "0001_access.sql",
      "0002_source_aliases.sql",
      ...(documentManagement
        ? ["0003_policy_management.sql", "0004_policy_history.sql"]
        : []),
    ])
      await (
        await mf.getD1Database("DOCUMENT_ACCESS_DB")
      ).exec(
        (await readFile("migrations/documents/" + file, "utf8"))
          .replace(/^--.*$/gm, "")
          .replaceAll("\n", " "),
      );
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
  const rememberAuthorization = (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.pathname, "/o/oauth2/v2/auth");
    flows.set(url.searchParams.get("state"), {
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
    });
    return url;
  };
  const start = async (b) => {
    const s = await b.api("/api/auth/status");
    assert.equal(s.status, 200, JSON.stringify(s.value));
    const r = await b.api("/api/auth/start", "POST", {}, s.value.csrfToken);
    assert.equal(r.status, 200, JSON.stringify(r.value));
    const url = rememberAuthorization(r.value.authorizationUrl);
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
    ready: () => mf.ready,
    rememberAuthorization,
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
    restart: async (documentAdmin) => {
      if (documentAdmin !== undefined) {
        assert.match(documentAdmin, /^[a-f0-9]{64}$/);
        assert.equal(documentManagement, true);
        config.bindings.DOCUMENT_ADMIN_ENABLED = "true";
        config.bindings.DOCUMENT_ADMIN_OWNER_HASH = documentAdmin;
      }
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(config));
      await mf.ready;
    },
  };
}
