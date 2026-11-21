import { test, expect, type Page } from "@playwright/test";

const feeds = [
  { url: "https://example.org/a.xml", title: "Alpha journal" },
  { url: "https://example.org/b.xml", title: "Beta notes" },
];

async function seed(page: Page, design = "studio") {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  }, design);
  await page.route("**/api/collection", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__layout", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("/__layout");
  await page.evaluate(async (feeds) => {
    const path = "/src/feed-store.ts",
      { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["feeds", "articles"], "readwrite");
      for (const feed of feeds)
        tx.objectStore("feeds").put({
          ...feed,
          fetchedAt: "2026-11-19T00:00:00Z",
        });
      for (let i = 0; i < 6; i++)
        tx.objectStore("articles").put({
          id: `layout-${i}`,
          feedUrl: feeds[i % 2].url,
          title: `Layout headline ${i}`,
          url: `https://example.org/${i}`,
          body: "A short summary that should stay quieter than the headline.",
          // Alpha の2件だけ未読にし、配信元ごとの未読数を確かめる。
          read: !(i % 2 === 0 && i < 4),
          saved: false,
          published: new Date(Date.UTC(2026, 10, 19, 12 - i)).toISOString(),
          fetchedAt: "2026-11-19T00:00:00Z",
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, feeds);
  await page.goto("/?view=feeds");
  await expect(
    page.getByRole("button", { name: "Layout headline 0", exact: true }),
  ).toBeVisible();
}

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

for (const design of ["studio", "editorial", "focus"])
  test(`${design}: 最初の見出しが紙面の上部にあり、暗いレールから配信元を選べる`, async ({
    page,
  }, info) => {
    await seed(page, design);
    const first = page.getByRole("button", {
      name: "Layout headline 0",
      exact: true,
    });
    const box = (await first.boundingBox())!;
    const viewport = page.viewportSize()!;
    // 以前は上部の操作群と検索の下、約430px の位置から記事が始まっていた。
    expect(box.y).toBeLessThan(info.project.name === "mobile" ? 340 : 240);
    await expect(first).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("button", { name: "あとで読むに保存：Layout headline 0" }),
    ).toBeInViewport({ ratio: 1 });
    const rail = page.getByRole("region", { name: "収集メニュー" });
    const colors = await rail.evaluate((element) => {
      const title = element.querySelector<HTMLElement>(".rss-feed-title")!;
      return {
        rail: getComputedStyle(element).backgroundColor,
        text: getComputedStyle(title).color,
      };
    });
    const [a, b] = [luminance(colors.text), luminance(colors.rail)];
    expect(luminance(colors.rail)).toBeLessThan(0.05);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThan(
      7,
    );
    if (info.project.name !== "mobile") {
      const railBox = (await rail.boundingBox())!;
      const list = (await page.locator(".rss-article-list").boundingBox())!;
      expect(railBox.x + railBox.width).toBeLessThanOrEqual(box.x);
      // 右側には読み物の外の余白を残す。
      expect(list.x + list.width).toBeLessThan(viewport.width - 160);
      await expect(page.getByLabel("サイト・RSSのURL")).toBeVisible();
      expect(
        await rail.evaluate((element) =>
          element.contains(document.getElementById("feed-url")),
        ),
      ).toBe(true);
    }
    const alpha = rail.locator(".rss-feed-state").filter({
      has: page.getByRole("button", { name: "Alpha journal", exact: true }),
    });
    await expect(alpha.locator(".rss-feed-total")).toHaveText("全3件");
    await expect(alpha.locator(".rss-feed-count")).toHaveText("未読2件");
    const label = alpha.locator(".rss-feed-label");
    expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const nameBox = (await label.boundingBox())!;
    const countBox = (await alpha.locator(".rss-feed-total").boundingBox())!;
    expect(countBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
    const unreadBox = (await alpha.locator(".rss-feed-count").boundingBox())!;
    expect(unreadBox.x).toBeGreaterThan(countBox.x + countBox.width);
    expect(unreadBox.y).toBeLessThan(countBox.y + countBox.height);
    await expect(rail.locator(".rss-feed-state")).toHaveCount(2);
    await alpha
      .getByRole("button", { name: "Alpha journal", exact: true })
      .click();
    await expect(
      alpha.getByRole("button", { name: "Alpha journal", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".rss-article-list li")).toHaveCount(3);
    await expect(page.getByLabel("配信元", { exact: true })).toHaveValue(
      feeds[0].url,
    );
    await page.screenshot({ path: info.outputPath(`${design}-layout.png`) });
  });

test("見出しはポインタなしで移動でき、未読と既読を文字の濃さで見分けられる", async ({
  page,
}) => {
  await seed(page);
  const titles = page.locator(".rss-article-title");
  const weights = await titles.evaluateAll((items) =>
    items.map((item) => Number(getComputedStyle(item).fontWeight)),
  );
  // 0 と 2 は未読、残りは既読。
  expect(weights[0]).toBeGreaterThan(weights[1]);
  expect(weights[2]).toBeGreaterThan(weights[3]);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("n");
  await expect(titles.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(titles.nth(1)).toBeFocused();
  await page.keyboard.press("n");
  await expect(titles.nth(2)).toBeFocused();
  await page.keyboard.press("p");
  await expect(titles.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(titles.nth(5)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(titles.nth(0)).toBeFocused();
  await page.getByLabel("保存領域の記事を検索").focus();
  await page.keyboard.type("n");
  await expect(page.getByLabel("保存領域の記事を検索")).toHaveValue("n");
  await page.getByLabel("保存領域の記事を検索").fill("");
  await titles.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#rss-current-title")).toHaveText(
    "Layout headline 0",
  );
  await page.keyboard.press("n");
  await expect(page.locator("#rss-current-title")).toHaveText(
    "Layout headline 0",
  );
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  const alpha = page
    .locator(".rss-feed-state")
    .filter({
      has: page.getByRole("button", { name: "Alpha journal", exact: true }),
    });
  await expect(alpha.locator(".rss-feed-count")).toHaveText("未読1件");
  await expect(alpha.locator(".rss-feed-total")).toHaveText("全3件");
});

test("空のライブラリでは追加欄を紙面に置き、購読後はレールの末尾へ移す", async ({
  page,
}, info) => {
  const xml = `<rss version="2.0"><channel><title>First source</title><item><guid>1</guid><title>First delivered story</title><description>Summary</description></item></channel></rss>`;
  await page.addInitScript(() =>
    localStorage.setItem("quilna.feed.refresh.v1", "0"),
  );
  await page.route("**/api/collection", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url: "https://example.org/first.xml", xml } }),
  );
  await page.goto("/?view=feeds");
  const welcome = page.getByRole("region", { name: "最初の配信元を追加" });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByLabel("サイト・RSSのURL")).toBeVisible();
  await expect(
    welcome.getByRole("button", { name: "Zennを追加", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("保存領域の記事を検索")).toBeHidden();
  await expect(page.locator(".rss-headline-player")).toBeHidden();
  const field = welcome.getByLabel("サイト・RSSのURL");
  const fieldBox = (await field.boundingBox())!;
  expect(fieldBox.y).toBeLessThan(info.project.name === "mobile" ? 420 : 320);
  await field.fill("https://example.org/");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "First delivered story", exact: true }),
  ).toBeVisible();
  await expect(welcome).toHaveCount(0);
  await expect(page.getByLabel("保存領域の記事を検索")).toBeVisible();
  expect(
    await page
      .getByRole("region", { name: "収集メニュー" })
      .evaluate((element) =>
        element.contains(document.getElementById("feed-url")),
      ),
  ).toBe(true);
});

test("Tabでヘッダーを飛ばして記事に移れる", async ({ page }) => {
  await seed(page);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "記事へ", exact: true });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Enter");
  await expect(page.locator("#rss-main")).toBeFocused();
});

