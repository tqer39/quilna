import { test, expect, type Page } from "@playwright/test";
const url = "https://publisher.example.org/tags";
const body =
  "A software developer explains how SQLite database transactions preserve records. This tutorial offers a step by step walkthrough with clear examples. ".repeat(
    5,
  );
async function importArticle(page: Page) {
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url,
        html: `<html lang="en"><title>SQLite tutorial</title><meta property="article:tag" content="Databases"><meta name="keywords" content="SQLite, Databases"><article><h1>SQLite tutorial</h1><p>${body}</p></article></html>`,
      },
    }),
  );
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill(url);
  await page
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "software developer",
  );
}
async function edit(page: Page, tags: string) {
  await page.getByText("タグを編集・根拠を確認", { exact: true }).click();
  await page
    .getByLabel("自分のタグを編集（カンマ区切り）", { exact: true })
    .fill(tags);
  await page.getByRole("button", { name: "タグを保存", exact: true }).click();
}
async function seed(page: Page) {
  await page.goto("/?view=feeds");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("tsumiki.rss.v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("feeds", { keyPath: "url" });
        request.result.createObjectStore("articles", { keyPath: "id" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("articles", "readwrite");
        for (const [id, title, body] of [
          ["legacy", "Old SQLite article", "A database and software story."],
          ["unknown", "Diary", "A quiet day by the river."],
          ["link", "Link only", ""],
        ])
          tx.objectStore("articles").put({
            id,
            title,
            body,
            url: "",
            feedUrl: "https://publisher.example.org/rss",
            saved: false,
            read: false,
            published: null,
            fetchedAt: "2026-10-24T00:00:00Z",
          });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
}
test("imported articles get explained tags; corrections persist, filter and search independently of automatic suggestions", async ({
  page,
}, info) => {
  await importArticle(page);
  await expect(page.getByRole("region", { name: "記事のタグ" })).toContainText(
    "自動判定：技術・開発・手順・解説",
  );
  await expect(page.locator(".rss-tag-summary")).toContainText(
    "配信元：Databases・SQLite",
  );
  await edit(page, "仕事, あとで読む");
  await expect(page.locator(".rss-tag-summary")).toContainText(
    "自分のタグ：仕事・あとで読む",
  );
  await page.reload();
  await page.getByLabel("保存領域の記事を検索").fill("仕事");
  await expect(page.locator("#rss-search-status")).toContainText("1件");
  await page.getByLabel("タグで絞り込み").selectOption("tag:あとで読む");
  await page
    .getByRole("button", { name: "SQLite tutorial", exact: true })
    .click();
  await page.getByText("タグを編集・根拠を確認", { exact: true }).click();
  await page.getByText("自動判定の根拠", { exact: true }).click();
  await expect(page.getByRole("region", { name: "記事のタグ" })).toContainText(
    "sqlite",
  );
  await page.screenshot({
    path: info.outputPath("tags-edited.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "自分のタグを解除", exact: true })
    .click();
  await expect(page.locator(".rss-tag-summary")).toContainText(
    "自動判定：技術・開発",
  );
  await expect(page.locator(".rss-tag-summary")).toContainText(
    "配信元：Databases・SQLite",
  );
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page.getByLabel("タグで絞り込み").selectOption("");
  await expect(page.locator("#rss-search-status")).toContainText("0件");
});
test("legacy backfill distinguishes unknown and missing content and preserves concurrent manual edits on refresh", async ({
  page,
}) => {
  await seed(page);
  await page.getByLabel("タグで絞り込み").selectOption("state:未処理");
  await expect(page.locator("#rss-search-status")).toContainText("3件");
  await page
    .getByRole("button", { name: "未処理3件のタグを判定", exact: true })
    .click();
  await expect(
    page.getByText("3件のタグ判定結果を保存しました。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#rss-search-status")).toContainText("0件");
  await page.getByLabel("タグで絞り込み").selectOption("state:分類できず");
  await expect(
    page.getByRole("button", { name: "Diary", exact: true }),
  ).toBeVisible();
  await page.getByLabel("タグで絞り込み").selectOption("state:本文なし");
  await expect(
    page.getByRole("button", { name: "Link only", exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const {
      openFeedLibrary,
      readArticle,
      setArticleTags,
      mergeFeed,
      flagArticle,
    } = await import(path);
    const db = await openFeedLibrary();
    const article = await readArticle(db, "legacy");
    await Promise.all([
      setArticleTags(db, "legacy", ["自分の分類"]),
      setArticleTags(db, "legacy", undefined, true),
      flagArticle(db, "legacy", "read", true),
    ]);
    await mergeFeed(
      db,
      {
        url: article.feedUrl,
        title: "Publisher",
        fetchedAt: article.fetchedAt,
      },
      [
        {
          ...article,
          title: "Nutrition and health",
          body: "Exercise and cooking help health.",
        },
      ],
    );
    const latest = await readArticle(db, "legacy");
    db.close();
    return latest;
  });
  expect(state.manualTags).toEqual(["自分の分類"]);
  expect(state.read).toBe(true);
  expect(
    state.tags.suggestions.map((item: { tag: string }) => item.tag),
  ).toEqual(["暮らし・健康"]);
  await page.reload();
  await page.getByLabel("タグで絞り込み").selectOption("tag:自分の分類");
  await expect(
    page.getByRole("button", { name: "Nutrition and health", exact: true }),
  ).toBeVisible();
});
test("translation changes reclassify only matching sources and do not replace manual tags", async ({
  page,
}) => {
  await seed(page);
  const results = await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const {
      openFeedLibrary,
      readArticle,
      updateArticleContent,
      mergeFeed,
      setArticleTags,
    } = await import(path);
    const db = await openFeedLibrary();
    const a = await readArticle(db, "unknown");
    await updateArticleContent(db, a, {
      translation: {
        text: "人工知能と機械学習",
        sourceText: a.body,
        sourceLanguage: "en",
        targetLanguage: "ja",
      },
    });
    const translated = await readArticle(db, a.id);
    await setArticleTags(db, a.id, ["日記"]);
    await mergeFeed(
      db,
      { url: a.feedUrl, title: "Publisher", fetchedAt: a.fetchedAt },
      [{ ...a, body: "A new personal story." }],
    );
    const refreshed = await readArticle(db, a.id);
    db.close();
    return { translated, refreshed };
  });
  expect(
    results.translated.tags.suggestions.map(
      (item: { tag: string }) => item.tag,
    ),
  ).toEqual(["AI・機械学習"]);
  expect(results.refreshed.tags.state).toBe("unclassified");
  expect(results.refreshed.manualTags).toEqual(["日記"]);
});
test("failed tag persistence keeps original tags and preserves a retryable draft", async ({
  page,
}) => {
  await importArticle(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (value.manualTags?.includes("失敗"))
        throw Error("simulated storage failure");
      return put.call(this, value, ...rest);
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = put;
    };
  });
  await edit(page, "失敗");
  await expect(page.getByRole("alert")).toContainText(
    "タグを保存できませんでした",
  );
  await expect(page.locator(".rss-tag-summary")).toContainText(
    "自動判定：技術・開発",
  );
  await expect(
    page.getByLabel("自分のタグを編集（カンマ区切り）", { exact: true }),
  ).toHaveValue("失敗");
  await page.evaluate(() =>
    (window as unknown as { restorePut: () => void }).restorePut(),
  );
  await page
    .getByRole("alert")
    .getByRole("button", { name: "再試行", exact: true })
    .click();
  await expect(page.locator(".rss-tag-summary")).toContainText(
    "自分のタグ：失敗",
  );
});

test("bulk classification can stop between records without dropping completed results", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary, readArticle } = await import(path);
    const db = await openFeedLibrary();
    const a = await readArticle(db, "legacy");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (let i = 0; i < 1000; i++)
        tx.objectStore("articles").put({ ...a, id: `bulk-${i}` });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page
    .getByRole("button", { name: "未処理1003件のタグを判定", exact: true })
    .click();
  const stop = await page
    .getByRole("button", { name: "タグ判定を中止", exact: true })
    .elementHandle();
  await expect(page.getByText(/タグを判定中：[1-9]\d*\/1003件/)).toBeVisible();
  // Progress must not detach the control while a pointer/keyboard action targets it.
  expect(await stop!.evaluate((node) => node.isConnected)).toBe(true);
  await page
    .getByRole("button", { name: "タグ判定を中止", exact: true })
    .click();
  await expect(
    page.getByText(/タグの判定を中止しました。\d+件の結果を保存済みです。/),
  ).toBeVisible();
  const completed = await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary, readFeedLibrary } = await import(path);
    const db = await openFeedLibrary();
    const { articles } = await readFeedLibrary(db);
    db.close();
    return articles.filter((a: { tags?: unknown }) => a.tags).length;
  });
  expect(completed).toBeGreaterThan(0);
  expect(completed).toBeLessThan(1003);
  await expect(
    page.getByRole("button", {
      name: `未処理${1003 - completed}件のタグを判定`,
      exact: true,
    }),
  ).toBeVisible();
});

