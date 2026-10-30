import { test, expect, type Page } from "@playwright/test";
test.use({ timezoneId: "UTC" });
const base = Date.parse("2026-10-24T00:00:00Z");
const address = "https://publisher.example.org/rss";
const xml = (label = "Updated") =>
  `<rss><channel><title>Publisher</title><item><guid>one</guid><title>${label}</title><description>Updated article body.</description></item><item><guid>new</guid><title>New story</title><description>Another article.</description></item></channel></rss>`;

test("an unsubscribed feed stays excluded from due collection after visibility changes", async ({
  page,
}) => {
  await environment(page);
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  let requests = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    requests++;
    return r.fulfill({ json: { url: address, xml: xml() } });
  });
  await seed(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Publisher 0の購読を解除", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Publisher 0の購読を再開", exact: true }),
  ).toBeEnabled();
  await wake(page, 16);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(requests).toBe(0);
  await expect(
    page.getByRole("button", { name: "すべて更新", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Saved original", exact: true }),
  ).toBeVisible();
});
async function environment(page: Page) {
  await page.clock.setFixedTime(new Date(base));
  await page.addInitScript(() => {
    const w = window as unknown as { qaHidden: boolean; qaOffline: boolean };
    w.qaHidden = false;
    w.qaOffline = false;
    Object.defineProperty(document, "hidden", {
      get: () => w.qaHidden,
      configurable: true,
    });
    Object.defineProperty(navigator, "onLine", {
      get: () => !w.qaOffline,
      configurable: true,
    });
  });
}
async function seed(page: Page, count = 1) {
  await page.goto("/?view=feeds");
  await page.evaluate(
    async ({ address, base, count }) => {
      const path = "/src/feed-store.ts";
      const { openFeedLibrary } = await import(path);
      const db = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["feeds", "articles"], "readwrite");
        for (let i = 0; i < count; i++)
          tx.objectStore("feeds").put({
            url: i ? `${address}/${i}` : address,
            title: `Publisher ${i}`,
            fetchedAt: new Date(base).toISOString(),
          });
        tx.objectStore("articles").put({
          id: JSON.stringify([address, "one"]),
          feedUrl: address,
          title: "Saved original",
          url: "",
          body: "Original content.",
          read: true,
          saved: true,
          published: null,
          fetchedAt: new Date(base).toISOString(),
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { address, base, count },
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Saved original", exact: true }),
  ).toBeVisible();
}
async function wake(
  page: Page,
  minutes: number,
  hidden = false,
  offline = false,
) {
  await page.clock.setFixedTime(new Date(base + minutes * 60_000));
  await page.evaluate(
    ({ hidden, offline }) => {
      const w = window as unknown as { qaHidden: boolean; qaOffline: boolean };
      w.qaHidden = hidden;
      w.qaOffline = offline;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    { hidden, offline },
  );
}
test("automatic collection respects due time, visibility and connectivity while retaining saved/read snapshots", async ({
  page,
}) => {
  await environment(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", (route) => {
    requests++;
    return route.fulfill({ json: { url: address, xml: xml() } });
  });
  await seed(page);
  await wake(page, 14);
  expect(requests).toBe(0);
  await wake(page, 16, true);
  await expect(page.locator("#rss-auto-refresh-status")).toContainText(
    "画面非表示",
  );
  expect(requests).toBe(0);
  await wake(page, 16, false, true);
  await expect(page.locator("#rss-auto-refresh-status")).toContainText(
    "オフライン",
  );
  expect(requests).toBe(0);
  await wake(page, 16);
  await expect(
    page.getByRole("button", { name: "New story", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
  await expect(
    page.getByRole("button", { name: "Saved original", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /未読 · 1/ })).toBeVisible();
  await wake(page, 17);
  expect(requests).toBe(1);
  await wake(page, 32);
  await expect.poll(() => requests).toBe(2);
  await expect(
    page.getByRole("button", { name: /すべての記事 · 2/ }),
  ).toBeVisible();
});
test("failed updates back off across reload and recovery clears failure without deleting articles", async ({
  page,
}) => {
  await environment(page);
  let requests = 0,
    fail = true;
  await page.route("**/api/feeds/fetch", (route) => {
    requests++;
    return route.fulfill(
      fail
        ? { status: 502, json: { error: "offline" } }
        : { json: { url: address, xml: xml() } },
    );
  });
  await seed(page);
  await wake(page, 16);
  await expect(page.locator(".rss-feed-error")).toBeVisible();
  expect(requests).toBe(1);
  await page.reload();
  await expect(page.locator(".rss-feed-error")).toBeVisible();
  expect(requests).toBe(1);
  await wake(page, 20);
  expect(requests).toBe(1);
  await wake(page, 21);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText(/次回更新の目安.*0:31/)).toBeVisible();
  fail = false;
  await wake(page, 30);
  expect(requests).toBe(2);
  await wake(page, 31);
  await expect(
    page.getByRole("button", { name: "New story", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rss-feed-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Saved original", exact: true }),
  ).toBeVisible();
});
test("multiple tabs share two fetch slots and recheck freshness under the per-feed lock", async ({
  page,
  context,
}) => {
  await environment(page);
  const other = await context.newPage();
  await environment(other);
  let active = 0,
    max = 0;
  const calls: string[] = [];
  const pending: (() => Promise<void>)[] = [];
  await context.route("**/api/feeds/fetch", async (route) => {
    const url = route.request().postDataJSON().url;
    calls.push(url);
    active++;
    max = Math.max(max, active);
    await new Promise<void>((resolve) =>
      pending.push(async () => {
        active--;
        await route.fulfill({ json: { url, xml: xml() } });
        resolve();
      }),
    );
  });
  await seed(page, 3);
  await other.goto("/?view=feeds");
  await expect(
    other.getByRole("button", { name: "Saved original", exact: true }),
  ).toBeVisible();
  await Promise.all([wake(page, 16), wake(other, 16)]);
  await expect.poll(() => pending.length).toBe(2);
  expect(max).toBe(2);
  await pending.shift()!();
  await pending.shift()!();
  // Both tabs may have used a different slot; the remaining feed is retried
  // on the next scheduler wake after those commits, not while both slots are held.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/feed-store.ts";
        const { openFeedLibrary, readFeedLibrary } = await import(path);
        const db = await openFeedLibrary();
        const library = await readFeedLibrary(db);
        db.close();
        return library.feeds.filter(
          (feed: { fetchedAt: string }) =>
            Date.parse(feed.fetchedAt) > Date.parse("2026-10-24T00:00:00Z"),
        ).length;
      }),
    )
    .toBe(2);
  await Promise.all([wake(page, 16), wake(other, 16)]);
  await expect.poll(() => pending.length).toBe(1);
  await pending.shift()!();
  await expect.poll(() => calls.length).toBe(3);
  expect(new Set(calls).size).toBe(3);
  expect(max).toBe(2);
  await expect(page.locator(".rss-feed-state").first()).not.toContainText(
    "9:15",
  );
  await Promise.all([wake(page, 17), wake(other, 17)]);
  expect(calls).toHaveLength(3);
  await other.close();
});
test("automatic collection can be turned off persistently and unsupported locks are disclosed", async ({
  page,
}) => {
  await environment(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", (route) => {
    requests++;
    return route.fulfill({ json: { url: address, xml: xml() } });
  });
  await seed(page);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("RSSの自動更新", { exact: true }).selectOption("0");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.reload();
  await wake(page, 120);
  await expect(page.locator("#rss-auto-refresh-status")).toHaveText(
    "自動更新：オフ",
  );
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByLabel("RSSの自動更新", { exact: true })).toHaveValue(
    "0",
  );
  await page.getByLabel("RSSの自動更新", { exact: true }).selectOption("30");
  await expect.poll(() => requests).toBe(1);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    }),
  );
  await page.reload();
  await expect(page.locator("#rss-auto-refresh-status")).toContainText(
    "自動更新を利用できません",
  );
});
test("discovery without RSS offers to save the original article rather than the fallback homepage", async ({
  page,
}) => {
  const original = "https://publisher.example.org/story";
  const urls: string[] = [];
  const content =
    "The article explains how a database stores information for software developers. ".repeat(
      6,
    );
  await page.route("**/api/feeds/fetch", (route) => {
    const url = route.request().postDataJSON().url;
    urls.push(url);
    return route.fulfill({
      json: {
        url,
        html: `<html lang="en"><title>A standalone article</title><article><h1>A standalone article</h1><p>${content}</p></article></html>`,
      },
    });
  });
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill(original);
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page
    .getByRole("button", { name: "この記事を取り込んで保存", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "database stores information",
  );
  expect(urls).toEqual([original, "https://publisher.example.org/", original]);
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("failure to persist a retry deadline stops automatic requests while retaining cached articles", async ({
  page,
}) => {
  await environment(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", (route) => {
    requests++;
    return route.fulfill({ status: 502, json: { error: "down" } });
  });
  await seed(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "feeds" && value.refreshFailure) throw Error("full");
      return put.call(this, value, ...args);
    };
  });
  await wake(page, 16);
  await expect(page.locator("#rss-auto-refresh-status")).toContainText(
    "自動更新を停止",
  );
  await wake(page, 200);
  expect(requests).toBe(1);
  await expect(
    page.getByRole("button", { name: "Saved original", exact: true }),
  ).toBeVisible();
});
