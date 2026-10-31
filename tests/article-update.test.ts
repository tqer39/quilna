import { describe, expect, it } from "vitest";
import { nextArticleUpdate, validArticleUpdate } from "../src/article-update";
import { feedRepresentation, validFeedRevision } from "../src/feed-revision";
import type { FeedArticle } from "../src/feed-parser";
const article: FeedArticle = {
  id: "a",
  feedUrl: "https://example.org/feed",
  title: "Title",
  url: "https://example.org/a",
  body: "Summary",
  saved: false,
  read: false,
  published: null,
  fetchedAt: "2026-10-30T00:00:00.000Z",
  content: {
    title: "Title",
    url: "https://example.org/a",
    text: "Body",
    language: "en",
    fetchedAt: "2026-10-30T00:00:00.000Z",
  },
};
describe("source change scheduling", () => {
  it("ignores polling timestamps and personal state, but detects updated metadata", () => {
    expect(
      feedRepresentation({
        ...article,
        fetchedAt: "2026-10-31T00:00:00Z",
        saved: true,
        read: true,
      }),
    ).toBe(feedRepresentation(article));
    expect(
      feedRepresentation({ ...article, sourceUpdated: "2026-10-31T00:00:00Z" }),
    ).not.toBe(feedRepresentation(article));
    expect(
      feedRepresentation({ ...article, sourceTags: ["a", "b", "a"] }),
    ).toBe(feedRepresentation({ ...article, sourceTags: ["b", "a"] }));
  });
  it("checks a body after one day without relying on RSS changes", () => {
    expect(nextArticleUpdate(article)).toBe(Date.parse("2026-10-31T00:00:00Z"));
    expect(nextArticleUpdate({ ...article, content: undefined })).toBe(
      Infinity,
    );
  });
  it("honors failure backoff even when a changed RSS fingerprint is pending", () => {
    const changed = {
      ...article,
      feedRevision: {
        fingerprint: "a".repeat(64),
        changedAt: "2026-10-30T01:00:00Z",
        observedAt: "2026-10-30T01:00:00Z",
        url: article.url,
      },
    };
    expect(nextArticleUpdate(changed)).toBe(0);
    expect(
      nextArticleUpdate({
        ...changed,
        bodyUpdate: {
          checkedAt: 0,
          failures: 1,
          retryAt: 100,
          error: "offline",
        },
      }),
    ).toBe(100);
  });
  it("rejects corrupt update records without affecting old articles", () => {
    expect(validArticleUpdate(undefined)).toBe(true);
    expect(validArticleUpdate({ checkedAt: 1, retryAt: 0, failures: 0 })).toBe(
      true,
    );
    for (const value of [
      null,
      {},
      { checkedAt: -1, retryAt: 0, failures: 0 },
      { checkedAt: 1, retryAt: 0, failures: 0, latest: {} },
    ])
      expect(validArticleUpdate(value)).toBe(false);
    expect(
      validFeedRevision({
        fingerprint: "a".repeat(64),
        changedAt: "2026-10-31",
        observedAt: "2026-10-30",
        url: article.url,
      }),
    ).toBe(false);
  });
});
