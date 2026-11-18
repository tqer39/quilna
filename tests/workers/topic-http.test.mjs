import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ReadableStream } from "node:stream/web";
import { createHandler, handleAccount } from "../../workers/http.mjs";
import { hash } from "../../workers/crypto.mjs";
const origin = "https://app.test";
const ownerA = { subject: "verified-owner-a", sessionId: "session-a" };
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
    "utf8",
  ),
);
const record = JSON.parse(
  Buffer.from(fixture.record, "base64").toString("utf8"),
);
const raw = Buffer.from(record.request, "base64").toString("utf8");
const input = {
  requestId: JSON.parse(raw).id,
  requestRaw: raw,
  purpose: "book-addition",
  modelId: "openai-luna-candidate",
  approvedPublicText: true,
  approvedMaxMilliYen: 1000,
  approvedQuoteDigest: "a".repeat(64),
};

async function jobsSetup(options) {
  const f = await setup(options);
  f.env.TOPIC_TEXTBOOK_JOBS = {};
  f.env.TOPIC_TEXTBOOK_JOBS_ENABLED = "true";
  return f;
}

test("教材ジョブは検証した所有者・CSRFを内部経路へ渡し、要求に所有者を混ぜさせない", async () => {
  const cases = {
    enqueue: { input },
    retry: { input, confirm: true },
    read: { id: input.requestId },
    refresh: { id: input.requestId },
    list: {},
    remove: { id: input.requestId, confirm: true },
    cancel: { id: input.requestId, confirm: true },
    resume: { id: input.requestId, confirm: true },
  };
  for (const [action, body] of Object.entries(cases)) {
    const f = await jobsSetup();
    assert.equal(
      (
        await f.handler(
          f.request("jobs/" + action, JSON.stringify(body)),
          f.env,
        )
      ).status,
      200,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://account.internal/command/topic-jobs");
    assert.equal(f.calls[0].id, f.account);
    assert.deepEqual(f.calls[0].command, {
      action: "topic-job-" + action,
      principal: ownerA,
      csrf: "synthetic-csrf",
      data: body.input
        ? {
            ...body,
            input: {
              ...body.input,
              requestId: body.input.requestId.toLowerCase(),
            },
          }
        : body,
    });
    const forged = { ...body, owner: "b".repeat(64) };
    assert.equal(
      (
        await f.handler(
          f.request("jobs/" + action, JSON.stringify(forged)),
          f.env,
        )
      ).status,
      400,
    );
    assert.equal(f.calls.length, 1);
  }
});

test("新しい背景送信の受付を止めても、保存済み結果の確認と取消は認証付きで続けられる", async () => {
  const f = await jobsSetup({ credentialsEnabled: false });
  for (const [action, body] of Object.entries({
    enqueue: { input },
    retry: { input, confirm: true },
    resume: { id: input.requestId, confirm: true },
  }))
    assert.equal(
      (
        await f.handler(
          f.request("jobs/" + action, JSON.stringify(body)),
          f.env,
        )
      ).status,
      503,
    );
  assert.equal(f.calls.length, 0);
  f.env.TOPIC_TEXTBOOK_JOBS_ENABLED = "false";
  for (const [action, body] of Object.entries({
    list: {},
    read: { id: input.requestId },
    refresh: { id: input.requestId },
    cancel: { id: input.requestId, confirm: true },
    remove: { id: input.requestId, confirm: true },
  }))
    assert.equal(
      (
        await f.handler(
          f.request("jobs/" + action, JSON.stringify(body)),
          f.env,
        )
      ).status,
      200,
    );
  assert.equal(f.calls.length, 5);
});

test("ジョブ受付は未構成・費用未承認・CSRF欠落・異なるアカウントを配送前に拒否する", async () => {
  const f = await jobsSetup();
  for (const name of ["X-Library-Account", "X-CSRF-Token"]) {
    const request = f.request("jobs/list", "{}");
    request.headers.delete(name);
    assert.equal((await f.handler(request, f.env)).status, 403);
  }
  const foreign = f.request("jobs/list", "{}");
  foreign.headers.set("X-Library-Account", "b".repeat(64));
  assert.equal((await f.handler(foreign, f.env)).status, 403);
  const command = { ...input };
  delete command.approvedQuoteDigest;
  assert.equal(
    (
      await f.handler(
        f.request("jobs/enqueue", JSON.stringify({ input: command })),
        f.env,
      )
    ).status,
    400,
  );
  f.env.TOPIC_TEXTBOOK_JOBS_ENABLED = "false";
  assert.equal(
    (
      await f.handler(
        f.request("jobs/enqueue", JSON.stringify({ input })),
        f.env,
      )
    ).status,
    503,
  );
  delete f.env.TOPIC_TEXTBOOK_JOBS;
  assert.equal(
    (await f.handler(f.request("jobs/list", "{}"), f.env)).status,
    503,
  );
  assert.equal(f.calls.length, 0);
});

for (const changed of ["owner", "session"])
  test(`ジョブの処理待ち中の${changed}変更では古い所有者の結果を渡さない`, async () => {
    let identity = ownerA;
    const f = await jobsSetup({
      authenticate: async () => identity,
      fetch: async () => {
        identity =
          changed === "owner"
            ? { ...ownerA, subject: "another-owner" }
            : { ...ownerA, sessionId: "next-session" };
        return Response.json({ job: { privateResult: "old-account-only" } });
      },
    });
    const response = await f.handler(
      f.request("jobs/read", JSON.stringify({ id: input.requestId })),
      f.env,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { status: "unauthenticated" });
    assert.equal(f.calls.length, 1);
  });

test("ジョブ本文の受信中にセッションが変わると内部処理を始めない", async () => {
  let identity = ownerA,
    entered,
    release,
    controller;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream(
    {
      pull(value) {
        controller = value;
        entered();
        return gate;
      },
    },
    { highWaterMark: 0 },
  );
  const f = await jobsSetup({ authenticate: async () => identity });
  const pending = f.handler(
    f.request("jobs/list", stream, { duplex: "half" }),
    f.env,
  );
  await reading;
  identity = { ...ownerA, sessionId: "replaced-session" };
  controller.enqueue(new TextEncoder().encode("{}"));
  controller.close();
  release();
  assert.equal((await pending).status, 401);
  assert.equal(f.calls.length, 0);
});

test("Accountのジョブ経路は読み取り枠を保ち、変更・再照会の制限と無効化を迂回させない", async () => {
  const account = await hash(ownerA.subject),
    calls = [];
  let exhausted = true,
    authorizations = 0;
  const core = {
    authorize: async (_principal, _csrf, mutating, options) => {
      authorizations++;
      assert.equal(mutating, true);
      if (exhausted && options.countRate) throw Error("rate-limit");
      return account;
    },
  };
  const jobs = {
    enabled: true,
    binding: {
      idFromName: (value) => {
        assert.equal(value, account);
        return value;
      },
      get: () => ({
        fetch: async (request) => {
          calls.push(await request.json());
          return Response.json({ account });
        },
      }),
    },
  };
  const command = (action, data, path = "/command/topic-jobs") =>
    new Request("https://account.internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "topic-job-" + action,
        principal: ownerA,
        csrf: "synthetic-csrf",
        data,
      }),
    });
  for (const [action, data] of [
    ["list", {}],
    ["read", { id: input.requestId }],
  ])
    assert.equal(
      (await handleAccount(core, command(action, data), null, null, jobs))
        .status,
      200,
    );
  assert.equal(
    (
      await handleAccount(
        core,
        command("refresh", { id: input.requestId }),
        null,
        null,
        jobs,
      )
    ).status,
    429,
  );
  assert.equal(calls.length, 2);
  const before = authorizations;
  assert.equal(
    (
      await handleAccount(
        core,
        command("list", {}, "/command"),
        null,
        null,
        jobs,
      )
    ).status,
    409,
  );
  assert.equal(authorizations, before);
  exhausted = false;
  jobs.enabled = false;
  assert.equal(
    (
      await handleAccount(
        core,
        command("resume", { id: input.requestId, confirm: true }),
        null,
        null,
        jobs,
      )
    ).status,
    503,
  );
  assert.equal(
    (await handleAccount(core, command("list", {}), null, null, jobs)).status,
    200,
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((value) => value.owner === account));
});
async function setup({
  authenticate = async () => ownerA,
  fetch = async () => Response.json({ status: "not-found" }),
  credentialsEnabled = true,
} = {}) {
  const account = await hash(ownerA.subject),
    calls = [];
  const handler = createHandler({ authenticate, credentialsEnabled });
  const env = {
    APP_ORIGIN: origin,
    ACCOUNTS: {
      idFromName: (value) => value,
      get: (id) => ({
        fetch: async (request) => {
          calls.push({
            id,
            url: request.url,
            command: await request.clone().json(),
          });
          return fetch(request);
        },
      }),
    },
  };
  const request = (
    path = "proposals",
    body = JSON.stringify(input),
    extra = {},
  ) =>
    new Request(`${origin}/api/topic-textbooks/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": "synthetic-csrf",
        "X-Library-Account": account,
      },
      body,
      ...extra,
    });
  return { handler, env, calls, request, account };
}
test("実キー入力を無効にしても保存操作の照会は認証とCSRFを付けて配送する", async () => {
  const f = await setup({ credentialsEnabled: false });
  assert.equal((await f.handler(f.request(), f.env)).status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handler(f.request("operations"), f.env)).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, f.account);
  assert.equal(
    f.calls[0].url,
    "https://account.internal/command/topic-textbooks",
  );
  assert.equal(f.calls[0].command.action, "topic-lookup");
  assert.equal(f.calls[0].command.csrf, "synthetic-csrf");
  assert.deepEqual(f.calls[0].command.principal, ownerA);
});
for (const changed of ["owner", "session"])
  test(
    `本文受信中の${changed}変更ではテーマ処理を配送しない`,
    { timeout: 2000 },
    async () => {
      let identity = ownerA,
        entered,
        release,
        controller;
      const reading = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const body = new ReadableStream(
        {
          pull(value) {
            controller = value;
            entered();
            return gate;
          },
        },
        { highWaterMark: 0 },
      );
      const f = await setup({ authenticate: async () => identity });
      const pending = f.handler(
        f.request("proposals", body, { duplex: "half" }),
        f.env,
      );
      await reading;
      identity =
        changed === "owner"
          ? { subject: "verified-owner-b", sessionId: "session-b" }
          : { ...ownerA, sessionId: "session-new" };
      controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
      controller.close();
      release();
      const response = await pending;
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { status: "unauthenticated" });
      assert.equal(f.calls.length, 0);
    },
  );
for (const changed of ["owner", "session"])
  test(
    `処理待ち中の${changed}変更では候補の応答を破棄する`,
    { timeout: 2000 },
    async () => {
      let identity = ownerA,
        entered,
        release,
        discarded = false;
      const processing = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const f = await setup({
        authenticate: async () => identity,
        fetch: async () => {
          entered();
          await gate;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('{"private":"candidate"}'),
                );
              },
              cancel() {
                discarded = true;
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      });
      const pending = f.handler(f.request(), f.env);
      await processing;
      identity =
        changed === "owner"
          ? { subject: "verified-owner-b", sessionId: "session-b" }
          : { ...ownerA, sessionId: "session-new" };
      release();
      const response = await pending;
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { status: "unauthenticated" });
      assert.equal(discarded, true);
      assert.equal(f.calls.length, 1);
    },
  );
test("テーマ用RPC以外から大きいbodyやテーマactionを受け付けない", async () => {
  let authorized = false;
  const core = {
    authorize: async () => {
      authorized = true;
      throw Error("must not authorize");
    },
  };
  for (const [path, action, data] of [
    ["/command", "topic-lookup", input],
    ["/command/topic-textbooks", "propose", input],
    ["/command", "propose", { ...input, requestRaw: "x".repeat(40000) }],
  ]) {
    const response = await handleAccount(
      core,
      new Request(`https://account.internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          data,
          principal: ownerA,
          csrf: "synthetic-csrf",
        }),
      }),
    );
    assert.equal(response.status, 409);
  }
  assert.equal(authorized, false);
});
test("不正なJSON・容量・Content-Typeは未配送の拒否として返す", async () => {
  const f = await setup();
  const badJson = await f.handler(f.request("proposals", "{"), f.env);
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { status: "invalid-request" });
  const tooLarge = await f.handler(
    f.request("proposals", "x".repeat(384001)),
    f.env,
  );
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { status: "body-limit" });
  const wrongType = f.request();
  wrongType.headers.set("Content-Type", "text/plain");
  const response = await f.handler(wrongType, f.env);
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { status: "json-required" });
  assert.equal(f.calls.length, 0);
});
for (const status of ["reserved", "unknown", "id-conflict"])
  test(`操作照会の${status}をCSRF付きで変更せず返す`, async () => {
    const account = await hash(ownerA.subject),
      calls = [];
    const value =
      status === "id-conflict" ? { status } : { status, draft: null };
    const core = {
      authorize: async (...args) => {
        calls.push(args);
        return account;
      },
      lookupTopic: async () => value,
    };
    const response = await handleAccount(
      core,
      new Request("https://account.internal/command/topic-textbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "topic-lookup",
          principal: ownerA,
          csrf: "synthetic-csrf",
          data: input,
        }),
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...value, account });
    assert.equal(calls[0][2], true);
    assert.deepEqual(calls[0][3], { countRate: false });
  });
