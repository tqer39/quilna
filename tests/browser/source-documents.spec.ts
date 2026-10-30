import { test, expect, type Page } from "@playwright/test";
const articleURL = "https://example.org/source";
const html = (version = 1) =>
  `<html lang="en"><title>Document ${version}</title><article><h1>Document ${version}</h1><p>${`Version ${version} explains how source evidence remains available for careful reading and learning. `.repeat(12)}</p><pre><code>const version = ${version};\n  console.log(version);\n</code></pre></article></html>`;
async function blank(page: Page) {
  await page.route("**/__documents", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Document fixture</title>",
    }),
  );
  await page.goto("/__documents");
}
async function fixture(page: Page, design = "studio") {
  await blank(page);
  await page.evaluate(
    async ({ articleURL, design }) => {
      localStorage.setItem("quilna.reader.design.v1", design);
      localStorage.setItem("quilna.feed.refresh.v1", "0");
      const path = "/src/feed-store.ts",
        db = await (await import(path)).openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        for (const id of ["a", "b"])
          tx.objectStore("articles").put({
            id,
            feedUrl: `https://example.org/feed-${id}`,
            title: `Article ${id}`,
            url: articleURL,
            body: "RSS summary",
            read: true,
            saved: id === "a",
            published: null,
            fetchedAt: new Date().toISOString(),
          });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { articleURL, design },
  );
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.goto("/?view=feeds");
}
async function snapshots(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      lib = await import(path),
      db = await lib.openFeedLibrary();
    try {
      return [await lib.readArticle(db, "a"), await lib.readArticle(db, "b")];
    } finally {
      db.close();
    }
  });
}

test("same source acquisition is shared across callers while scope and query remain distinct", async ({
  page,
}) => {
  await blank(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    requests++;
    return r.fulfill({ json: { url: articleURL, html: html() } });
  });
  const result = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path);
    const all = await Promise.all(
      Array.from({ length: 8 }, () => api.acquireDocument(url)),
    );
    const query = await api.acquireDocument(url + "?edition=2"),
      other = await api.acquireDocument(url, { scope: "second-private-scope" });
    let refused = false;
    try {
      await api.readDocumentVersion(
        all[0].content.document.documentId,
        all[0].content.document.versionId,
        "second-private-scope",
      );
    } catch {
      refused = true;
    }
    return {
      refs: all.map((x) => x.content.document),
      query: query.content.document,
      other: other.content.document,
      refused,
    };
  }, articleURL);
  expect(requests).toBe(3);
  expect(new Set(result.refs.map((r) => r.documentId)).size).toBe(1);
  expect(new Set(result.refs.map((r) => r.versionId)).size).toBe(1);
  expect(result.query.documentId).not.toBe(result.refs[0].documentId);
  expect(result.other.documentId).not.toBe(result.refs[0].documentId);
  expect(result.refused).toBe(true);
});

test("unchanged refresh reuses an immutable version and failure retains the previous source", async ({
  page,
}) => {
  await blank(page);
  let requests = 0,
    fail = false;
  await page.route("**/api/feeds/fetch", (r) => {
    requests++;
    return r.fulfill(
      fail
        ? { status: 503, json: {} }
        : { json: { url: articleURL, html: html() } },
    );
  });
  const before = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path);
    const first = await api.acquireDocument(url);
    const refreshed = await Promise.all(
      Array.from({ length: 6 }, () =>
        api.acquireDocument(url, { force: true }),
      ),
    );
    const history = await api.documentHistory(
      first.content.document.documentId,
    );
    return { first, refreshed, history };
  }, articleURL);
  expect(requests).toBe(2);
  expect(before.history.versions).toHaveLength(1);
  expect(
    before.refreshed.every(
      (r) =>
        r.content.document.versionId ===
        before.first.content.document.versionId,
    ),
  ).toBe(true);
  fail = true;
  const failed = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts";
    return (await import(path)).acquireDocument(url, { force: true });
  }, articleURL);
  expect(failed.warning).toContain("更新を確認できませんでした");
  expect(failed.content).toEqual(before.first.content);
});

