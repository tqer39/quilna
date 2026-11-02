import { test, expect } from "vitest";
import {
  classifyArticle,
  effectiveTags,
  normalizeManualTags,
} from "../src/article-tags";
import { ArticleSearch } from "../src/article-search";
import type { FeedArticle } from "../src/feed-parser";
const article = (title: string, body: string): FeedArticle => ({
  id: "a",
  title,
  body,
  feedUrl: "",
  url: "https://example.org/a",
  saved: false,
  read: false,
  published: null,
  fetchedAt: "2026-10-24T00:00:00Z",
});
test("classifies Japanese and English clues with visible reasons and avoids substring/repetition false positives", () => {
  const result = classifyArticle(
    article(
      "SQLite tutorial",
      "A software developer explains database transactions in this step by step walkthrough.",
    ),
  );
  expect(result.suggestions.map((item) => item.tag)).toEqual([
    "技術・開発",
    "手順・解説",
  ]);
  expect(result.suggestions[0].evidence).toContain("sqlite");
  expect(
    classifyArticle(
      article(
        "日常の出来事",
        "これは機械学習と人工知能に関する研究と実験です。本文をここに記録します。",
      ),
    ).suggestions.map((item) => item.tag),
  ).toEqual(["AI・機械学習", "科学・研究"]);
  expect(
    classifyArticle(article("Capital ship", "research research research"))
      .state,
  ).toBe("unclassified");
  expect(
    classifyArticle(
      article(
        "SQLite",
        "Article URL: https://example.org/a\nComments URL: https://news.example.org",
      ),
    ).state,
  ).toBe("classified");
});
test("classifies only a translation matching the current source; personal tags remain independent", () => {
  const a = article("A story", "A personal recollection.");
  a.translation = {
    text: "機械学習と人工知能",
    sourceText: "stale original",
    sourceLanguage: "en",
    targetLanguage: "ja",
  };
  expect(classifyArticle(a).suggestions).toEqual([]);
  a.translation.sourceText = a.body;
  a.tags = classifyArticle(a);
  expect(effectiveTags(a)).toEqual(["AI・機械学習"]);
  a.manualTags = ["仕事"];
  a.tags = classifyArticle({ ...a, title: "SQLite tutorial" });
  expect(effectiveTags(a)).toEqual([
    "技術・開発",
    "AI・機械学習",
    "手順・解説",
    "仕事",
  ]);
  a.manualTags = [];
  expect(effectiveTags(a)).toEqual([
    "技術・開発",
    "AI・機械学習",
    "手順・解説",
  ]);
});
test("normalizes user tags, rejects excessive input, and keeps search aligned with effective tags", async () => {
  expect(normalizeManualTags([" ＳＱＬ ", "sql", " AI・機械学習 "])).toEqual([
    "sql",
    "AI・機械学習",
  ]);
  expect(() => normalizeManualTags(["a".repeat(31)])).toThrow();
  expect(() =>
    normalizeManualTags(Array.from({ length: 13 }, (_, i) => `tag${i}`)),
  ).toThrow();
  const a = article("An article", "Text");
  const search = new ArticleSearch();
  await search.prepare([{ ...a, manualTags: ["仕事"] }]);
  expect([...search.search("仕事")]).toEqual(["a"]);
  search.update({ ...a, manualTags: ["家庭"] });
  expect([...search.search("仕事")]).toEqual([]);
  expect([...search.search("家庭")]).toEqual(["a"]);
});
