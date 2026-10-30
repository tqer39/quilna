import { test, expect, type Page } from "@playwright/test";

const url = "https://publisher.example.org/rss";
const other = "https://other.example.org/rss";
const fetchedAt = "2026-10-30T00:00:00Z";
const initial = () => ({
  available: true,
  account: "subscription-account-000000000000",
  revision: 0,
  interval: 15,
  hosts: [],
  sourcePolicy: "public-https",
  pending: [],
  bytes: 0,
  blocked: false,
  feeds: [url, other].map((url) => ({
    url,
    nextAt: Date.now() + 600000,
    lastSuccess: Date.now(),
    failures: 0,
    error: "",
  })),
});

async function seed(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("quilna.feed.refresh.v1", "0"),
  );
  await page.route("**/__subscription", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Subscription fixture</title>",
    }),
  );
  await page.goto("/__subscription");
  await page.evaluate(
    async ({ url, fetchedAt }) => {
      const path = "/src/feed-store.ts";
      const { openFeedLibrary } = await import(path);
      const db = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["feeds", "articles"], "readwrite");
        tx.objectStore("feeds").put({ url, title: "Publisher", fetchedAt });
        tx.objectStore("articles").put({
          id: "retained",
          feedUrl: url,
          title: "Saved article",
          url: "",
          body: "Saved original",
          published: null,
          fetchedAt,
          saved: true,
          read: true,
          manualTags: ["自分のタグ"],
        });
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { url, fetchedAt },
  );
  await page.goto("/?view=feeds");
  await expect(
    page.getByRole("button", { name: "Publisherの購読を解除", exact: true }),
  ).toBeEnabled();
}
async function stored(page: Page) {
  return page.evaluate(async (url) => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary, readFeed, readArticle } = await import(path);
    const db = await openFeedLibrary();
    try {
      return {
        feed: await readFeed(db, url),
        article: await readArticle(db, "retained"),
      };
    } finally {
      db.close();
    }
  }, url);
}
async function operate(page: Page, label: string) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: label, exact: true }).click();
}

test("unsubscribe keeps articles, excludes collection, survives reload and resumes explicitly", async ({
  page,
}) => {
  const state = initial();
  const writes: string[][] = [];
  await page.route("**/api/collection", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(state.revision);
      expect(body.interval).toBe(15);
      writes.push(body.urls);
      state.revision++;
      state.feeds = body.urls.map(
        (address: string) =>
          state.feeds.find((f) => f.url === address) ?? {
            url: address,
            nextAt: Date.now(),
            lastSuccess: null,
            failures: 0,
            error: "",
          },
      );
    }
    return route.fulfill({ json: state });
  });
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { csrfToken: "subscription-csrf-000000000000" } }),
  );
  let refreshes = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    refreshes++;
    return r.abort();
  });
  await seed(page);
  const original = (await stored(page)).article;
  await operate(page, "Publisherの購読を解除");
  await expect(
    page.getByText("購読解除済み。保存した記事は引き続き読めます。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toEqual([[other]]);
  expect((await stored(page)).article).toEqual(original);
  await expect(
    page.getByRole("button", { name: "すべて更新", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Publisherを更新", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Saved article", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page
    .getByRole("button", {
      name: "クラウド収集を開始・設定を更新",
      exact: true,
    })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual([other]);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await operate(page, "Publisherの購読を再開");
  await expect(
    page.getByRole("button", { name: "Publisherの購読を解除", exact: true }),
  ).toBeEnabled();
  expect((await stored(page)).feed.unsubscribed).toBe(false);
  expect((await stored(page)).article).toEqual(original);
  expect(refreshes).toBe(0);
});

test("lost cloud reply retains a pending state and retry confirms without deleting delivery data", async ({
  page,
}) => {
  const state = initial();
  let writes = 0;
  await page.route("**/api/collection", async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      state.feeds = state.feeds.filter((f) => f.url !== url);
      state.revision++;
      return route.abort(); // Applied, but the acknowledgement was lost.
    }
    return route.fulfill({ json: state });
  });
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { csrfToken: "subscription-csrf-000000000000" } }),
  );
  await seed(page);
  await operate(page, "Publisherの購読を解除");
  await expect(
    page.getByRole("button", {
      name: "Publisherのクラウド解除を再確認",
      exact: true,
    }),
  ).toBeEnabled();
  expect((await stored(page)).feed.cloudUnsubscribePending).toBe(true);
  await page.reload();
  await operate(page, "Publisherのクラウド解除を再確認");
  await expect(
    page.getByText("購読解除済み。保存した記事は引き続き読めます。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect((await stored(page)).article.body).toBe("Saved original");
});