test("アカウント付き応答のbyte上限ちょうどを許し1byte超過を区別する", async () => {
  const account = await hash(ownerA.subject),
    base = { status: "complete", draft: { json: "" } };
  const remaining =
    262144 - Buffer.byteLength(JSON.stringify({ ...base, account }));
  for (const extra of [0, 1]) {
    const core = {
      authorize: async () => account,
      lookupTopic: async () => ({
        ...base,
        draft: { json: "x".repeat(remaining + extra) },
      }),
    };
    const response = await handleAccount(
      core,
      new Request("https://account.internal/command/topic-textbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "topic-lookup",
          principal: ownerA,
          csrf: "synthetic-csrf",
          data: input,
        }),
      }),
    );
    assert.equal(response.status, extra ? 502 : 200);
    if (extra)
      assert.deepEqual(await response.json(), {
        status: "response-limit",
        account,
      });
    else assert.equal(Buffer.byteLength(await response.text()), 262144);
  }
});
for (const credentialsEnabled of [true, false])
  test(`テーマstatusは秘密を出さず機能gate ${credentialsEnabled} を保持する`, async () => {
    let reads = 0;
    const core = {
      authorize: async (p, csrf, mutating) => {
        assert.equal(mutating, false);
        return hash(p.subject);
      },
      topicStatus: async () => {
        reads++;
        return { mode: "test-only", quotes: [{ synthetic: true }], budget: {} };
      },
      session: async () => ({ csrfToken: "synthetic-csrf-token" }),
    };
    const f = await setup({
      credentialsEnabled,
      fetch: (req) => handleAccount(core, req),
    });
    const request = new Request(`${origin}/api/topic-textbooks/status`, {
      headers: { Origin: origin, "X-Library-Account": f.account },
    });
    const response = await f.handler(request, f.env),
      body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(reads, 1);
    assert.equal(body.mode, credentialsEnabled ? "test-only" : "unconnected");
    assert.deepEqual(
      body.quotes,
      credentialsEnabled ? [{ synthetic: true }] : [],
    );
    assert.equal(body.csrfToken, "synthetic-csrf-token");
  });
