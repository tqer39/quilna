import { test, expect } from "@playwright/test";
const feedUrl = "https://feeds.example.org/rss";
const rss = (body = "最初の本文です。", title = "保存して読み返す記事") =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>検証用フィード</title><item><guid>stable-1</guid><title>${title}</title><link>https://example.org/articles/1</link><pubDate>Fri, 23 Oct 2026 12:00:00 GMT</pubDate><content:encoded><![CDATA[<p>${body}</p><p>二つ目の段落です。</p>]]></content:encoded></item><item><guid>stable-2</guid><title>もう一つの記事</title><link>https://example.org/articles/2</link><description>次に読む記事です。</description></item></channel></rss>`;

test("a site or article URL discovers choices without embedding HTML; only the chosen feed is registered", async ({
  page,
}, info) => {
  const calls: { url: string; discover?: boolean }[] = [];
  const trackers: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("tracker.example.org"))
      trackers.push(request.url());
  });
  const chosen = "https://publisher.example.org/feeds/main.xml?lang=ja&full=1";
  await page.route("**/api/feeds/fetch", (route) => {
    if (route.request().postDataJSON().icon === true)
      return route.fulfill({ status: 404, json: {} });
    const body = route.request().postDataJSON();
    calls.push(body);
    return route.fulfill({
      json: body.discover
        ? {
            url: "https://publisher.example.org/blog/",
            html: `<!doctype html><html><head><title>読んでいるブログ</title><base href="../feeds/">
        <link REL="ALTERNATE" TYPE="application/rss+xml; charset=utf-8" title="記事の配信" href="main.xml?lang=ja&amp;full=1">
        <link rel="alternate" type="application/atom+xml" title="コメント" href="//publisher.example.org/comments.atom">
        <link rel="alternate" type="application/rss+xml" href="main.xml?lang=ja&amp;full=1#duplicate">
        <link rel="alternate" type="application/rss+xml" href="http://unsafe.example.org/rss">
        <link rel="alternate" type="application/rss+xml" href="https://127.0.0.1/private">
        <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
        <link rel="stylesheet" type="application/rss+xml" href="/not-a-feed">
        <script>window.discoveryExecuted = true</script></head><body>
        <img src="https://tracker.example.org/pixel"><iframe src="https://tracker.example.org/frame"></iframe></body></html>`,
          }
        : { url: chosen, xml: rss() },
    });
  });
  await page.goto("/");
  await page
    .getByLabel("サイト・RSSのURL")
    .fill("publisher.example.org/story#section");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-candidates li")).toHaveCount(2);
  await expect(page.locator(".rss-candidates")).toContainText(chosen);
  expect(calls).toEqual([
    { url: "https://publisher.example.org/story", discover: true },
  ]);
  await expect(
    page.getByLabel("配信元", { exact: true }).getByRole("option"),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { discoveryExecuted?: boolean })
          .discoveryExecuted,
    ),
  ).toBeUndefined();
  expect(trackers).toEqual([]);
  await page.screenshot({
    path: info.outputPath("discovery-choices.png"),
    fullPage: true,
  });
  await page
    .locator(".rss-candidates li")
    .filter({ hasText: "記事の配信" })
    .getByRole("button", { name: "登録して読む", exact: true })
    .click();
  await expect
    .poll(() => calls)
    .toEqual([
      { url: "https://publisher.example.org/story", discover: true },
      { url: chosen },
    ]);
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await page
    .getByRole("button", { name: "この記事を保存", exact: true })
    .click();
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await page.getByRole("button", { name: /保存した記事 · 1/ }).click();
  await expect(
    page.getByRole("button", { name: "保存して読み返す記事", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("article pages without feed links fall back to their final site's home page", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route("**/api/feeds/fetch", (route) => {
    if (route.request().postDataJSON().icon === true)
      return route.fulfill({ status: 404, json: {} });
    const { url, discover } = route.request().postDataJSON();
    calls.push(url);
    return route.fulfill({
      json: !discover
        ? { url, xml: rss() }
        : {
            url: url.endsWith("/story")
              ? "https://publisher.example.org/story"
              : url,
            html: url.endsWith("/story")
              ? "<!doctype html><p>Article</p>"
              : '<link rel="alternate" type="application/rss+xml" href="/feed/" title="サイトの更新">',
          },
    });
  });
  await page.goto("/");
  await page
    .getByLabel("サイト・RSSのURL")
    .fill("https://publisher.example.org/story");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-candidates")).toContainText("サイトの更新");
  expect(calls).toEqual([
    "https://publisher.example.org/story",
    "https://publisher.example.org/",
  ]);
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "検証用フィード", exact: true }),
  ).toHaveCount(1);
});