test("スマートフォンでは暗い一行の帯から保存一覧と取り込みへ移れる", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  const header = page.getByRole("banner");
  const destinations = header.getByRole("navigation", { name: "主な移動先" });
  for (const name of ["記事一覧", "保存した記事", "サイト・記事の取り込み"])
    await expect(
      destinations.getByRole("link", { name, exact: true }),
    ).toBeVisible();
  for (const name of ["ことばの辞書を開く", "設定"])
    await expect(
      header.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  const headerBox = (await header.boundingBox())!;
  expect(headerBox.height).toBeLessThan(120);
  await destinations
    .getByRole("link", { name: "保存した記事", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "保存した記事", level: 1 }),
  ).toBeVisible();
  await destinations
    .getByRole("link", { name: "サイト・記事の取り込み", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "サイト・記事の取り込み" })
      .getByLabel("サイト・RSSのURL"),
  ).toBeFocused();
});

test("購読先のアイコンを共用し、壊れた画像は配信元の頭文字に戻す", async ({
  page,
}) => {
  let requests = 0;
  let icon =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  await page.route("**/api/feeds/fetch", (route) => {
    if (route.request().postDataJSON().icon) {
      requests++;
      return route.fulfill({ json: { icon } });
    }
    return route.fulfill({ status: 404 });
  });
  await seed(page);
  const alpha = page.getByRole("button", {
    name: "Alpha journal",
    exact: true,
  });
  await alpha.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      alpha
        .locator("img")
        .evaluateAll((images) =>
          images.some((img) => (img as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  const beta = page.getByRole("button", { name: "Beta notes", exact: true });
  await beta.scrollIntoViewIfNeeded();
  await expect(beta.locator("img")).toHaveAttribute("src", icon);
  expect(requests).toBe(1);
  icon = "data:image/png;base64,AAAA";
  await page.reload();
  await alpha.scrollIntoViewIfNeeded();
  await expect.poll(() => requests).toBe(2);
  await expect(alpha.locator(".rss-feed-mark")).toHaveText("A");
  await expect(beta.locator(".rss-feed-mark")).toHaveText("B");
});

test("見出し中心の表示で記事を往復し、再読み込み後に概要を戻せる", async ({ page }) => {
  await seed(page);
  const rows = page.locator(".rss-article-list > li");
  const summary = rows.first().locator(".rss-excerpt");
  const toggle = page.getByRole("checkbox", { name: "見出し中心" });
  const originalHeight = (await rows.first().boundingBox())!.height;
  await toggle.check();
  await expect(summary).toBeHidden();
  expect((await rows.first().boundingBox())!.height).toBeLessThan(originalHeight);
  const title = page.getByRole("button", { name: "Layout headline 2", exact: true });
  await title.click();
  await page.getByRole("button", { name: /記事一覧へ/ }).click();
  await expect(title).toBeFocused();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(summary).toBeHidden();
  await toggle.uncheck();
  await expect(summary).toBeVisible();
});
