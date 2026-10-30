import { test, expect, type Page } from "@playwright/test";
import type { SourceDocument } from "../../src/source-document";
const url = "https://example.org/reusable",
  account = "a".repeat(64),
  other = "b".repeat(64);
const shared = "shared:11111111-1111-4111-8111-111111111111:1";
async function blank(page: Page) {
  await page.route("**/__document_client", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Document client fixture</title>",
    }),
  );
  await page.goto("/__document_client");
}
async function pair(page: Page, scope = shared, revision = 1) {
  return page.evaluate(
    async ({ url, scope, revision }) => {
      const path = "/src/source-document.ts",
        api = await import(path);
      const content = {
        text:
          `Cloud revision ${revision}. ` +
          "Source evidence stays available for reading and learning. ".repeat(
            12,
          ) +
          "\nconst value = 1;\n",
        title: `Cloud ${revision}`,
        url,
        language: "en",
        fetchedAt: "2026-10-01T00:00:00.000Z",
      };
      const id = await api.documentIdentity(scope, url),
        hash = await api.representationHash(content),
        versionId = await api.versionIdentity(id, hash);
      return {
        status: "ready",
        reused: true,
        account: "a".repeat(64),
        document: {
          id,
          scope,
          sourceURL: url,
          currentVersionId: versionId,
          checkedAt: "2026-10-02T00:00:00.000Z",
          revision,
        },
        version: {
          id: versionId,
          documentId: id,
          scope,
          sourceURL: url,
          representationHash: hash,
          formatVersion: 1,
          createdAt: "2026-10-01T01:00:00.000Z",
          content,
        },
      };
    },
    { url, scope, revision },
  );
}
async function connect(
  page: Page,
  value: Awaited<ReturnType<typeof pair>>,
  mode = "shared",
) {
  await page.route("**/api/documents/status", (r) =>
    r.fulfill({ json: { account, enabled: true } }),
  );
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { csrfToken: "synthetic-token-for-client-fixture" } }),
  );
  await page.route("**/api/documents/acquire", (r) =>
    r.fulfill({ json: value }),
  );
  await page.evaluate(
    ({ account, mode }) =>
      localStorage.setItem(
        "quilna.document-acquisition.v1",
        JSON.stringify({ mode, account }),
      ),
    { account, mode },
  );
}
async function acquire(page: Page, address = url) {
  return page.evaluate(async (url) => {
    const path = "/src/document-acquisition.ts",
      client = new (await import(path)).DocumentAcquisition();
    try {
      return { result: await client.acquire(url, true), error: "" };
    } catch (e) {
      return { result: null, error: (e as Error).message };
    }
  }, address);
}
async function current(page: Page, scope = shared) {
  return page.evaluate(
    async ({ url, scope }) => {
      const path = "/src/source-document-store.ts";
      return (await import(path)).currentDocument(url, scope);
    },
    { url, scope },
  );
}

test("two isolated browser profiles retain shared server identities and original timestamps", async ({
  page,
  browser,
}) => {
  await blank(page);
  const value = await pair(page);
  const secondContext = await browser.newContext(),
    second = await secondContext.newPage();
  try {
    await blank(second);
    await connect(page, value);
    await connect(second, { ...value, account: other });
    await second.route("**/api/documents/status", (r) =>
      r.fulfill({ json: { account: other, enabled: true } }),
    );
    await second.evaluate(
      (other) =>
        localStorage.setItem(
          "quilna.document-acquisition.v1",
          JSON.stringify({ mode: "shared", account: other }),
        ),
      other,
    );
    const [a, b] = await Promise.all([acquire(page), acquire(second)]);
    expect(a.error).toBe("");
    expect(b.error).toBe("");
    expect(a.result?.content.document).toEqual(b.result?.content.document);
    expect((await current(page))?.version).toEqual(value.version);
    expect((await current(second))?.version).toEqual(value.version);
    await page.reload();
    await current(page);
    await page.context().setOffline(true);
    expect((await current(page))?.version).toEqual(value.version);
    expect(a.result?.content.fetchedAt).toBe(value.version.content.fetchedAt);
  } finally {
    await secondContext.close();
  }
});

