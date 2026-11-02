import { describe, expect, it } from "vitest";
import type { FeedArticle } from "../src/feed-parser";
import {
  relatedArticles,
  findConnectionTargets,
} from "../src/related-articles";
function article(id: string, tags = ["shared"]): FeedArticle {
  return {
    id,
    title: `Article ${id}`,
    url: "",
    feedUrl: "",
    body: "Body-only words",
    published: null,
    fetchedAt: "2026-10-27T00:00:00Z",
    read: true,
    saved: false,
    manualTags: tags,
  };
}
describe("local related-article candidates", () => {
  it("ranks a bounded set by shared topics, excludes hidden/self/unread and treats manual tags as authoritative", async () => {
    const current = article("a", ["shared", "second"]),
      hidden = article("hidden", ["shared", "second"]);
    const unread = { ...article("unread"), read: false };
    const overridden = {
      ...article("override", []),
      tags: {
        version: 1 as const,
        state: "classified" as const,
        suggestions: [{ tag: "shared", evidence: ["keyword"] }],
      },
    };
    const best = article("best", ["shared", "second"]);
    const found = await relatedArticles(
      current,
      [
        current,
        hidden,
        unread,
        overridden,
        article("z"),
        article("c"),
        best,
        article("b"),
      ],
      new Set(["hidden"]),
      new AbortController().signal,
    );
    expect(found.map((x) => x.article.id)).toEqual(["best", "b", "c"]);
    expect(found[0].tags).toEqual(["shared", "second"]);
    expect(unread.read).toBe(false);
  });
  it("cancels an in-flight large scan instead of publishing partial candidates", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const scan = relatedArticles(
      article("a"),
      Array.from({ length: 1500 }, (_, i) => article(String(i))),
      new Set(),
      controller.signal,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    controller.abort();
    release!();
    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
  });
  it("searches normalized titles only and bounds the result list without requiring shared tags", async () => {
    const articles = Array.from({ length: 40 }, (_, i) => ({
      ...article(String(i), []),
      title: `ＡＰＩ ${i}`,
    }));
    const signal = new AbortController().signal;
    expect(
      await findConnectionTargets("0", articles, "api", signal),
    ).toHaveLength(20);
    expect(
      (await findConnectionTargets("0", articles, "api 39", signal)).map(
        (a) => a.id,
      ),
    ).toEqual(["39"]);
    expect(
      await findConnectionTargets("0", articles, "Body-only", signal),
    ).toEqual([]);
  });
});
