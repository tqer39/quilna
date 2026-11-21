import { expect, it } from "vitest";
import { interestHeadlines, interestWords } from "../src/headline-interests";
import type { FeedArticle } from "../src/feed-parser";

it("全配信元を先頭ページの後まで調べ、既読を除いた最新50件だけを順番に残す", () => {
  const articles: FeedArticle[] = Array.from({ length: 112 }, (_, i) => ({
    id: String(i),
    title: i % 2 === 0 && i >= 60 ? "ＡＩの速報" : "今日の速報",
    sourceTags: i >= 60 && i % 2 ? ["AI"] : [],
    read: i === 60,
    feedUrl: "",
    url: "",
    saved: false,
    body: "AI",
    published: null,
    fetchedAt: "",
  }));
  const words = interestWords(" ＡＩ，AI、 宇宙 ");
  expect(words).toEqual(["ai", "宇宙"]);
  const queue = interestHeadlines(articles, words);
  expect(queue.map((article) => article.id)).toEqual(
    articles.slice(61, 111).map((article) => article.id),
  );
  expect(interestHeadlines(articles, [])).toEqual([]);
});
it("関心の個数と長さの上限を超えた入力を拒む", () => {
  expect(() => interestWords("あ".repeat(41))).toThrow();
  expect(() => interestWords("1、2、3、4、5、6、7、8、9")).toThrow();
});
