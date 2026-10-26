import { test, expect, type Page } from "@playwright/test";
const address = "https://zenn.dev/feed";
const account = "cloud-account-fixture-000000000000";
const csrf = "cloud-csrf-fixture-000000000000";
const time = Date.parse("2026-10-24T00:00:00Z");
const snapshotId = "f85a0f14-caff-4cc6-81f8-d4d00ca919ee";
const xml =
  "<rss><channel><title>Cloud source</title><item><guid>one</guid><title>Older remote copy</title><description>Older body</description></item><item><guid>two</guid><title>While PC was off</title><description>New body</description></item></channel></rss>";
const initial = () => ({
  available: true,
  account,
  revision: 0,
  interval: 0,
  hosts: ["zenn.dev"],
  sourcePolicy: "public-https",
  feeds: [] as {
    url: string;
    nextAt: number;
    lastSuccess: number | null;
    failures: number;
    error: string;
  }[],
  pending: [] as {
    id: string;
    feedUrl: string;
    url: string;
    fetchedAt: number;
    parts: number;
    size: number;
  }[],
  bytes: 0,
  blocked: false,
});
async function seed(page: Page, feedAddress = address) {
  await page.goto("/?view=feeds");
  await page.evaluate(
    async ({ address, time }) => {
      const path = "/src/feed-store.ts";
      const { openFeedLibrary } = await import(path);
      const db = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["feeds", "articles"], "readwrite");
        const fetchedAt = new Date(time + 60_000).toISOString();
        tx.objectStore("feeds").put({
          url: address,
          title: "Current source",
          fetchedAt,
        });
        tx.objectStore("articles").put({
          id: JSON.stringify([address, "one"]),
          feedUrl: address,
          title: "Newer local article",
          url: "",
          body: "Keep newer local body",
          published: null,
          fetchedAt,
          saved: false,
          read: true,
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { address: feedAddress, time },
  );
}
test("cloud success time advances without a new snapshot and survives a later fetch failure", async ({
  page,
}) => {
  const state = initial();
  state.interval = 15;
  state.feeds = [
    { url: address, nextAt: time, lastSuccess: null, failures: 0, error: "" },
  ];
  await page.route("**/api/collection", (route) =>
    route.fulfill({ json: state }),
  );
  await seed(page);
  await page.reload();
  const source = page.locator(".rss-feed-state");
  await expect(source).toContainText("クラウドの取得はまだ成功していません");
  const localTime = await source
    .getByText(/^ブラウザ内の最終取得 /)
    .textContent();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  state.feeds[0].lastSuccess = time + 15 * 60_000;
  state.feeds[0].nextAt = time + 30 * 60_000;
  await page
    .getByRole("button", {
      name: "クラウドの状態確認・記事を取り込む",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  const success = source.locator("time");
  await expect(success).toHaveAttribute(
    "datetime",
    new Date(time + 15 * 60_000).toISOString(),
  );
  await expect(source).toContainText(localTime!);
  await expect(
    page.getByRole("button", { name: "Newer local article", exact: true }),
  ).toBeVisible();

  state.feeds[0].error = "feed-fetch-failed";
  state.feeds[0].failures = 1;
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page
    .getByRole("button", {
      name: "クラウドの状態確認・記事を取り込む",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(source).toContainText("クラウドで取得できませんでした");
  await expect(success).toHaveAttribute(
    "datetime",
    new Date(time + 15 * 60_000).toISOString(),
  );
});
test("cloud results import after reopening, preserve newer local content and tolerate a lost acknowledgement", async ({
  page,
}) => {
  const state = initial();
  // Cloud collection is active during seeding too: the initial page may read
  // the seeded, overdue feed before its asynchronous startup has completed.
  state.interval = 15;
  let loseAck = true,
    acknowledgements = 0;
  let foregroundRequests = 0;
  await page.route("**/api/feeds/fetch", (route) => {
    foregroundRequests++;
    return route.fulfill({
      status: 502,
      json: { error: "unexpected-foreground-request" },
    });
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { csrfToken: csrf } }),
  );
  await page.route("**/api/collection**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/ack")) {
      acknowledgements++;
      expect(route.request().headers()["x-collection-account"]).toBe(account);
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      if (loseAck)
        return route.fulfill({
          status: 503,
          json: { status: "lost-response" },
        });
      state.pending = [];
    }
    if (path.includes("/snapshots/"))
      return route.fulfill({ json: { ...state.pending[0], account, xml } });
    return route.fulfill({ json: state });
  });
  await seed(page);
  state.pending = [
    {
      id: snapshotId,
      feedUrl: address,
      url: address,
      fetchedAt: time,
      parts: 1,
      size: xml.length,
    },
  ];
  await page.reload();
  await expect(
    page.getByRole("button", { name: "While PC was off", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Newer local article", exact: true }),
  ).toBeVisible();
  expect(acknowledgements).toBe(1);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "接続できません",
  );
  loseAck = false;
  await page
    .getByRole("button", {
      name: "クラウドの状態確認・記事を取り込む",
      exact: true,
    })
    .click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "未取り込みの取得結果：0件",
  );
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "すべての記事 · 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "未読 · 1", exact: true }),
  ).toBeVisible();
  expect(acknowledgements).toBe(2);
  expect(foregroundRequests).toBe(0);
});

test("cloud settings start and stop explicitly; stale revisions show a recoverable conflict", async ({
  page,
}) => {
  const address = "https://publisher.example.org/feed";
  const state = initial();
  let conflict = false;
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { csrfToken: csrf } }),
  );
  await page.route("**/api/collection", (route) => {
    if (route.request().method() === "PUT") {
      if (conflict)
        return route.fulfill({
          status: 409,
          json: { status: "collection-conflict" },
        });
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(state.revision);
      expect(body.urls).toEqual([address]);
      state.revision++;
      state.interval = body.interval;
      state.feeds = [
        {
          url: address,
          nextAt: time,
          lastSuccess: null,
          failures: 0,
          error: "",
        },
      ];
    }
    return route.fulfill({ json: state });
  });
  await seed(page, address);
  await page.reload();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "公開HTTPSのサイト・RSSに対応",
  );
  await page
    .getByLabel("クラウドの収集間隔", { exact: true })
    .selectOption("30");
  await page
    .getByRole("button", {
      name: "クラウド収集を開始・設定を更新",
      exact: true,
    })
    .click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "クラウドで30分ごと",
  );
  await page.reload();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByLabel("クラウドの収集間隔", { exact: true }),
  ).toHaveValue("30");
  await page
    .getByLabel("クラウドの収集間隔", { exact: true })
    .selectOption("60");
  await page
    .getByRole("button", {
      name: "クラウドの状態確認・記事を取り込む",
      exact: true,
    })
    .click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "クラウドで30分ごと",
  );
  await expect(
    page.getByLabel("クラウドの収集間隔", { exact: true }),
  ).toHaveValue("60");
  conflict = true;
  await page
    .getByRole("button", { name: "クラウド収集を停止", exact: true })
    .click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "別の画面で設定が変わりました",
  );
  expect(state.interval).toBe(30);
  conflict = false;
  await page
    .getByRole("button", { name: "クラウド収集を停止", exact: true })
    .click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "クラウド収集は停止中",
  );
});

