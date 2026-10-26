import { expect, test } from "vitest";
import { articlePage } from "../src/article-page";
import type { FeedArticle } from "../src/feed-parser";
const article = (
  id: string,
  patch: Partial<FeedArticle> = {},
): FeedArticle => ({
  id,
  feedUrl: "source-a",
  title: id,
  url: "",
  body: "本文",
  saved: false,
  read: false,
  published: null,
  fetchedAt: "2026-10-27T00:00:00Z",
  ...patch,
});
const all = {
  matched: null,
  source: "",
  filter: "all",
  tagFilter: "",
  page: 0,
  pageSize: 50,
};
const ids = (items: FeedArticle[]) => items.map((item) => item.id);

test("all matches are counted and ordered pages clamp correctly when the library shrinks", () => {
  const articles = Array.from({ length: 121 }, (_, i) => article(String(i)));
  const first = articlePage(articles, all);
  expect(first.count).toBe(121);
  expect(ids(first.items)).toEqual(
    Array.from({ length: 50 }, (_, i) => String(i)),
  );
  const last = articlePage(articles, { ...all, page: 9 });
  expect(last.page).toBe(2);
  expect(ids(last.items)).toEqual(
    Array.from({ length: 21 }, (_, i) => String(100 + i)),
  );
  const exactBoundary = articlePage(articles.slice(0, 100), {
    ...all,
    page: 2,
  });
  expect(exactBoundary.page).toBe(1);
  expect(ids(exactBoundary.items)).toEqual(
    Array.from({ length: 50 }, (_, i) => String(50 + i)),
  );
  expect(articlePage([], { ...all, page: 9 })).toEqual({
    count: 0,
    page: 0,
    items: [],
  });
  expect(first.count).toBe(121);
  expect(first.items[0].id).toBe("0");
});

test("tag, source, search and read filters intersect without reviving overridden automatic tags", () => {
  const tags = {
    version: 1 as const,
    state: "classified" as const,
    suggestions: [{ tag: "技術・開発", evidence: ["database"] }],
  };
  const articles = [
    article("auto", { tags, saved: true }),
    article("removed", { tags, manualTags: [], saved: true }),
    article("manual", { tags, manualTags: ["仕事"], saved: true }),
    article("other-source", { tags, feedUrl: "source-b", saved: true }),
    article("read", { tags, read: true }),
    article("pending"),
  ];
  const tagged = { ...all, tagFilter: "tag:技術・開発" };
  expect(ids(articlePage(articles, tagged).items)).toEqual([
    "auto",
    "other-source",
    "read",
  ]);
  expect(
    ids(
      articlePage(articles, { ...tagged, source: "source-a", filter: "unread" })
        .items,
    ),
  ).toEqual(["auto"]);
  expect(
    ids(
      articlePage(articles, {
        ...tagged,
        filter: "saved",
        matched: new Set(["auto", "read", "missing"]),
      }).items,
    ),
  ).toEqual(["auto"]);
  expect(
    ids(articlePage(articles, { ...all, tagFilter: "state:手動設定" }).items),
  ).toEqual(["removed", "manual"]);
  expect(
    ids(articlePage(articles, { ...all, tagFilter: "state:未処理" }).items),
  ).toEqual(["pending"]);
  expect(articlePage(articles, { ...all, matched: new Set() }).count).toBe(0);
  articles[0] = { ...articles[0], manualTags: ["仕事"] };
  expect(ids(articlePage(articles, tagged).items)).toEqual([
    "other-source",
    "read",
  ]);
  expect(
    ids(articlePage(articles, { ...all, tagFilter: "tag:仕事" }).items),
  ).toEqual(["auto", "manual"]);
});
