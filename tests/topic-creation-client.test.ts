import { it, expect } from "vitest";
import fixture from "./fixtures/shared-textbook-v2.json";
import { TopicGenerationClient } from "../src/topic-generation-client";
import { sharedTextbookDigest } from "../src/shared-textbook-format";
import type { TopicCreation } from "../src/topic-creation-protocol";
const decode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const record = JSON.parse(decode(fixture.record));
record.generator.provider = record.reviewer.provider = "openai";
record.version = 1;
const raw = decode(record.request),
  request = JSON.parse(raw),
  account = "a".repeat(64);
const encode = (s: string) =>
  btoa(
    Array.from(new TextEncoder().encode(s), (c) => String.fromCharCode(c)).join(
      "",
    ),
  );
const book = JSON.stringify({
  ...fixture,
  record: encode(JSON.stringify(record)),
});
const generation = {
  provider: "openai" as const,
  modelId: "fixture",
  model: "fixture",
  purpose: "book-addition" as const,
  maxMilliYen: 1000,
  quoteDigest: "c".repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "合成データのみ",
  priceCheckedAt: "2026-11-18T00:00:00Z",
  costCheckedAt: "2026-11-18T00:00:00Z",
};
const review = {
  ...generation,
  purpose: "evidence-check" as const,
  quoteDigest: "d".repeat(64),
};
const c: TopicCreation = {
  id: request.id.toLowerCase(),
  bookID: record.bookID,
  reviewRequestId: crypto.randomUUID(),
  revision: await sharedTextbookDigest(
    new TextEncoder().encode(JSON.stringify(raw)),
  ),
  state: "draft",
  stage: "generation",
  title: request.topic.name,
  learningGoal: request.learningGoal,
  requestRaw: raw,
  createdAt: 1800000000000,
  updatedAt: 1800000000000,
  quotes: null,
  reason: "",
  operation: null,
  book: null,
};
const capabilities = {
  account,
  mode: "test-only",
  csrfToken: "synthetic-csrf-token-for-tests",
  quotes: [generation, review],
  creations: { available: true, enabled: true },
  budget: {
    limitMilliYen: 500000,
    spentMilliYen: 0,
    heldMilliYen: 0,
    fixedMilliYen: null,
    safetyMilliYen: null,
  },
};
const signal = () => new AbortController().signal;
function setup(
  reply: unknown = { account, creation: c },
  status = capabilities,
) {
  const calls: { url: string; input: RequestInit | undefined }[] = [];
  let owner: string | null = account,
    lost = 0;
  const client = new TopicGenerationClient(
    account,
    () => owner,
    () => {
      lost++;
    },
    async (url, input) => {
      calls.push({ url: String(url), input });
      return Response.json(String(url).endsWith("/status") ? status : reply);
    },
  );
  return {
    client,
    calls,
    lost: () => lost,
    owner: (value: string | null) => (owner = value),
  };
}
it("草案の同じ原文と受付IDを保存し、CSRFと所有者を固定する", async () => {
  const f = setup();
  const reply = await f.client.creations("save", { requestRaw: raw }, signal());
  expect(reply.creation).toEqual(c);
  expect(f.calls.map((c) => c.url)).toEqual([
    "/api/topic-textbooks/status",
    "/api/topic-textbooks/creations/save",
  ]);
  expect(f.calls[1].input?.headers).toMatchObject({
    "X-Library-Account": account,
    "X-CSRF-Token": capabilities.csrfToken,
  });
  expect(JSON.parse(String(f.calls[1].input?.body))).toEqual({
    requestRaw: raw,
  });
});
it("構造が壊れた別アカウント応答でも本人性を失効させる", async () => {
  const f = setup({
    account: "b".repeat(64),
    creation: { private: "invalid" },
  });
  await expect(
    f.client.creations("read", { id: c.id }, signal()),
  ).rejects.toHaveProperty("code", "account-mismatch");
  expect(f.lost()).toBe(1);
});
for (const field of [
  "id",
  "revision",
  "requestRaw",
  "title",
  "learningGoal",
] as const)
  it(`${field}が指定した依頼と違う控えを拒否する`, async () => {
    const changed = {
      ...c,
      [field]:
        field === "id"
          ? crypto.randomUUID()
          : field === "revision"
            ? "f".repeat(64)
            : c[field] + "変更",
    };
    const f = setup({ account, creation: changed });
    await expect(
      f.client.creations("read", { id: c.id }, signal()),
    ).rejects.toHaveProperty("code", "invalid-response");
  });