test("a local-only environment clearly reports unavailable cloud collection", async ({
  page,
}) => {
  await page.route("**/api/collection", (route) =>
    route.fulfill({ status: 404, json: { status: "auth-unconfigured" } }),
  );
  await page.goto("/?view=feeds");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "画面表示中の更新のみ",
  );
  await expect(
    page.getByRole("button", {
      name: "クラウド収集を開始・設定を更新",
      exact: true,
    }),
  ).toBeDisabled();
});

test("a failed browser save never acknowledges the cloud result", async ({
  page,
}) => {
  const state = initial();
  let acknowledgements = 0;
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { csrfToken: csrf } }),
  );
  await page.route("**/api/collection**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/ack")) acknowledgements++;
    return route.fulfill({
      json: path.includes("/snapshots/")
        ? { ...state.pending[0], account, xml }
        : state,
    });
  });
  await seed(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<typeof original>
    ) {
      if (this.name === "articles")
        throw new DOMException("Fixture quota", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  state.pending = [
    {
      id: snapshotId,
      feedUrl: address,
      url: address,
      fetchedAt: time,
      parts: 1,
      size: xml.length,
    },
  ];
  await page.reload();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "記事を保存できませんでした",
  );
  expect(acknowledgements).toBe(0);
  expect(state.pending).toHaveLength(1);
});

