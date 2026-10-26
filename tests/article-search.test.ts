import { expect, test } from "vitest";
import { ArticleSearch } from "../src/article-search";
import type { FeedArticle } from "../src/feed-parser";
const article = (id: string, body: string): FeedArticle => ({
  id,
  body,
  title: "題名",
  feedUrl: "https://example.org/rss",
  url: "https://example.org/a",
  published: null,
  fetchedAt: "2026-10-24T00:00:00Z",
  read: false,
  saved: false,
});
test("search normalizes width and case, uses AND terms and only current translations", async () => {
  const index = new ArticleSearch();
  const a = article("one", "SQLite 分散データベース");
  await index.prepare([
    a,
    {
      ...article("two", "other"),
      translation: {
        text: "日本語の訳",
        sourceText: "other",
        sourceLanguage: "en",
        targetLanguage: "ja",
      },
    },
    {
      ...article("three", "changed"),
      translation: {
        text: "古い翻訳",
        sourceText: "old",
        sourceLanguage: "en",
        targetLanguage: "ja",
      },
    },
  ]);
  expect([...index.search("ＳＱＬｉｔｅ　データ")]).toEqual(["one"]);
  expect([...index.search("日本語")]).toEqual(["two"]);
  expect([...index.search("古い翻訳")]).toEqual([]);
  expect([...index.search("sqlite 不存在")]).toEqual([]);
});
test("a superseded preparation cannot publish stale documents", async () => {
  const index = new ArticleSearch();
  let release!: () => void;
  const pending = index.prepare(
    [article("old", "old")],
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  expect(() => index.search("old")).toThrow();
  await index.prepare([article("new", "new")]);
  release();
  expect(await pending).toBe(false);
  expect([...index.search("old")]).toEqual([]);
  expect([...index.search("new")]).toEqual(["new"]);
});
test("reindex reflects edited originals and removals", async () => {
  const index = new ArticleSearch();
  await index.prepare([article("one", "old"), article("removed", "old")]);
  await index.prepare([article("one", "new")]);
  expect([...index.search("old")]).toEqual([]);
  expect([...index.search("new")]).toEqual(["one"]);
});

test("incremental updates replace original and translated search terms", async () => {
  const index = new ArticleSearch();
  const a = article("one", "before");
  await index.prepare([a, article("two", "unchanged")]);
  index.update({
    ...a,
    body: "after",
    translation: {
      text: "更新された訳",
      sourceText: "after",
      sourceLanguage: "en",
      targetLanguage: "ja",
    },
  });
  expect([...index.search("before")]).toEqual([]);
  expect([...index.search("after")]).toEqual(["one"]);
  expect([...index.search("更新された訳")]).toEqual(["one"]);
  expect([...index.search("unchanged")]).toEqual(["two"]);
  index.invalidate();
  expect(() => index.search("after")).toThrow();
});

test("repeated queries change after writes, preserve returned snapshots and discard removed documents", async () => {
  const index = new ArticleSearch();
  const a = article("one", "before"),
    b = article("two", "after");
  await index.prepare([a, b]);
  const previous = index.search("before");
  expect([...index.search("after")]).toEqual(["two"]);
  index.update({ ...a, body: "after" });
  index.update({ ...b, body: "before" });
  expect([...previous]).toEqual(["one"]);
  expect([...index.search("before")]).toEqual(["two"]);
  expect([...index.search("after")]).toEqual(["one"]);
  const returned = index.search("before");
  returned.clear();
  expect([...index.search("before")]).toEqual(["two"]);
  await index.prepare([{ ...a, body: "after" }]);
  expect([...index.search("before")]).toEqual([]);
  expect([...index.search("after")]).toEqual(["one"]);
});

test("broad cached results remain correct through writes, eviction and replacement", async () => {
  const index = new ArticleSearch();
  const corpus = Array.from({ length: 6000 }, (_, i) =>
    article(String(i), "shared broad text"),
  );
  await index.prepare(corpus);
  const snapshot = index.search("shared");
  expect(snapshot.size).toBe(6000);
  // Fourteen broad queries exceed the aggregate ID budget before the query
  // count limit. Evicted queries must still return complete current results.
  for (let i = 1; i <= 14; i++)
    expect(index.search("shared ".repeat(i)).size).toBe(6000);
  // More than sixteen distinct queries forces eviction. Subsequent searches
  // must still include all matches and reflect changes on either side of it.
  for (let i = 0; i < 18; i++) index.search(`missing-${i}`);
  index.update(article("0", "changed"));
  expect(index.search("shared").size).toBe(5999);
  index.update(article("1", "changed"));
  expect(index.search("shared").size).toBe(5998);
  expect(snapshot.size).toBe(6000);
  snapshot.clear();
  expect(index.search("shared").has("2")).toBe(true);
  await index.prepare([article("new", "shared")]);
  expect([...index.search("shared")]).toEqual(["new"]);
});

test("writes crossing the aggregate cache budget keep every result current", async () => {
  const index = new ArticleSearch();
  await index.prepare([
    ...Array.from({ length: 5000 }, (_, i) => article(String(i), "shared")),
    article("changing", "other"),
  ]);
  const queries = Array.from({ length: 16 }, (_, i) => "shared ".repeat(i + 1));
  for (const query of queries) expect(index.search(query).size).toBe(5000);
  index.update(article("changing", "shared"));
  for (const query of queries) {
    const result = index.search(query);
    expect(result.size).toBe(5001);
    expect(result.has("changing")).toBe(true);
  }
  index.update(article("changing", "other"));
  for (const query of queries) expect(index.search(query).size).toBe(5000);
});
