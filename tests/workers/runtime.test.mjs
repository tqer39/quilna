import {
  topicCapabilitiesSchema,
  topicGenerationReplySchema,
  topicQuoteSchema,
} from "../../src/topic-generation-protocol.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { encode, hash } from "../../workers/crypto.mjs";
async function bundle(entry) {
  return (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    })
  ).outputFiles[0].text;
}
const origin = "http://app.test";
const ring = () =>
  JSON.stringify({
    active: "test-v1",
    keys: { "test-v1": encode(crypto.getRandomValues(new Uint8Array(32))) },
  });
async function fixture(
  t,
  entry = "tests/workers/fixture-entry.mjs",
  extra = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "textbook-workers-test-"));
  const script = await bundle(entry);
  let outbound = 0;
  const config = {
    modules: true,
    script,
    compatibilityDate: "2026-10-11",
    durableObjects: {
      ACCOUNTS: { className: "AccountVault", useSQLite: true },
    },
    resourcePersistencePath: dir,
    d1Databases: { AUTH_DB: "runtime-auth" },
    bindings: {
      APP_ORIGIN: origin,
      BYOK_ENCRYPTION_KEYRING: ring(),
      GOOGLE_ALLOWED_EMAIL: "admin@example.test",
    },
    outboundService: () => {
      outbound++;
      throw Error("external network forbidden in tests");
    },
    ...extra,
  };
  let mf = new Miniflare(convertV4MiniflareOptions(config));
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
    .bind("test-a", "Admin", "admin@example.test", 1, 0, 0)
    .run();
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const api = async (
    path,
    { user = "test-a", method = "GET", body, csrf, headers = {} } = {},
  ) => {
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        "X-Test-Principal": user,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    return { status: response.status, value, headers: response.headers };
  };
  return {
    api,
    script,
    outbound: () => outbound,
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(config));
    },
  };
}
const command = (expectedRevision = 0) => ({
  requestId: randomUUID(),
  expectedRevision,
  key: `DUMMY-ONLY-${randomUUID()}`,
  model: "gpt-6-luna",
});
test("production bundle stays auth-unconfigured despite forged principal/session/key flags", async (t) => {
  const f = await fixture(t, "workers/index.mjs", {
    bindings: {
      APP_ORIGIN: origin,
      BYOK_ENCRYPTION_KEYRING: ring(),
      AUTH_MODE: "test",
      CREDENTIALS_ENABLED: "true",
    },
  });
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const result = await f.api("/api/credentials/openai", {
      method,
      body: method === "GET" ? undefined : command(),
      csrf: "forged",
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.value, {
      status: "auth-unconfigured",
      realKeyInputEnabled: false,
    });
    assert.equal(JSON.stringify(result).includes("DUMMY-ONLY"), false);
  }
  assert.equal(f.script.includes("X-Test-Principal"), false);
  assert.equal(f.script.includes("X-Test-Principal"), false);
  assert.equal(f.outbound(), 0);
});
test("actual local SQLite DO CRUD separates users/providers, rejects ownership injection, persists and deletes without secret responses", async (t) => {
  const f = await fixture(t);
  const session = await f.api("/api/session");
  const csrf = session.value.csrfToken;
  const bSession = await f.api("/api/session", { user: "test-b" });
  const data = command();
  const first = await f.api("/api/credentials/openai", {
    method: "POST",
    body: data,
    csrf,
  });
  assert.equal(first.status, 200);
  assert.equal(first.value.revision, 1);
  assert.equal(first.value.connection, "unconnected");
  assert.equal(JSON.stringify(first).includes(data.key), false);
  assert.equal(JSON.stringify(first).includes("ciphertext"), false);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(
    (await f.api("/api/credentials/openai", { user: "test-b" })).value.state,
    "deleted",
  );
  assert.equal(
    (await f.api("/api/credentials/anthropic")).value.state,
    "deleted",
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        user: "test-b",
        method: "PUT",
        body: command(1),
        csrf: bSession.value.csrfToken,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "PUT",
        body: { ...command(1), owner: "test-b" },
        csrf,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "PUT",
        body: command(1),
        csrf: bSession.value.csrfToken,
      })
    ).status,
    403,
  );
  await f.restart();
  assert.equal((await f.api("/api/credentials/openai")).value.revision, 1);
  const results = await Promise.all([
    f.api("/api/credentials/openai", { method: "PUT", body: command(1), csrf }),
    f.api("/api/credentials/openai", { method: "PUT", body: command(1), csrf }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "DELETE",
        body: { requestId: randomUUID(), expectedRevision: 2 },
        csrf,
      })
    ).value.state,
    "deleted",
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: data,
        csrf,
      })
    ).value.state,
    "deleted",
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: command(3),
        csrf,
      })
    ).value.revision,
    4,
  );
  assert.equal((await f.api("/api/budget")).value.limitMilliYen, 500000);
  assert.equal(
    (await f.api("/api/budget", { user: "test-b" })).value.limitMilliYen,
    500000,
  );
  assert.equal(f.outbound(), 0);
});
test("missing encryption, unauthenticated, bad origin/CSRF/body size never saves a dummy credential", async (t) => {
  const f = await fixture(t, undefined, { bindings: { APP_ORIGIN: origin } });
  const csrf = (await f.api("/api/session")).value.csrfToken;
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: command(),
        csrf,
      })
    ).value.status,
    "encryption-unconfigured",
  );
  assert.equal((await f.api("/api/credentials/openai")).value.state, "deleted");
  assert.equal(
    (await f.api("/api/credentials/openai", { user: "unknown" })).status,
    401,
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        headers: { Origin: "http://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: command(),
        csrf: "bad",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: { ...command(), key: "x".repeat(40000) },
        csrf,
      })
    ).status,
    503,
  );
  assert.equal(f.outbound(), 0);
});
const proposal = (modelId, question = "公開CAA質問") => ({
  requestId: randomUUID(),
  bookId: "caa",
  version: "1.8",
  blockId: "read",
  question,
  excerpt: "CAA",
  purpose: "book-addition",
  modelId,
  sourceIds: ["rfc8659"],
  approvedPublicText: true,
});
test("SQLite per-user budgets combine providers, preserve unknown reservations after deletion and restart, and do not cap all users together", async (t) => {
  const f = await fixture(t);
  const csrf = (await f.api("/api/session")).value.csrfToken;
  const bCsrf = (await f.api("/api/session", { user: "test-b" })).value
    .csrfToken;
  await f.api("/api/credentials/openai", {
    method: "POST",
    body: command(),
    csrf,
  });
  await f.api("/api/credentials/anthropic", {
    method: "POST",
    body: { ...command(), model: "claude-haiku-5-5" },
    csrf,
  });
  const first = await f.api("/api/proposals", {
    method: "POST",
    body: proposal("openai-luna-candidate"),
    csrf,
  });
  assert.equal(first.value.status, "complete");
  assert.equal(
    (
      await f.api("/api/proposals", {
        method: "POST",
        body: proposal("anthropic-haiku-candidate"),
        csrf,
      })
    ).value.status,
    "complete",
  );
  assert.equal(
    (
      await f.api("/api/proposals", {
        method: "POST",
        body: proposal("anthropic-haiku-candidate"),
        csrf,
      })
    ).value.status,
    "budget-exhausted",
  );
  assert.equal(
    (await f.api("/api/budget", { user: "test-b" })).value.spentMilliYen,
    0,
  );
  await f.api("/api/credentials/openai", {
    user: "test-b",
    method: "POST",
    body: command(),
    csrf: bCsrf,
  });
  assert.equal(
    (
      await f.api("/api/proposals", {
        user: "test-b",
        method: "POST",
        body: proposal("openai-luna-candidate"),
        csrf: bCsrf,
      })
    ).value.status,
    "complete",
  );
  const waiting = await f.api("/api/proposals", {
    user: "test-b",
    method: "POST",
    body: proposal("openai-luna-candidate", "WAIT-MOCK"),
    csrf: bCsrf,
  });
  assert.equal(waiting.value.status, "unknown");
  await f.api("/api/credentials/openai", {
    user: "test-b",
    method: "DELETE",
    body: { requestId: randomUUID(), expectedRevision: 1 },
    csrf: bCsrf,
  });
  await f.restart();
  const held = await f.api("/api/budget", { user: "test-b" });
  assert.ok(held.value.heldMilliYen > 0);
  await f.api("/api/credentials/openai", {
    user: "test-b",
    method: "POST",
    body: command(2),
    csrf: bCsrf,
  });
  assert.equal(
    (
      await f.api("/api/proposals", {
        user: "test-b",
        method: "POST",
        body: proposal("openai-luna-candidate"),
        csrf: bCsrf,
      })
    ).value.status,
    "busy",
  );
  assert.equal(f.outbound(), 0);
});
test("connection check consumes the same per-user budget and stale credential versions cannot be checked", async (t) => {
  const f = await fixture(t);
  const csrf = (await f.api("/api/session")).value.csrfToken;
  await f.api("/api/credentials/openai", {
    method: "POST",
    body: command(),
    csrf,
  });
  const body = {
    requestId: randomUUID(),
    expectedRevision: 1,
    approvedPublicText: true,
  };
  const result = await f.api("/api/credentials/openai/check", {
    method: "POST",
    body,
    csrf,
  });
  assert.equal(result.status, 200);
  assert.equal(result.value.checked, true);
  assert.equal(result.value.connection, "unconnected");
  assert.ok((await f.api("/api/budget")).value.spentMilliYen > 0);
  const spent = (await f.api("/api/budget")).value.spentMilliYen;
  await f.api("/api/credentials/openai/check", { method: "POST", body, csrf });
  assert.equal((await f.api("/api/budget")).value.spentMilliYen, spent);
  await f.api("/api/credentials/openai", {
    method: "PUT",
    body: command(1),
    csrf,
  });
  assert.equal(
    (
      await f.api("/api/credentials/openai/check", {
        method: "POST",
        body,
        csrf,
      })
    ).status,
    409,
  );
  assert.equal((await f.api("/api/credentials/openai")).value.checked, false);
  assert.equal(f.outbound(), 0);
});
test("same-origin browser GET without Origin works only with Fetch Metadata; cross-site reads are denied", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.api("/api/session", {
        headers: { Origin: "", "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  const handler = await import("../../workers/http.mjs");
  let delegated = 0;
  const env = {
    APP_ORIGIN: origin,
    ACCOUNTS: {
      idFromName: () => "owner",
      get: () => ({
        fetch: async () => {
          delegated++;
          return new Response("{}");
        },
      }),
    },
  };
  const fetch = handler.createHandler({
    authenticate: async () => ({
      subject: "verified-test",
      sessionId: "test-session",
    }),
  });
  assert.equal(
    (
      await fetch(
        new Request(origin + "/api/session", {
          headers: { "Sec-Fetch-Site": "same-origin" },
        }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(
        new Request(origin + "/api/session", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(delegated, 1);
});
const topicFile = JSON.parse(
  await readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
    "utf8",
  ),
);
const topicFileRecord = JSON.parse(
  Buffer.from(topicFile.record, "base64").toString("utf8"),
);
const topicRequestRaw = Buffer.from(topicFileRecord.request, "base64").toString(
  "utf8",
);
const topicInput = () => ({
  requestId: JSON.parse(topicRequestRaw).id,
  requestRaw: topicRequestRaw,
  purpose: "book-addition",
  modelId: "openai-luna-candidate",
  approvedPublicText: true,
});
async function approveTopic(f, input, user = "test-a") {
  const account = await hash(`better-auth:${user}`);
  const response = await f.api("/api/topic-textbooks/status", {
    user,
    headers: { "X-Library-Account": account },
  });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  topicCapabilitiesSchema.parse(response.value);
  const quote = response.value.quotes.find(
    (q) => q.modelId === input.modelId && q.purpose === input.purpose,
  );
  assert.ok(quote, JSON.stringify(response.value));
  topicQuoteSchema.parse(quote);
  return {
    ...input,
    approvedMaxMilliYen: quote.maxMilliYen,
    approvedQuoteDigest: quote.quoteDigest,
  };
}
test("テーマの実SQLite台帳とHTTPで生成・検証・再起動・キー削除後の照会を保持する", async (t) => {
  const f = await fixture(t),
    account = await hash("better-auth:test-a");
  const csrf = (await f.api("/api/session")).value.csrfToken;
  const key = command();
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: key,
        csrf,
      })
    ).status,
    200,
  );
  const call = (path, body) =>
    f.api(`/api/topic-textbooks/${path}`, {
      method: "POST",
      body,
      csrf,
      headers: { "X-Library-Account": account },
    });
  const input = await approveTopic(f, topicInput()),
    generated = await call("proposals", input);
  assert.equal(generated.status, 200, JSON.stringify(generated.value));
  assert.equal(
    generated.value.status,
    "complete",
    JSON.stringify(generated.value),
  );
  topicGenerationReplySchema.parse(generated.value);
  assert.equal(generated.value.account, account);
  assert.equal(generated.value.draft.kind, "topic-textbook-draft");
  assert.ok(Buffer.byteLength(JSON.stringify(generated.value)) > 20000);
  assert.equal(JSON.stringify(generated.value).includes(key.key), false);
  assert.equal(JSON.stringify(generated.value).includes("ciphertext"), false);
  assert.equal(generated.headers.get("cache-control"), "no-store");
  const reviewInput = await approveTopic(f, {
    ...input,
    requestId: randomUUID(),
    purpose: "evidence-check",
    generationRequestId: input.requestId,
    generatorInvocation: generated.value.draft.invocation.id,
    draftRaw: generated.value.draft.json,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(reviewInput)) > 32768);
  const reviewed = await call("proposals", reviewInput);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.value));
  assert.equal(
    reviewed.value.status,
    "complete",
    JSON.stringify(reviewed.value),
  );
  topicGenerationReplySchema.parse(reviewed.value);
  topicGenerationReplySchema.parse(
    (await call("operations", reviewInput)).value,
  );
  assert.equal(reviewed.value.draft.allChecksPassed, true);
  const before = (await f.api("/api/budget")).value;
  assert.ok(before.spentMilliYen > 0);
  assert.equal(before.heldMilliYen, 0);
  assert.deepEqual((await call("proposals", input)).value, generated.value);
  assert.deepEqual(
    (await call("proposals", reviewInput)).value,
    reviewed.value,
  );
  assert.deepEqual((await f.api("/api/budget")).value, before);
  await f.restart();
  assert.deepEqual((await call("operations", input)).value, generated.value);
  assert.deepEqual(
    (await call("operations", reviewInput)).value,
    reviewed.value,
  );
  assert.deepEqual((await f.api("/api/budget")).value, before);
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "DELETE",
        csrf,
        body: { requestId: randomUUID(), expectedRevision: 1 },
      })
    ).status,
    200,
  );
  assert.equal((await call("proposals", input)).value.status, "unconnected");
  assert.deepEqual((await call("operations", input)).value, generated.value);
  await f.restart();
  assert.deepEqual(
    (await call("operations", reviewInput)).value,
    reviewed.value,
  );
  assert.equal(f.outbound(), 0);
});
test("別の利用者のテーマ候補を照会・検証せず予算と操作を分離する", async (t) => {
  const f = await fixture(t),
    input = topicInput();
  const sessions = {};
  for (const user of ["test-a", "test-b"]) {
    sessions[user] = {
      csrf: (await f.api("/api/session", { user })).value.csrfToken,
      account: await hash(`better-auth:${user}`),
    };
    assert.equal(
      (
        await f.api("/api/credentials/openai", {
          user,
          method: "POST",
          body: command(),
          csrf: sessions[user].csrf,
        })
      ).status,
      200,
    );
  }
  const call = (user, path, body) =>
    f.api(`/api/topic-textbooks/${path}`, {
      user,
      method: "POST",
      body,
      csrf: sessions[user].csrf,
      headers: { "X-Library-Account": sessions[user].account },
    });
  const approvedInput = await approveTopic(f, input);
  const a = (await call("test-a", "proposals", approvedInput)).value;
  assert.equal(a.status, "complete");
  assert.equal(
    (await call("test-b", "operations", input)).value.status,
    "not-found",
  );
  const rejected = await call(
    "test-b",
    "proposals",
    await approveTopic(
      f,
      {
        ...input,
        requestId: randomUUID(),
        purpose: "evidence-check",
        generationRequestId: input.requestId,
        generatorInvocation: a.draft.invocation.id,
        draftRaw: a.draft.json,
      },
      "test-b",
    ),
  );
  assert.equal(rejected.status, 403);
  assert.deepEqual(rejected.value, {
    status: "topic-author-forbidden",
    account: sessions["test-b"].account,
  });
  assert.equal(
    (await f.api("/api/budget", { user: "test-b" })).value.spentMilliYen,
    0,
  );
  const beforeA = (await f.api("/api/budget")).value;
  const b = (
    await call("test-b", "proposals", await approveTopic(f, input, "test-b"))
  ).value;
  assert.equal(b.status, "topic-author-forbidden");
  assert.notEqual(b.account, a.account);
  assert.deepEqual((await f.api("/api/budget")).value, beforeA);
  assert.deepEqual(
    (await call("test-a", "operations", approvedInput)).value,
    a,
  );
  assert.equal(f.outbound(), 0);
});
test("テーマ配送は不正な所有者・CSRF・Origin・入力を予約前に拒否する", async (t) => {
  const f = await fixture(t),
    account = await hash("better-auth:test-a"),
    input = {
      ...topicInput(),
      approvedMaxMilliYen: 1000,
      approvedQuoteDigest: "a".repeat(64),
    };
  const csrf = (await f.api("/api/session")).value.csrfToken;
  await f.api("/api/credentials/openai", {
    method: "POST",
    body: command(),
    csrf,
  });
  const call = (extra) =>
    f.api("/api/topic-textbooks/proposals", {
      method: "POST",
      body: input,
      csrf,
      headers: { "X-Library-Account": account },
      ...extra,
    });
  for (const [extra, status] of [
    [{ headers: {} }, 403],
    [{ headers: { "X-Library-Account": "b".repeat(64) } }, 403],
    [
      { headers: { "X-Library-Account": account, Origin: "http://evil.test" } },
      403,
    ],
    [{ csrf: "wrong" }, 403],
    [{ csrf: "x".repeat(201) }, 403],
    [{ user: "unknown" }, 401],
    [{ body: { ...input, owner: "test-b" } }, 400],
    [{ body: { ...input, requestRaw: "x".repeat(384001) } }, 413],
    [{ body: { ...input, requestRaw: "x".repeat(96001) } }, 400],
  ])
    assert.equal((await call(extra)).status, status, JSON.stringify(extra));
  assert.equal(
    (
      await f.api("/api/topic-textbooks/proposals", {
        headers: { "X-Library-Account": account },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.api("/api/topic-textbooks/unknown", {
        method: "POST",
        body: input,
        csrf,
        headers: { "X-Library-Account": account },
      })
    ).status,
    404,
  );
  assert.equal((await f.api("/api/budget")).value.spentMilliYen, 0);
  assert.equal((await f.api("/api/budget")).value.heldMilliYen, 0);
  assert.equal(f.outbound(), 0);
});
test("保存操作の照会が生成・キー操作の20回枠を消費しない", async (t) => {
  const f = await fixture(t),
    account = await hash("better-auth:test-a"),
    csrf = (await f.api("/api/session")).value.csrfToken;
  for (let i = 0; i < 25; i++) {
    const result = await f.api("/api/topic-textbooks/operations", {
      method: "POST",
      body: topicInput(),
      csrf,
      headers: { "X-Library-Account": account },
    });
    assert.equal(result.status, 200);
    assert.equal(result.value.status, "not-found");
  }
  assert.equal(
    (
      await f.api("/api/credentials/openai", {
        method: "POST",
        body: command(),
        csrf,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api("/api/topic-textbooks/operations", {
        method: "POST",
        body: topicInput(),
        csrf: "wrong",
        headers: { "X-Library-Account": account },
      })
    ).status,
    403,
  );
  assert.equal(f.outbound(), 0);
});
test("HTTPの結果不明照会はSQLiteの予約を保持し入力の差し替えを区別する", async (t) => {
  const f = await fixture(t),
    account = await hash("better-auth:test-a"),
    csrf = (await f.api("/api/session")).value.csrfToken;
  await f.api("/api/credentials/openai", {
    method: "POST",
    body: command(),
    csrf,
  });
  const request = JSON.parse(topicRequestRaw);
  request.learningGoal = "WAIT-MOCK";
  const input = await approveTopic(f, {
    ...topicInput(),
    requestRaw: JSON.stringify(request),
  });
  const call = (path, body) =>
    f.api(`/api/topic-textbooks/${path}`, {
      method: "POST",
      body,
      csrf,
      headers: { "X-Library-Account": account },
    });
  const unknown = await call("proposals", input);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.value.status, "unknown");
  const before = (await f.api("/api/budget")).value;
  assert.ok(before.heldMilliYen > 0);
  await f.restart();
  assert.deepEqual((await call("operations", input)).value, unknown.value);
  assert.equal(
    (await call("operations", { ...input, modelId: "different-model" })).value
      .status,
    "id-conflict",
  );
  assert.deepEqual((await f.api("/api/budget")).value, before);
  assert.equal(f.outbound(), 0);
});