test("a malformed snapshot stays recoverable without blocking healthy articles; discard needs explicit confirmation", async ({
  page,
}) => {
  const state = initial();
  const goodId = "f85a0f14-caff-4cc6-81f8-d4d00ca919ef";
  const acknowledged: string[] = [];
  const discarded: string[] = [];
  let badReads = 0;
  let loseDiscard = true;
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { csrfToken: csrf } }),
  );
  await page.route("**/api/collection**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/snapshots/")) {
      const meta = state.pending.find((item) => path.endsWith(item.id));
      if (meta?.id === snapshotId) badReads++;
      return route.fulfill({
        json: {
          ...meta,
          account,
          xml: meta?.id === snapshotId ? "<rss>broken" : xml,
        },
      });
    }
    if (path.endsWith("/ack") || path.endsWith("/discard")) {
      const ids: string[] = route.request().postDataJSON().ids;
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      expect(route.request().headers()["x-collection-account"]).toBe(account);
      if (path.endsWith("/discard") && loseDiscard)
        return route.fulfill({ status: 503, json: { status: "held" } });
      (path.endsWith("/ack") ? acknowledged : discarded).push(...ids);
      state.pending = state.pending.filter((item) => !ids.includes(item.id));
    }
    return route.fulfill({ json: state });
  });
  await seed(page);
  state.interval = 30;
  state.pending = [snapshotId, goodId].map((id) => ({
    id,
    feedUrl: address,
    url: address,
    fetchedAt: time,
    parts: 1,
    size: xml.length,
  }));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "While PC was off", exact: true }),
  ).toBeVisible();
  expect(acknowledged).toEqual([goodId]);
  expect(state.pending.map((item) => item.id)).toEqual([snapshotId]);
  await expect(page.locator("#rss-auto-refresh-status")).toContainText(
    "1件の取得結果を取り込めません",
  );
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator("#rss-cloud-failures")).toContainText(
    "RSS / Atomの形式を読み取れませんでした",
  );
  await page.locator("#rss-cloud-failures").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("cloud-recovery.png") });
  await expect(
    page.getByLabel("クラウドの収集間隔", { exact: true }),
  ).toHaveValue("30");
  await page
    .getByRole("button", {
      name: "クラウドの状態確認・記事を取り込む",
      exact: true,
    })
    .click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "未取り込みの取得結果：1件",
  );
  expect(badReads).toBe(1);
  await page
    .getByRole("button", { name: "取り込めない取得結果を再試行", exact: true })
    .click();
  await expect.poll(() => badReads).toBe(2);
  const remove = page.getByRole("button", {
    name: "この取得結果を削除",
    exact: true,
  });
  await expect(remove).toBeEnabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect(discarded).toEqual([]);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "接続できません",
  );
  expect(discarded).toEqual([]);
  await expect(remove).toBeEnabled();
  loseDiscard = false;
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.locator("#rss-cloud-failures")).toBeEmpty();
  expect(discarded).toEqual([snapshotId]);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "While PC was off", exact: true }),
  ).toBeVisible();
});

test("five malformed snapshots do not starve the next batch, and a concurrently removed snapshot is harmless", async ({
  page,
}) => {
  const state = initial();
  const ids = Array.from(
    { length: 7 },
    (_, index) => `f85a0f14-caff-4cc6-81f8-d4d00ca919e${index}`,
  );
  const reads: string[] = [];
  const acknowledged: string[] = [];
  await page.clock.install();
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { csrfToken: csrf } }),
  );
  await page.route("**/api/collection**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/snapshots/")) {
      const meta = state.pending.find((item) => path.endsWith(item.id));
      expect(meta).toBeTruthy();
      reads.push(meta!.id);
      if (meta!.id === ids[5]) {
        state.pending = state.pending.filter((item) => item.id !== ids[5]);
        return route.fulfill({
          status: 409,
          json: { status: "snapshot-missing" },
        });
      }
      return route.fulfill({
        json: {
          ...meta,
          account,
          xml: meta!.id === ids[6] ? xml : "<rss>broken",
        },
      });
    }
    if (path.endsWith("/ack")) {
      const received: string[] = route.request().postDataJSON().ids;
      acknowledged.push(...received);
      state.pending = state.pending.filter(
        (item) => !received.includes(item.id),
      );
    }
    return route.fulfill({ json: state });
  });
  await seed(page);
  state.interval = 30;
  state.pending = ids.map((id) => ({
    id,
    feedUrl: address,
    url: address,
    fetchedAt: time,
    parts: 1,
    size: xml.length,
  }));
  await page.reload();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "取り込めない取得結果：5件",
  );
  expect(reads).toEqual(ids.slice(0, 5));
  await page.clock.fastForward(16000);
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "未取り込みの取得結果：5件",
  );
  expect(reads).toEqual(ids);
  expect(acknowledged).toEqual([ids[6]]);
  await page.clock.fastForward(65000);
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "取り込めない取得結果：5件",
  );
  expect(reads).toEqual(ids);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "While PC was off", exact: true }),
  ).toBeVisible();
});

