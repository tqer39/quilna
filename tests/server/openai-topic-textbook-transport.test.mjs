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
    reasoningEffort: "none",
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
  for (const key of [
    "model",
    "input",
    "instructions",
    "text",
    "tools",
    "reasoning",
  ])
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
test("別段階のreviewへ候補を送り、digestをモデルに書かせず否定の結果と使用量を保持する", async () => {
  const { requestDigest, draftDigest, ...wire } = JSON.parse(review);
  wire.sections[0].checks[0].passed = false;
  const { api, calls } = transport(output(JSON.stringify(wire)));
  const result = await api.review(request, draft, options());
  assert.equal(result.allChecksPassed, false);
  assert.equal(result.outcome, "complete");
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.deepEqual(JSON.parse(result.json), {
    requestDigest,
    draftDigest,
    ...wire,
  });
  const payload = JSON.parse(calls[0].body.input[0].content);
  assert.deepEqual(payload.draft, JSON.parse(draft));
  assert.equal(payload.requestDigest, undefined);
  assert.equal(payload.draftDigest, undefined);
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
    reasoningEffort: "none",
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
    reasoningEffort: "none",
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

for (const stage of ["generate", "review"]) {
  test(`${stage}: 不完全・拒否・不正出力でもusageを保持し、複数messageを混ぜない`, async () => {
    const invoke = (api) =>
      stage === "generate"
        ? api.generate(request, options())
        : api.review(request, draft, options());
    for (const [response, outcome] of [
      [output("{}", { status: "incomplete" }), "incomplete"],
      [
        output("{}", {
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
      [output("{}"), "invalid-output"],
      [
        output("{}", {
          output: [output("{}").output[0], output("{}").output[0]],
        }),
        "invalid-output",
      ],
    ]) {
      const { api, calls } = transport(response),
        result = await invoke(api);
      assert.equal(result.outcome, outcome);
      assert.equal(result.json, "");
      assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 500 });
      assert.equal(calls.length, 2);
    }
    const { api, calls } = transport(
      output("{}", { service_tier: "priority" }),
    );
    await assert.rejects(invoke(api), /usage-unconfirmed/);
    assert.equal(calls.length, 2);
    const limited = transport();
    const result =
      stage === "generate"
        ? await limited.api.generate(request, options({ inputTokens: 1000 }))
        : await limited.api.review(
            request,
            draft,
            options({ inputTokens: 1000 }),
          );
    assert.equal(result.outcome, "input-limit");
    assert.equal(limited.calls.length, 1);
  });
  test(`${stage}: 生成要求中の中断後に返った応答を教材として使わず、既知の費用情報を残す`, async () => {
    const controller = new AbortController(),
      calls = [];
    const response = output(JSON.stringify(wire), {
      output: [
        { type: "reasoning", summary: [] },
        ...output(JSON.stringify(wire)).output,
      ],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        output_tokens_details: { reasoning_tokens: 200 },
      },
    });
    const api = openaiTopicTextbookTransport({
      model,
      reasoningEffort: "none",
      mockOnly: true,
      secret: "synthetic-credential-not-live",
      send: async (url) => {
        calls.push(url);
        if (url.endsWith("input_tokens"))
          return Response.json({ input_tokens: 1000 });
        controller.abort();
        return Response.json(response);
      },
    });
    const result =
      stage === "generate"
        ? await api.generate(request, options({ signal: controller.signal }))
        : await api.review(
            request,
            draft,
            options({ signal: controller.signal }),
          );
    assert.deepEqual(result, {
      json: "",
      usage: { inputTokens: 1000, outputTokens: 500 },
      outcome: "cancelled",
    });
    assert.equal(calls.length, 2);
  });
}
test("壊れたtoken数・応答・messageを分類したエラーへ閉じ、例外の詳細を返さない", async () => {
  for (const counted of [null, [], {}, { input_tokens: -1 }]) {
    let calls = 0;
    const api = openaiTopicTextbookTransport({
      model,
      reasoningEffort: "none",
      secret: "synthetic-credential-not-live",
      send: async () => {
        calls++;
        return Response.json(counted);
      },
    });
    await assert.rejects(
      api.generate(request, options()),
      /provider-unknown|usage-unconfirmed/,
    );
    assert.equal(calls, 1);
  }
  const { api } = transport(output("{}", { output: [null] }));
  await assert.rejects(api.generate(request, options()), /usage-unconfirmed/);
  const content = transport(
    output("{}", {
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [null],
        },
      ],
    }),
  );
  assert.equal(
    (await content.api.generate(request, options())).outcome,
    "invalid-output",
  );
});
test("明示的な推論設定・資格情報がないと送信しない", async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    throw Error("fixture sender must not run");
  };
  for (const config of [
    {},
    { reasoningEffort: "unsupported" },
    { reasoningEffort: "none", secret: "short" },
  ]) {
    const api = openaiTopicTextbookTransport({
      model,
      secret: "synthetic-credential-not-live",
      send,
      ...config,
    });
    await assert.rejects(
      api.generate(request, options()),
      /transport-unconfigured|credential-unconfigured/,
    );
  }
  assert.equal(calls, 0);
});

test("reasoning項目は本文へ混ぜず、推論tokenをoutput tokenへ二重加算しない", async () => {
  const response = output(JSON.stringify(wire));
  response.output.unshift({ type: "reasoning", summary: [] });
  response.usage.output_tokens_details = { reasoning_tokens: 200 };
  const { api } = transport(response),
    result = await api.generate(request, options());
  assert.equal(result.outcome, "complete");
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.deepEqual(JSON.parse(result.json), JSON.parse(draft));
});
