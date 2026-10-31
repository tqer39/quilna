import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { authWorkerFixture } from "../fixtures/auth-worker.mjs";

const articleURL = "https://publisher.example.org/article";
const feedURL = "https://publisher.example.org/feed.xml";
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

// Compare the app's committed copy with an authenticated read of the exact
// server version. Chromium's tracing protocol can lose a fetch response body
// even after the app has consumed and retained it; do not make that observer
// the source of truth for browser-to-server persistence.
async function retainedServerVersion(reader, origin, requestedURL) {
  const [article] = await storedArticles(reader.page),
    ref = article.content.document;
  const retained = await reader.page.evaluate(async (versionId) => {
    const db = await new Promise((resolve, reject) => {
      const r = globalThis.indexedDB.open("quilna.documents.v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("versions"),
          r = tx.objectStore("versions").get(versionId);
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, ref.versionId);
  const status = await reader.page.request.get(origin + "/api/session", {
    headers: { Origin: origin },
  });
  expect(status.status()).toBe(200);
  const session = await status.json();
  const response = await reader.page.request.post(
    origin + "/api/documents/read",
    {
      headers: {
        Origin: origin,
        "X-CSRF-Token": session.csrfToken,
        "X-Document-Account": reader.account,
      },
      data: { url: requestedURL, audience: "shared", versionId: ref.versionId },
    },
  );
  expect(response.status()).toBe(200);
  const value = await response.json(),
    version = { ...value };
  expect(value.account).toBe(reader.account);
  delete version.account;
  delete version.resolution;
  expect(retained).toEqual(version);
  expect(article.content).toEqual({
    ...version.content,
    document: {
      documentId: version.documentId,
      versionId: version.id,
      scope: version.scope,
      sourceURL: version.sourceURL,
    },
  });
  return { version, resolution: value.resolution };
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
        documentManagement: true,
        missing: { RSS_COLLECTION_ENABLED: "true" },
        origin,
        server: { host: "127.0.0.1", port, https: true, logRequests: false },
        assets: await assets(),
        sourceResponses: {
          ["https://publisher.example.org/favicon.ico"]: () =>
            new Response(
              Uint8Array.from(
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6GtIAAAAASUVORK5CYII=",
                  "base64",
                ),
              ),
              { headers: { "Content-Type": "image/png" } },
            ),
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
    await f.restart(a.account);
    const admin = a.page.locator(".rss-policy-settings");
    async function openAdmin() {
      await a.page.getByRole("button", { name: "設定", exact: true }).click();
      if (!(await admin.evaluate((n) => n.open)))
        await admin.locator("summary").click();
    }
    async function saveAdmin() {
      await admin
        .getByRole("button", { name: "変更内容を確認", exact: true })
        .click();
      await admin
        .getByRole("button", { name: "この内容を保存", exact: true })
        .click();
      await expect(admin.getByRole("status")).toContainText(
        "共有設定を保存しました",
      );
      await a.page.getByRole("button", { name: "閉じる", exact: true }).click();
    }
    await openAdmin();
    await admin
      .getByRole("button", { name: "管理者として接続を確認", exact: true })
      .click();
    await expect(admin.getByRole("status")).toContainText(
      "管理者の接続を確認しました",
    );
    await admin
      .getByRole("button", { name: "共有する出典を登録", exact: true })
      .click();
    await admin.getByLabel("出典の記事URL", { exact: true }).fill(articleURL);
    await admin
      .getByLabel("本文を共有できる根拠", { exact: true })
      .fill("Synthetic fixture publisher permits offline test reuse");
    await admin
      .getByLabel("指定した利用者への本文共有を有効にする", { exact: true })
      .check();
    if (aliasMode) {
      await admin
        .getByRole("button", { name: "別名URLを追加", exact: true })
        .click();
      await admin.getByLabel("別名URL", { exact: true }).fill(aliasURL);
      await admin
        .getByLabel("同じ記事と判断した根拠", { exact: true })
        .fill("Synthetic explicit same-source evidence");
      await admin.getByLabel("この別名を有効にする", { exact: true }).check();
      await admin
        .getByLabel("現在の共有条件で、同じ記事を指すことを確認しました", {
          exact: true,
        })
        .check();
    }
    await saveAdmin();
    const db = await f.documentDB();
    const initialPolicy = await db
      .prepare(
        "SELECT id, revision, management_revision FROM document_policies WHERE source_url=?",
      )
      .bind(articleURL)
      .first();
    expect(initialPolicy.revision).toBe(1);
    expect(initialPolicy.management_revision).toBe(1);
    await b.page.getByRole("button", { name: "設定", exact: true }).click();
    const nonadmin = b.page.locator(".rss-policy-settings");
    await nonadmin.locator("summary").click();
    await nonadmin
      .getByRole("button", { name: "管理者として接続を確認", exact: true })
      .click();
    await expect(nonadmin.getByRole("status")).toContainText(
      "管理を利用できません",
    );
    await b.page.getByRole("button", { name: "閉じる", exact: true }).click();
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
    expect((await firstResponse).status()).toBe(200);
    await expect(a.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    await expect
      .poll(() =>
        a.page
          .locator(".rss-site-icon img")
          .first()
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    const first = await retainedServerVersion(
      a,
      origin,
      aliasMode ? aliasURL : articleURL,
    );
    await a.page
      .getByRole("button", { name: "この記事を保存", exact: true })
      .click();
    await expect(a.page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await openAdmin();
    await admin
      .getByLabel("共有する利用者ID（1行に1人）", { exact: true })
      .fill(a.account + "\n" + b.account);
    await saveAdmin();
    const addedPolicy = await db
      .prepare(
        "SELECT revision, management_revision FROM document_policies WHERE id=?",
      )
      .bind(initialPolicy.id)
      .first();
    expect(addedPolicy.revision).toBe(1);
    expect(addedPolicy.management_revision).toBe(2);
    await openAdmin();
    await admin
      .getByRole("button", { name: "変更履歴を確認", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "変更 #1 を読む", exact: true })
      .click();
    const policyHistory = admin.getByRole("region", {
      name: "共有設定の変更履歴",
    });
    await expect(policyHistory).toContainText("共有する利用者（1人）");
    await expect(policyHistory).toContainText(a.account);
    await expect(policyHistory).not.toContainText(b.account);
    await expect(
      admin.getByLabel("共有する利用者ID（1行に1人）", { exact: true }),
    ).toHaveValue([a.account, b.account].sort().join("\n"));
    await a.page.getByRole("button", { name: "閉じる", exact: true }).click();
    const bBefore = await storedArticles(b.page);
    expect(bBefore[0].read).toBe(false);
    expect(bBefore[0].saved).toBe(false);
    const secondResponse = b.page.waitForResponse(
      (r) => r.url() === origin + "/api/documents/acquire",
    );
    await b.page
      .getByRole("button", { name: "Runtime article", exact: true })
      .click();
    expect((await secondResponse).status()).toBe(200);
    await expect(b.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    const second = await retainedServerVersion(b, origin, articleURL);
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
        scope: first.version.scope,
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
    await openAdmin();
    await admin
      .getByLabel("共有する利用者ID（1行に1人）", { exact: true })
      .fill(a.account);
    await saveAdmin();
    await b.page.locator(".rss-document-history summary").click();
    await b.page.getByRole("button", { name: "元サイトの更新を確認" }).click();
    await expect(
      b.page.getByText(/この本文はクラウドで利用できないか/).first(),
    ).toBeVisible();
    await expect(b.page.locator(".rss-source-text")).toContainText(
      "Runtime version 1",
    );
    expect(articleFetches).toBe(3);
    await openAdmin();
    await admin
      .getByRole("button", { name: "変更履歴を確認", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "変更 #2 を読む", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "この記録から下書きを作る", exact: true })
      .click();
    await expect(admin.getByRole("status")).toContainText(
      "履歴から下書きを作りました",
    );
    await expect(
      admin.getByLabel("指定した利用者への本文共有を有効にする", {
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(
      admin.getByLabel("共有する利用者ID（1行に1人）", { exact: true }),
    ).toHaveValue([a.account, b.account].sort().join("\n"));
    // Merely opening the recovery draft cannot reinstate the removed reader.
    const beforeRecovery = await db
      .prepare("SELECT management_revision FROM document_policies WHERE id=?")
      .bind(initialPolicy.id)
      .first();
    expect(beforeRecovery.management_revision).toBe(3);
    await admin
      .getByLabel("指定した利用者への本文共有を有効にする", { exact: true })
      .check();
    if (aliasMode) {
      await expect(
        admin.getByLabel("この別名を有効にする", { exact: true }),
      ).not.toBeChecked();
      await expect(
        admin.getByLabel("現在の共有条件で、同じ記事を指すことを確認しました", {
          exact: true,
        }),
      ).not.toBeChecked();
      await admin.getByLabel("この別名を有効にする", { exact: true }).check();
      await admin
        .getByLabel("現在の共有条件で、同じ記事を指すことを確認しました", {
          exact: true,
        })
        .check();
    }
    await saveAdmin();
    const recovered = await db
      .prepare("SELECT management_revision FROM document_policies WHERE id=?")
      .bind(initialPolicy.id)
      .first();
    expect(recovered.management_revision).toBe(4);
    const events = await db
      .prepare(
        "SELECT management_revision FROM document_policy_history WHERE policy_id=? ORDER BY management_revision",
      )
      .bind(initialPolicy.id)
      .all();
    expect(events.results.map((e) => e.management_revision)).toEqual([
      1, 2, 3, 4,
    ]);
    const restoredRead = await retainedServerVersion(b, origin, articleURL);
    expect(restoredRead.version).toEqual(first.version);
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

test("closed reader receives a durable RSS revision and retains the old body until explicit selection", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const cleanup = [],
    unexpected = [],
    browserErrors = [];
  const port = await freePort(),
    origin = `https://127.0.0.1:${port}`;
  let context,
    holdCollection = false,
    heldRequests = 0,
    articleFetches = 0,
    version = 1,
    release;
  const publisherGate = new Promise((resolve) => {
    release = resolve;
  });
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
          [feedURL]: async () => {
            if (holdCollection) {
              heldRequests++;
              await publisherGate;
            }
            return new Response(
              xml.replace(
                "Summary from the runtime feed.",
                `RSS revision ${version}.`,
              ),
              {
                headers: { "Content-Type": "application/rss+xml" },
              },
            );
          },
          ["https://publisher.example.org/favicon.ico"]: () =>
            new Response("", { status: 404 }),
        },
        articleResponse: (request) => {
          articleFetches++;
          expect(request.headers.get("Cookie")).toBeNull();
          expect(request.headers.get("Authorization")).toBeNull();
          return new Response(
            `<html lang="en"><title>Collected original ${version}</title><article><p>${`Collected version ${version} preserves original source evidence for later reading. `.repeat(15)}</p></article></html>`,
            { headers: { "Content-Type": "text/html", ETag: `"v${version}"` } },
          );
        },
      },
    );
    await f.ready();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
      viewport: info.project.use.viewport,
      isMobile: info.project.use.isMobile,
      locale: "ja-JP",
    });
    context.on("page", (page) =>
      page.on("pageerror", (error) => browserErrors.push(error.message)),
    );
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (
        url.origin === "https://accounts.google.com" &&
        url.pathname === "/o/oauth2/v2/auth"
      ) {
        return route.fulfill({
          status: 302,
          headers: {
            Location:
              origin + f.callback(f.rememberAuthorization(url.href), "a"),
          },
          body: "",
        });
      }
      unexpected.push(url.origin + url.pathname);
      return route.abort();
    });
    let page = await context.newPage();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Googleでログイン", exact: true })
      .click();
    await page.waitForURL(origin + "/?auth=success");
    await page.goto(origin + "/?view=feeds");
    await subscribe(page);
    await page
      .getByRole("button", { name: "Runtime article", exact: true })
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Collected version 1",
    );
    await page
      .getByRole("button", { name: "この記事を保存", exact: true })
      .click();
    await expect(page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const [before] = await storedArticles(page);
    expect(before.saved).toBe(true);
    expect(before.read).toBe(true);
    expect(articleFetches).toBe(1);

    // The real Durable Object alarm starts the request; the publisher completes
    // only after all app pages close. No browser timer or test alarm hook runs it.
    holdCollection = true;
    version = 2;
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByRole("button", {
        name: "クラウド収集を開始・設定を更新",
        exact: true,
      })
      .click();
    await expect(page.locator("#rss-cloud-status")).toContainText("15分ごと");
    await expect.poll(() => heldRequests).toBe(1);
    await page.close();
    expect(context.pages()).toHaveLength(0);
    const closedAt = Date.now();
    release();
    async function cloudState() {
      const response = await context.request.get(origin + "/api/collection", {
        headers: { Origin: origin },
      });
      expect(response.status()).toBe(200);
      return response.json();
    }
    await expect.poll(async () => (await cloudState()).pending.length).toBe(1);
    const queued = await cloudState();
    expect(queued.pending[0].fetchedAt).toBeGreaterThanOrEqual(closedAt);
    expect(queued.feeds[0].lastSuccess).toBeGreaterThan(
      Date.parse(before.content.fetchedAt),
    );
    expect(articleFetches).toBe(1); // No background original-body acquisition is claimed.
    await f.restart();
    expect((await cloudState()).pending).toEqual(queued.pending);

    page = await context.newPage();
    await page.goto(origin + "/?view=feeds");
    const item = page.getByRole("button", {
      name: "Collected original 1",
      exact: true,
    });
    await expect(item).toBeVisible();
    await expect.poll(async () => (await cloudState()).pending.length).toBe(0);
    await expect
      .poll(
        async () =>
          (await storedArticles(page))[0]?.bodyUpdate?.latest?.versionId,
        { timeout: 45_000 },
      )
      .toBeTruthy();
    const [updated] = await storedArticles(page);
    expect(updated.content).toEqual(before.content);
    expect(updated.body).toBe(before.body);
    expect(updated.saved).toBe(true);
    expect(updated.read).toBe(true);
    expect(updated.feedRevision.fingerprint).not.toBe(
      before.feedRevision.fingerprint,
    );
    expect(updated.bodyUpdate.latest.versionId).not.toBe(
      before.content.document.versionId,
    );
    expect(articleFetches).toBe(2);
    await item.click();
    await expect(
      page.getByRole("region", { name: "本文の更新", exact: true }),
    ).toContainText("本文の更新あり");
    await expect(page.locator(".rss-source-text")).toContainText(
      "Collected version 1",
    );
    await page.screenshot({
      path: info.outputPath("closed-reader-update.png"),
    });
    await page
      .getByRole("button", { name: "更新された本文を読む", exact: true })
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Collected version 2",
    );
    await expect(page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.locator(".rss-document-history summary").click();
    await expect(page.locator(".rss-document-version")).toHaveCount(2);
    await page.reload();
    await page
      .getByRole("button", { name: "Collected original 2", exact: true })
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Collected version 2",
    );
    expect((await storedArticles(page))[0].saved).toBe(true);
    await page.locator(".rss-document-history summary").click();
    await expect(page.locator(".rss-document-version")).toHaveCount(2);
    await page
      .locator(".rss-document-version")
      .filter({ hasText: "Collected version 1" })
      .getByRole("button", { name: "この本文を表示", exact: true })
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Collected version 1",
    );
    expect((await storedArticles(page))[0].content).toEqual(before.content);
    expect(articleFetches).toBe(2);
    expect((await cloudState()).pending).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    release();
    const closed = await Promise.allSettled([context?.close()]);
    const disposed = await Promise.allSettled(
      cleanup.reverse().map((dispose) => dispose()),
    );
    expect(
      [...closed, ...disposed].filter((result) => result.status === "rejected"),
    ).toEqual([]);
  }
});
