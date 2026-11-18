import { test, expect, type Page } from "@playwright/test";

const googleURL = "https://trends.google.com/trending/rss?geo=JP";
const hnURL = "https://news.ycombinator.com/rss";
const githubURL = "https://github.com/trending?since=daily";
const google = `<rss version="2.0"><channel><title>Daily Search Trends</title><item><title>非同期</title><link>${googleURL.replaceAll("&", "&amp;")}</link><pubDate>Tue, 17 Nov 2026 09:00:00 GMT</pubDate></item><item><title>キャッシュ</title><link>${googleURL.replaceAll("&", "&amp;")}</link><pubDate>Tue, 17 Nov 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
const hackernews = `<rss version="2.0"><channel><title>Hacker News</title><item><title>SQLite improves database caching</title><link>https://example.org/sqlite</link></item></channel></rss>`;
const github = `<!doctype html><article class="Box-row"><h2><a href="/meta/astryx">meta / astryx</a></h2><img src="https://tracker.example.net/pixel"><script>window.injected=true</script></article><article class="Box-row"><h2><a href="javascript:alert(1)">bad</a></h2></article>`;

async function openTrends(page: Page) {
  await page.getByRole("button", { name: "ことばの辞書を開く" }).click();
  await page.getByText("話題の言葉を探す", { exact: true }).click();
  return page.locator(".rss-trend-sources");
}

test("Googleの同じリンクを持つ別キーワードも残し、取得時刻と地域を示して辞書へ渡す", async ({
  page,
}, info) => {
  const trackers: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("tracker.example.net"))
      trackers.push(request.url());
  });
  await page.route("**/api/feeds/fetch", (route) => {
    const { url } = route.request().postDataJSON();
    return route.fulfill({
      json:
        url === githubURL
          ? { url, html: github }
          : url === hnURL
            ? { url, xml: hackernews }
            : { url: googleURL, xml: google },
    });
  });
  await page.goto("/?view=feeds");
  const trends = await openTrends(page);
  await expect(trends.getByRole("status")).toContainText("保存しました");
  await expect(trends.locator("li")).toHaveCount(2);
  await expect(trends).toContainText("日本の検索キーワード");
  await expect(trends).toContainText("集計期間はRSSに未記載");
  await expect(trends).toContainText("取得日時");
  await trends
    .getByRole("button", { name: "辞書で調べる：非同期", exact: true })
    .click();
  await expect(page.getByLabel("調べたい言葉")).toHaveValue("非同期");
  await expect(page.locator(".rss-definition")).toContainText("完了を待つ間");
  await trends.getByLabel("話題の情報源").selectOption("github");
  await expect(trends.getByRole("status")).toContainText("保存しました");
  await expect(trends.locator("li")).toHaveCount(1);
  await expect(
    trends.getByRole("link", { name: "meta/astryx", exact: true }),
  ).toHaveAttribute("href", "https://github.com/meta/astryx");
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  expect(trackers).toEqual([]);
  await trends.getByLabel("話題の情報源").selectOption("hackernews");
  await expect(
    trends.getByRole("button", { name: "辞書で調べる：SQLite", exact: true }),
  ).toBeVisible();
  await expect(trends).toContainText("RedditはRSS提供を終了しているため未接続");
  await page.setViewportSize({ width: 320, height: 740 });
  await trends.locator("select").scrollIntoViewIfNeeded();
  const control = await trends.locator("select").boundingBox();
  const header = await page
    .locator(".rss-dictionary .rss-settings-header")
    .boundingBox();
  expect(control!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("trends-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: /すべての記事 · 0/ }),
  ).toBeVisible();
});

test("保存済みの観測を再読込後も再利用し、更新失敗でも前回の話題を残す", async ({
  page,
}) => {
  let requests = 0;
  let fail = false;
  await page.route("**/api/feeds/fetch", (route) => {
    requests++;
    return route.fulfill(
      fail
        ? { status: 502, json: {} }
        : { json: { url: googleURL, xml: google } },
    );
  });
  await page.goto("/?view=feeds");
  let trends = await openTrends(page);
  await expect(trends.getByRole("status")).toContainText("保存しました");
  expect(requests).toBe(1);
  await page.reload();
  trends = await openTrends(page);
  await expect(trends.getByRole("status")).toContainText(
    "保存済みの話題を表示",
  );
  expect(requests).toBe(1);
  fail = true;
  await trends.getByRole("button", { name: "話題を更新" }).click();
  await expect(trends.getByRole("status")).toContainText("前回の取得分");
  await expect(
    trends.getByRole("button", { name: "辞書で調べる：非同期", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(2);
});

test("更新中もキーボードのフォーカスを保持し、連打で重複取得しない", async ({
  page,
}) => {
  let requests = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    requests++;
    if (requests === 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ json: { url: googleURL, xml: google } });
  });
  await page.goto("/?view=feeds");
  const trends = await openTrends(page);
  await expect(trends.getByRole("status")).toContainText("保存しました");
  const refresh = trends.getByRole("button", { name: "話題を更新" });
  await refresh.focus();
  await refresh.press("Enter");
  await expect.poll(() => requests).toBe(2);
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveAttribute("aria-disabled", "true");
  await refresh.press("Enter");
  await refresh.press("Space");
  expect(requests).toBe(2);
  release!();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(refresh).toBeFocused();
  await expect(trends.getByRole("status")).toContainText("保存しました");
  expect(requests).toBe(2);
});

