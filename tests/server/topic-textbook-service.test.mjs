import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GenerationService } from "../../server/service.mjs";
import { FileLedger } from "../../server/ledger.mjs";
import { openaiTopicTextbookTransport } from "../../server/openai-topic-textbook-transport.mjs";
import {
  topicTextbookContract,
  topicTextbookBudgetAdapter,
} from "../../server/topic-textbook-contract.mjs";

const file = JSON.parse(
  await readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
  ),
);
const record = JSON.parse(Buffer.from(file.record, "base64"));
const requestRaw = Buffer.from(record.request, "base64").toString("utf8"),
  draftRaw = Buffer.from(record.draft, "base64").toString("utf8"),
  reviewRaw = Buffer.from(record.review, "base64").toString("utf8");
const requestId = JSON.parse(requestRaw).id.toLowerCase();
const date = "2026-11-17T00:00:00.000Z";
const model = {
  id: "topic-fixture",
  provider: "fixture",
  model: "synthetic-model",
  purposes: ["book-addition", "evidence-check"],
  structuredOutput: true,
  dataConditions: "合成応答のみ。外部通信なし。価格も試験用の値。",
  dataConditionsAccepted: true,
  approval: "test-only",
  priceCheckedAt: date,
  inputUsdMicrosPerMillion: 250000,
  outputUsdMicrosPerMillion: 750000,
  inputTokens: 8000,
  outputTokens: 2000,
  tokenCountMargin: 256,
  tokenCountTermsConfirmed: true,
};
const policy = {
  confirmedCostUpperBounds: true,
  checkedAt: date,
  fixedMilliYen: 0,
  safetyMilliYen: 0,
  yenPerUsdMilli: 200000,
  taxFeePermille: 1200,
  providerCapsMilliYen: {},
};
const generateRequest = (extra = {}) => ({
  requestId,
  purpose: "book-addition",
  requestRaw,
  approvedPublicText: true,
  ...extra,
});
const reviewRequest = (generated, extra = {}) => ({
  requestId: randomUUID(),
  purpose: "evidence-check",
  requestRaw,
  approvedPublicText: true,
  generationRequestId: requestId,
  generatorInvocation: generated.draft.invocation.id,
  draftRaw: generated.draft.json,
  ...extra,
});
async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "quilna-topic-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new FileLedger(dir),
    calls = [];
  const transport = {
    kind: "test-only",
    protocol: "topic-textbook-v2",
    acceptsModel: (value) => value === model.model,
    async generate(raw) {
      calls.push({ stage: "generate", raw });
      return {
        json: draftRaw,
        usage: { inputTokens: 100, outputTokens: 100 },
        outcome: "complete",
      };
    },
    async review(raw, draft) {
      calls.push({ stage: "review", raw, draft });
      return {
        json: reviewRaw,
        usage: { inputTokens: 100, outputTokens: 100 },
        outcome: "complete",
      };
    },
    ...extra.transport,
  };
  const config = {
    ledger,
    policy,
    registry: [model],
    selectionPolicy: {
      "book-addition": model.id,
      "evidence-check": model.id,
    },
    now: () => new Date(date),
    contract: topicTextbookContract,
    adapters: { fixture: topicTextbookBudgetAdapter(transport) },
    ...extra.config,
  };
  return { ledger, dir, calls, config, service: new GenerationService(config) };
}

test("生成・独立検証・再起動後の再取得で正確な候補とサーバー発行IDを保持する", async (t) => {
  const f = await fixture(t);
  const generated = await f.service.propose(generateRequest());
  assert.equal(generated.status, "complete");
  assert.equal(generated.draft.kind, "topic-textbook-draft");
  assert.equal(generated.draft.json, draftRaw);
  assert.notEqual(generated.draft.invocation.id, record.generator.id);
  assert.deepEqual(
    await new GenerationService({
      ...f.config,
      ledger: new FileLedger(f.dir),
    }).propose(generateRequest({ requestId: requestId.toUpperCase() })),
    generated,
  );
  const input = reviewRequest(generated),
    reviewed = await f.service.propose(input);
  assert.equal(reviewed.status, "complete");
  assert.equal(reviewed.draft.kind, "topic-textbook-review");
  assert.equal(reviewed.draft.allChecksPassed, true);
  assert.equal(reviewed.draft.json, reviewRaw);
  assert.equal(reviewed.draft.draftDigest, generated.draft.draftDigest);
  assert.notEqual(reviewed.draft.invocation.id, generated.draft.invocation.id);
  assert.deepEqual(await f.service.propose(input), reviewed);
  assert.deepEqual(f.calls, [
    { stage: "generate", raw: requestRaw },
    { stage: "review", raw: requestRaw, draft: draftRaw },
  ]);
  const records = await f.ledger.transaction((state) => state.records);
  assert.equal(records.length, 2);
  assert.ok(
    records.every((r) => r.spentMilliYen > 0 && r.state === "complete"),
  );
});