for (const kind of ["account", "origin", "method"])
  test(`テーマstatusの不正な${kind}を配送前に拒否する`, async () => {
    const f = await setup();
    const response = await f.handler(
      new Request(`${origin}/api/topic-textbooks/status`, {
        method: kind === "method" ? "POST" : "GET",
        headers: {
          Origin: kind === "origin" ? "https://other.test" : origin,
          "X-Library-Account": kind === "account" ? "b".repeat(64) : f.account,
        },
      }),
      f.env,
    );
    assert.equal(response.status, kind === "method" ? 404 : 403);
    assert.equal(f.calls.length, 0);
  });
for (const missing of ["both", "amount", "digest"])
  test(`HTTPの費用承認${missing}の不足を予約前に拒否する`, async () => {
    const f = await setup(),
      value = { ...input };
    if (missing !== "digest") delete value.approvedMaxMilliYen;
    if (missing !== "amount") delete value.approvedQuoteDigest;
    const response = await f.handler(
      f.request("proposals", JSON.stringify(value)),
      f.env,
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).status, "cost-unapproved");
    assert.equal(f.calls.length, 0);
  });
test("実キー受付の停止中も資料準備を本人・CSRF付きで配送し、余分な入力を拒否する", async () => {
  const f = await setup({ credentialsEnabled: false });
  const response = await f.handler(
    f.request("preparations", JSON.stringify({ topic: "RSS" })),
    f.env,
  );
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].command.action, "topic-prepare");
  assert.deepEqual(f.calls[0].command.data, { topic: "RSS" });
  assert.equal(f.calls[0].command.csrf, "synthetic-csrf");
  assert.equal(
    (
      await f.handler(
        f.request(
          "preparations",
          JSON.stringify({ topic: "RSS", owner: f.account }),
        ),
        f.env,
      )
    ).status,
    400,
  );
  assert.equal(f.calls.length, 1);
});
test("資料準備の内部経路でも本文・CSRF・利用者を確認してから探索する", async () => {
  const calls = [],
    owner = await hash(ownerA.subject);
  const core = {
    async authorize(who, csrf, mutating, options) {
      assert.deepEqual(who, ownerA);
      assert.equal(csrf, "synthetic-csrf");
      assert.equal(mutating, true);
      assert.equal(options.countRate, true);
      assert.equal(options.rateScope, "topic-preparation");
      return owner;
    },
  };
  const command = (data) => ({
    action: "topic-prepare",
    principal: ownerA,
    csrf: "synthetic-csrf",
    data,
  });
  const request = (url, data) =>
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command(data)),
    });
  const prepare = async (account, data) => {
    calls.push({ account, data });
    return { synthetic: true };
  };
  const path = "https://account.internal/command/topic-textbooks";
  assert.equal(
    (
      await handleAccount(
        core,
        request(path, { topic: "RSS" }),
        null,
        null,
        null,
        prepare,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [{ account: owner, data: { topic: "RSS" } }]);
  assert.equal(
    (
      await handleAccount(
        core,
        request(path, { topic: "RSS", owner }),
        null,
        null,
        null,
        prepare,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleAccount(
        core,
        request(path + "?wrong", { topic: "RSS" }),
        null,
        null,
        null,
        prepare,
      )
    ).status,
    404,
  );
  assert.equal(calls.length, 1);
});
test("資料準備はテーマの500/501バイトとJSON本文4096バイトの上限を区別する", async () => {
  const f = await setup();
  assert.equal(
    (
      await f.handler(
        f.request("preparations", JSON.stringify({ topic: "a".repeat(500) })),
        f.env,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.handler(
        f.request("preparations", JSON.stringify({ topic: "a".repeat(501) })),
        f.env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.handler(
        f.request(
          "preparations",
          JSON.stringify({ topic: "a".repeat(500) }) + " ".repeat(4096),
        ),
        f.env,
      )
    ).status,
    413,
  );
  assert.equal(f.calls.length, 1);
});
test("原文3件と題名・語句が最大でエスケープの多い資料候補もHTTP応答枠に収まる", async () => {
  const owner = await hash(ownerA.subject),
    excerpt = "RSS" + "\u0001".repeat(5994) + "RSS";
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(excerpt)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const page = {
    account: owner,
    topic: "RSS",
    after: null,
    inspected: 3,
    unavailable: 0,
    sources: Array.from({ length: 3 }, (_, i) => {
      const id = crypto.randomUUID();
      return {
        documentId: crypto.randomUUID(),
        versionId: id,
        source: {
          id,
          title: "T" + "\u0001".repeat(1999),
          url: "https://example.org/" + i,
          capturedAt: 800000000,
          publishedAt: null,
          updatedAt: null,
          sourceFingerprint: fingerprint,
          excerpt,
        },
        score: 120,
        matchedTerms: Array.from(
          { length: 8 },
          (_, n) => String(n) + "\u0001".repeat(499),
        ),
      };
    }),
  };
  const { topicPreparationPageSchema } =
    await import("../../src/topic-preparation-protocol.ts");
  assert.equal(topicPreparationPageSchema.safeParse(page).success, true);
  const request = new Request(
    "https://account.internal/command/topic-textbooks",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "topic-prepare",
        principal: ownerA,
        csrf: "synthetic-csrf",
        data: { topic: "RSS" },
      }),
    },
  );
  const response = await handleAccount(
    { authorize: async () => owner },
    request,
    null,
    null,
    null,
    async () => page,
  );
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(new TextEncoder().encode(raw).length < 262144, true);
  assert.equal(JSON.parse(raw).sources.length, 3);
});

