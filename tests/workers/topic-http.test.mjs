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
};
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