test("未発行・改変・別所有者の候補と生成IDの差し替えを送信前に拒否する", async (t) => {
  const f = await fixture(t),
    other = await fixture(t),
    generated = await f.service.propose(generateRequest());
  for (const [input, reason] of [
    [
      reviewRequest(generated, { generatorInvocation: randomUUID() }),
      /textbook-unissued-draft/,
    ],
    [
      reviewRequest(generated, { draftRaw: draftRaw + " " }),
      /textbook-unissued-draft/,
    ],
    [
      reviewRequest(generated, { requestRaw: requestRaw + " " }),
      /textbook-unissued-draft/,
    ],
    [
      reviewRequest(generated, { generationRequestId: randomUUID() }),
      /textbook-stage/,
    ],
  ])
    await assert.rejects(f.service.propose(input), reason);
  await assert.rejects(
    other.service.propose(reviewRequest(generated)),
    /textbook-unissued-draft/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(other.calls.length, 0);
  await assert.rejects(readFile(join(other.dir, "budget.json")));
  await f.ledger.transaction((state) => {
    state.records[0].draft.json += "\n";
  });
  await assert.rejects(
    f.service.propose(reviewRequest(generated, { draftRaw: draftRaw + "\n" })),
    /textbook-unissued-draft/,
  );
  assert.equal(f.calls.length, 1);
});

test("私的な項目・誤った段階・未確認の送信範囲を予約と送信の前に拒否する", async (t) => {
  const f = await fixture(t);
  for (const input of [
    generateRequest({ answers: ["個人の回答"] }),
    generateRequest({ approvedPublicText: false }),
    generateRequest({ requestId: randomUUID() }),
    generateRequest({ draftRaw }),
    generateRequest({
      requestRaw: JSON.stringify({
        ...JSON.parse(requestRaw),
        referringArticle: "個人の記事",
      }),
    }),
  ])
    await assert.rejects(f.service.propose(input));
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(join(f.dir, "budget.json")));
});

test("不正な有料出力と否定された検証でも確認済み使用量を共通台帳へ記録する", async (t) => {
  const bad = await fixture(t, {
    transport: {
      generate: async () => ({
        json: "{}",
        usage: { inputTokens: 100, outputTokens: 100 },
        outcome: "complete",
      }),
    },
  });
  assert.deepEqual(await bad.service.propose(generateRequest()), {
    status: "rejected",
    draft: null,
    outcome: "invalid-output",
  });
  assert.ok(
    (await bad.ledger.transaction((s) => s.records))[0].spentMilliYen > 0,
  );
  const negative = JSON.parse(reviewRaw);
  negative.sections[0].checks[0].passed = false;
  const f = await fixture(t, {
    transport: {
      review: async () => ({
        json: JSON.stringify(negative),
        usage: { inputTokens: 100, outputTokens: 100 },
        outcome: "complete",
      }),
    },
  });
  const generated = await f.service.propose(generateRequest());
  const reviewed = await f.service.propose(reviewRequest(generated));
  assert.equal(reviewed.status, "complete");
  assert.equal(reviewed.draft.allChecksPassed, false);
  assert.equal(
    JSON.parse(reviewed.draft.json).sections[0].checks[0].passed,
    false,
  );
  assert.ok(
    (await f.ledger.transaction((s) => s.records))[1].spentMilliYen > 0,
  );
});