test("an alias requires an explicit response binding to the requested URL and retains one canonical version", async ({
  page,
  browser,
}) => {
  await blank(page);
  const value = await pair(page),
    alias = url + "?utm_source=approved";
  await connect(page, value);
  expect((await acquire(page, alias)).error).toContain("本文を確認できません");
  expect(await current(page)).toBeUndefined();
  const resolution = { requestedURL: alias, sourceURL: url, scope: shared };
  for (const invalid of [
    { ...resolution, requestedURL: url },
    { ...resolution, sourceURL: alias },
    { ...resolution, scope: "shared:wrong:1" },
  ]) {
    await page.route("**/api/documents/acquire", (r) =>
      r.fulfill({ json: { ...value, resolution: invalid } }),
    );
    expect((await acquire(page, alias)).error).toContain(
      "本文を確認できません",
    );
    expect(await current(page)).toBeUndefined();
  }
  await page.route("**/api/documents/acquire", (r) =>
    r.fulfill({ json: { ...value, resolution } }),
  );
  const result = await acquire(page, alias);
  expect(result.error).toBe("");
  expect(result.result?.content.document?.sourceURL).toBe(url);
  expect((await current(page))?.version).toEqual(value.version);
  expect((await acquire(page)).error).toBe("");
  expect((await current(page))?.version).toEqual(value.version);
  const archive = await page.evaluate(
    async ({ alias, value }) => {
      const path = "/src/source-document-store.ts",
        backupPath = "/src/library-backup.ts";
      const docs = await import(path);
      await docs.retainDocument(alias, {
        ...value.version.content,
        text: "Older browser original",
      });
      const sources = await docs.documentSources(alias);
      const { blob } = await (await import(backupPath)).exportLibrary();
      return {
        sources,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      };
    },
    { alias, value },
  );
  expect(archive.sources).toHaveLength(2);
  expect(
    archive.sources.find((d: SourceDocument) => d.id === value.document.id)
      ?.sourceAliases,
  ).toEqual([alias]);
  const fresh = await browser.newContext(),
    restored = await fresh.newPage();
  try {
    await blank(restored);
    const sources = await restored.evaluate(
      async ({ bytes, alias }) => {
        const path = "/src/library-backup.ts",
          docsPath = "/src/source-document-store.ts";
        const backup = await import(path);
        const preview = await backup.validateBackup(
          new File([new Uint8Array(bytes)], "aliases.quilna.gz"),
        );
        await backup.restoreBackup(preview.id);
        return (await import(docsPath)).documentSources(alias);
      },
      { bytes: archive.bytes, alias },
    );
    expect(sources).toEqual(archive.sources);
  } finally {
    await fresh.close();
  }
});

test("client rejects changed account, denied source, pending and corrupt responses without fallback or lost copies", async ({
  page,
}) => {
  await blank(page);
  const value = await pair(page);
  await connect(page, value);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) requests.push(r.url());
  });
  expect((await acquire(page)).error).toBe("");
  const saved = await current(page);
  for (const [status, json, message] of [
    [403, {}, "権限"],
    [404, {}, "許可"],
    [429, {}, "上限"],
    [502, {}, "取得できません"],
    [
      202,
      { status: "pending", account, retryAt: Date.now() + 30000 },
      "取得中",
    ],
    [200, { ...value, account: other }, "アカウント"],
    [
      200,
      {
        ...value,
        version: {
          ...value.version,
          content: { ...value.version.content, text: "tampered" },
        },
      },
      "保存情報",
    ],
    [
      200,
      { ...value, document: { ...value.document, scope: `private:${other}` } },
      "確認できません",
    ],
  ] as const) {
    await page.route("**/api/documents/acquire", (r) =>
      r.fulfill({ status, json }),
    );
    expect((await acquire(page)).error).toContain(message);
    expect(await current(page)).toEqual(saved);
  }
  const before = requests.filter((x) => x.endsWith("/acquire")).length;
  await page.route("**/api/documents/status", (r) =>
    r.fulfill({ json: { account: other, enabled: true } }),
  );
  expect((await acquire(page)).error).toContain("アカウント");
  expect(requests.filter((x) => x.endsWith("/acquire"))).toHaveLength(before);
  expect(requests.some((x) => x.includes("/feeds/fetch"))).toBe(false);
});

