import { test, expect, type Page } from "@playwright/test";

const feedURL = "https://example.org/navigation.xml";
async function seed(page: Page) {
  const xml = `<rss version="2.0"><channel><title>Navigation fixture</title>${Array.from({ length: 80 }, (_, i) => `<item><guid>${String(i).padStart(3, "0")}</guid><title>記事 ${i}</title><description>${"共通の本文。読み進めても記事の一覧へ戻れます。 ".repeat(i === 70 ? 500 : 3)}</description></item>`).join("")}</channel></rss>`;
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ json: { url: feedURL, xml } }),
  );
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill(feedURL);
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(page.locator("#rss-search-status")).toContainText("80件");
}

for (const design of ["studio", "editorial", "focus"])
  test(`${design} keeps a way back while reading and restores the source row in its filtered page`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem("quilna.reader.design.v1", value),
      design,
    );
    await seed(page);
    await page.getByLabel("保存領域の記事を検索").fill("共通");
    await page.getByRole("button", { name: "次の50件", exact: true }).click();
    await expect(page.locator("#rss-search-status")).toContainText("51–80件");
    const row = page.getByRole("button", { name: "記事 70", exact: true });
    await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const before = await row.boundingBox();
    await row.click();
    await expect(page.locator("#rss-current-title")).toBeFocused();
    await page.locator("#rss-reading-tools").scrollIntoViewIfNeeded();
    const back = page.getByRole("button", {
      name: "← 記事一覧へ",
      exact: true,
    });
    await expect(back).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`${design}-reading-back.png`),
    });
    await back.click();
    await expect(page.getByLabel("保存領域の記事を検索")).toHaveValue("共通");
    await expect(page.locator("#rss-search-status")).toContainText("51–80件");
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    await expect
      .poll(async () => Math.abs((await row.boundingBox())!.y - before!.y))
      .toBeLessThan(8);
  });

for (const fromDiscovery of [false, true])
  test(`importing an article URL moves focus to its reading view${fromDiscovery ? " after unsuccessful feed discovery" : ""}`, async ({
    page,
  }) => {
    await page.route("**/api/feeds/fetch", (r) =>
      r.fulfill({
        json: {
          url: "https://example.org/story",
          html: `<html><title>取り込んだ記事</title><article><h1>取り込んだ記事</h1><p>${"本文を読み始められます。".repeat(100)}</p></article></html>`,
        },
      }),
    );
    await page.goto("/?view=feeds");
    await page.getByLabel("サイト・RSSのURL").fill("https://example.org/story");
    if (fromDiscovery) {
      await page
        .getByRole("button", { name: "フィードを探す", exact: true })
        .click();
      await expect(
        page.getByText(/配信元が見つかりませんでした/),
      ).toBeVisible();
    }
    await page
      .getByRole("button", {
        name: fromDiscovery ? "この記事を取り込んで保存" : "記事として取り込む",
        exact: true,
      })
      .click();
    await expect(page.locator("#rss-current-title")).toHaveText(
      "取り込んだ記事",
    );
    await expect(page.locator("#rss-current-title")).toBeFocused();
    await expect(page.locator("#rss-current-title")).toBeInViewport();
    await expect(
      page.getByRole("region", { name: "見つかった配信元" }),
    ).toBeHidden();
  });

for (const onlyMatch of [false, true])
  test(`returning from unread keeps navigation usable when the read row disappears${onlyMatch ? " and no matches remain" : ""}`, async ({
    page,
  }) => {
    await seed(page);
    await page.getByRole("button", { name: /未読 ·/ }).click();
    if (onlyMatch)
      await page.getByLabel("保存領域の記事を検索").fill("記事 20");
    await page.getByRole("button", { name: "記事 20", exact: true }).click();
    await expect(page.getByRole("button", { name: /未読 · 79/ })).toBeVisible();
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "記事 20", exact: true }),
    ).toHaveCount(0);
    const destination = onlyMatch
      ? page.getByRole("heading", { name: "未読の記事", exact: true })
      : page.getByRole("button", { name: "記事 21", exact: true });
    await expect(destination).toBeFocused();
    await expect(destination).toBeInViewport();
  });

test("a later cross-tab removal preserves keyboard navigation after returning", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: /未読 ·/ }).click();
  await page.getByRole("button", { name: "記事 20", exact: true }).click();
  await expect(page.getByRole("button", { name: /未読 · 79/ })).toBeVisible();
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "記事 21", exact: true }),
  ).toBeFocused();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("tsumiki.rss.v1");
      request.onsuccess = () => resolve(request.result);
    });
    let removedId = "";
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      const store = tx.objectStore("articles");
      const request = store.getAll();
      request.onsuccess = () => {
        const article = request.result.find(
          (article) => article.title === "記事 21",
        );
        removedId = article.id;
        store.put({ ...article, read: true });
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const channel = new BroadcastChannel("tsumiki.rss.v1");
    channel.postMessage({ articleId: removedId });
    channel.close();
  });
  await expect(
    page.getByRole("button", { name: "記事 21", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "記事 22", exact: true }),
  ).toBeFocused();
});