test("不明な使用量を保留し、再起動や別契約でも自動送信しない", async (t) => {
  const f = await fixture(t, {
    transport: {
      generate: async () => {
        throw Error("合成の応答欠落");
      },
    },
  });
  assert.deepEqual(await f.service.propose(generateRequest()), {
    status: "unknown",
    draft: null,
  });
  const saved = (await f.ledger.transaction((s) => s.records))[0];
  assert.ok(saved.reservedMilliYen > 0);
  assert.equal(saved.spentMilliYen, 0);
  const request = JSON.parse(requestRaw);
  request.id = randomUUID();
  assert.deepEqual(
    await new GenerationService({
      ...f.config,
      ledger: new FileLedger(f.dir),
    }).propose(
      generateRequest({
        requestId: request.id,
        requestRaw: JSON.stringify(request),
      }),
    ),
    { status: "busy" },
  );
  const legacy = new GenerationService({
    ...f.config,
    contract: undefined,
    adapters: {
      fixture: {
        kind: "test-only",
        generate: async () => {
          assert.fail("保留中の送信");
        },
      },
    },
    sources: [
      {
        id: "rfc8659",
        url: "https://www.rfc-editor.org/rfc/rfc8659.html",
        checkedAt: date,
        body: "合成出典",
      },
    ],
  });
  assert.deepEqual(
    await legacy.propose({
      requestId: randomUUID(),
      bookId: "caa",
      version: "1",
      blockId: "read",
      question: "合成の質問",
      excerpt: "合成の抜粋",
      purpose: "book-addition",
      sourceIds: ["rfc8659"],
      approvedPublicText: true,
    }),
    { status: "busy" },
  );
});

test("未接続・CAA adapter・数え上げ条件未確認・予算不足では送信しない", async (t) => {
  const cases = [
    {
      adapters: { fixture: { kind: "test-only", protocol: "provider-v1" } },
      status: "unconnected",
    },
    {
      registry: [{ ...model, tokenCountTermsConfirmed: false }],
      status: "count-unconfigured",
    },
    {
      policy: { ...policy, fixedMilliYen: 500000 },
      status: "budget-exhausted",
    },
  ];
  for (const { status, ...config } of cases) {
    const f = await fixture(t, { config });
    assert.deepEqual(await f.service.propose(generateRequest()), { status });
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => topicTextbookBudgetAdapter({ protocol: "provider-v1" }));
  const f = await fixture(t, { transport: { kind: "prepared" } });
  assert.deepEqual(await f.service.propose(generateRequest()), {
    status: "unconnected",
  });
  assert.equal(f.calls.length, 0);
});

test("価格確認の失効や設定変更後も、同じ完了済み操作を再送せず取り出せる", async (t) => {
  const f = await fixture(t);
  const generated = await f.service.propose(generateRequest());
  const expired = new GenerationService({
    ...f.config,
    now: () => new Date("2026-12-20T00:00:00.000Z"),
    policy: null,
    registry: [],
    adapters: {},
  });
  assert.deepEqual(await expired.propose(generateRequest()), generated);
  const changed = new GenerationService({
    ...f.config,
    registry: [{ ...model, inputUsdMicrosPerMillion: 1000000 }],
  });
  assert.deepEqual(await changed.propose(generateRequest()), generated);
  assert.deepEqual(
    await expired.propose(generateRequest({ requestRaw: requestRaw + " " })),
    { status: "id-conflict" },
  );
  assert.equal(f.calls.length, 1);
});

test("テーマadapterをCAAへ誤接続しても予約や通信を始めない", async (t) => {
  const f = await fixture(t);
  const service = new GenerationService({ ...f.config, contract: undefined });
  const result = await service.propose({
    requestId: randomUUID(),
    bookId: "caa",
    version: "1",
    blockId: "read",
    question: "合成の質問",
    excerpt: "合成の抜粋",
    purpose: "book-addition",
    sourceIds: ["rfc8659"],
    approvedPublicText: true,
  });
  assert.deepEqual(result, { status: "unconnected" });
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(join(f.dir, "budget.json")));
});

test("読取後に別実行が完了しても、予約トランザクションは同じ操作の識別を保つ", async (t) => {
  const f = await fixture(t);
  const secondLedger = new FileLedger(f.dir),
    read = secondLedger.read.bind(secondLedger);
  let entered, release;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  secondLedger.read = async () => {
    const snapshot = await read();
    entered();
    await gate;
    return snapshot;
  };
  const second = new GenerationService({
    ...f.config,
    ledger: secondLedger,
    registry: [{ ...model, inputUsdMicrosPerMillion: 1000000 }],
  });
  const pending = second.propose(generateRequest());
  await started;
  const first = await f.service.propose(generateRequest());
  release();
  assert.deepEqual(await pending, first);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.ledger.read()).records.length, 1);
});