test("failed local save leaves subscription and cloud unchanged", async ({
  page,
}) => {
  const state = initial();
  let writes = 0;
  await page.route("**/api/collection", (r) => {
    if (r.request().method() === "PUT") writes++;
    return r.fulfill({ json: state });
  });
  await seed(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "feeds" && value.unsubscribed) {
        throw new DOMException("Synthetic full storage", "QuotaExceededError");
      }
      return put.call(this, value, key);
    };
  });
  await operate(page, "Publisherの購読を解除");
  await expect(page.getByRole("alert")).toContainText(
    "購読の変更を完了できませんでした",
  );
  expect((await stored(page)).feed.unsubscribed).toBeUndefined();
  expect(writes).toBe(0);
});

test("cloud collection can still be stopped when local subscription reads fail", async ({
  page,
}) => {
  const state = initial();
  let writes = 0;
  await page.route("**/api/collection", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body.urls).toEqual([url, other]);
      expect(body.interval).toBe(0);
      writes++;
      state.interval = 0;
      state.revision++;
    }
    return route.fulfill({ json: state });
  });
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { csrfToken: "subscription-csrf-000000000000" } }),
  );
  await seed(page);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "クラウド収集を停止", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === "feeds")
        throw new DOMException("Synthetic read failure", "UnknownError");
      return getAll.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "クラウド収集を停止", exact: true })
    .click();
  await expect.poll(() => writes, { timeout: 2000 }).toBe(1);
  await expect(
    page.getByRole("button", { name: "クラウド収集を停止", exact: true }),
  ).toBeDisabled();
  expect((await stored(page)).article.body).toBe("Saved original");
});

for (const failure of ["account-changed", "conflict", "unavailable"]) {
  test(`cloud ${failure} keeps removal unconfirmed and other subscriptions intact`, async ({
    page,
  }) => {
    const state = initial();
    let fail = false,
      writes = 0;
    await page.route("**/api/collection", (route) => {
      if (route.request().method() === "PUT") {
        writes++;
        return route.fulfill({
          status: 409,
          json: { status: "collection-conflict" },
        });
      }
      return route.fulfill({
        json:
          fail && failure === "account-changed"
            ? { ...state, account: "different-account-000000000000" }
            : fail && failure === "unavailable"
              ? { ...state, available: false }
              : state,
      });
    });
    await page.route("**/api/session", (r) =>
      r.fulfill({ json: { csrfToken: "subscription-csrf-000000000000" } }),
    );
    await seed(page);
    await expect(page.locator("#rss-auto-refresh-status")).toContainText(
      "クラウド収集：15分",
    );
    fail = true;
    await operate(page, "Publisherの購読を解除");
    await expect(page.getByRole("alert")).toContainText(
      failure === "account-changed"
        ? "アカウントが変わりました"
        : failure === "unavailable"
          ? "クラウド収集を利用できない"
          : "別の画面で設定が変わりました",
    );
    expect(writes).toBe(failure === "conflict" ? 1 : 0);
    expect(state.feeds.map((f) => f.url)).toEqual([url, other]);
    expect((await stored(page)).feed.cloudUnsubscribePending).toBe(true);
    expect((await stored(page)).article.body).toBe("Saved original");
  });
}