test("preference changes and logout before retention discard late acquisition", async ({
  page,
}) => {
  await blank(page);
  const value = await pair(page);
  const results = await page.evaluate(
    async ({ value, url, account, other }) => {
      const path = "/src/document-acquisition.ts",
        { DocumentAcquisition } = await import(path);
      const errors = [];
      for (const change of ["preference", "logout"]) {
        let statusCalls = 0;
        const client = new DocumentAcquisition(async (input: string) => {
          if (input.endsWith("/status")) {
            statusCalls++;
            return Response.json({
              account: change === "logout" && statusCalls > 1 ? other : account,
              enabled: true,
            });
          }
          if (input === "/api/session")
            return Response.json({
              csrfToken: "synthetic-csrf-token-for-test",
            });
          if (change === "preference") client.save({ mode: "browser" });
          return Response.json(value);
        });
        client.save({ mode: "shared", account });
        try {
          await client.acquire(url, true);
          errors.push("unexpected success");
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      return errors;
    },
    { value, url, account, other },
  );
  expect(results[0]).toContain("変更");
  expect(results[1]).toContain("アカウント");
  expect(await current(page)).toBeUndefined();
});

test("remote persistence is immutable, retains earlier revisions and rolls back failed transactions", async ({
  page,
}) => {
  await blank(page);
  const first = await pair(page),
    second = await pair(page, shared, 2);
  const result = await page.evaluate(
    async ({ first, second, url, shared }) => {
      const path = "/src/remote-document-store.ts",
        lib = "/src/source-document-store.ts";
      const { retainRemoteDocument: retain } = await import(path),
        store = await import(lib);
      const signal = new AbortController().signal;
      await retain(second.document, second.version, signal);
      await retain(first.document, first.version, signal);
      const before = await store.currentDocument(url, shared),
        errors = [];
      for (const value of [
        {
          ...first,
          version: { ...first.version, createdAt: "2026-10-03T00:00:00.000Z" },
        },
        {
          ...second,
          document: { ...second.document, currentVersionId: first.version.id },
          version: first.version,
        },
      ]) {
        try {
          await retain(value.document, value.version, signal);
          errors.push(false);
        } catch {
          errors.push(true);
        }
      }
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "documents") {
          this.transaction.abort();
          throw Error("synthetic abort");
        }
        return put.apply(this, args);
      };
      try {
        await retain(
          { ...second.document, revision: 3 },
          second.version,
          signal,
        );
        errors.push(false);
      } catch {
        errors.push(true);
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const after = await store.currentDocument(url, shared),
        history = await store.documentHistory(first.document.id, shared);
      return { before, after, history, errors };
    },
    { first, second, url, shared },
  );
  expect(result.errors).toEqual([true, true, true]);
  expect(result.before).toEqual(result.after);
  expect(result.after?.document).toEqual(second.document);
  expect(result.history.versions).toHaveLength(2);
});

for (const schemaVersion of [1, 2])
  test(`v${schemaVersion} storage upgrades preserve browser originals and add source history lookup`, async ({
    page,
  }) => {
    await blank(page);
    const value = await pair(page, "browser-private");
    const result = await page.evaluate(
      async ({ value, url, schemaVersion }) => {
        await new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("quilna.documents.v1", schemaVersion);
          r.onupgradeneeded = () => {
            const d = r.result.createObjectStore("documents", {
                keyPath: "id",
              }),
              v = r.result.createObjectStore("versions", { keyPath: "id" });
            d.createIndex("source", ["scope", "sourceURL"], { unique: true });
            if (schemaVersion === 2) d.createIndex("url", "sourceURL");
            v.createIndex(
              "representation",
              ["documentId", "representationHash"],
              { unique: true },
            );
            v.createIndex("history", ["documentId", "createdAt", "id"]);
            d.put(value.document);
            v.put(value.version);
          };
          r.onsuccess = () => {
            r.result.close();
            resolve();
          };
          r.onerror = () => reject(r.error);
        });
        const path = "/src/source-document-store.ts",
          lib = await import(path);
        return {
          sources: await lib.documentSources(url),
          current: await lib.currentDocument(url),
        };
      },
      { value, url, schemaVersion },
    );
    expect(result.sources).toEqual([value.document]);
    expect(result.current).toEqual({
      document: value.document,
      version: value.version,
    });
  });

