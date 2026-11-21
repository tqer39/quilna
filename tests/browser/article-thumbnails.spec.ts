import { expect, test } from "@playwright/test";

test("画像がある記事と画像がない記事は同じ左端に見出しが並ぶ", async ({
  page,
}) => {
  const base = "https://publisher.example.org",
    image = base + "/cover.png";
  const items = [
    ["画像あり", '<enclosure type="image/png" url="/cover.png"/>'],
    ["画像なし", ""],
    ["取得失敗", '<media:thumbnail url="/missing.png"/>'],
  ];
  const xml =
    '<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>配信元</title>' +
    items
      .map(
        ([name, media], i) =>
          "<item><guid>" +
          i +
          "</guid><title>" +
          name +
          "</title><description>概要</description>" +
          media +
          "</item>",
      )
      .join("") +
    "</channel></rss>";
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url: base + "/rss", xml } }),
  );
  await page.route(image, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="navy"/></svg>',
    }),
  );
  await page.route(base + "/missing.png", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill(base + "/rss");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  const rows = page.locator(".rss-article-list > li");
  await expect(rows).toHaveCount(3);
  const cover = rows
    .filter({ hasText: "画像あり" })
    .locator(".rss-story-thumbnail img");
  await expect
    .poll(() => cover.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await rows.filter({ hasText: "取得失敗" }).scrollIntoViewIfNeeded();
  await expect(
    rows.filter({ hasText: "取得失敗" }).locator(".rss-story-thumbnail img"),
  ).toHaveCount(0);
  await expect(
    rows.filter({ hasText: "画像なし" }).locator(".rss-story-thumbnail img"),
  ).toHaveCount(0);
  const unavailable = page.getByRole("img", { name: "画像を表示できません" });
  await expect(unavailable).toHaveCount(1);
  await expect(
    rows
      .filter({ hasText: "取得失敗" })
      .getByRole("img", { name: "画像を表示できません" }),
  ).toBeVisible();
  const positions = await rows.evaluateAll((nodes) =>
    nodes.map((node) => {
      const title = node
        .querySelector(".rss-article-title")!
        .getBoundingClientRect();
      const slot = node
        .querySelector(".rss-story-thumbnail")!
        .getBoundingClientRect();
      return { title: title.left, slot: slot.right };
    }),
  );
  for (const item of positions) {
    expect(item.title).toBe(positions[0].title);
    expect(item.slot).toBeLessThan(item.title);
  }
  await page.route(base + "/missing.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    }),
  );
  await page.reload();
  await expect(cover).toHaveAttribute("src", image);
  const recovered = rows
    .filter({ hasText: "取得失敗" })
    .locator(".rss-story-thumbnail img");
  await recovered.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      recovered.evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(8);
  await expect(unavailable).toHaveCount(0);
});