for (const failure of [
  "503",
  "network",
  "timeout",
  "401",
  "unconfigured",
] as const) {
  test(`cloud polling recovers after ${failure} only when retry is safe`, async ({
    page,
  }) => {
    const state = initial();
    let mode: "healthy" | "failure" = "healthy";
    let requests = 0;
    let acknowledgements = 0;
    await page.clock.install();
    await page.route("**/api/session", (route) =>
      route.fulfill({ json: { csrfToken: csrf } }),
    );
    await page.route("**/api/collection**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/ack")) {
        acknowledgements++;
        state.pending = [];
      } else if (path.includes("/snapshots/")) {
        return route.fulfill({ json: { ...state.pending[0], account, xml } });
      } else {
        requests++;
        if (mode === "failure") {
          if (failure === "timeout") return;
          if (failure === "network") return route.abort("failed");
          return route.fulfill({
            status: failure === "unconfigured" ? 503 : Number(failure),
            json: {
              status:
                failure === "unconfigured"
                  ? "auth-unconfigured"
                  : "temporary-fixture",
            },
          });
        }
      }
      return route.fulfill({ json: state });
    });
    await seed(page);
    state.interval = 15;
    await page.reload();
    await expect(page.locator("#rss-cloud-status")).toContainText(
      "クラウドで15分ごと",
    );
    const healthyRequests = requests;
    mode = "failure";
    await page.clock.fastForward(60001);
    await expect.poll(() => requests).toBe(healthyRequests + 1);
    if (failure === "timeout") await page.clock.fastForward(16001);
    await expect(page.locator("#rss-cloud-status")).toContainText(
      failure === "unconfigured"
        ? "有効になっていません"
        : failure === "401"
          ? "ログインが必要"
          : failure === "timeout"
            ? "時間内に届きません"
            : "接続できません",
    );
    mode = "healthy";
    state.pending = [
      {
        id: snapshotId,
        feedUrl: address,
        url: address,
        fetchedAt: time,
        parts: 1,
        size: xml.length,
      },
    ];
    await page.clock.fastForward(
      ["401", "unconfigured"].includes(failure) ? 600001 : 30001,
    );
    if (["401", "unconfigured"].includes(failure)) {
      expect(requests).toBe(healthyRequests + 1);
      expect(acknowledgements).toBe(0);
    } else {
      await expect.poll(() => acknowledgements).toBe(1);
      await expect(page.locator("#rss-cloud-status")).toContainText(
        "未取り込みの取得結果：0件",
      );
      await expect(
        page.getByRole("button", { name: "While PC was off", exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "Newer local article", exact: true }),
    ).toBeVisible();
  });
}

test("initial connection failures back off to five minutes and a lost ACK recovers without duplicate articles", async ({
  page,
}) => {
  const state = initial();
  state.interval = 15;
  state.pending = [
    {
      id: snapshotId,
      feedUrl: address,
      url: address,
      fetchedAt: time,
      parts: 1,
      size: xml.length,
    },
  ];
  let online = false;
  let requests = 0;
  let acknowledgements = 0;
  await page.clock.install({ time: new Date(time) });
  await page.clock.pauseAt(new Date(time + 1000));
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { csrfToken: csrf } }),
  );
  await page.route("**/api/collection**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/ack")) {
      acknowledgements++;
      if (acknowledgements === 1)
        return route.fulfill({ status: 503, json: { status: "lost-ack" } });
      state.pending = [];
    } else if (path.includes("/snapshots/")) {
      return route.fulfill({ json: { ...state.pending[0], account, xml } });
    } else {
      requests++;
      if (!online)
        return route.fulfill({
          status: 503,
          json: { status: "temporary-fixture" },
        });
    }
    return route.fulfill({ json: state });
  });
  await page.goto("/?view=feeds");
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "自動的に再確認",
  );
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    const before = requests;
    await page.clock.fastForward(delay - 1);
    expect(requests).toBe(before);
    await page.clock.fastForward(1);
    await expect.poll(() => requests).toBe(before + 1);
    await expect(page.locator("#rss-cloud-status")).toContainText(
      "自動的に再確認",
    );
  }
  online = true;
  await page.clock.fastForward(300000);
  await expect.poll(() => acknowledgements).toBe(1);
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "自動的に再確認",
  );
  await expect(
    page.getByRole("button", { name: "While PC was off", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(300000);
  await expect.poll(() => acknowledgements).toBe(2);
  await expect(page.locator("#rss-cloud-status")).toContainText(
    "未取り込みの取得結果：0件",
  );
  await expect(
    page.getByRole("button", { name: "すべての記事 · 2", exact: true }),
  ).toBeVisible();
  const before = requests;
  await page.clock.fastForward(59999);
  expect(requests).toBe(before);
  await page.clock.fastForward(1);
  await expect.poll(() => requests).toBe(before + 1);
});