test("no feed and failed discovery leave cached articles readable and let a new search recover", async ({
  page,
}) => {
  let mode = "feed";
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill(
      mode === "failed"
        ? { status: 502, json: { error: "fetch" } }
        : {
            json:
              mode === "empty"
                ? {
                    url: "https://no-feed.example.org/",
                    html: "<!doctype html><title>No feed</title>",
                  }
                : { url: feedUrl, xml: rss() },
          },
    ),
  );
  await page.goto("/");
  await register(page);
  mode = "empty";
  await page
    .getByLabel("サイト・RSSのURL")
    .fill("https://no-feed.example.org/");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-discovery")).toContainText(
    "配信元が見つかりませんでした",
  );
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await page
    .getByRole("button", { name: "この記事を保存", exact: true })
    .click();
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  mode = "failed";
  await page
    .getByRole("button", { name: "収集メニューを表示", exact: true })
    .click();
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-discovery")).toContainText(
    "取得できませんでした",
  );
  await expect(page.locator(".rss-article-body")).toContainText("最初の本文");
  mode = "feed";
  await page.getByLabel("サイト・RSSのURL").fill(feedUrl);
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "登録済みの配信元を読む", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "登録済みの配信元を読む", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "検証用フィード", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /保存した記事 · 1/ }),
  ).toBeVisible();
});

test("editing the URL cancels pending discovery and stale results cannot replace a newer search", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  let finishedOld = false;
  await page.route("**/api/feeds/fetch", async (route) => {
    if (route.request().postDataJSON().icon === true)
      return route.fulfill({ status: 404, json: {} });
    const { url } = route.request().postDataJSON();
    if (url.includes("slow"))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route
      .fulfill({
        json: {
          url,
          html: `<link rel="alternate" type="application/rss+xml" title="${url.includes("slow") ? "古い候補" : "新しい候補"}" href="/feed/">`,
        },
      })
      .catch(() => {
        /* An edited query aborts the older request. */
      });
    if (url.includes("slow")) finishedOld = true;
  });
  await page.goto("/");
  await page.getByLabel("サイト・RSSのURL").fill("https://slow.example.org/");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect.poll(() => !!release).toBe(true);
  await expect(page.locator(".rss-discovery")).toContainText(
    "配信元を探しています",
  );
  await page.getByLabel("サイト・RSSのURL").fill("https://new.example.org/");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-candidates")).toContainText("新しい候補");
  release!();
  await expect.poll(() => finishedOld).toBe(true);
  await expect(page.locator(".rss-candidates")).not.toContainText("古い候補");
  await expect(page.getByLabel("サイト・RSSのURL")).toHaveValue(
    "https://new.example.org/",
  );
});