test("情報源の切替後に古い取得が終わっても新しい話題へ上書きしない", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    const { url } = route.request().postDataJSON();
    if (url === googleURL) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route
        .fulfill({ json: { url, xml: google } })
        .catch(() => undefined);
    } else await route.fulfill({ json: { url, html: github } });
  });
  await page.goto("/?view=feeds");
  const trends = await openTrends(page);
  await expect.poll(() => !!release).toBe(true);
  await trends.getByLabel("話題の情報源").selectOption("github");
  await expect(
    trends.getByRole("link", { name: "meta/astryx", exact: true }),
  ).toBeVisible();
  release!();
  await expect(trends.locator("li")).toHaveCount(1);
  await expect(trends.getByLabel("話題の情報源")).toHaveValue("github");
});

test("空・壊れた応答や情報源のすり替えを成功と表示せず、保存した観測を破壊しない", async ({
  page,
}) => {
  let response: unknown = { url: googleURL, xml: google };
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: response }),
  );
  await page.goto("/?view=feeds");
  const trends = await openTrends(page);
  await expect(trends.getByRole("status")).toContainText("保存しました");
  for (const invalid of [
    null,
    { url: "not-an-url", xml: google },
    { url: hnURL, xml: google },
    { url: googleURL, xml: "<rss><channel></channel></rss>" },
    {
      url: googleURL,
      xml: '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel>&secret;</channel></rss>',
    },
  ]) {
    response = invalid;
    await trends.getByRole("button", { name: "話題を更新" }).click();
    await expect(trends.getByRole("status")).toContainText(
      "形式を確認できません",
    );
    await expect(trends.locator("li")).toHaveCount(2);
  }
  await page.reload();
  const reopened = await openTrends(page);
  await expect(reopened.getByRole("status")).toContainText(
    "保存済みの話題を表示",
  );
  await expect(reopened.locator("li")).toHaveCount(2);
});

test("遅れて保存する古い観測は新しい観測を上書きせず、破損記録も黙って置き換えない", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  const result = await page.evaluate(async () => {
    const path = "/src/trend-store.ts";
    const { saveTrendSnapshot, readTrendSnapshot, trendDatabase } =
      await import(path);
    const base = {
      version: 1,
      source: "google",
      fetchedAt: "2026-11-18T00:00:00Z",
      items: [
        {
          title: "新しい観測",
          url: "https://trends.google.com/",
          published: null,
          terms: ["新しい観測"],
        },
      ],
    };
    await saveTrendSnapshot(base);
    await saveTrendSnapshot({
      ...base,
      fetchedAt: "2026-11-17T00:00:00Z",
      items: [{ ...base.items[0], title: "古い観測", terms: ["古い観測"] }],
    });
    const latest = await readTrendSnapshot("google");
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(trendDatabase);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("sources", "readwrite");
        transaction
          .objectStore("sources")
          .put({ version: 999, keep: "future" }, "google");
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    let rejected = false;
    try {
      await saveTrendSnapshot(base);
    } catch {
      rejected = true;
    }
    const preserved = await new Promise<unknown>((resolve) => {
      const request = indexedDB.open(trendDatabase);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("sources");
        const record = transaction.objectStore("sources").get("google");
        transaction.oncomplete = () => {
          db.close();
          resolve(record.result);
        };
      };
    });
    return { title: latest.items[0].title, rejected, preserved };
  });
  expect(result).toEqual({
    title: "新しい観測",
    rejected: true,
    preserved: { version: 999, keep: "future" },
  });
});

test("辞書を閉じて戻ったときも期限切れの観測を再確認し、メモリ内の古い表示を最新扱いにしない", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/feeds/fetch", (route) => {
    requests++;
    return route.fulfill({ json: { url: googleURL, xml: google } });
  });
  await page.goto("/?view=feeds");
  let trends = await openTrends(page);
  await expect(trends.getByRole("status")).toContainText("保存しました");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const name = "/src/trend-store.ts";
    const { trendDatabase } = await import(name);
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(trendDatabase);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("sources", "readwrite");
        const store = transaction.objectStore("sources");
        const record = store.get("google");
        record.onsuccess = () =>
          store.put(
            {
              ...record.result,
              fetchedAt: new Date(Date.now() - 3600000).toISOString(),
            },
            "google",
          );
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  trends = await openTrends(page);
  await expect.poll(() => requests).toBe(2);
  await expect(trends.getByRole("status")).toContainText("保存しました");
  expect(requests).toBe(2);
});