for (const design of ["studio", "editorial", "focus"])
  for (const aliasMode of [false, true])
    test(`${design} ${aliasMode ? "alias" : "exact"} reader switches acquisition while preserving personal flags, old histories and offline content`, async ({
      page,
    }, info) => {
      await blank(page);
      const value = await pair(page);
      const articleURL = aliasMode ? url + "?utm_source=approved" : url;
      await connect(page, value);
      if (aliasMode)
        await page.route("**/api/documents/acquire", (r) =>
          r.fulfill({
            json: {
              ...value,
              resolution: {
                requestedURL: articleURL,
                sourceURL: url,
                scope: shared,
              },
            },
          }),
        );
      await page.evaluate(
        async ({ url, design }) => {
          localStorage.removeItem("quilna.document-acquisition.v1");
          localStorage.setItem("quilna.reader.design.v1", design);
          localStorage.setItem("quilna.feed.refresh.v1", "0");
          const path = "/src/feed-store.ts",
            lib = await import(path),
            db = await lib.openFeedLibrary();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("articles", "readwrite");
            tx.objectStore("articles").put({
              id: "a",
              url,
              title: "Local article",
              body: "RSS summary",
              feedUrl: "",
              saved: true,
              read: true,
              published: null,
              fetchedAt: new Date().toISOString(),
            });
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
          db.close();
        },
        { url: articleURL, design },
      );
      let originalFetches = 0;
      await page.route("**/api/collection", (r) =>
        r.fulfill({ status: 404, json: {} }),
      );
      await page.route("**/api/feeds/fetch", (r) => {
        if (r.request().postDataJSON().icon === true)
          return r.fulfill({ status: 404, json: {} });
        originalFetches++;
        return r.fulfill({
          json: {
            url,
            html: `<html lang="en"><title>Local article</title><article><p>${"Browser original stays available for offline reading. ".repeat(12)}</p></article></html>`,
          },
        });
      });
      const posted: unknown[] = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/documents/acquire")) {
          posted.push(r.postDataJSON());
          expect(r.headers()["x-document-account"]).toBe(account);
          expect(r.headers()["x-csrf-token"]).toBe(
            "synthetic-token-for-client-fixture",
          );
        }
      });
      await page.goto("/?view=feeds");
      await page
        .getByRole("button", { name: "Local article", exact: true })
        .click();
      await expect(page.locator(".rss-source-text")).toContainText(
        "Browser original",
      );
      await page.getByRole("button", { name: "設定", exact: true }).click();
      await page
        .getByLabel("新しく取り込む本文の取得先")
        .selectOption("shared");
      await expect(page.getByRole("dialog")).toContainText(
        "取得先を保存しました",
      );
      await page
        .getByLabel("新しく取り込む本文の取得先")
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("document-settings.png") });
      await page.getByRole("button", { name: "閉じる", exact: true }).click();
      const history = page.locator(".rss-document-history");
      await history.locator("summary").click();
      await history
        .getByRole("button", { name: "元サイトの更新を確認" })
        .click();
      await expect(page.locator(".rss-source-text")).toContainText(
        "Cloud revision 1",
      );
      await expect(history.getByLabel("履歴の取得先")).toBeVisible();
      const browserScope = await history
        .getByLabel("履歴の取得先")
        .locator("option")
        .filter({ hasText: "このブラウザ用" })
        .getAttribute("value");
      await history.getByLabel("履歴の取得先").selectOption(browserScope!);
      await history
        .getByRole("button", { name: "この本文を表示", exact: true })
        .click();
      await expect(page.locator(".rss-source-text")).toContainText(
        "Browser original",
      );
      await history.getByLabel("履歴の取得先").selectOption(value.document.id);
      await history
        .getByRole("button", { name: "この本文を表示", exact: true })
        .click();
      await expect(page.locator(".rss-source-text")).toContainText(
        "Cloud revision 1",
      );
      await page.route("**/api/documents/acquire", (r) =>
        r.fulfill({ status: 404, json: { status: "document-unavailable" } }),
      );
      await history
        .getByRole("button", { name: "元サイトの更新を確認" })
        .click();
      await expect(
        page.getByText(/この本文はクラウドで利用できないか/).first(),
      ).toBeVisible();
      await expect(page.locator(".rss-source-text")).toContainText(
        "Cloud revision 1",
      );
      expect(originalFetches).toBe(1);
      expect(posted).toEqual(
        Array.from({ length: 2 }, () => ({
          url: articleURL,
          audience: "shared",
          force: true,
        })),
      );
      const saved = await page.evaluate(async () => {
        const path = "/src/feed-store.ts",
          lib = await import(path),
          db = await lib.openFeedLibrary();
        try {
          return await lib.readArticle(db, "a");
        } finally {
          db.close();
        }
      });
      expect(saved.url).toBe(articleURL);
      expect(saved.saved).toBe(true);
      expect(saved.read).toBe(true);
      expect(saved.content.document.versionId).toBe(value.version.id);
      await page.setViewportSize({ width: 320, height: 800 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await history.getByLabel("履歴の取得先").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("document-history.png") });
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Cloud 1", exact: true }),
      ).toBeVisible();
      await page.context().setOffline(true);
      await page.getByRole("button", { name: "Cloud 1", exact: true }).click();
      await expect(page.locator(".rss-source-text")).toContainText(
        "Cloud revision 1",
      );
    });