test("unsafe input never reaches discovery and unadvertised or nested template links are not guessed", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/feeds/fetch", (route) => {
    if (route.request().postDataJSON().icon === true)
      return route.fulfill({ status: 404, json: {} });
    calls++;
    return route.fulfill({
      json: {
        url: "https://publisher.example.org/",
        html: `<base href="http://unsafe.example.org/"><a href="/feed/">RSS</a><template><link rel="alternate" type="application/rss+xml" href="/hidden.xml"></template>`,
      },
    });
  });
  await page.goto("/");
  for (const value of [
    "http://publisher.example.org/",
    "https://127.0.0.1/private",
    "javascript:alert(1)",
    "https://user:pass@publisher.example.org/",
    "https://publisher.example.org:8443/",
  ]) {
    await page.getByLabel("サイト・RSSのURL").fill(value);
    await page
      .getByRole("button", { name: "フィードを探す", exact: true })
      .click();
    await expect(page.locator(".rss-discovery")).toContainText("公開HTTPS");
  }
  expect(calls).toBe(0);
  await page
    .getByLabel("サイト・RSSのURL")
    .fill("https://publisher.example.org/");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-discovery")).toContainText(
    "配信元が見つかりませんでした",
  );
  expect(calls).toBe(1);
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url: "https://publisher.example.org/",
        html: Array.from(
          { length: 30 },
          (_, index) =>
            `<link rel="alternate" type="application/rss+xml" href="/feeds/${index}">`,
        ).join(""),
      },
    }),
  );
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await expect(page.locator(".rss-candidates li")).toHaveCount(20);
  await expect(
    page.getByLabel("配信元", { exact: true }).getByRole("option"),
  ).toHaveCount(1);
});
async function register(page: import("@playwright/test").Page) {
  await page.getByLabel("サイト・RSSのURL").fill(feedUrl);
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存して読み返す記事", exact: true }),
  ).toBeVisible();
}

test("RSS collection, reading, saved snapshot, refresh deduplication and reopen preserve learning history", async ({
  page,
}, info) => {
  let xml = rss();
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url: feedUrl, xml } }),
  );
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("owner-learning-history-sentinel", "keep"),
  );
  await expect(
    page.getByRole("heading", { name: "情報収集", exact: true }),
  ).toBeVisible();
  await register(page);
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "最初の本文です。",
  );
  await expect(
    page.getByRole("link", { name: "元の記事を開く" }),
  ).toHaveAttribute("href", "https://example.org/articles/1");
  await page
    .getByRole("button", { name: "この記事を保存", exact: true })
    .click();
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#rss-save-article")).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("rss-reading-saved.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: /保存した記事 · 1/ }).click();
  await expect(
    page.getByRole("button", { name: "保存して読み返す記事", exact: true }),
  ).toBeVisible();
  xml = rss("後から変わった本文です。", "更新されたタイトル");
  await page.getByRole("button", { name: "すべて更新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "すべて更新", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "最初の本文です。",
  );
  await expect(page.locator(".rss-article-body")).not.toContainText(
    "後から変わった",
  );
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page.getByRole("button", { name: /すべての記事 · 2/ }).click();
  await expect(
    page.getByRole("list", { name: "記事一覧" }).locator("li"),
  ).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("owner-learning-history-sentinel"),
    ),
  ).toBe("keep");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("rss-list.png"),
    fullPage: true,
  });
});