for (const design of ["studio", "editorial", "focus"])
  test(`${design} reader reuses source, keeps per-article flags and lets the reader revisit immutable versions`, async ({
    page,
  }, info) => {
    await fixture(page, design);
    let version = 1,
      requests = 0;
    await page.route("**/api/feeds/fetch", (r) => {
      requests++;
      return r.fulfill({ json: { url: articleURL, html: html(version) } });
    });
    await page.getByRole("button", { name: "Article a", exact: true }).click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Version 1 explains",
    );
    await page.getByRole("button", { name: /記事一覧へ/ }).click();
    await page.getByRole("button", { name: "Article b", exact: true }).click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Version 1 explains",
    );
    expect(requests).toBe(1);
    const original = await snapshots(page);
    expect(original[0].content.document).toEqual(original[1].content.document);
    expect(original.map((a) => a.saved)).toEqual([true, false]);
    const history = page.locator(".rss-document-history");
    await history.locator("summary").click();
    await expect(history).toContainText("表示中");
    version = 2;
    await history.getByRole("button", { name: "元サイトの更新を確認" }).click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Version 2 explains",
    );
    await expect(history.locator(".rss-document-version")).toHaveCount(2);
    const rows = history.locator(".rss-document-version");
    await rows
      .filter({ hasText: "Version 1 explains" })
      .getByRole("button", { name: "この本文を表示" })
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Version 1 explains",
    );
    expect(requests).toBe(2);
    const restored = await snapshots(page);
    expect(restored[1].content).toEqual(original[1].content);
    expect(restored.map((a) => [a.id, a.read, a.saved])).toEqual(
      original.map((a) => [a.id, a.read, a.saved]),
    );
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await history.getByRole("button", { name: "保存履歴を再読み込み" }).focus();
    await page.screenshot({ path: info.outputPath("document-history.png") });
    await page.reload();
    await page
      .getByRole("button", { name: "Document 1", exact: true })
      .first()
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Version 1 explains",
    );
    expect(requests).toBe(2);
  });

test("failed immutable-version transaction leaves the current document intact and permits retry", async ({
  page,
}) => {
  await blank(page);
  const result = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path);
    const content = {
      text: "Old source",
      url,
      title: "Source",
      language: "en",
      fetchedAt: new Date().toISOString(),
      codeRanges: [],
    };
    const first = await api.retainDocument(url, content);
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (
        this.transaction.db.name === api.documentDatabase &&
        this.name === "versions"
      )
        throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args);
    };
    let failed = false;
    try {
      await api.retainDocument(url, { ...content, text: "Updated source" });
    } catch {
      failed = true;
    } finally {
      IDBObjectStore.prototype.add = add;
    }
    const after = await api.currentDocument(url);
    const retry = await api.retainDocument(url, {
      ...content,
      text: "Updated source",
    });
    const history = await api.documentHistory(first.document.id);
    return { first, after, retry, history, failed };
  }, articleURL);
  expect(result.failed).toBe(true);
  expect(result.after).toEqual(result.first);
  expect(result.retry.document.id).toBe(result.first.document.id);
  expect(result.history.versions).toHaveLength(2);
});

test("seeding an old article preserves the latest version and history pagination is complete", async ({
  page,
}) => {
  await blank(page);
  const result = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path);
    const content = {
      text: "Version 0",
      url,
      title: "Source",
      language: "en",
      fetchedAt: "2026-01-01T00:00:00Z",
      codeRanges: [],
    };
    const first = await api.retainDocument(url, content);
    for (let i = 1; i < 25; i++)
      await api.retainDocument(url, { ...content, text: `Version ${i}` });
    await api.retainDocument(url, content, { seed: true });
    const current = await api.currentDocument(url),
      a = await api.documentHistory(first.document.id),
      last = a.versions.at(-1),
      b = await api.documentHistory(first.document.id, undefined, [
        last.createdAt,
        last.id,
      ]);
    return {
      current,
      ids: [...a.versions, ...b.versions].map((v) => v.id),
      more: [a.more, b.more],
    };
  }, articleURL);
  expect(result.current.version.content.text).toBe("Version 24");
  expect(new Set(result.ids).size).toBe(25);
  expect(result.more).toEqual([true, false]);
});

