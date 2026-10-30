import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { authWorkerFixture } from "../fixtures/auth-worker.mjs";

const articleURL = "https://publisher.example.org/article";
const feedURL = "https://publisher.example.org/feed.xml";
const policyId = "77777777-7777-4777-8777-777777777777";
const xml = `<rss version="2.0"><channel><title>Runtime news</title><item><guid>one</guid><title>Runtime article</title><link>${articleURL}</link><description>Summary from the runtime feed.</description></item></channel></rss>`;
// The OS selects an unused loopback port. A race is a setup failure, never permission to reuse another server.
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function assets() {
  const root = resolve("dist"),
    files = new Map();
  for (const file of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (file.isFile()) {
      const path = resolve(file.parentPath, file.name);
      files.set(
        "/" + path.slice(root.length + 1).replaceAll("\\", "/"),
        await readFile(path),
      );
    }
  }
  if (!files.has("/index.html"))
    throw Error("Build the browser app before running the runtime suite.");
  return (request) => {
    const path = new URL(request.url).pathname,
      key = path === "/" ? "/index.html" : path;
    if (!["GET", "HEAD"].includes(request.method) || !files.has(key))
      return new Response("", { status: 404 });
    return new Response(request.method === "HEAD" ? null : files.get(key), {
      headers: {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(key)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}
async function settings(page, mode) {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("新しく取り込む本文の取得先").selectOption(mode);
  await expect(page.getByRole("dialog")).toContainText("取得先を保存しました");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
}
async function subscribe(page, address = feedURL) {
  await page.getByLabel("サイト・RSSのURL").fill(address);
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Runtime article", exact: true }),
  ).toBeVisible();
}
async function storedArticles(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = globalThis.indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("articles"),
          r = tx.objectStore("articles").getAll();
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

for (const aliasMode of [false, true])
  test(`real browser login and ${aliasMode ? "approved alias" : "exact source"} RSS preserve shared originals and private reading state`, async ({
    browser,
  }, info) => {
    await runReaderScenario(browser, info, aliasMode);
  });
async function runReaderScenario(browser, info, aliasMode) {
  const aliasURL = articleURL + "?utm_source=approved",
    aliasFeed = feedURL + "?reader=b";
  const cleanup = [],
    cleanupErrors = [],
    contexts = [],
    unexpected = [],
    browserErrors = [];
  const port = await freePort(),
    origin = `https://127.0.0.1:${port}`;
  let articleFetches = 0,
    version = 1,
    fail = false;
  try {
    const f = await authWorkerFixture(
      { after: (fn) => cleanup.push(fn) },
      {
        entry: "tests/runtime/reader-entry.mjs",
        documents: true,
        missing: { RSS_COLLECTION_ENABLED: "true" },
        origin,
        server: { host: "127.0.0.1", port, https: true, logRequests: false },
        assets: await assets(),
        sourceResponses: {
          [aliasFeed]: () =>
            new Response(
              xml
                .replace(articleURL, aliasURL)
                .replace(
                  "<guid>one</guid>",
                  "<guid>other-publisher-guid</guid>",
                ),
              { headers: { "Content-Type": "application/rss+xml" } },
            ),
          [feedURL]: () =>
            new Response(xml, {
              headers: { "Content-Type": "application/rss+xml" },
            }),
        },
        articleResponse: (request) => {
          articleFetches++;
          expect(request.headers.get("Cookie")).toBeNull();
          expect(request.headers.get("Authorization")).toBeNull();
          if (fail) return new Response("unavailable", { status: 503 });
          return new Response(
            `<html lang="en"><title>Runtime original ${version}</title><article><p>${`Runtime version ${version} explains how information connects through carefully retained source evidence. `.repeat(12)}</p><pre><code>const value = ${version};\n  console.log(value);\n</code></pre></article></html>`,
            {
              headers: { "Content-Type": "text/html", ETag: `"v${version}"` },
            },
          );
        },
      },
    );
    expect((await f.ready()).origin).toBe(origin);
    async function login(owner) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
        viewport: info.project.use.viewport,
        isMobile: info.project.use.isMobile,
        locale: "ja-JP",
      });
      contexts.push(context);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (
          url.origin === "https://accounts.google.com" &&
          url.pathname === "/o/oauth2/v2/auth"
        ) {
          const auth = f.rememberAuthorization(url.href);
          return route.fulfill({
            status: 302,
            headers: { Location: origin + f.callback(auth, owner) },
            body: "",
          });
        }
        unexpected.push(url.origin + url.pathname);
        return route.abort();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.goto(origin);
      await expect(
        page.getByRole("button", { name: "Googleでログイン", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Googleでログイン", exact: true })
        .click();
      await page.waitForURL(origin + "/?auth=success");
      await page.goto(origin + "/?view=feeds");
      await expect(
        page.getByRole("button", { name: "設定", exact: true }),
      ).toBeVisible();
      const status = await page.request.get(origin + "/api/documents/status", {
        headers: { Origin: origin },
      });
      expect(status.status()).toBe(200);
      return { page, context, account: (await status.json()).account };
    }
    const a = await login("a"),
      b = await login("b");
    expect(a.account).not.toBe(b.account);
    const db = await f.documentDB();
    await db
      .prepare(
        "INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
      )
      .bind(
        policyId,
        articleURL,
        Date.now() + 3600000,
        "Synthetic fixture publisher permits offline test reuse",
      )
      .run();
    if (aliasMode)
      await db
        .prepare("INSERT INTO document_aliases VALUES(?,?,1,1,?,?)")
        .bind(
          aliasURL,
          policyId,
          Date.now() + 3600000,
          "Synthetic explicit same-source evidence",
        )
        .run();
    for (const account of [a.account, b.account])
      await db
        .prepare(
          "INSERT INTO document_members(policy_id,owner_hash) VALUES(?,?)",
        )
        .bind(policyId, account)
        .run();
    await settings(a.page, "shared");
    await settings(b.page, "shared");
    await subscribe(a.page, aliasMode ? aliasFeed : feedURL);
    await subscribe(b.page);
    const firstResponse = a.page.waitForResponse(
      (r) => r.url() === origin + "/api/documents/acquire",
    );
    await a.page
      .getByRole("button", { name: "Runtime article", exact: true })
      .click();
    const first = await (await firstResponse).json();
    await expect(a.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    await a.page
      .getByRole("button", { name: "この記事を保存", exact: true })
      .click();
    await expect(a.page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const bBefore = await storedArticles(b.page);
    expect(bBefore[0].read).toBe(false);
    expect(bBefore[0].saved).toBe(false);
    const secondResponse = b.page.waitForResponse(
      (r) => r.url() === origin + "/api/documents/acquire",
    );
    await b.page
      .getByRole("button", { name: "Runtime article", exact: true })
      .click();
    const second = await (await secondResponse).json();
    await expect(b.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    expect(second.reused).toBe(true);
    expect(second.version).toEqual(first.version);
    expect(articleFetches).toBe(1);
    const [aStored] = await storedArticles(a.page),
      [bStored] = await storedArticles(b.page);
    expect(aStored.content.document).toEqual(bStored.content.document);
    expect(aStored.url).toBe(aliasMode ? aliasURL : articleURL);
    expect(bStored.url).toBe(articleURL);
    if (aliasMode) {
      expect(aStored.id).not.toBe(bStored.id);
      expect(first.resolution).toEqual({
        requestedURL: aliasURL,
        sourceURL: articleURL,
        scope: first.document.scope,
      });
    }
    expect(aStored.saved).toBe(true);
    expect(bStored.saved).toBe(false);
    expect(bStored.content.fetchedAt).toBe(first.version.content.fetchedAt);
    await expect(b.page.locator(".rss-source-text pre code")).toHaveText(
      "const value = 1;\n  console.log(value);\n",
    );
    const history = a.page.locator(".rss-document-history");
    await history.locator("summary").click();
    if (aliasMode) {
      await expect(history).toContainText("許可済みの共通本文を表示しています");
      await expect(history).toContainText(aliasURL);
    }
    version = 2;
    await history.getByRole("button", { name: "元サイトの更新を確認" }).click();
    await expect(a.page.locator(".rss-source-text")).toContainText(
      "Runtime version 2",
    );
    await expect(history.locator(".rss-document-version")).toHaveCount(2);
    fail = true;
    await history.getByRole("button", { name: "元サイトの更新を確認" }).click();
    await expect(
      a.page.getByText(/クラウドで本文を取得できませんでした/).first(),
    ).toBeVisible();
    await expect(a.page.locator(".rss-source-text")).toContainText(
      "Runtime version 2",
    );
    expect(articleFetches).toBe(3);
    await db
      .prepare(
        "DELETE FROM document_members WHERE policy_id=? AND owner_hash=?",
      )
      .bind(policyId, b.account)
      .run();
    await b.page.locator(".rss-document-history summary").click();
    await b.page.getByRole("button", { name: "元サイトの更新を確認" }).click();
    await expect(
      b.page.getByText(/この本文はクラウドで利用できないか/).first(),
    ).toBeVisible();
    await expect(b.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    expect(articleFetches).toBe(3);
    await f.restart();
    fail = false;
    await a.page.reload();
    await a.page
      .getByRole("button", { name: "Runtime original 2", exact: true })
      .click();
    await expect(a.page.locator(".rss-source-text")).toContainText(
      "Runtime version 2",
    );
    expect(articleFetches).toBe(3);
    await a.context.setOffline(true);
    await a.page.locator(".rss-document-history summary").click();
    await a.page
      .locator(".rss-document-version")
      .filter({ hasText: "Runtime version 1" })
      .getByRole("button", { name: "この本文を表示" })
      .click();
    await expect(a.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    await expect(a.page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await a.page.locator(".rss-document-history").scrollIntoViewIfNeeded();
    await a.page.screenshot({ path: info.outputPath("reader-runtime.png") });
    expect(browserErrors).toEqual([]);
    expect(unexpected).toEqual([]);
  } finally {
    const closed = await Promise.allSettled(
      contexts.map((context) => context.close()),
    );
    const disposed = await Promise.allSettled(
      cleanup.reverse().map((close) => close()),
    );
    for (const result of [...closed, ...disposed])
      if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  expect(cleanupErrors).toEqual([]);
}
