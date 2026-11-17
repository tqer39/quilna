import { test, expect } from "@playwright/test";

for (const design of ["studio", "editorial", "focus"]) {
  for (const withHeadings of [false, true]) {
    test(`${design}・見出し${withHeadings ? "あり" : "なし"}: 通常の記事は操作欄に埋もれず最初の画面で読み始められる`, async ({
      page,
    }, info) => {
      await page.setViewportSize(
        info.project.name === "mobile"
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
      );
      await page.addInitScript((design) => {
        localStorage.setItem("quilna.reader.design.v1", design);
        localStorage.setItem("quilna.feed.refresh.v1", "0");
        localStorage.setItem("quilna.article.updates.v1", "false");
      }, design);
      await page.route("**/api/collection", (r) =>
        r.fulfill({ status: 404, json: {} }),
      );
      await page.route("**/api/feeds/fetch", (r) =>
        r.fulfill({ status: 404, json: {} }),
      );
      await page.route("**/__reading_entry", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>合成の読書確認</title>",
        }),
      );
      await page.goto("/__reading_entry");
      await page.evaluate(async (withHeadings) => {
        const path = "/src/feed-store.ts",
          db = await (await import(path)).openFeedLibrary();
        const title = "合成記事の読み始め",
          url = "https://example.org/reading-entry",
          text =
            "本文の最初から読めます。保存や目次を使うために、文章が画面外へ押し出されないことを確認します。".repeat(
              40,
            ) + "\n\n途中の見出し\n\nその後の本文です。";
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("articles", "readwrite");
          tx.objectStore("articles").add({
            id: "entry",
            title,
            url,
            feedUrl: "",
            body: text,
            read: true,
            saved: false,
            published: null,
            fetchedAt: "2026-11-17T00:00:00Z",
            content: {
              title,
              url,
              text,
              language: "ja",
              fetchedAt: "2026-11-17T00:00:00Z",
              codeRanges: [],
              structure: {
                version: 1,
                links: [],
                headings: withHeadings
                  ? [
                      {
                        start: text.indexOf("途中の見出し"),
                        end:
                          text.indexOf("途中の見出し") + "途中の見出し".length,
                        level: 2,
                      },
                    ]
                  : [],
              },
            },
          });
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
        db.close();
      }, withHeadings);
      await page.goto("/?view=feeds&article=entry");
      const body = page.locator(".rss-source-text");
      await expect(body).toContainText("本文の最初から読めます。");
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        scrollTo(0, 0);
      });
      const position = await body.evaluate((e) => {
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent?.trim()) node = walker.nextNode();
        if (!node) throw Error("本文が必要です");
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        return {
          top: range.getBoundingClientRect().top,
          height: innerHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      await page.screenshot({
        path: info.outputPath(`${design}-reading-entry.png`),
        fullPage: false,
      });
      await info.attach("本文の開始位置", {
        body: JSON.stringify(position),
        contentType: "application/json",
      });
      expect(
        await page
          .locator(".rss-content-note")
          .filter({ hasText: "元サイトから取り込んだ本文です。" })
          .evaluate(
            (note) =>
              !!(
                document
                  .querySelector(".rss-source-text")!
                  .compareDocumentPosition(note) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ),
          ),
      ).toBe(true);
      expect(position.overflow).toBe(false);
      expect(
        position.top,
        "初期画面の少なくとも下部3割を本文に使えること",
      ).toBeLessThan(position.height * 0.7);
      await page
        .getByRole("button", { name: "この記事を保存", exact: true })
        .click();
      await expect(page.locator("#rss-save-article")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(
        page.getByRole("button", { name: "目次・見出しマップ", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".rss-article-meta")).toContainText(
        "画像・埋め込みなし",
      );
      await page.evaluate(async () => {
        const path = "/src/feed-store.ts",
          db = await (await import(path)).openFeedLibrary();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("articles", "readwrite"),
            store = tx.objectStore("articles"),
            get = store.get("entry");
          get.onsuccess = () =>
            store.put({ ...get.result, contentError: "合成の更新確認失敗" });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
      });
      await page.reload();
      const failure = page
        .locator(".rss-content-note")
        .filter({ hasText: "合成の更新確認失敗" });
      await expect(failure).toBeVisible();
      expect(
        await failure.evaluate(
          (note) =>
            !!(
              note.compareDocumentPosition(
                document.querySelector(".rss-source-text")!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
      ).toBe(true);
      expect(
        await page
          .locator(".rss-content-note")
          .filter({ hasText: "元サイトから取り込んだ本文です。" })
          .evaluate(
            (note) =>
              !!(
                document
                  .querySelector(".rss-source-text")!
                  .compareDocumentPosition(note) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ),
          ),
      ).toBe(true);
      await expect(body).toContainText("本文の最初から読めます。");
      await page.evaluate(async () => {
        const path = "/src/feed-store.ts",
          db = await (await import(path)).openFeedLibrary();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("articles", "readwrite"),
            store = tx.objectStore("articles"),
            get = store.get("entry");
          get.onsuccess = () => {
            const article = get.result;
            delete article.content.codeRanges;
            store.put(article);
          };
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
      });
      await page.reload();
      const legacyWarning = page
        .locator(".rss-content-note")
        .filter({
          hasText: "以前に取り込んだ本文にはコードの書式情報がありません。",
        });
      await expect(legacyWarning).toBeVisible();
      expect(
        await legacyWarning.evaluate(
          (note) =>
            !!(
              note.compareDocumentPosition(
                document.querySelector(".rss-source-text")!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "← 記事一覧へ", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "合成記事の読み始め", exact: true }),
      ).toBeVisible();
    });
  }
}

test("本文の取り込み中と失敗の案内は、本文より前で知らせる", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  });
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/api/feeds/fetch", async (r) => {
    if (r.request().postDataJSON()?.icon)
      return r.fulfill({ status: 404, json: {} });
    await held;
    await r.fulfill({ status: 502, json: { error: "合成の取り込み失敗" } });
  });
  try {
    await page.goto("/?view=feeds");
    await page
      .getByLabel("サイト・RSSのURL")
      .fill("https://example.org/chrome-pending");
    await page
      .getByRole("button", { name: "記事として取り込む", exact: true })
      .click();
    const notice = page.locator(".rss-content-note").first();
    await expect(notice).toContainText("取り込み中");
    expect(
      await notice.evaluate(
        (note) =>
          !!(
            note.compareDocumentPosition(
              document.querySelector(".rss-article-body")!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
    ).toBe(true);
    release();
    await expect(notice).toContainText("取り込みに失敗しました");
    expect(
      await notice.evaluate(
        (note) =>
          !!(
            note.compareDocumentPosition(
              document.querySelector(".rss-article-body")!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
    ).toBe(true);
  } finally {
    release();
  }
});
