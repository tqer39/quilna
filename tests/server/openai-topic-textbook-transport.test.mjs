import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openaiTopicTextbookTransport } from "../../server/openai-topic-textbook-transport.mjs";
const f = JSON.parse(
  await readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
    "utf8",
  ),
);
const decode = (s) => Buffer.from(s, "base64").toString("utf8");
const record = JSON.parse(decode(f.record));
const request = decode(record.request),
  draft = decode(record.draft),
  review = decode(record.review);
const model = "fixture-openai-model";
const options = (extra = {}) => ({
  model,
  inputTokens: 32000,
  outputTokens: 16000,
  tokenCountMargin: 100,
  tokenCountTermsConfirmed: true,
  retries: 0,
  store: false,
  tools: [],
  signal: new AbortController().signal,
  ...extra,
});
const wire = JSON.parse(draft);
for (const lesson of wire.lessons)
  lesson.optionEvidence = Object.entries(lesson.optionEvidence).map(
    ([optionID, evidence]) => ({ optionID, evidence }),
  );
const output = (text, extra = {}) => ({
  model,
  service_tier: "default",
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
  usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
  ...extra,
});
function transport(response = output(JSON.stringify(wire))) {
  const calls = [];
  const api = openaiTopicTextbookTransport({
    model,
    mockOnly: true,
    secret: "synthetic-credential-not-live",
    send: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Response.json(
        url.endsWith("input_tokens") ? { input_tokens: 1000 } : response,
      );
    },
  });
  return { api, calls };
}

test("生成前に全promptとschemaを数え、同じ入力を保存・stream・toolなしで一度だけ送る", async () => {
  const { api, calls } = transport();
  const result = await api.generate(request, options());
  assert.equal(result.outcome, "complete");
  assert.deepEqual(JSON.parse(result.json), JSON.parse(draft));
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://api.openai.com/v1/responses/input_tokens",
  );
  assert.equal(calls[1].url, "https://api.openai.com/v1/responses");
  for (const key of ["model", "input", "instructions", "text", "tools"])
    assert.deepEqual(calls[0].body[key], calls[1].body[key]);
  assert.deepEqual(
    {
      store: calls[1].body.store,
      stream: calls[1].body.stream,
      max: calls[1].body.max_output_tokens,
      tier: calls[1].body.service_tier,
    },
    { store: false, stream: false, max: 16000, tier: "default" },
  );
  assert.equal(calls[0].body.text.format.strict, true);
  assert.equal(calls[0].body.text.format.name, "topic_textbook");
  assert.ok(calls.every((c) => c.init.redirect === "error"));
});
test("別段階のreviewへ候補と正確なdigestを渡し、否定レビューの使用量とbytesを保持する", async () => {
  const negative = JSON.parse(review);
  negative.sections[0].checks[0].passed = false;
  const raw = JSON.stringify(negative),
    { api, calls } = transport(output(raw));
  const result = await api.review(request, draft, options());
  assert.deepEqual(result, {
    json: raw,
    usage: { inputTokens: 1000, outputTokens: 500 },
    outcome: "complete",
    allChecksPassed: false,
  });
  const payload = JSON.parse(calls[0].body.input[0].content);
  assert.equal(payload.requestDigest, negative.requestDigest);
  assert.equal(payload.draftDigest, negative.draftDigest);
  assert.equal(calls[0].body.text.format.name, "topic_textbook_review");
});
test("個人情報の混入と未確認の送信条件をHTTP前に拒否する", async () => {
  const { api, calls } = transport();
  await assert.rejects(
    api.generate(
      JSON.stringify({ ...JSON.parse(request), answers: ["私的な回答"] }),
      options(),
    ),
  );
  for (const extra of [
    { model: "other" },
    { retries: 1 },
    { store: true },
    { tools: ["web"] },
    { tokenCountTermsConfirmed: false },
    { outputTokens: 16001 },
  ])
    await assert.rejects(api.generate(request, options(extra)));
  assert.equal(calls.length, 0);
});
test("token上限を越えた入力を生成へ進めず、自動再送しない", async () => {
  const { api, calls } = transport();
  assert.equal(
    (await api.generate(request, options({ inputTokens: 1000 }))).outcome,
    "input-limit",
  );
  assert.equal(calls.length, 1);
});
test("token計数が中断を無視して返っても、その後に生成を送らない", async () => {
  const controller = new AbortController(),
    calls = [];
  const api = openaiTopicTextbookTransport({
    model,
    mockOnly: true,
    secret: "synthetic-credential-not-live",
    send: async (url) => {
      calls.push(url);
      controller.abort();
      return Response.json({ input_tokens: 1000 });
    },
  });
  await assert.rejects(
    api.generate(request, options({ signal: controller.signal })),
  );
  assert.equal(calls.length, 1);
});
test("不正・拒否・途中終了の有料出力でも確認済みの使用量を返す", async () => {
  for (const [response, outcome] of [
    [output('{"answers":["private"]}'), "invalid-output"],
    [output("", { status: "incomplete" }), "incomplete"],
    [
      output("", {
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "fixture" }],
          },
        ],
      }),
      "refused",
    ],
  ]) {
    const { api, calls } = transport(response),
      result = await api.generate(request, options());
    assert.equal(result.outcome, outcome);
    assert.equal(result.json, "");
    assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 500 });
    assert.equal(calls.length, 2);
  }
});
test("モデル・tier・使用量が不明な応答を成功へ読み替えず、再送しない", async () => {
  for (const extra of [
    { model: "other" },
    { service_tier: "priority" },
    { usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1499 } },
    {
      usage: { input_tokens: 1000, output_tokens: 16001, total_tokens: 17001 },
    },
  ]) {
    const { api, calls } = transport(output(JSON.stringify(wire), extra));
    await assert.rejects(api.generate(request, options()), /usage-unconfirmed/);
    assert.equal(calls.length, 2);
  }
});
test("大きめの教材応答は有界に読み、過大な応答とredirectは拒否する", async () => {
  const okay = transport(
    output(JSON.stringify(wire), { padding: "x".repeat(70000) }),
  );
  assert.equal(
    (await okay.api.generate(request, options())).outcome,
    "complete",
  );
  const big = transport(
    output(JSON.stringify(wire), { padding: "x".repeat(192001) }),
  );
  await assert.rejects(
    big.api.generate(request, options()),
    /provider-unknown/,
  );
  assert.equal(big.calls.length, 2);
  let calls = 0;
  const api = openaiTopicTextbookTransport({
    model,
    secret: "synthetic-credential-not-live",
    send: async () => {
      calls++;
      return new Response(null, { status: 302 });
    },
  });
  assert.equal(api.kind, "prepared");
  await assert.rejects(api.generate(request, options()), /provider-unknown/);
  assert.equal(calls, 1);
});