test("a stale tab's cloud configuration rereads local subscription choices", async ({
  page,
  context,
}) => {
  const state = initial();
  const writes: string[][] = [];
  await context.route("**/api/collection", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      if (body.expectedRevision !== state.revision)
        return route.fulfill({
          status: 409,
          json: { status: "collection-conflict" },
        });
      state.revision++;
      writes.push(body.urls);
      state.feeds = state.feeds.filter((f) => body.urls.includes(f.url));
    }
    return route.fulfill({ json: state });
  });
  await context.route("**/api/session", (r) =>
    r.fulfill({ json: { csrfToken: "subscription-csrf-000000000000" } }),
  );
  await seed(page);
  const stale = await context.newPage();
  await stale.addInitScript(() =>
    Object.defineProperty(window, "BroadcastChannel", { value: undefined }),
  );
  await stale.goto("/?view=feeds");
  await expect(
    stale.getByRole("button", { name: "Publisherの購読を解除", exact: true }),
  ).toBeEnabled();
  await operate(page, "Publisherの購読を解除");
  await expect(
    page.getByText("購読解除済み。保存した記事は引き続き読めます。", {
      exact: true,
    }),
  ).toBeVisible();
  await stale.getByRole("button", { name: "設定", exact: true }).click();
  await stale
    .getByRole("button", {
      name: "クラウドの状態確認・記事を取り込む",
      exact: true,
    })
    .click();
  await expect(
    stale.getByRole("button", {
      name: "クラウド収集を開始・設定を更新",
      exact: true,
    }),
  ).toBeEnabled();
  await stale
    .getByRole("button", {
      name: "クラウド収集を開始・設定を更新",
      exact: true,
    })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes).toEqual([[other], [other]]);
  expect((await stored(stale)).feed.unsubscribed).toBe(true);
  await stale.close();
});

test("late snapshots and cloud acknowledgements cannot undo subscription choices; backup keeps them", async ({
  page,
}) => {
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await seed(page);
  const result = await page.evaluate(
    async ({ url, fetchedAt }) => {
      const path = "/src/feed-store.ts",
        backupPath = "/src/library-backup.ts";
      const {
        openFeedLibrary,
        readFeed,
        readArticle,
        setFeedSubscription,
        mergeFeed,
      } = await import(path);
      const db = await openFeedLibrary();
      const original = await readArticle(db, "retained");
      const revision = await setFeedSubscription(db, url, false);
      await mergeFeed(
        db,
        { url, title: "Late source", fetchedAt: "2026-10-30T01:00:00Z" },
        [
          {
            ...original,
            body: "Late body",
            saved: false,
            read: false,
            fetchedAt,
          },
        ],
      );
      const paused = await readFeed(db, url);
      const article = await readArticle(db, "retained");
      await setFeedSubscription(db, url, true);
      const staleResult = await setFeedSubscription(db, url, false, revision);
      const resumed = await readFeed(db, url);
      await setFeedSubscription(db, url, false);
      const before = await readFeed(db, url);
      db.close();
      const backup = await import(backupPath);
      const archive = await backup.exportLibrary();
      const preview = await backup.validateBackup(
        new File([archive.blob], "test.quilna.gz"),
      );
      const restoreDB = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = restoreDB.transaction("feeds", "readwrite");
        tx.objectStore("feeds").delete(url); // This isolated fixture only; articles remain.
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      restoreDB.close();
      await backup.restoreBackup(preview.id);
      const finalDB = await openFeedLibrary();
      const after = await readFeed(finalDB, url);
      finalDB.close();
      return { paused, original, article, staleResult, resumed, before, after };
    },
    { url, fetchedAt },
  );
  expect(result.paused.unsubscribed).toBe(true);
  expect(result.article).toEqual({
    ...result.original,
    tags: result.article.tags,
  });
  expect(result.staleResult).toBeNull();
  expect(result.resumed.unsubscribed).toBe(false);
  expect(result.after).toEqual(result.before);
});