test("出力検査が期限を越えても確認済み費用を保持し、遅い合格を採用しない", async (t) => {
  let release, entered, ended;
  const gate = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve)),
    finished = new Promise((resolve) => (ended = resolve));
  const f = await fixture(t, {
    config: {
      timeoutMs: 20,
      contract: {
        ...topicTextbookContract,
        async validate(...args) {
          entered();
          await gate;
          try {
            return await topicTextbookContract.validate(...args);
          } finally {
            ended();
          }
        },
      },
    },
  });
  const result = f.service.propose(generateRequest());
  await started;
  assert.deepEqual(await result, {
    status: "rejected",
    draft: null,
    outcome: "cancelled",
  });
  const before = await f.ledger.transaction((s) => s.records);
  assert.ok(before[0].spentMilliYen > 0);
  release();
  await finished;
  assert.deepEqual(await f.ledger.transaction((s) => s.records), before);
  assert.equal(f.calls.length, 1);
});

test("実transportを合成HTTPへ接続し、数え上げから生成と別レビューまで共通予算で扱う", async (t) => {
  const calls = [],
    wire = JSON.parse(draftRaw),
    review = JSON.parse(reviewRaw);
  for (const lesson of wire.lessons)
    lesson.optionEvidence = Object.entries(lesson.optionEvidence).map(
      ([optionID, evidence]) => ({ optionID, evidence }),
    );
  delete review.requestDigest;
  delete review.draftDigest;
  const api = openaiTopicTextbookTransport({
    model: model.model,
    reasoningEffort: "none",
    mockOnly: true,
    secret: "synthetic-credential-not-live",
    send: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.endsWith("input_tokens"))
        return Response.json({ input_tokens: 1000 });
      return Response.json({
        model: model.model,
        service_tier: "default",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(
                  body.text.format.name === "topic_textbook" ? wire : review,
                ),
              },
            ],
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
      });
    },
  });
  const f = await fixture(t, {
    config: { adapters: { fixture: topicTextbookBudgetAdapter(api) } },
  });
  const generated = await f.service.propose(generateRequest());
  assert.equal(generated.status, "complete");
  const checked = await f.service.propose(reviewRequest(generated));
  assert.equal(checked.status, "complete");
  assert.equal(checked.draft.draftDigest, generated.draft.draftDigest);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((c) => c.url.endsWith("input_tokens")).length, 2);
  assert.ok(
    calls
      .filter((c) => c.url.endsWith("/responses"))
      .every((c) => c.body.max_output_tokens === 2000),
  );
  assert.ok((await f.ledger.read()).records.every((r) => r.spentMilliYen > 0));
});

test("送信前のtransport設定不良では共通台帳を保留せず、入力上限の理由を再取得でも保持する", async (t) => {
  for (const extra of [
    { model: "different-fixture" },
    { secret: "" },
    { send: undefined },
  ]) {
    const api = openaiTopicTextbookTransport({
      model: model.model,
      reasoningEffort: "none",
      mockOnly: true,
      secret: "synthetic-credential-not-live",
      send: async () => assert.fail("不適合な設定で送信してはいけない"),
      ...extra,
    });
    const f = await fixture(t, {
      config: { adapters: { fixture: topicTextbookBudgetAdapter(api) } },
    });
    assert.deepEqual(await f.service.propose(generateRequest()), {
      status: "unconnected",
    });
    await assert.rejects(readFile(join(f.dir, "budget.json")));
  }
  let calls = 0;
  const api = openaiTopicTextbookTransport({
    model: model.model,
    reasoningEffort: "none",
    mockOnly: true,
    secret: "synthetic-credential-not-live",
    send: async (url) => {
      assert.ok(url.endsWith("input_tokens"));
      calls++;
      return Response.json({ input_tokens: 9000 });
    },
  });
  const f = await fixture(t, {
    config: { adapters: { fixture: topicTextbookBudgetAdapter(api) } },
  });
  const result = { status: "rejected", draft: null, outcome: "input-limit" };
  assert.deepEqual(await f.service.propose(generateRequest()), result);
  assert.deepEqual(await f.service.propose(generateRequest()), result);
  assert.equal(calls, 1);
  const saved = (await f.ledger.read()).records[0];
  assert.equal(saved.spentMilliYen, 0);
  assert.equal(saved.state, "rejected");
});

