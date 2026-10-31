import { test, expect, type Page } from "@playwright/test";
const url = "https://example.org/reader";
const text =
  `読み方のヒント\n\n詳しくは公式ガイドを参照してください。\n\n` +
  Array.from(
    { length: 45 },
    (_, i) =>
      `段落${i + 1}：${"情報を読んで、関連する知識を自分の言葉で整理します。".repeat(6)}`,
  ).join("\n\n");
async function setup(page: Page, design = "studio") {
  await page.route("**/__reader", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>fixture</title>",
    }),
  );
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.goto("/__reader");
  await page.evaluate(
    async ({ text, url, design }) => {
      localStorage.setItem("quilna.reader.design.v1", design);
      localStorage.setItem("quilna.feed.refresh.v1", "0");
      const path = "/src/feed-store.ts",
        db = await (await import(path)).openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        tx.objectStore("articles").put({
          id: "reader",
          feedUrl: "https://example.org/feed",
          title: "集中して読むための記事",
          url,
          body: "概要",
          saved: true,
          read: true,
          published: "2026-10-31T00:00:00Z",
          fetchedAt: new Date().toISOString(),
          content: {
            text,
            url,
            title: "集中して読むための記事",
            language: "ja",
            fetchedAt: new Date().toISOString(),
            codeRanges: [],
            info: { author: "Reader Author", siteName: "Example" },
            structure: {
              version: 1,
              links: [
                {
                  start: text.indexOf("公式ガイド"),
                  end: text.indexOf("公式ガイド") + 5,
                  href: "https://example.org/guide",
                },
              ],
              headings: [{ start: 0, end: 7, level: 2 }],
            },
          },
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { text, url, design },
  );
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "集中して読むための記事", exact: true })
    .click();
  await expect(page.locator("#rss-current-title")).toHaveText(
    "集中して読むための記事",
  );
}
for (const design of ["studio", "editorial", "focus"])
  test(`${design}: dedicated reader, article metadata, headings, links and stable return`, async ({
    page,
  }, info) => {
    await setup(page, design);
    await expect(page.locator(".rss-shell")).toHaveClass(/rss-focused/);
    await expect(page.locator(".rss-article-meta")).toContainText(
      "Reader Author",
    );
    await expect(page.locator(".rss-article-meta")).toContainText("読了目安");
    await expect(page.locator(".rss-source-text h2")).toHaveText(
      "読み方のヒント",
    );
    await expect(page.locator(".rss-body-link")).toHaveAttribute(
      "href",
      "https://example.org/guide",
    );
    await page.locator(".rss-article-outline summary").click();
    await page.evaluate(() => {
      speechSynthesis.dispatchEvent(new Event("voiceschanged"));
    });
    await expect(page.locator(".rss-article-outline")).toHaveAttribute(
      "open",
      "",
    );
    await page
      .getByRole("navigation", { name: "この記事の目次" })
      .getByRole("link")
      .click();
    await expect(page.locator("#rss-section-0")).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "集中して読むための記事", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "集中して読むための記事", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath("reading-experience.png"),
      fullPage: false,
    });
  });
test("hover preview waits for intent, remains reachable, dismisses with Escape, and supports touch button", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", async (r) => {
    if (r.request().postDataJSON().icon)
      return r.fulfill({ status: 404, json: {} });
    requests++;
    return r.fulfill({
      json: {
        url: "https://example.org/guide",
        html: '<html><head><title>ガイドの見出し</title><meta name="description" content="プレビュー説明"></head><body><script>window.previewExecuted=true</script><img src="https://evil.example.org/a"></body></html>',
      },
    });
  });
  const link = page.locator(".rss-body-link");
  await link.hover();
  await expect(
    page.getByRole("dialog", { name: "リンク先のプレビュー" }),
  ).toContainText("プレビュー説明");
  expect(requests).toBe(1);
  await page.getByRole("dialog").hover();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page
    .locator(".rss-source-text")
    .getByRole("button", { name: "リンク先をプレビュー：example.org" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(requests).toBe(1);
  expect(
    await page.evaluate(() => Reflect.get(window, "previewExecuted")),
  ).toBeUndefined();
  await expect(
    page.getByRole("dialog").locator("iframe,img,script"),
  ).toHaveCount(0);
});
test("reading position survives reload without treating opening as reading; latest article flags survive writes", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByLabel("読書位置")).toContainText(
    "スクロールすると保存",
  );
  const read = () =>
    page.evaluate(async () => {
      const path = "/src/feed-store.ts",
        lib = await import(path),
        db = await lib.openFeedLibrary();
      const a = await lib.readArticle(db, "reader");
      db.close();
      return a;
    });
  expect((await read()).readingPositions).toBeUndefined();
  await page.mouse.wheel(0, 1900);
  await expect
    .poll(async () => (await read()).readingPositions?.original?.offset ?? 0)
    .toBeGreaterThan(0);
  const p = (await read()).readingPositions.original;
  await page.reload();
  await page
    .getByRole("button", { name: "集中して読むための記事", exact: true })
    .click();
  await page.getByRole("button", { name: "続きから読む", exact: true }).click();
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500);
  expect((await read()).readingPositions.original.fingerprint).toBe(
    p.fingerprint,
  );
  const result = await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      lib = await import(path),
      db = await lib.openFeedLibrary();
    const article = await lib.readArticle(db, "reader");
    await lib.flagArticle(db, "reader", "saved", false);
    await lib.saveReadingPosition(
      db,
      "reader",
      "original",
      article.content.text,
      {
        ...article.readingPositions.original,
        offset: 20,
        updatedAt: Date.now() + 1000,
      },
    );
    const latest = await lib.readArticle(db, "reader");
    let refused = false;
    try {
      await lib.saveReadingPosition(
        db,
        "reader",
        "original",
        "changed",
        article.readingPositions.original,
      );
    } catch {
      refused = true;
    }
    db.close();
    return { saved: latest.saved, refused };
  });
  expect(result).toEqual({ saved: false, refused: true });
});

