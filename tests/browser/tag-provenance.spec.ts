import { test, expect } from "@playwright/test";

test("RSS and Atom publisher tags survive refresh independently of personal tags and saved snapshots", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  const result = await page.evaluate(async () => {
    const parserPath = "/src/feed-parser.ts",
      storePath = "/src/feed-store.ts";
    const { parseFeed } = await import(parserPath),
      lib = await import(storePath);
    const url = "https://example.org/feed";
    const rss = (tag: string) =>
      parseFeed(
        `<rss version="2.0"><channel><title>Publisher</title><item><guid>a</guid><title>Notes</title><category>${tag}</category><category>${tag.toLowerCase()}</category><description>A quiet day.</description></item></channel></rss>`,
        url,
      );
    const first = rss("Python");
    const atom = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>b</id><title>Notes</title><category term="internal" label="Research"/><category term="Science"/></entry></feed>',
      url,
    );
    const db = await lib.openFeedLibrary();
    await lib.mergeFeed(db, first.feed, first.articles);
    const id = first.articles[0].id;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles"),
        get = store.get(id);
      get.onsuccess = () =>
        store.put({
          ...get.result,
          read: true,
          manualTags: ["Personal"],
          tags: { version: 1, state: "unclassified", suggestions: [] },
        });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const newer = rss("Swift");
    await lib.mergeFeed(db, newer.feed, newer.articles);
    const refreshed = await lib.readArticle(db, id);
    await lib.flagArticle(db, id, "saved", true);
    const latest = rss("Rust");
    await lib.mergeFeed(db, latest.feed, latest.articles);
    const saved = await lib.readArticle(db, id);
    db.close();
    return {
      first: first.articles[0],
      atom: atom.articles[0],
      refreshed,
      saved,
    };
  });
  expect(result.first.sourceTags).toEqual(["Python"]);
  expect(result.atom.sourceTags).toEqual(["Research", "Science"]);
  expect(result.refreshed.sourceTags).toEqual(["Swift"]);
  expect(result.refreshed.manualTags).toEqual(["Personal"]);
  expect(result.refreshed.read).toBe(true);
  expect(result.refreshed.tags.version).toBe(2);
  expect(result.saved.sourceTags).toEqual(["Swift"]);
  expect(result.saved.manualTags).toEqual(["Personal"]);
});

test("publisher-only metadata changes retain both immutable source versions", async ({
  page,
}) => {
  let tag = "First";
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({
      json: {
        url: "https://example.org/source-tags",
        html: `<html><head><title>Source</title><meta property="article:tag" content="${tag}"></head><body><article><h1>Source</h1><p>${"The original evidence stays exactly the same while its publisher updates the labels. ".repeat(12)}</p></article></body></html>`,
      },
    }),
  );
  await page.goto("/?view=feeds");
  const acquire = () =>
    page.evaluate(async () => {
      const path = "/src/source-document-store.ts";
      return (await import(path)).acquireDocument(
        "https://example.org/source-tags",
        { force: true },
      );
    });
  const first = await acquire();
  tag = "Second";
  const second = await acquire();
  expect(first.content.text).toBe(second.content.text);
  expect(first.content.document.documentId).toBe(
    second.content.document.documentId,
  );
  expect(first.content.document.versionId).not.toBe(
    second.content.document.versionId,
  );
  await page.reload();
  const retained = await page.evaluate(async (ref) => {
    const path = "/src/source-document-store.ts";
    return (await import(path)).readDocumentVersion(
      ref.documentId,
      ref.versionId,
    );
  }, first.content.document);
  expect(retained.content.sourceTags).toEqual(["First"]);
  expect(second.content.sourceTags).toEqual(["Second"]);
});