test("future catalog and corrupted version refuse without fetching or rewriting records", async ({
  page,
}) => {
  await blank(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    requests++;
    return r.fulfill({ json: { url: articleURL, html: html() } });
  });
  const result = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path);
    const first = await api.acquireDocument(url),
      db = await api.openDocuments();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("versions", "readwrite"),
        store = tx.objectStore("versions"),
        get = store.get(first.content.document.versionId);
      get.onsuccess = () =>
        store.put({
          ...get.result,
          content: { ...get.result.content, text: "corrupt" },
        });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    let corrupt = false,
      future = false;
    try {
      await api.acquireDocument(url);
    } catch {
      corrupt = true;
    }
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(api.documentDatabase, 99);
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
    });
    try {
      await api.acquireDocument(url);
    } catch {
      future = true;
    }
    return { corrupt, future };
  }, articleURL);
  expect(requests).toBe(1);
  expect(result).toEqual({ corrupt: true, future: true });
});

test("legacy history migration retains translated text and private state without fetching", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(
    async ({ url, html }) => {
      const storePath = "/src/feed-store.ts",
        contentPath = "/src/article-content.ts";
      const api = await import(storePath),
        content = (await import(contentPath)).extractArticle(html, url),
        db = await api.openFeedLibrary();
      const article = await api.readArticle(db, "a");
      // Another feed retained this representation at a different acquisition time.
      const documentPath = "/src/source-document-store.ts";
      await (
        await import(documentPath)
      ).retainDocument(url, {
        ...content,
        fetchedAt: "2020-01-01T00:00:00.000Z",
      });
      await api.updateArticleContent(db, article, { content });
      await api.updateArticleContent(db, await api.readArticle(db, "a"), {
        translation: {
          text: "保存済みの訳文",
          sourceText: content.text,
          sourceLanguage: "en",
          targetLanguage: "ja",
        },
      });
      db.close();
    },
    { url: articleURL, html: html() },
  );
  await page.reload();
  let requests = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    requests++;
    return r.abort();
  });
  const before = await snapshots(page);
  await page.getByRole("button", { name: "Document 1", exact: true }).click();
  const history = page.locator(".rss-document-history");
  await history.locator("summary").click();
  await expect(history).toContainText("表示中");
  const after = await snapshots(page);
  expect(after[0].content.document).toBeTruthy();
  expect({ ...after[0].content, document: undefined }).toEqual(
    before[0].content,
  );
  expect(after[0].translation).toEqual(before[0].translation);
  expect(after[0].saved).toBe(before[0].saved);
  expect(after[0].id).toBe(before[0].id);
  expect(requests).toBe(0);
  await page.unroute("**/api/feeds/fetch");
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ json: { url: articleURL, html: html() } }),
  );
  await history.getByRole("button", { name: "元サイトの更新を確認" }).click();
  await expect(
    history.getByRole("button", { name: "元サイトの更新を確認" }),
  ).toBeEnabled();
  expect((await snapshots(page))[0].translation).toEqual(before[0].translation);
  await expect(history.locator(".rss-document-version")).toHaveCount(1);
});

