import test from "node:test";
import assert from "node:assert/strict";
import { libraryStatus } from "../../workers/library-status.mjs";
import { createHandler } from "../../workers/http.mjs";
import { hash } from "../../workers/crypto.mjs";

const origin = "https://app.test";
const alice = {
  subject: "better-auth:synthetic-alice",
  sessionId: "session-a",
};
const bob = { subject: "better-auth:synthetic-bob", sessionId: "session-b" };
const owner = await hash(alice.subject);
const env = {
  APP_ORIGIN: origin,
  LIBRARY_ISOLATION_ENABLED: "true",
  LIBRARY_LEGACY_OWNER_HASH: owner,
};
const request = (options = {}, suffix = "") =>
  new Request(origin + "/api/library/status" + suffix, {
    ...options,
    headers: { Origin: origin, ...options.headers },
  });

test("library assignment returns only the verified account hash and explicit legacy ownership", async () => {
  for (const [principal, legacy] of [
    [alice, true],
    [bob, false],
  ]) {
    let checks = 0;
    const account = await hash(principal.subject);
    const r = await libraryStatus(
      request({ headers: { "X-Library-Account": account } }),
      env,
      async () => {
        checks++;
        return principal;
      },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { schema: 1, account, legacy });
    assert.equal(checks, 2);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal(r.headers.get("set-cookie"), null);
  }
});

test("library route stays disabled by default and missing configuration never falls back to a shared account", async () => {
  const handler = createHandler();
  for (const flag of [undefined, "false", "TRUE", "1", true]) {
    const r = await handler(request(), {
      ...env,
      LIBRARY_ISOLATION_ENABLED: flag,
    });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { status: "not-found" });
  }
  assert.equal((await handler(request(), env)).status, 503);
  for (const legacy of [
    undefined,
    "",
    " " + owner,
    owner.toUpperCase(),
    "a".repeat(63),
    "a".repeat(65),
    "z".repeat(64),
    true,
  ]) {
    let checks = 0;
    const r = await libraryStatus(
      request(),
      { ...env, LIBRARY_LEGACY_OWNER_HASH: legacy },
      async () => {
        checks++;
        return alice;
      },
    );
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { status: "library-unconfigured" });
    assert.equal(checks, 0);
  }
});

test("library status enforces same-origin GET without query or account overrides", async () => {
  const denied = [
    request({ headers: { Origin: "https://other.test" } }),
    request({ headers: { Origin: "null" } }),
    new Request(origin + "/api/library/status"),
    new Request(origin + "/api/library/status", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    }),
    new Request("https://other.test/api/library/status", {
      headers: { Origin: origin },
    }),
    request({}, "?account=" + owner),
    request({}, "?legacy=true"),
  ];
  for (const input of denied) {
    let calls = 0;
    const r = await libraryStatus(input, env, async () => {
      calls++;
      return alice;
    });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { status: "forbidden" });
    assert.equal(calls, 0);
  }
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
    assert.equal(
      (await libraryStatus(request({ method }), env, async () => alice)).status,
      405,
    );
  const read = new Request(origin + "/api/library/status", {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal((await libraryStatus(read, env, async () => alice)).status, 200);
  for (const expected of [
    "",
    "forged",
    await hash(bob.subject),
    owner.toUpperCase(),
  ]) {
    const r = await libraryStatus(
      request({ headers: { "X-Library-Account": expected } }),
      env,
      async () => alice,
    );
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { status: "account-mismatch" });
  }
});

test("library status withholds identity after logout, expiry, account/session replacement and authenticator failure", async () => {
  for (const after of [
    null,
    bob,
    { ...alice, sessionId: "replacement" },
    {},
    { ...alice, extra: "untrusted" },
  ]) {
    let checks = 0;
    const r = await libraryStatus(request(), env, async () =>
      ++checks === 1 ? alice : after,
    );
    assert.equal(r.status, after?.subject && !after.extra ? 403 : 401);
    const body = await r.json();
    assert.equal(Object.hasOwn(body, "account"), false);
    assert.equal(Object.hasOwn(body, "legacy"), false);
    assert.equal(checks, 2);
  }
  for (const before of [
    null,
    {},
    { ...alice, sessionId: "" },
    { ...alice, subject: "a".repeat(301) },
    { ...alice, legacy: true },
  ]) {
    const r = await libraryStatus(request(), env, async () => before);
    assert.equal(r.status, 401);
  }
  for (const failingCheck of [1, 2]) {
    let checks = 0;
    const r = await libraryStatus(request(), env, async () => {
      if (++checks === failingCheck) throw Error("sensitive internal error");
      return alice;
    });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { status: "library-unavailable" });
  }
});

test("library status route does not access account vaults, documents or browser content", async () => {
  const forbiddenBindings = new Proxy(env, {
    get(target, key) {
      if (
        ["ACCOUNTS", "DOCUMENTS", "DOCUMENT_ACCESS_DB", "ASSETS"].includes(key)
      )
        throw Error("unrelated storage access");
      return target[key];
    },
  });
  const r = await createHandler({ authenticate: async () => alice })(
    request(),
    forbiddenBindings,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { schema: 1, account: owner, legacy: true });
});