it("検証済み完成版の原文・教材ID・承認モデルを照合する", async () => {
  const ready = { ...c, state: "ready", quotes: { generation, review }, book };
  const f = setup({ account, creation: ready });
  expect(
    (await f.client.creations("read", { id: c.id }, signal())).creation?.book,
  ).toBe(book);
  for (const patch of [
    { bookID: crypto.randomUUID() },
    { quotes: { generation: { ...generation, model: "別モデル" }, review } },
    { book: book.replace("TsumikiText", "invalid") },
  ]) {
    const g = setup({ account, creation: { ...ready, ...patch } });
    await expect(
      g.client.creations("read", { id: c.id }, signal()),
    ).rejects.toHaveProperty("code", "invalid-response");
  }
});
it("未知の私的なフィールドと重複した一覧や続き位置を拒否する", async () => {
  const f = setup({ account, creation: { ...c, privateNotes: "漏洩" } });
  await expect(
    f.client.creations("read", { id: c.id }, signal()),
  ).rejects.toHaveProperty("code", "invalid-response");
  const row = {
    id: c.id,
    title: c.title,
    state: c.state,
    stage: c.stage,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    reason: c.reason,
  };
  for (const items of [[row, row], [row]]) {
    const g = setup({ account, creations: items, next: c.id });
    await expect(
      g.client.creations("list", { after: c.id }, signal()),
    ).rejects.toHaveProperty("code", "invalid-response");
  }
});
it("無効な受付先では送信せず、停止中も保存結果の読取だけを行う", async () => {
  const f = setup(undefined, {
    ...capabilities,
    creations: { available: false, enabled: false },
  });
  await expect(
    f.client.creations("save", { requestRaw: raw }, signal()),
  ).rejects.toHaveProperty("code", "topic-creations-unconfigured");
  expect(f.calls).toHaveLength(1);
  const g = setup(undefined, {
    ...capabilities,
    creations: { available: true, enabled: false },
  });
  expect(
    (await g.client.creations("read", { id: c.id }, signal())).creation?.id,
  ).toBe(c.id);
  await expect(
    g.client.creations(
      "approve",
      {
        id: c.id,
        expectedRevision: c.revision,
        confirm: true,
        approvedPublicText: true,
        generation,
        review,
      },
      signal(),
    ),
  ).rejects.toHaveProperty("code", "topic-creations-unconfigured");
  expect(g.calls).toHaveLength(3);
});
it("不正な依頼や中止済み/変わった所有者で受付を送らない", async () => {
  const f = setup();
  await expect(
    f.client.creations("save", { requestRaw: "{}" }, signal()),
  ).rejects.toHaveProperty("code", "invalid-request");
  expect(f.calls).toHaveLength(0);
  const stop = new AbortController();
  stop.abort();
  await expect(
    f.client.creations("read", { id: c.id }, stop.signal),
  ).rejects.toHaveProperty("code", "cancelled");
  f.owner(null);
  await expect(
    f.client.creations("read", { id: c.id }, signal()),
  ).rejects.toHaveProperty("code", "account-mismatch");
  expect(f.calls).toHaveLength(0);
});
it("構造が不正なstatusも別の所有者なら失効し、段階IDの不一致を拒否する", async () => {
  const f = setup(undefined, {
    ...capabilities,
    account: "b".repeat(64),
    csrfToken: "bad",
  });
  await expect(
    f.client.creations("read", { id: c.id }, signal()),
  ).rejects.toHaveProperty("code", "account-mismatch");
  expect(f.lost()).toBe(1);
  expect(f.calls).toHaveLength(1);
  const g = setup({
    account,
    creation: {
      ...c,
      operation: { id: crypto.randomUUID(), state: "unavailable" },
    },
  });
  await expect(
    g.client.creations("read", { id: c.id }, signal()),
  ).rejects.toHaveProperty("code", "invalid-response");
});
it("承認応答の費用と追加検証IDを照合し、不一致を成功扱いにしない", async () => {
  const input = {
    id: c.id,
    expectedRevision: c.revision,
    confirm: true as const,
    approvedPublicText: true as const,
    generation,
    review,
  };
  const f = setup();
  await expect(
    f.client.creations("approve", input, signal()),
  ).rejects.toHaveProperty("code", "invalid-response");
  const admitted = {
    ...c,
    state: "review",
    stage: "review",
    quotes: { generation, review },
    reviewRequestId: crypto.randomUUID(),
  };
  const g = setup({ account, creation: admitted });
  await expect(
    g.client.creations(
      "review-again",
      {
        id: c.id,
        expectedRevision: c.revision,
        confirm: true,
        approvedPublicText: true,
        quote: review,
        reviewRequestId: crypto.randomUUID(),
      },
      signal(),
    ),
  ).rejects.toHaveProperty("code", "invalid-response");
  const h = setup({ account, creation: admitted });
  expect(
    (
      await h.client.creations(
        "review-again",
        {
          id: c.id,
          expectedRevision: c.revision,
          confirm: true,
          approvedPublicText: true,
          quote: review,
          reviewRequestId: admitted.reviewRequestId,
        },
        signal(),
      )
    ).creation?.reviewRequestId,
  ).toBe(admitted.reviewRequestId);
});
it("作成権限の拒否はログアウト扱いにせず、保存記録の読取を続けられる", async () => {
  let lost = 0;
  const client = new TopicGenerationClient(
    account,
    () => account,
    () => {
      lost++;
    },
    async (url) =>
      String(url).endsWith("/status")
        ? Response.json(capabilities)
        : Response.json(
            { account, status: "topic-author-forbidden" },
            { status: 403 },
          ),
  );
  await expect(
    client.creations("save", { requestRaw: raw }, signal()),
  ).rejects.toHaveProperty("code", "topic-author-forbidden");
  expect(lost).toBe(0);
});
