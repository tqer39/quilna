import { test, expect, type Page } from "@playwright/test";

const feed = "https://example.org/location.xml";
async function seed(page: Page, design = "studio") {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  }, design);
  await page.route("**/api/collection", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__location", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("/__location");
  await page.evaluate(async (feed) => {
    const path = "/src/feed-store.ts",
      { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    const now = new Date().toISOString();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["feeds", "articles"], "readwrite");
      tx.objectStore("feeds").put({
        url: feed,
        title: "Location source",
        fetchedAt: now,
      });
      for (let i = 0; i < 124; i++) {
        const id = String(i).padStart(3, "0"),
          text = "Common original evidence. ".repeat(100).trim();
        tx.objectStore("articles").put({
          id,
          feedUrl: feed,
          title: "Location article " + id,
          url: "https://example.org/" + id,
          body: text,
          read: true,
          saved: i % 2 === 0,
          published: null,
          fetchedAt: now,
          manualTags: ["検証"],
          content: {
            title: "Location article " + id,
            url: "https://example.org/" + id,
            text,
            language: "en",
            fetchedAt: now,
          },
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, feed);
  await page.goto("/?view=feeds");
}
const destinations = (page: Page) =>
  page.getByRole("navigation", { name: "主な移動先" });
const current = (page: Page) => page.locator(".rss-location-current");
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "サイト・記事の取り込み", exact: true });

for (const design of ["studio", "editorial", "focus"])
  test(`${design}: named destinations, reader and import retain the filtered list position`, async ({
    page,
  }, info) => {
    await seed(page, design);
    await expect(current(page)).toHaveText("記事一覧");
    await destinations(page)
      .getByRole("link", { name: "保存した記事", exact: true })
      .click();
    await expect(current(page)).toHaveText("保存した記事");
    await expect(
      destinations(page).getByRole("link", {
        name: "保存した記事",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByLabel("保存領域の記事を検索").fill("Common");
    await page.getByLabel("配信元", { exact: true }).selectOption(feed);
    await page.getByLabel("タグで絞り込み").selectOption("tag:検証");
    await page.getByRole("button", { name: "次の50件", exact: true }).click();
    const row = page.getByRole("button", {
      name: "Location article 110",
      exact: true,
    });
    await row.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    const before = await row.boundingBox();
    await row.click();
    await expect(current(page)).toContainText(
      "保存した記事 · Location source › 記事詳細",
    );
    await expect(current(page)).toContainText("Location article 110");
    await expect(page).toHaveTitle("Location article 110 | Quilna");
    await expect(page.locator("#rss-focus-toggle")).toHaveText("配信元");
    await expect(page.locator("#rss-focus-toggle")).toHaveAccessibleName(
      "配信元の収集メニューを表示",
    );
    const contrasts = await page
      .locator(".rss-location-bar button")
      .evaluateAll((buttons) => {
        const luminance = (value: string) => {
          const [r, g, b] = value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map((part) => {
              const c = Number(part) / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return buttons.map((button) => {
          const style = getComputedStyle(button),
            a = luminance(style.color),
            b = luminance(style.backgroundColor);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
      });
    expect(contrasts.every((contrast) => contrast >= 4.5)).toBe(true);
    await page.screenshot({ path: info.outputPath(`location-${design}.png`) });
    await expect(page.locator(".rss-destinations > summary")).toHaveCount(0);
    await destinations(page)
      .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
      .click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByLabel("サイト・RSSのURL")).toBeFocused();
    await expect(current(page)).toContainText("サイト・記事の取り込み");
    await dialog(page)
      .getByLabel("サイト・RSSのURL")
      .fill("https://example.org/unfinished");
    await page.screenshot({ path: info.outputPath(`import-${design}.png`) });
    expect(
      await dialog(page).evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(current(page)).toContainText("記事詳細");
    await expect(
      destinations(page).getByRole("link", {
        name: "サイト・記事の取り込み",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      destinations(page).getByRole("link", {
        name: "サイト・記事の取り込み",
        exact: true,
      }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await expect(page.getByLabel("保存領域の記事を検索")).toHaveValue("Common");
    await expect(page.getByLabel("配信元", { exact: true })).toHaveValue(feed);
    await expect(page.getByLabel("タグで絞り込み")).toHaveValue("tag:検証");
    await expect(page.locator("#rss-search-status")).toContainText("51–62件");
    await expect(row).toBeFocused();
    await expect
      .poll(async () => Math.abs((await row.boundingBox())!.y - before!.y))
      .toBeLessThan(8);
    await destinations(page)
      .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
      .click();
    await expect(dialog(page).getByLabel("サイト・RSSのURL")).toHaveValue(
      "https://example.org/unfinished",
    );
    await dialog(page)
      .getByRole("button", { name: "記事一覧へ戻る", exact: true })
      .click();
    await expect(current(page)).toContainText("保存した記事");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (info.project.name === "mobile") {
      await page.setViewportSize({ width: 320, height: 800 });
      await destinations(page)
        .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
        .click();
      expect(
        await dialog(page).evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await expect(
        dialog(page).getByRole("button", {
          name: "記事一覧へ戻る",
          exact: true,
        }),
      ).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });

test("an import refusal stays actionable inside the dialog and does not create an article", async ({
  page,
}) => {
  await seed(page);
  await destinations(page)
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  await dialog(page)
    .getByLabel("サイト・RSSのURL")
    .fill("http://127.0.0.1/private");
  await dialog(page)
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
  await expect(dialog(page).getByRole("alert")).toContainText(
    "公開HTTPSの記事URLを入力",
  );
  await expect(
    dialog(page).getByRole("button", { name: "再試行", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rss-search-status")).toContainText("124件");
});

test("successful article import closes the dialog at the saved article detail", async ({
  page,
}) => {
  await seed(page);
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url: "https://example.org/new",
        html: `<html><title>Imported location</title><article><p>${"Common imported source evidence. ".repeat(40)}</p></article></html>`,
      },
    }),
  );
  await destinations(page)
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  await dialog(page)
    .getByLabel("サイト・RSSのURL")
    .fill("https://example.org/new");
  await dialog(page)
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator("#rss-current-title")).toHaveText(
    "Imported location",
  );
  await expect(page.locator("#rss-current-title")).toBeFocused();
  await expect(current(page)).toContainText(
    "保存した記事 › 記事詳細 — Imported location",
  );
});

test("a feed registered through the dialog opens that source's article list", async ({
  page,
}) => {
  await seed(page);
  const url = "https://example.org/new-feed.xml";
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url,
        xml: "<rss version='2.0'><channel><title>New location source</title><item><guid>first</guid><title>New location article</title><description>Original source body.</description></item></channel></rss>",
      },
    }),
  );
  await destinations(page)
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  await dialog(page).getByLabel("サイト・RSSのURL").fill(url);
  await dialog(page)
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "登録して読む", exact: true })
    .click();
  await expect(dialog(page)).toBeHidden();
  await expect(current(page)).toHaveText("記事一覧 · New location source");
  await expect(
    page.getByRole("button", { name: "New location article", exact: true }),
  ).toBeVisible();
});

test("saved and import destination URLs reopen their named screens", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/?view=feeds&filter=saved&screen=import");
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: "記事一覧へ戻る", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "保存した記事", exact: true }),
  ).toBeVisible();
  await expect(current(page)).toHaveText("保存した記事");
});

for (const mode of ["inline", "dialog", "repeat", "draft", "error"])
  test(`late registration cannot replace a newer reader context (${mode})`, async ({
    page,
  }) => {
    await seed(page);
    const modal = mode !== "inline";
    if (mode === "repeat") {
      await page
        .getByRole("button", { name: "Location article 002", exact: true })
        .click();
      await expect(page.locator(".rss-destinations > summary")).toHaveCount(0);
    }
    const url = "https://example.org/delayed-feed.xml";
    const xml =
      "<rss version='2.0'><channel><title>Delayed registration</title><item><guid>later</guid><title>Delayed entry</title><description>Source evidence.</description></item></channel></rss>";
    let requests = 0;
    let finish: (() => void) | undefined;
    await page.route("**/api/feeds/fetch", async (route) => {
      if (route.request().postDataJSON().icon)
        return route.fulfill({ status: 404, json: {} });
      if (++requests === 2)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      await route.fulfill({ json: { url, xml } });
    });
    if (modal)
      await destinations(page)
        .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
        .click();
    await page.getByLabel("サイト・RSSのURL").fill(url);
    await page
      .getByRole("button", { name: "フィードを探す", exact: true })
      .click();
    await page
      .getByRole("button", { name: "登録して読む", exact: true })
      .click();
    await expect.poll(() => !!finish).toBe(true);
    if (mode === "draft" || mode === "error") {
      const draft =
        mode === "error"
          ? "http://127.0.0.1/private"
          : "https://example.org/new-draft";
      await page.getByLabel("サイト・RSSのURL").fill(draft);
      if (mode === "error") {
        await dialog(page)
          .getByRole("button", { name: "記事として取り込む", exact: true })
          .click();
        await expect(dialog(page).getByRole("alert")).toContainText(
          "公開HTTPSの記事URLを入力",
        );
      }
      finish!();
      await expect(
        page
          .locator("#feed-source option")
          .filter({ hasText: "Delayed registration" }),
      ).toHaveCount(1);
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByLabel("サイト・RSSのURL")).toHaveValue(
        draft,
      );
      if (mode === "error")
        await expect(dialog(page).getByRole("alert")).toContainText(
          "公開HTTPSの記事URLを入力",
        );
      else
        await expect(dialog(page).getByLabel("サイト・RSSのURL")).toBeFocused();
      return;
    }
    if (modal)
      await dialog(page)
        .getByRole("button", { name: /へ戻る$/, exact: false })
        .click();
    if (mode === "repeat") {
      await page
        .getByRole("button", { name: "← 記事一覧へ", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Location article 004", exact: true })
        .click();
      await page
        .getByRole("button", { name: "← 記事一覧へ", exact: true })
        .click();
    }
    await page
      .getByRole("button", { name: "Location article 002", exact: true })
      .click();
    await expect(page.locator("#rss-current-title")).toBeFocused();
    finish!();
    await expect(
      page
        .locator("#feed-source option")
        .filter({ hasText: "Delayed registration" }),
    ).toHaveCount(1);
    await expect(current(page)).toContainText(
      "記事詳細 — Location article 002",
    );
    await expect(page.locator("#rss-current-title")).toBeFocused();
    await expect(dialog(page)).toBeHidden();
  });

test("a delayed body refresh keeps a newer import error and URL draft", async ({
  page,
}) => {
  await seed(page);
  let finish: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    if (route.request().postDataJSON().icon)
      return route.fulfill({ status: 404, json: {} });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fulfill({
      json: {
        url: "https://example.org/002",
        html: `<html><title>Updated original</title><article><p>${"Common original evidence. ".repeat(100)}</p></article></html>`,
      },
    });
  });
  await page
    .getByRole("button", { name: "Location article 002", exact: true })
    .click();
  await page
    .getByRole("button", { name: "コードの書式を取り直す", exact: true })
    .click();
  await expect.poll(() => !!finish).toBe(true);
  await expect(page.locator(".rss-destinations > summary")).toHaveCount(0);
  await destinations(page)
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  const draft = "http://127.0.0.1/private";
  await dialog(page).getByLabel("サイト・RSSのURL").fill(draft);
  await dialog(page)
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
  await expect(dialog(page).getByRole("alert")).toContainText(
    "公開HTTPSの記事URLを入力",
  );
  finish!();
  await expect(
    page.locator(".rss-content-note").filter({ hasText: "取り込み中" }),
  ).toHaveCount(0);
  await expect(dialog(page).getByRole("alert")).toContainText(
    "公開HTTPSの記事URLを入力",
  );
  await expect(dialog(page).getByLabel("サイト・RSSのURL")).toHaveValue(draft);
});

test("a delayed feed refresh keeps a newer import error", async ({ page }) => {
  await seed(page);
  let finish: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    if (route.request().postDataJSON().icon)
      return route.fulfill({ status: 404, json: {} });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fulfill({
      json: {
        url: feed,
        xml: "<rss version='2.0'><channel><title>Updated location source</title><item><guid>later</guid><title>Later refreshed article</title><description>Source evidence.</description></item></channel></rss>",
      },
    });
  });
  await page.getByRole("button", { name: "すべて更新", exact: true }).click();
  await expect.poll(() => !!finish).toBe(true);
  await destinations(page)
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  await dialog(page)
    .getByLabel("サイト・RSSのURL")
    .fill("http://127.0.0.1/private");
  await dialog(page)
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
  await expect(dialog(page).getByRole("alert")).toContainText(
    "公開HTTPSの記事URLを入力",
  );
  finish!();
  await expect(
    page.getByRole("button", { name: "Later refreshed article", exact: true }),
  ).toHaveCount(1);
  await expect(dialog(page).getByRole("alert")).toContainText(
    "公開HTTPSの記事URLを入力",
  );
  await expect(
    dialog(page).getByRole("button", {
      name: "記事として取り込む",
      exact: true,
    }),
  ).toBeFocused();
});