test("不明または拒否された生成を、発行済み候補としてレビューできない", async (t) => {
  for (const generate of [
    async () => {
      throw Error("合成の不明な送信結果");
    },
    async () => ({
      json: "{}",
      usage: { inputTokens: 100, outputTokens: 100 },
      outcome: "complete",
    }),
  ]) {
    const f = await fixture(t, { transport: { generate } });
    const generated = await f.service.propose(generateRequest());
    assert.ok(["unknown", "rejected"].includes(generated.status));
    await assert.rejects(
      f.service.propose({
        requestId: randomUUID(),
        purpose: "evidence-check",
        requestRaw,
        approvedPublicText: true,
        generationRequestId: requestId,
        generatorInvocation: randomUUID(),
        draftRaw,
      }),
    );
    assert.equal((await f.ledger.read()).records.length, 1);
    assert.equal(f.calls.length, 0);
  }
});

for (const outcome of ["refused", "incomplete"])
  test(`${outcome}の費用と区分を保存し、同じ操作を再送しない`, async (t) => {
    let sends = 0;
    const f = await fixture(t, {
      transport: {
        generate: async () => {
          sends++;
          return {
            json: "",
            usage: { inputTokens: 100, outputTokens: 100 },
            outcome,
          };
        },
      },
    });
    const expected = { status: "rejected", draft: null, outcome };
    assert.deepEqual(await f.service.propose(generateRequest()), expected);
    assert.deepEqual(await f.service.propose(generateRequest()), expected);
    assert.equal(sends, 1);
    const saved = (await f.ledger.read()).records[0];
    assert.ok(saved.spentMilliYen > 0);
    assert.equal(saved.outcome, outcome);
  });

test("完了済みCAA記録とテーマ候補を同じ永続台帳で保持する", async (t) => {
  const f = await fixture(t),
    generated = await f.service.propose(generateRequest());
  const draft = {
    gap: "合成の追加説明",
    block: {
      id: "fixture-extra",
      title: "追加の説明",
      kind: "reading",
      markdown: "合成の出典に基づく説明です。",
    },
    references: [{ sourceId: "rfc8659", quote: "合成出典" }],
  };
  const service = new GenerationService({
    ...f.config,
    contract: undefined,
    sources: [
      {
        id: "rfc8659",
        url: "https://www.rfc-editor.org/rfc/rfc8659.html",
        checkedAt: date,
        body: "合成出典",
      },
    ],
    adapters: {
      fixture: {
        kind: "test-only",
        protocol: "provider-v1",
        generate: async () => ({
          json: JSON.stringify(draft),
          usage: { inputTokens: 100, outputTokens: 100 },
        }),
      },
    },
  });
  const input = {
    requestId: randomUUID(),
    bookId: "caa",
    version: "1",
    blockId: "read",
    question: "合成の質問",
    excerpt: "合成の抜粋",
    purpose: "book-addition",
    sourceIds: ["rfc8659"],
    approvedPublicText: true,
  };
  assert.deepEqual(await service.propose(input), { status: "complete", draft });
  assert.deepEqual(await f.service.propose(generateRequest()), generated);
  const records = (await new FileLedger(f.dir).read()).records;
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].draft, generated.draft);
  assert.deepEqual(records[1].draft, draft);
});

test("同じ操作が予約中なら候補を返さず、送信を重ねない", async (t) => {
  let entered,
    release,
    sends = 0;
  const started = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const f = await fixture(t, {
    transport: {
      generate: async () => {
        sends++;
        entered();
        await gate;
        return {
          json: draftRaw,
          usage: { inputTokens: 100, outputTokens: 100 },
          outcome: "complete",
        };
      },
    },
  });
  const pending = f.service.propose(generateRequest());
  await started;
  try {
    assert.deepEqual(await f.service.propose(generateRequest()), {
      status: "reserved",
      draft: null,
    });
    assert.equal(sends, 1);
  } finally {
    release();
  }
  assert.equal((await pending).status, "complete");
});