test("legacy structure enrichment preserves identical text, translation and flags; changed sources are refused", async ({
  page,
}) => {
  await setup(page);
  const html =
    '<html lang="en"><head><title>Legacy</title><meta name="author" content="Publisher"></head><body><article><h2>Guide section</h2><p>' +
    "A readable paragraph links to ".repeat(20) +
    '<a href="/guide">the guide</a>.</p></article></body></html>';
  const seed = await page.evaluate(
    async ({ html, url }) => {
      const contentPath = "/src/article-content.ts",
        path = "/src/feed-store.ts",
        lib = await import(path),
        db = await lib.openFeedLibrary();
      const content = (await import(contentPath)).extractArticle(html, url);
      delete content.structure;
      delete content.info;
      const a = await lib.readArticle(db, "reader");
      const translation = {
        text: "保持する日本語訳",
        sourceText: content.text,
        sourceLanguage: "en",
        targetLanguage: "ja",
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        tx.objectStore("articles").put({
          ...a,
          content,
          translation,
          manualTags: ["個人用"],
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      return { content, translation };
    },
    { html, url },
  );
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill(
      r.request().postDataJSON().icon
        ? { status: 404, json: {} }
        : { json: { url, html } },
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "Legacy", exact: true }).click();
  await page.getByRole("button", { name: "リンク・見出しを取り直す" }).click();
  await expect(page.locator(".rss-source-text h2")).toHaveText("Guide section");
  const result = await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      lib = await import(path),
      db = await lib.openFeedLibrary(),
      a = await lib.readArticle(db, "reader");
    let refused = false;
    const stale = { ...a, content: { ...a.content, structure: undefined } };
    // Simulate a legacy article whose publisher changed while enrichment was requested.
    await new Promise<void>((resolve) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").put(stale);
      tx.oncomplete = () => resolve();
    });
    try {
      await lib.updateArticleContent(
        db,
        stale,
        { content: { ...a.content, text: "Changed source" } },
        false,
        undefined,
        true,
      );
    } catch {
      refused = true;
    }
    const retained = await lib.readArticle(db, "reader");
    db.close();
    return { a, refused, retained };
  });
  expect(result.a.content.text).toBe(seed.content.text);
  expect(result.a.translation).toEqual(seed.translation);
  expect(result.a.manualTags).toEqual(["個人用"]);
  expect(result.a.saved).toBe(true);
  expect(result.refused).toBe(true);
  expect(result.retained.content.text).toBe(seed.content.text);
});

test("preview failure permits retry and a late response cannot reopen a dismissed card", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ status: 503, json: {} }),
  );
  const preview = page
    .locator(".rss-source-text")
    .getByRole("button", { name: "リンク先をプレビュー：example.org" });
  await preview.click();
  await expect(page.getByRole("dialog")).toContainText(
    "プレビューできませんでした",
  );
  let release!: () => void;
  await page.route("**/api/feeds/fetch", async (r) => {
    if (r.request().postDataJSON().icon)
      return r.fulfill({ status: 404, json: {} });
    await new Promise<void>((resolve) => (release = resolve));
    await r.fulfill({ json: { url, html: "<title>Late preview</title>" } });
  });
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.keyboard.press("Escape");
  release();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("position writes report quota failure without losing article data and recover on another scroll", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await expect(page.getByLabel("読書位置")).toContainText(
    "スクロールすると保存",
  );
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "articles" && value.readingPositions)
        throw new DOMException("quota", "QuotaExceededError");
      return put.call(this, value, ...args);
    };
    Object.assign(window, {
      restorePositionPut: () => {
        IDBObjectStore.prototype.put = put;
      },
    });
  });
  await page.mouse.wheel(0, 1800);
  await expect(page.getByLabel("読書位置")).toContainText(
    "保存できませんでした",
  );
  await expect(page.locator(".rss-source-text")).toContainText("情報を読んで");
  await page.evaluate(() => Reflect.get(window, "restorePositionPut")());
  await page.mouse.wheel(0, 200);
  await expect(page.getByLabel("読書位置")).toContainText("到達");
  await expect(
    page.getByRole("button", { name: "続きから読む", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