const creationQuote = (purpose) => ({
  modelId: "fixture",
  provider: "openai",
  model: "fixture",
  purpose,
  maxMilliYen: 1000,
  quoteDigest: "e".repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "合成検証のみ",
  priceCheckedAt: "2026-11-18T00:00:00Z",
  costCheckedAt: "2026-11-18T00:00:00Z",
});
const creationRevision = "d".repeat(64);
const creationBodies = {
  save: { requestRaw: raw },
  read: { id: input.requestId.toLowerCase() },
  list: {},
  refresh: { id: input.requestId.toLowerCase() },
  remove: { id: input.requestId.toLowerCase(), confirm: true },
  resume: { id: input.requestId.toLowerCase(), confirm: true },
  approve: {
    id: input.requestId.toLowerCase(),
    expectedRevision: creationRevision,
    confirm: true,
    approvedPublicText: true,
    generation: creationQuote("book-addition"),
    review: creationQuote("evidence-check"),
  },
  retry: {
    id: input.requestId.toLowerCase(),
    expectedRevision: creationRevision,
    confirm: true,
    approvedPublicText: true,
    quote: creationQuote("evidence-check"),
  },
  "review-again": {
    id: input.requestId.toLowerCase(),
    expectedRevision: creationRevision,
    reviewRequestId: crypto.randomUUID(),
    confirm: true,
    approvedPublicText: true,
    quote: creationQuote("evidence-check"),
  },
};
async function creationSetup(options) {
  const f = await setup(options);
  f.env.TOPIC_TEXTBOOK_CREATIONS = {};
  f.env.TOPIC_TEXTBOOK_CREATIONS_ENABLED = "true";
  return f;
}
test("作成受付の全操作で所有者・CSRFをAccountへ渡し、現在見積り/所有者/余分な確認を注入させない", async () => {
  for (const [action, body] of Object.entries(creationBodies)) {
    const f = await creationSetup();
    assert.equal(
      (
        await f.handler(
          f.request("creations/" + action, JSON.stringify(body)),
          f.env,
        )
      ).status,
      200,
    );
    assert.deepEqual(f.calls[0].command, {
      action: "topic-creation-" + action,
      principal: ownerA,
      csrf: "synthetic-csrf",
      data: body,
    });
    assert.equal(
      f.calls[0].url,
      "https://account.internal/command/topic-creations",
    );
    for (const injected of [
      { owner: "b".repeat(64) },
      { currentQuotes: [] },
      { action: "approve" },
    ])
      assert.equal(
        (
          await f.handler(
            f.request(
              "creations/" + action,
              JSON.stringify({ ...body, ...injected }),
            ),
            f.env,
          )
        ).status,
        400,
      );
    assert.equal(f.calls.length, 1);
  }
});
test("生成の受付停止中にも草案の保存/読取/整理ができ、費用承認・再予約・再開は停止する", async () => {
  const f = await creationSetup({ credentialsEnabled: false });
  f.env.TOPIC_TEXTBOOK_CREATIONS_ENABLED = "false";
  for (const [action, body] of Object.entries(creationBodies))
    assert.equal(
      (
        await f.handler(
          f.request("creations/" + action, JSON.stringify(body)),
          f.env,
        )
      ).status,
      ["approve", "retry", "resume", "review-again"].includes(action)
        ? 503
        : 200,
    );
  delete f.env.TOPIC_TEXTBOOK_CREATIONS;
  assert.equal(
    (await f.handler(f.request("creations/list", "{}"), f.env)).status,
    503,
  );
});
for (const phase of ["before-dispatch", "after-processing"])
  test(`作成受付の ${phase} のセッション変更で配送/応答を拒否する`, async () => {
    let checks = 0;
    const f = await creationSetup({
      authenticate: async () =>
        ++checks >= (phase === "before-dispatch" ? 2 : 3)
          ? { subject: "other", sessionId: "other" }
          : ownerA,
    });
    assert.equal(
      (
        await f.handler(
          f.request("creations/save", JSON.stringify(creationBodies.save)),
          f.env,
        )
      ).status,
      401,
    );
    assert.equal(f.calls.length, phase === "before-dispatch" ? 0 : 1);
  });