test("failed and pending feed refresh keep cached articles readable and retryable", async ({
  page,
}) => {
  let fail = false;
  let release: (() => void) | undefined;
  let hold = false;
  await page.route("**/api/feeds/fetch", async (route) => {
    if (route.request().postDataJSON().icon === true)
      return route.fulfill({ status: 404, json: {} });
    if (route.request().postDataJSON().url !== feedUrl)
      return route.fulfill({
        status: 502,
        json: { error: "article-unavailable" },
      });
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return fail
      ? route.fulfill({ status: 502, json: { error: "fetch" } })
      : route.fulfill({ json: { xml: rss(), url: feedUrl } });
  });
  await page.goto("/");
  await register(page);
  hold = true;
  await page.getByRole("button", { name: "すべて更新", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText("最初の本文");
  fail = true;
  hold = false;
  release!();
  await page
    .getByRole("button", { name: "収集メニューを表示", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "検証用フィードを再試行", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rss-article-body")).toContainText("最初の本文");
  fail = false;
  await page
    .getByRole("button", { name: "検証用フィードを再試行", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "検証用フィードを更新", exact: true }),
  ).toBeEnabled();
});

test("Atom, malformed XML and malicious feed markup are handled without executing or embedding content", async ({
  page,
}) => {
  let xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>one</id><title>Atomの記事</title><link href="javascript:alert(1)"/><content type="html">&lt;p&gt;本文&lt;/p&gt;&lt;img src="https://tracker.example.org/pixel" onerror="alert(1)"/&gt;&lt;script&gt;alert(2)&lt;/script&gt;</content></entry></feed>`;
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("tracker.example.org"))
      requests.push(request.url());
  });
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { xml, url: feedUrl } }),
  );
  await page.goto("/");
  await page.getByLabel("サイト・RSSのURL").fill(feedUrl);
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await page.getByRole("button", { name: "Atomの記事", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText("本文");
  await expect(
    page.locator(".rss-article img, .rss-article script, .rss-article iframe"),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "元の記事を開く" })).toHaveCount(
    0,
  );
  expect(requests).toEqual([]);
  await page
    .getByRole("button", { name: "収集メニューを表示", exact: true })
    .click();
  xml = "<rss><broken>";
  await page.getByRole("button", { name: "すべて更新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Atomを再試行", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rss-article-body")).toContainText("本文");
});

test("a failed article save stays unsaved until explicit retry commits it", async ({
  page,
}) => {
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { xml: rss(), url: feedUrl } }),
  );
  await page.goto("/");
  await register(page);
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await expect(page.locator("#rss-save-article")).toBeEnabled();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<typeof original>
    ) {
      if (this.name === "articles")
        throw new DOMException("test quota", "QuotaExceededError");
      return original.apply(this, args);
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = original;
    };
  });
  await page
    .getByRole("button", { name: "この記事を保存", exact: true })
    .click();
  await expect(page.locator(".rss-error")).toContainText(
    "変更を保存できませんでした",
  );
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.evaluate(() =>
    (window as unknown as { restorePut: () => void }).restorePut(),
  );
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#rss-save-article")).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /保存した記事 · 1/ }),
  ).toBeVisible();
});

test("two tabs merge saved flags during refresh and an empty valid feed is not an error", async ({
  page,
  context,
}) => {
  await context.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { xml: rss(), url: feedUrl } }),
  );
  await page.goto("/");
  await register(page);
  const other = await context.newPage();
  await other.goto("/");
  await other
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await other
    .getByRole("button", { name: "この記事を保存", exact: true })
    .click();
  await expect(other.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "すべて更新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "すべて更新", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: /保存した記事 · 1/ }),
  ).toBeVisible();
  await other.close();
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        xml: "<rss version='2.0'><channel><title>空の配信元</title></channel></rss>",
        url: "https://empty.example.org/rss",
      },
    }),
  );
  await page
    .getByLabel("サイト・RSSのURL")
    .fill("https://empty.example.org/rss");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "空の配信元", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator(".rss-empty")).toContainText(
    "まだ記事がありません",
  );
  await expect(page.locator(".rss-error")).toBeHidden();
});

test("future database versions are held without deleting subscriptions or lesson history", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "フィードを探す", exact: true }),
  ).toBeEnabled();
  // Upgrade from a different connection; the app closes its old connection on versionchange.
  await page.evaluate(async () => {
    localStorage.setItem("owner-lesson-history", "preserve");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("tsumiki.rss.v1", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("feeds", "readwrite");
        tx.objectStore("feeds").put({
          url: "https://future.example.org/rss",
          title: "将来形式の購読",
          fetchedAt: "2026-10-24T00:00:00Z",
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(Error("fixture failed"));
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.reload();
  await expect(page.locator(".rss-error")).toContainText(
    "既存データは削除していません",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("owner-lesson-history")),
  ).toBe("preserve");
  const count = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("tsumiki.rss.v1");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("feeds");
          const count = tx.objectStore("feeds").count();
          tx.oncomplete = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
  expect(count).toBe(1);
});

test("long unmatched markup does not block reading or saving", async ({
  page,
}) => {
  const xml = rss("<".repeat(300000));
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { xml, url: feedUrl } }),
  );
  await page.goto("/");
  await register(page);
  await page
    .getByRole("button", { name: "保存して読み返す記事", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "<".repeat(100),
  );
  await page
    .getByRole("button", { name: "この記事を保存", exact: true })
    .click();
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
