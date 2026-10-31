import { test, expect } from "vitest";
import { normalizeSourceTags, validSourceTags } from "../src/source-tags";
import {
  classifyArticle,
  tagRules,
  effectiveTags,
  validArticleTags,
} from "../src/article-tags";
import {
  representationHash,
  sourceContent,
  validDocumentContent,
} from "../src/source-document";
import { ArticleSearch } from "../src/article-search";
import { articlePage } from "../src/article-page";
import type { FeedArticle } from "../src/feed-parser";
const article: FeedArticle = {
  id: "a",
  feedUrl: "",
  url: "https://example.org/a",
  title: "AIエージェントとCodex",
  body: "",
  read: false,
  saved: false,
  published: null,
  fetchedAt: "2026-10-31T00:00:00Z",
};
test("publisher labels are bounded, normalized, deduplicated and never treated as markup", () => {
  expect(
    normalizeSourceTags([
      " ＡＩ ",
      "ai",
      "a\nb",
      "x".repeat(61),
      "<script>literal</script>",
    ]),
  ).toEqual(["AI", "a b", "<script>literal</script>"]);
  expect(
    normalizeSourceTags(Array.from({ length: 30 }, (_, i) => `t${i}`)),
  ).toHaveLength(20);
  expect(validSourceTags(["bad\nlabel"])).toBe(false);
  expect(validSourceTags(["x".repeat(61)])).toBe(false);
});
test("titles and publisher clues classify missing-body entries without classifying URL metadata", () => {
  const tags = classifyArticle(article);
  expect(tags.version).toBe(2);
  expect(tags.suggestions.map((t) => t.tag)).toContain("AI・機械学習");
  expect(validArticleTags(tags)).toBe(true);
  expect(
    classifyArticle({
      ...article,
      title: "A story",
      body: "Article URL: https://example.org/ai/codex",
    }).state,
  ).toBe("no-content");
  const fromPublisher = classifyArticle({
    ...article,
    title: "A story",
    sourceTags: ["WebAssembly"],
  });
  expect(fromPublisher.suggestions[0].evidence).toContain("配信元:webassembly");
});
test("all three tag layers remain searchable and filterable when personal tags are cleared", async () => {
  const a = {
    ...article,
    sourceTags: ["配信元分類"],
    tags: classifyArticle(article),
    manualTags: ["自分専用"],
  };
  const search = new ArticleSearch();
  await search.prepare([a]);
  for (const query of ["配信元分類", "AI・機械学習", "自分専用"])
    expect([...search.search(query)]).toEqual(["a"]);
  a.manualTags = [];
  search.update(a);
  expect([...search.search("自分専用")]).toEqual([]);
  expect(effectiveTags(a)).toContain("配信元分類");
  expect(
    articlePage([a], {
      matched: null,
      source: "",
      filter: "all",
      tagFilter: "tag:配信元分類",
      page: 0,
      pageSize: 50,
    }).count,
  ).toBe(1);
});
test("publisher metadata participates in immutable representation identity without changing old hashes", async () => {
  const old = {
    text: "A retained original.",
    url: article.url,
    title: "Original",
    language: "en",
    fetchedAt: article.fetchedAt,
  };
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([1, old.text, old.url, old.title, old.language, null]),
    ),
  );
  expect(await representationHash(old)).toBe(
    Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  );
  const tagged = { ...old, sourceTags: ["Publisher"] };
  expect(sourceContent(tagged).sourceTags).toEqual(["Publisher"]);
  expect(await representationHash(tagged)).not.toBe(
    await representationHash(old),
  );
  expect(validDocumentContent({ ...old, sourceTags: [42] })).toBe(false);
});

test("all dictionary matches remain valid bounded stored evidence", () => {
  const tags = classifyArticle({
    ...article,
    title: tagRules.flatMap((r) => r.terms).join(" "),
  });
  expect(validArticleTags(tags)).toBe(true);
  expect(tags.suggestions).toHaveLength(8);
  expect(tags.suggestions[0].evidence).toHaveLength(20);
});