test("AccountがCSRF・流量を確認し、資料と保存版を照合してホストの見積りだけを作成DOへ渡す", async () => {
  const owner = await hash(ownerA.subject),
    calls = [],
    checks = [],
    materials = [];
  let exhausted = false,
    missing = false,
    revision = creationRevision;
  const core = {
    authorize: async (_p, csrf, mutating, options) => {
      assert.equal(mutating, true);
      if (csrf !== "valid-csrf") throw Error("csrf-invalid");
      checks.push(options);
      if (exhausted && options.countRate) throw Error("rate-limit");
      return owner;
    },
    topicStatus: async () => ({
      quotes: [creationQuote("book-addition"), creationQuote("evidence-check")],
    }),
  };
  const creations = {
    enabled: true,
    verifyMaterials: async (account, value) => {
      assert.equal(account, owner);
      materials.push(value);
    },
    binding: {
      idFromName: (id) => id,
      get: (id) => {
        assert.equal(id, owner);
        return {
          fetch: async (request) => {
            assert.equal(
              request.url,
              "https://topic-creations.internal/command",
            );
            const command = await request.json();
            calls.push(command);
            return Response.json(
              command.action === "read"
                ? {
                    account: owner,
                    creation: missing
                      ? null
                      : {
                          id: input.requestId.toLowerCase(),
                          revision,
                          requestRaw: raw,
                        },
                  }
                : {
                    account: owner,
                    creation: { id: input.requestId.toLowerCase() },
                  },
            );
          },
        };
      },
    },
  };
  const command = (
    action,
    data,
    csrf = "valid-csrf",
    path = "/command/topic-creations",
  ) =>
    new Request("https://account.internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "topic-creation-" + action,
        principal: ownerA,
        csrf,
        data,
      }),
    });
  const send = (action, data, csrf, path) =>
    handleAccount(
      core,
      command(action, data, csrf, path),
      null,
      null,
      null,
      null,
      creations,
    );
  for (const [action, data] of Object.entries(creationBodies))
    assert.equal((await send(action, data)).status, 200);
  assert.ok(calls.every((c) => c.owner === owner));
  for (const c of calls.filter((c) =>
    ["approve", "retry", "review-again"].includes(c.action),
  ))
    assert.deepEqual(c.currentQuotes, (await core.topicStatus()).quotes);
  assert.equal(materials.length, 4);
  assert.ok(materials.every((r) => r === raw));
  const before = calls.length;
  assert.equal(
    (await send("read", creationBodies.read, "invalid")).status,
    403,
  );
  assert.equal(calls.length, before);
  exhausted = true;
  assert.equal((await send("list", {})).status, 200);
  assert.equal(checks.at(-1).countRate, false);
  assert.equal((await send("refresh", creationBodies.refresh)).status, 429);
  exhausted = false;
  assert.equal((await send("list", {}, undefined, "/command")).status, 409);
  revision = "f".repeat(64);
  assert.equal((await send("approve", creationBodies.approve)).status, 409);
  missing = true;
  assert.equal((await send("approve", creationBodies.approve)).status, 404);
});

for (const [credentialsEnabled, flag] of [
  [false, true],
  [true, false],
  [false, false],
])
  test(`作成の受付停止を個別に検証する: credentials=${credentialsEnabled}, flag=${flag}`, async () => {
    const f = await creationSetup({ credentialsEnabled });
    f.env.TOPIC_TEXTBOOK_CREATIONS_ENABLED = String(flag);
    for (const action of ["approve", "retry", "resume", "review-again"]) {
      const response = await f.handler(
        f.request(
          "creations/" + action,
          JSON.stringify(creationBodies[action]),
        ),
        f.env,
      );
      assert.equal(response.status, 503);
      assert.equal(
        (await response.json()).status,
        credentialsEnabled
          ? "topic-creations-unconfigured"
          : "credentials-unconfigured",
      );
    }
    assert.equal(f.calls.length, 0);
    assert.equal(
      (
        await f.handler(
          f.request("creations/read", JSON.stringify(creationBodies.read)),
          f.env,
        )
      ).status,
      200,
    );
  });