test("background tag updates preserve an open filter while refreshing its results", async ({
  page,
}) => {
  await seed(page);
  const filter = page.getByLabel("タグで絞り込み");
  await filter.focus();
  const witness = await filter.evaluateHandle((control) => {
    const state = { control, detached: false };
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of Array.from(record.removedNodes))
          if (node === control || node.contains(control)) state.detached = true;
    }).observe(document.body, { childList: true, subtree: true });
    return state;
  });
  for (const [index, id] of ["legacy", "unknown"].entries()) {
    await page.evaluate(async (id) => {
      const path = "/src/feed-store.ts";
      const { openFeedLibrary, setArticleTags } = await import(path);
      const db = await openFeedLibrary();
      await setArticleTags(db, id, ["更新中の分類"]);
      db.close();
      const channel = new BroadcastChannel("tsumiki.rss.v1");
      channel.postMessage({ articleId: id });
      channel.close();
    }, id);
    await expect(filter.locator('option[value="tag:更新中の分類"]')).toHaveText(
      `更新中の分類 · ${index + 1}`,
    );
    expect(
      await witness.evaluate(
        ({ control, detached }) => control.isConnected && !detached,
      ),
    ).toBe(true);
    if (!index) await filter.selectOption("tag:更新中の分類");
    await expect(page.locator("#rss-search-status")).toContainText(
      `${index + 1}件`,
    );
    await expect(filter).toBeFocused();
  }
});