test("private mode persists the signed-in scope, refuses oversized data and leaves settings unchanged when service is disabled", async ({
  page,
}) => {
  await blank(page);
  const value = await pair(page, `private:${account}`);
  await connect(page, value, "private");
  expect((await acquire(page)).error).toBe("");
  expect((await current(page, `private:${account}`))?.document.id).toBe(
    value.document.id,
  );
  await page.route("**/api/documents/acquire", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...value, padding: "x".repeat(4_100_001) }),
    }),
  );
  expect((await acquire(page)).error).toContain("確認できません");
  expect((await current(page, `private:${account}`))?.version).toEqual(
    value.version,
  );
  await page.route("**/api/documents/status", (r) =>
    r.fulfill({ json: { account, enabled: false } }),
  );
  await page.evaluate(async () => {
    const clientPath = "/src/document-acquisition.ts",
      viewPath = "/src/document-acquisition-view.ts";
    const client = new (await import(clientPath)).DocumentAcquisition();
    client.save({ mode: "browser" });
    document.body.append(
      (await import(viewPath)).documentAcquisitionSettings(client),
    );
  });
  await page.getByLabel("新しく取り込む本文の取得先").selectOption("shared");
  await expect(page.getByRole("status")).toContainText(
    "設定は変更していません",
  );
  await expect(page.getByLabel("新しく取り込む本文の取得先")).toHaveValue(
    "browser",
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("quilna.document-acquisition.v1")!),
    ),
  ).toEqual({ mode: "browser" });
});

test("corrupt acquisition preferences explain recovery in Japanese and never choose a fallback", async ({
  page,
}) => {
  await blank(page);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) requests.push(r.url());
  });
  await page.evaluate(() =>
    localStorage.setItem("quilna.document-acquisition.v1", "{"),
  );
  expect((await acquire(page)).error).toContain(
    "設定で取得先を選び直してください",
  );
  expect(requests).toEqual([]);
});
