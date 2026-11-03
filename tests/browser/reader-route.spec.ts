import { test, expect } from "@playwright/test";

test("list query and page are retained through direct URLs and history", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  });
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.goto("/?view=feeds");
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (let i = 0; i < 60; i++)
        tx.objectStore("articles").put({
          id: `list-${i}`,
          title: `History ${i}`,
          url: "",
          feedUrl: "",
          body: "History",
          saved: true,
          read: true,
          published: null,
          fetchedAt: new Date().toISOString(),
        });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/?view=feeds&filter=saved&q=History&page=2");
  await expect(page.locator("#rss-search-status")).toHaveText(
    "60件 · 51–60件を表示",
  );
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole("button", { name: "前の50件" }).click();
  await expect(page.locator("#rss-search-status")).toHaveText(
    "60件 · 1–50件を表示",
  );
  await page.goBack();
  await expect(page.locator("#rss-search-status")).toHaveText(
    "60件 · 51–60件を表示",
  );
  await page
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  await expect(page).toHaveURL(/screen=import/);
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "サイト・記事の取り込み" }),
  ).not.toBeVisible();
  await expect(page.locator("#rss-search-status")).toHaveText(
    "60件 · 51–60件を表示",
  );
  await page.goto("/?view=feeds&article=missing");
  await expect(
    page.getByText("このURLの記事は現在のライブラリにありません。", {
      exact: false,
    }),
  ).toBeVisible();
});

test("article and heading URLs survive reload and browser back/forward", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  });
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.goto("/?view=feeds");
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    const text =
      "First\n\n" + "Text paragraph. ".repeat(400) + "\n\nSecond\n\nEnd.";
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").put({
        id: "url / 日本語",
        title: "URL article",
        url: "https://example.org/story",
        feedUrl: "",
        body: text,
        saved: true,
        read: true,
        published: null,
        fetchedAt: new Date().toISOString(),
        content: {
          title: "URL article",
          text,
          url: "https://example.org/story",
          language: "en",
          fetchedAt: new Date().toISOString(),
          structure: {
            version: 1,
            links: [],
            headings: ["First", "Second"].map((label) => ({
              start: text.indexOf(label),
              end: text.indexOf(label) + label.length,
              level: 2,
            })),
          },
        },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/?view=feeds&filter=saved");
  await page.getByRole("button", { name: "URL article", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("article")).toBe("url / 日本語");
  await page.getByRole("button", { name: "目次・見出しマップ" }).click();
  await page
    .getByRole("navigation", { name: "この記事の目次" })
    .getByRole("link", { name: "Second", exact: true })
    .click();
  const headingURL = page.url();
  expect(new URL(headingURL).hash).toMatch(/^#rss-section-\d+$/);
  await page.evaluate(async () => {
    localStorage.setItem(
      "quilna.reader.preferences.v1",
      JSON.stringify({ targetLanguage: "ja", automatic: true }),
    );
    const path = "/src/feed-store.ts",
      { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles"),
        request = store.get("url / 日本語");
      request.onsuccess = () =>
        store.put({
          ...request.result,
          translation: {
            text: "保存した日本語訳",
            sourceText: request.result.content.text,
            sourceLanguage: "en",
            targetLanguage: "ja",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "URL article", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(new URL(headingURL).hash)
        .evaluate(
          (e) =>
            e.getBoundingClientRect().top < innerHeight &&
            e.getBoundingClientRect().bottom > 0,
        ),
    )
    .toBe(true);
  await page.goBack();
  await expect(page).not.toHaveURL(/#rss-section-/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "保存した記事", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "URL article", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(headingURL);
  await expect(page.locator(new URL(headingURL).hash)).toBeInViewport();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page).toHaveURL(/screen=settings/);
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "設定・保存先" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "設定・保存先" }),
  ).not.toBeVisible();
});

test("late heading arrival, current jump links and RSS-only translations survive URL restoration", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
    localStorage.setItem(
      "quilna.reader.preferences.v1",
      JSON.stringify({ targetLanguage: "ja", automatic: true }),
    );
  });
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  const lead = "Long source paragraph.\n\n".repeat(100),
    text = lead + "Late heading\n\nEnd.";
  await page.goto(`/?view=feeds&article=late#rss-section-${lead.length}`);
  await expect(
    page.getByText("このURLの記事は現在のライブラリにありません。", {
      exact: false,
    }),
  ).toBeVisible();
  await page.evaluate(
    async ({ text, start }) => {
      const path = "/src/feed-store.ts",
        { openFeedLibrary } = await import(path),
        db = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        for (const id of ["late", "rss-only"])
          tx.objectStore("articles").put({
            id,
            title: id,
            url: id === "late" ? "https://example.org/late" : "",
            feedUrl: "",
            body: text,
            published: null,
            saved: true,
            read: true,
            fetchedAt: new Date().toISOString(),
            ...(id === "late"
              ? {
                  content: {
                    title: id,
                    url: "https://example.org/late",
                    text,
                    language: "en",
                    fetchedAt: new Date().toISOString(),
                    structure: {
                      version: 1,
                      links: [],
                      headings: [{ start, end: start + 12, level: 2 }],
                    },
                  },
                }
              : {
                  translation: {
                    text: "保存済みの日本語本文",
                    sourceText: text,
                    sourceLanguage: "en",
                    targetLanguage: "ja",
                  },
                }),
          });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      const c = new BroadcastChannel("tsumiki.rss.v1");
      c.postMessage("changed");
      c.close();
    },
    { text, start: lead.length },
  );
  await expect(page.locator(`#rss-section-${lead.length}`)).toBeInViewport();
  const jump = page.locator(".rss-header a[data-reader-target]");
  expect(
    new URL((await jump.getAttribute("href"))!).searchParams.get("article"),
  ).toBe("late");
  await page
    .getByRole("navigation", { name: "主な移動先" })
    .getByRole("link", { name: "記事一覧", exact: true })
    .click();
  expect(
    new URL((await jump.getAttribute("href"))!).searchParams.has("article"),
  ).toBe(false);
  await page.goto("/?view=feeds&article=rss-only");
  await expect(page.locator(".rss-source-text")).toContainText(
    "保存済みの日本語本文",
  );
  await page.reload();
  await expect(page.locator(".rss-source-text")).toContainText(
    "保存済みの日本語本文",
  );
});
