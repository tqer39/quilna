import { expect, it, vi } from "vitest";
import fixture from "./fixtures/shared-textbook-v2.json";
import {
  generatedTopicBook,
  newTopicOperation,
} from "../src/topic-generation-store";
import { createTopicTextbookEdition } from "../src/topic-textbook-edition";
import { parseTextbookCandidate } from "../src/shared-textbook-format";
import type {
  TopicQuote,
  TopicTextbookEnvelope,
} from "../src/topic-generation-protocol";
vi.mock("../src/library-context", () => ({
  libraryAccount: () => "a".repeat(64),
  libraryName: (name: string) => name,
}));
const decode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const record = JSON.parse(decode(fixture.record)),
  requestRaw = decode(record.request),
  draftRaw = decode(record.draft),
  reviewRaw = decode(record.review);
const content = await parseTextbookCandidate(requestRaw, draftRaw);
const quote: TopicQuote = {
  modelId: "fixture",
  provider: "openai",
  model: "fixture",
  purpose: "book-addition",
  maxMilliYen: 1000,
  quoteDigest: "c".repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "合成検証のみ",
  priceCheckedAt: "2026-11-18T00:00:00Z",
  costCheckedAt: "2026-11-18T00:00:00Z",
};
const draft: TopicTextbookEnvelope = {
  kind: "topic-textbook-draft",
  requestDigest: content.requestDigest,
  draftDigest: content.draftDigest,
  json: draftRaw,
  invocation: { ...record.generator, provider: "openai", model: "fixture" },
};
const checked: TopicTextbookEnvelope = {
  ...draft,
  kind: "topic-textbook-review",
  json: reviewRaw,
  allChecksPassed: true,
  invocation: { ...record.reviewer, provider: "openai", model: "fixture" },
};

it("旧画面と背景処理が同じ入力から同じ教材版を作り、保存失敗は日本語で案内する", async () => {
  const root = await newTopicOperation(
    {
      requestId: content.request.id.toLowerCase(),
      purpose: "book-addition",
      requestRaw,
      modelId: quote.modelId,
      approvedPublicText: true,
      approvedMaxMilliYen: quote.maxMilliYen,
      approvedQuoteDigest: quote.quoteDigest,
    },
    quote,
  );
  const reviewQuote: TopicQuote = { ...quote, purpose: "evidence-check" };
  const review = await newTopicOperation(
    {
      ...root.input,
      requestId: crypto.randomUUID(),
      purpose: "evidence-check",
      generationRequestId: root.id,
      generatorInvocation: draft.invocation.id.toLowerCase(),
      draftRaw,
    },
    reviewQuote,
    root,
  );
  const fromUI = await generatedTopicBook(root, review, draft, checked);
  const fromBackground = await createTopicTextbookEdition({
    bookID: root.bookID,
    createdAt: root.createdAt,
    requestRaw,
    draft,
    checked,
    generationQuote: quote,
    reviewQuote,
  });
  expect(fromBackground.raw).toBe(fromUI.raw);
  await expect(
    generatedTopicBook(
      root,
      review,
      { ...draft, draftDigest: "0".repeat(64) },
      checked,
    ),
  ).rejects.toThrow(
    "作成の控えの形式を確認できません。記録は変更していません。対応するアプリの版を確認してください。",
  );
});
