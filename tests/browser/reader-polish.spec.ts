import { test, expect } from "@playwright/test";
test.use({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: [
      "--disable-features=OverlayScrollbar,OverlayScrollbars,FluentOverlayScrollbar",
    ],
  },
});

for (const design of ["studio", "editorial", "focus"])
  test(`${design} keeps the saved list aligned when the page scrollbar disappears`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem("quilna.reader.design.v1", value),
      design,
    );
    await page.setViewportSize({ width: 1440, height: 1600 });
    const url = "https://example.org/alignment.xml";
    await page.route("**/api/feeds/fetch", (r) =>
      r.fulfill({
        json: {
          url,
          xml: `<rss version="2.0"><channel><title>位置の検証</title>${Array.from({ length: 30 }, (_, i) => `<item><guid>${i}</guid><title>記事${i}</title><description>保存一覧との切り替えで横位置を保つための記事です。</description></item>`).join("")}</channel></rss>`,
        },
      }),
    );
    await page.goto("/?view=feeds");
    // Exercise a classic width-consuming scrollbar even on overlay-scrollbar hosts.
    await page.addStyleTag({ content: "::-webkit-scrollbar { width: 18px; }" });
    await page.getByLabel("サイト・RSSのURL").fill(url);
    await page
      .getByRole("button", { name: "フィードを探す", exact: true })
      .click();
    await page
      .getByRole("button", { name: "登録して読む", exact: true })
      .click();
    await expect(page.locator("#rss-search-status")).toContainText("30件");
    const measure = () =>
      page.locator("#rss-main").evaluate((e) => ({
        left: e.getBoundingClientRect().left,
        width: e.getBoundingClientRect().width,
        scrolling: document.documentElement.scrollHeight > innerHeight,
        gutter: innerWidth - document.documentElement.clientWidth,
      }));
    const long = await measure();
    expect(long.scrolling).toBe(true);
    if (info.project.name === "desktop") expect(long.gutter).toBeGreaterThan(0);
    await page
      .getByRole("button", { name: "保存した記事 · 0", exact: true })
      .click();
    const short = await measure();
    expect(short.scrolling).toBe(false);
    expect(Math.abs(short.left - long.left)).toBeLessThan(1);
    expect(Math.abs(short.width - long.width)).toBeLessThan(1);
    await page.screenshot({ path: info.outputPath(`${design}-saved.png`) });
  });

test("fixed sample lesson is explained in settings instead of the reading header", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".rss-header")
      .getByRole("link", { name: "サンプル教材", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("固定のデモ教材");
  await dialog
    .getByRole("link", { name: "デモ教材を開く", exact: true })
    .click();
  await expect(page).toHaveURL(/view=lesson/);
});