test("document versions round-trip in backup v2 and dangling or altered references are refused", async ({
  page,
  browser,
}) => {
  await fixture(page);
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({
      json: {
        url: articleURL,
        html: html(),
        validators: { url: articleURL, etag: '"backup"' },
      },
    }),
  );
  await page.getByRole("button", { name: "Article a", exact: true }).click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 1 explains",
  );
  const archive = await page.evaluate(async (url) => {
    const documentPath = "/src/source-document-store.ts",
      backupPath = "/src/library-backup.ts",
      api = await import(documentPath),
      backup = await import(backupPath);
    const first = await api.currentDocument(url);
    await api.retainDocument(
      url,
      {
        ...first.version.content,
        text: first.version.content.text + " Updated.",
      },
      { validators: { url, etag: '"backup-v2"' } },
    );
    const file = await backup.exportLibrary();
    return {
      bytes: Array.from(new Uint8Array(await file.blob.arrayBuffer())),
      counts: file.counts,
      text: await new Response(
        file.blob.stream().pipeThrough(new DecompressionStream("gzip")),
      ).text(),
    };
  }, articleURL);
  expect(archive.counts.documents).toBe(1);
  expect(archive.counts.documentVersions).toBe(2);
  const context = await browser.newContext(),
    other = await context.newPage();
  await other.goto(page.url());
  await blank(other);
  const result = await other.evaluate(async (bytes) => {
    const path = "/src/library-backup.ts",
      api = await import(path);
    const preview = await api.validateBackup(
      new File([new Uint8Array(bytes)], "versions.quilna.gz"),
    );
    await api.restoreBackup(preview.id);
    const file = await api.exportLibrary();
    return await new Response(
      file.blob.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
  }, archive.bytes);
  const entries = (text: string) =>
    text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === "entry")
      .sort((a, b) =>
        JSON.stringify([a.kind, a.key]).localeCompare(
          JSON.stringify([b.kind, b.key]),
        ),
      );
  expect(entries(result)).toEqual(entries(archive.text));
  expect(
    entries(result).find((entry) => entry.kind === "documents").value.validators,
  ).toEqual({ url: articleURL, etag: '"backup-v2"' });
  const refusals = await other.evaluate(async (text) => {
    const path = "/src/library-backup.ts",
      api = await import(path),
      lines = text
        .trim()
        .split("\n")
        .map((l: string) => JSON.parse(l));
    const badHash = structuredClone(lines);
    const version = badHash.find(
      (e: { kind?: string }) => e.kind === "documentVersions",
    );
    version.value.content.text += " corrupted";
    const missing = structuredClone(lines).filter(
      (e: { kind?: string }) => e.kind !== "documents",
    );
    missing.at(-1).counts.documents = 0;
    const mismatchedValidator = structuredClone(lines);
    mismatchedValidator.find(
      (e: { kind?: string }) => e.kind === "documents",
    ).value.validators.url = "https://other.example.org/unrelated";
    const messages = [];
    for (const variant of [badHash, missing, mismatchedValidator]) {
      const blob = await new Response(
        new Blob([
          variant.map((e: unknown) => JSON.stringify(e)).join("\n") + "\n",
        ])
          .stream()
          .pipeThrough(new CompressionStream("gzip")),
      ).blob();
      try {
        await api.validateBackup(new File([blob], "broken.quilna.gz"));
        messages.push("success");
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    return messages;
  }, archive.text);
  expect(
    refusals.every((message) => message.includes("検証できませんでした")),
  ).toBe(true);
  await context.close();
});

test("closing an acquiring tab releases the source lock and a new tab recovers", async ({
  page,
  context,
}) => {
  await blank(page);
  let started = false;
  let release = () => {};
  await page.route("**/api/feeds/fetch", async (r) => {
    started = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await r
      .fulfill({ json: { url: articleURL, html: html() } })
      .catch(() => {});
  });
  const pending = page
    .evaluate(async (url) => {
      const path = "/src/source-document-store.ts";
      return (await import(path)).acquireDocument(url);
    }, articleURL)
    .catch(() => undefined);
  await expect.poll(() => started).toBe(true);
  await page.close();
  release();
  await pending;
  const other = await context.newPage();
  await other.goto("http://127.0.0.1:5197");
  await blank(other);
  await other.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ json: { url: articleURL, html: html(2) } }),
  );
  const result = await other.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path),
      value = await api.acquireDocument(url);
    return {
      value,
      history: await api.documentHistory(value.content.document.documentId),
    };
  }, articleURL);
  expect(result.value.content.text).toContain("Version 2 explains");
  expect(result.history.versions).toHaveLength(1);
});

test("a failed version switch keeps the selected source and retry succeeds", async ({
  page,
}) => {
  await fixture(page);
  let version = 1;
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ json: { url: articleURL, html: html(version) } }),
  );
  await page.getByRole("button", { name: "Article a", exact: true }).click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 1 explains",
  );
  const history = page.locator(".rss-document-history");
  await history.locator("summary").click();
  version = 2;
  await history.getByRole("button", { name: "元サイトの更新を確認" }).click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 2 explains",
  );
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (
        this.transaction.db.name === "tsumiki.rss.v1" &&
        this.name === "articles"
      )
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
    Object.assign(window, {
      restorePut: () => {
        IDBObjectStore.prototype.put = put;
      },
    });
  });
  await history
    .locator(".rss-document-version")
    .filter({ hasText: "Version 1 explains" })
    .getByRole("button", { name: "この本文を表示" })
    .click();
  await expect(history.getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 2 explains",
  );
  await page.evaluate(() =>
    (window as unknown as { restorePut: () => void }).restorePut(),
  );
  await history
    .locator(".rss-document-version")
    .filter({ hasText: "Version 1 explains" })
    .getByRole("button", { name: "この本文を表示" })
    .click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 1 explains",
  );
});

