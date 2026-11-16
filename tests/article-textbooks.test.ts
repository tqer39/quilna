import { expect, it } from "vitest";
import { BackupCounter, backupEntry } from "../src/library-backup-format";
import fixture from "./fixtures/shared-textbook-v2.json";
import {
  parseSharedTextbook,
  sharedTextbookDigest,
} from "../src/shared-textbook-format";
import {
  textbookLinkSource,
  textbookLinkTarget,
  textbookLinkKey,
  validTextbookLink,
  type TextbookLink,
  type TextbookReading,
} from "../src/article-textbooks";

const reading: TextbookReading = {
  articleId: "article-a",
  title: "元の記事",
  url: "https://example.org/article",
  original: "古い原文",
  text: "古い原文",
  view: "original",
  language: "en",
};
it("参照を固定している間に画面の本文が変わっても、古い本文・言語・版を混在させない", async () => {
  const view = { ...reading };
  const pending = textbookLinkSource(view);
  Object.assign(view, {
    original: "新しい原文",
    text: "新しい訳文",
    view: "translation",
    language: "ja",
    title: "新しい題名",
  });
  const source = await pending;
  expect(source).toMatchObject({
    title: "元の記事",
    excerpt: "古い原文",
    view: "original",
    language: "en",
  });
  expect(source.version).toBe(
    await sharedTextbookDigest(
      new TextEncoder().encode(
        JSON.stringify(["古い原文", "古い原文", "original", "en"]),
      ),
    ),
  );
});
it("長い参照元でも文字を途中で壊さず、表示した訳と原文を識別する", async () => {
  const original = await textbookLinkSource({
    ...reading,
    text: "あ".repeat(999) + "😀末尾",
  });
  expect(Array.from(original.excerpt)).toHaveLength(1000);
  expect(original.excerpt.endsWith("😀")).toBe(true);
  const translated = await textbookLinkSource({
    ...reading,
    view: "translation",
    language: "ja",
  });
  expect(translated.version).not.toBe(
    (await textbookLinkSource(reading)).version,
  );
});
it("関連理由と参照先の厳密な記録だけを受け付け、個人項目や識別子の不整合を拒否する", async () => {
  const book = await parseSharedTextbook(JSON.stringify(fixture));
  const record: TextbookLink = {
    id: textbookLinkKey(reading.articleId, book.id),
    source: await textbookLinkSource(reading),
    target: textbookLinkTarget(book),
    reason: "モデルと保存処理の区別を学ぶ",
    createdAt: "2026-11-17T00:00:00.000Z",
    revision: 1,
  };
  expect(validTextbookLink(record)).toBe(true);
  for (const invalid of [
    { ...record, id: "別の記事" },
    { ...record, reason: " " },
    { ...record, revision: 0 },
    { ...record, answers: ["PRIVATE"] },
    { ...record, source: { ...record.source, credentials: "PRIVATE" } },
    { ...record, target: { ...record.target, notes: "PRIVATE" } },
  ])
    expect(validTextbookLink(invalid)).toBe(false);
});

it("教材版の整数上限を越える関連づけを復元対象にしない", async () => {
  const book = await parseSharedTextbook(JSON.stringify(fixture));
  const target = {
    ...textbookLinkTarget(book),
    id: `${book.id.split(":")[0]}:2147483648`,
  };
  expect(
    validTextbookLink({
      id: textbookLinkKey(reading.articleId, target.id),
      source: await textbookLinkSource(reading),
      target,
      reason: "理由",
      createdAt: "2026-11-17T00:00:00Z",
      revision: 1,
    }),
  ).toBe(false);
});

it("バックアップ検証で記事ごと20件・全体20,000件を越える関連づけを拒否する", async () => {
  const book = await parseSharedTextbook(JSON.stringify(fixture));
  const source = await textbookLinkSource(reading),
    target = textbookLinkTarget(book);
  const entry = (articleId: string, edition: number) => {
    const t = { ...target, id: `${book.id.split(":")[0]}:${edition}` };
    return backupEntry("textbookLinks", {
      id: textbookLinkKey(articleId, t.id),
      source: { ...source, articleId },
      target: t,
      reason: "理由",
      createdAt: "2026-11-17T00:00:00Z",
      revision: 1,
    });
  };
  const perArticle = new BackupCounter();
  for (let i = 1; i <= 20; i++) perArticle.add(entry("a", i));
  expect(() => perArticle.add(entry("a", 21))).toThrow("上限");
  const total = new BackupCounter();
  for (let i = 0; i < 20_000; i++) total.add(entry(`article-${i}`, 1));
  expect(() => total.add(entry("one-more", 1))).toThrow("上限");
});
