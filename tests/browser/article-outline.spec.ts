import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page, design = "studio") {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  }, design);
  await page.route("**/api/collection", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__outline", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("/__outline");
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary();
    let text = "";
    const headings: { start: number; end: number; level: number }[] = [];
    for (const [label, level] of [
      ["Overview", 2],
      ["Repeated", 4],
      ["Repeated", 4],
      ["Details", 3],
      [
        "非常に長い見出しを狭い画面でも読めるように折り返して表示します。".repeat(
          3,
        ),
        6,
      ],
      ["Conclusion", 2],
    ] as const) {
      headings.push({
        start: text.length,
        end: text.length + label.length,
        level,
      });
      text +=
        label +
        "\n\n" +
        "Original source reading evidence remains intact. ".repeat(35) +
        "\n\n";
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ["map", "plain"])
        tx.objectStore("articles").put({
          id,
          title: id === "map" ? "Heading map fixture" : "Plain article",
          url: "https://example.org/" + id,
          feedUrl: "",
          body: text,
          saved: true,
          read: true,
          published: null,
          fetchedAt: new Date().toISOString(),
          content: {
            title: id === "map" ? "Heading map fixture" : "Plain article",
            url: "https://example.org/" + id,
            text,
            language: "en",
            fetchedAt: new Date().toISOString(),
            codeRanges: [],
            structure: {
              version: 1,
              headings: id === "map" ? headings : [],
              links: [],
            },
          },
          translation: {
            text: "保存済みの日本語訳。".repeat(100),
            sourceText: text,
            sourceLanguage: "en",
            targetLanguage: "ja",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Heading map fixture", exact: true })
    .click();
}

for (const design of ["studio", "editorial", "focus"])
  test(`${design}: source heading hierarchy, current position and keyboard jumps fit the viewport`, async ({
    page,
  }, info) => {
    await seed(page, design);
    const outline = page.locator(".rss-article-outline");
    if (info.project.name === "mobile")
      await outline.locator("summary").click();
    const nav = page.getByRole("navigation", { name: "この記事の目次" });
    await expect(nav.getByRole("link")).toHaveCount(6);
    await page.screenshot({
      path: info.outputPath(`heading-map-initial-${design}.png`),
    });
    await expect(nav.locator(":scope > ol > li")).toHaveCount(2);
    await expect(nav.locator("ol ol")).toHaveCount(2);
    const duplicates = nav.getByRole("link", { name: "Repeated", exact: true });
    expect(await duplicates.nth(0).getAttribute("href")).not.toEqual(
      await duplicates.nth(1).getAttribute("href"),
    );
    await duplicates.nth(1).focus();
    await duplicates.nth(1).press("Enter");
    const href = (await duplicates.nth(1).getAttribute("href"))!.split("#")[1];
    await expect(page.locator(`#${href}`)).toBeFocused();
    await expect
      .poll(async () => {
        const heading = await page.locator(`#${href}`).boundingBox();
        const toolbar = await page
          .locator(".rss-reader-navigation")
          .boundingBox();
        return heading!.y - (toolbar!.y + toolbar!.height);
      })
      .toBeGreaterThanOrEqual(12);
    await expect(duplicates.nth(1)).toHaveAttribute("aria-current", "location");
    const lastHeading = page.locator(".rss-source-text h2").last();
    await lastHeading.scrollIntoViewIfNeeded();
    await lastHeading.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await expect(
      nav.getByRole("link", { name: "Conclusion", exact: true }),
    ).toHaveAttribute("aria-current", "location");
    const contrast = await nav
      .locator("[aria-current=location]")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (value: string) => {
          const [r, g, b] = value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map((part) => {
              const channel = Number(part) / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const foreground = luminance(style.color),
          background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    if (info.project.name === "desktop") {
      const map = await outline.boundingBox(),
        body = await page.locator(".rss-article-body").boundingBox();
      expect(map!.x).toBeGreaterThanOrEqual(body!.x + body!.width);
      await expect(outline).toBeInViewport();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`heading-map-${design}.png`),
    });
    // Unrelated reader rerenders preserve the map disclosure and current link.
    await page.evaluate(() =>
      speechSynthesis.dispatchEvent(new Event("voiceschanged")),
    );
    await expect(outline).toHaveAttribute("open", "");
    await expect(
      nav.getByRole("link", { name: "Conclusion", exact: true }),
    ).toHaveAttribute("aria-current", "location");
    await page.evaluate(async () => {
      const path = "/src/feed-store.ts",
        api = await import(path),
        db = await api.openFeedLibrary();
      const article = await api.readArticle(db, "map");
      const text =
        "Fresh version\n\n" +
        "Changed original body with its own heading. ".repeat(40);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        tx.objectStore("articles").put({
          ...article,
          content: {
            ...article.content,
            text,
            structure: {
              version: 1,
              links: [],
              headings: [{ start: 0, end: 13, level: 2 }],
            },
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      db.close();
      const channel = new BroadcastChannel("tsumiki.rss.v1");
      channel.postMessage({ articleId: "map" });
      channel.close();
    });
    await expect(outline.locator("a")).toHaveCount(1);
    await page
      .getByRole("button", { name: "目次・見出しマップ", exact: true })
      .click();
    await expect(outline).toBeFocused();
    await expect(
      outline.getByRole("link", { name: "Fresh version", exact: true }),
    ).toBeVisible();
    await expect(outline.locator("[aria-current=location]")).toHaveText(
      "Fresh version",
    );
  });

test("translation and another article never reuse the original heading map", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByRole("button", { name: "日本語訳を読む", exact: true })
    .click();
  const outline = page.locator(".rss-article-outline");
  await outline.locator("summary").click();
  await expect(outline).toContainText("見出しとリンクは原文で確認できます");
  await expect(outline.locator("a")).toHaveCount(0);
  await page.getByRole("button", { name: "原文を読む", exact: true }).click();
  await expect(outline.locator("a")).toHaveCount(6);
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page
    .getByRole("button", { name: "Plain article", exact: true })
    .click();
  await outline.locator("summary").click();
  await expect(outline).toContainText("この記事には見出し情報がありません");
  await expect(outline.locator("a")).toHaveCount(0);
});