test("conditional refresh retains exact original and translation, survives reload, and rejects unrelated 304", async ({
  page,
}) => {
  await fixture(page);
  let phase = 0;
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/feeds/fetch", (r) => {
    const body = r.request().postDataJSON();
    requests.push(body);
    if (phase === 0)
      return r.fulfill({
        json: {
          url: articleURL,
          html: html(),
          validators: { url: articleURL, etag: '"v1"' },
        },
      });
    if (phase === 1)
      return r.fulfill({ json: { url: articleURL, notModified: true } });
    if (phase === 2)
      return r.fulfill({
        json: { url: "https://other.example.org/changed", notModified: true },
      });
    return r.fulfill({ json: { url: articleURL, html: html(2) } });
  });
  await page.getByRole("button", { name: "Article a", exact: true }).click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 1 explains",
  );
  const initial = await snapshots(page);
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary(),
      article = await api.readArticle(db, "a");
    await api.updateArticleContent(db, article, {
      translation: {
        text: "保持する訳文",
        sourceText: article.content.text,
        sourceLanguage: "en",
        targetLanguage: "ja",
      },
    });
    db.close();
  });
  await page.reload();
  await page.getByRole("button", { name: "Document 1", exact: true }).click();
  const history = page.locator(".rss-document-history");
  await history.locator("summary").click();
  phase = 1;
  const refresh = history.getByRole("button", { name: "元サイトの更新を確認" });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  expect(requests[1].validators).toEqual({ url: articleURL, etag: '"v1"' });
  const unchanged = await snapshots(page);
  expect(unchanged[0].content).toEqual(initial[0].content);
  expect(unchanged[0].translation.text).toBe("保持する訳文");
  await expect(history.locator(".rss-document-version")).toHaveCount(1);
  phase = 2;
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(
    page.locator(".rss-content-note").filter({ hasText: "更新確認の結果" }),
  ).toBeVisible();
  expect((await snapshots(page))[0].content).toEqual(initial[0].content);
  phase = 3;
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Version 2 explains",
  );
  await expect(history.locator(".rss-document-version")).toHaveCount(2);
  const final = await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      api = await import(path);
    return api.currentDocument(url);
  }, articleURL);
  expect(final.document.validators).toBeUndefined();
  expect((await snapshots(page))[0].translation).toBeUndefined();
});

test("an unsolicited unchanged response cannot invent an original", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ json: { url: articleURL, notModified: true } }),
  );
  await page.getByRole("button", { name: "Article a", exact: true }).click();
  await expect(page.locator(".rss-content-note")).toContainText(
    "更新確認の結果",
  );
  expect((await snapshots(page))[0].content).toBeUndefined();
});

test("large validator requests fall back to a full fetch within the existing body limit", async ({
  page,
}) => {
  await blank(page);
  const url = "https://example.org/" + "a".repeat(2000);
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/feeds/fetch", (r) => {
    expect(
      new TextEncoder().encode(r.request().postData()!).byteLength,
    ).toBeLessThanOrEqual(4096);
    requests.push(r.request().postDataJSON());
    return r.fulfill({ json: { url, html: html() } });
  });
  const result = await page.evaluate(
    async ({ url, html }) => {
      const path = "/src/article-content.ts",
        api = await import(path),
        content = api.extractArticle(html, url);
      return api.fetchArticle(url, {
        content,
        validators: { url, etag: '"' + "v".repeat(500) + '"' },
      });
    },
    { url, html: html() },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].validators).toBeUndefined();
  expect(result.notModified).toBe(false);
  expect(result.content.text).toContain("Version 1 explains");
});
