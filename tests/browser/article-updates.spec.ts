import { test, expect, type Page } from "@playwright/test";
const url = "https://example.org/update",
  feed = "https://example.org/rss";
const html = `<html lang="en"><title>Updated source</title><article><h1>Updated source</h1><p>${"New version with corrected source evidence and reading details. ".repeat(30)}</p></article></html>`;
async function seed(
  page: Page,
  options: {
    saved?: boolean;
    duplicate?: boolean;
    due?: boolean;
    design?: string;
  } = {},
) {
  await page.route("**/__update_fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("/__update_fixture");
  await page.evaluate(
    async ({ url, feed, options }) => {
      localStorage.setItem("quilna.feed.refresh.v1", "0");
      localStorage.setItem("quilna.article.updates.v1", "false");
      localStorage.setItem(
        "quilna.reader.design.v1",
        options.design ?? "studio",
      );
      const path = "/src/feed-store.ts",
        api = await import(path),
        db = await api.openFeedLibrary();
      const now = Date.now(),
        old = new Date(now - 2 * 86400000).toISOString();
      for (const id of options.duplicate ? ["a", "b"] : ["a"]) {
        const article = {
          id,
          feedUrl: id === "b" ? feed + "?other" : feed,
          title: "Saved original " + id,
          url,
          body: "Summary",
          saved: options.saved ?? true,
          read: true,
          published: null,
          fetchedAt: old,
        };
        await api.mergeFeed(
          db,
          { url: article.feedUrl, title: "Publisher " + id, fetchedAt: old },
          [article],
        );
        await api.updateArticleContent(db, article, {
          content: {
            url,
            title: "Old source",
            text: "Old body kept for quotations. ".repeat(30),
            language: "en",
            codeRanges: [],
            fetchedAt:
              options.due === false ? new Date(now).toISOString() : old,
          },
        });
      }
      db.close();
    },
    { url, feed, options },
  );
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary();
    try {
      return (await api.readFeedLibrary(db)).articles;
    } finally {
      db.close();
    }
  });
}
async function run(page: Page) {
  return page.evaluate(async () => {
    const paths = [
      "/src/feed-store.ts",
      "/src/article-auto-update.ts",
      "/src/document-acquisition.ts",
    ];
    const [api, update, acquisition] = await Promise.all(
        paths.map((p) => import(p)),
      ),
      db = await api.openFeedLibrary();
    try {
      return await update.checkArticleUpdates(
        db,
        (await api.readFeedLibrary(db)).articles,
        new acquisition.DocumentAcquisition(),
        () => {},
      );
    } finally {
      db.close();
    }
  });
}

test("saved RSS snapshots track real changes, not polling dates, and ignore late observations", async ({
  page,
}) => {
  await seed(page, { due: false });
  const result = await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary();
    const before = await api.readArticle(db, "a"),
      first = new Date(Date.now() - 1000).toISOString();
    const rss = { ...before, content: undefined };
    await api.mergeFeed(
      db,
      { url: before.feedUrl, title: "Publisher", fetchedAt: first },
      [
        {
          ...rss,
          title: "Revised title",
          body: "Revised summary",
          fetchedAt: first,
        },
      ],
    );
    const changed = await api.readArticle(db, "a");
    await api.mergeFeed(
      db,
      {
        url: before.feedUrl,
        title: "Publisher",
        fetchedAt: new Date().toISOString(),
      },
      [
        {
          ...rss,
          title: "Revised title",
          body: "Revised summary",
          fetchedAt: new Date().toISOString(),
        },
      ],
    );
    const polled = await api.readArticle(db, "a");
    await api.mergeFeed(
      db,
      { url: before.feedUrl, title: "Publisher", fetchedAt: before.fetchedAt },
      [rss],
    );
    const late = await api.readArticle(db, "a");
    db.close();
    return { before, changed, polled, late };
  });
  expect(result.changed.title).toBe(result.before.title);
  expect(result.changed.content).toEqual(result.before.content);
  expect(result.changed.feedRevision.fingerprint).not.toBe(
    result.before.feedRevision.fingerprint,
  );
  expect(result.polled.feedRevision.changedAt).toBe(
    result.changed.feedRevision.changedAt,
  );
  expect(result.late).toEqual(result.polled);
});

test("Atom published dates do not hide explicit update metadata", async ({
  page,
}) => {
  await seed(page);
  const updated = await page.evaluate(async () => {
    const path = "/src/feed-parser.ts";
    return (await import(path)).parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><id>one</id><title>Title</title><published>2026-10-01T00:00:00Z</published><updated>2026-10-30T00:00:00Z</updated><link href="https://example.org/update"/></entry></feed>',
      "https://example.org/rss",
    ).articles[0];
  });
  expect(updated.sourceUpdated).toBe("2026-10-30T00:00:00.000Z");
  expect(updated.published).toBe("2026-10-01T00:00:00.000Z");
});

test("one acquisition serves duplicate sources and retains old versions and personal flags", async ({
  page,
}) => {
  await seed(page, { duplicate: true });
  let calls = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    calls++;
    return r.fulfill({ json: { url, html } });
  });
  const before = await stored(page);
  expect(await run(page)).toEqual(["a", "b"]);
  expect(calls).toBe(1);
  const after = await stored(page);
  for (const [i, a] of after.entries()) {
    expect(a.content.text).toBe(before[i].content.text);
    expect(a.saved).toBe(before[i].saved);
    expect(a.read).toBe(before[i].read);
    expect(a.bodyUpdate.latest.versionId).not.toBe(
      a.content.document.versionId,
    );
  }
  expect(after[0].bodyUpdate.latest).toEqual(after[1].bodyUpdate.latest);
  expect(await run(page)).toEqual([]);
  expect(calls).toBe(1);
});

for (const design of ["studio", "editorial", "focus"])
  test(`${design}: automatic update is opt-out, announced and opens only on request`, async ({
    page,
  }) => {
    await seed(page, { design });
    await page.route("**/api/feeds/fetch", (r) =>
      r.request().postDataJSON().icon
        ? r.fulfill({ status: 404, json: {} })
        : r.fulfill({ json: { url, html } }),
    );
    await page.goto("/?view=feeds");
    await page.getByRole("button", { name: "Old source", exact: true }).click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Old body kept",
    );
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page
      .getByLabel("取り込み済み本文の更新を自動確認", { exact: true })
      .check();
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "更新された本文を読む" }),
    ).toBeVisible();
    await expect(page.locator(".rss-source-text")).toContainText(
      "Old body kept",
    );
    await expect(
      page.getByText(/^本文の更新あり。表示中の本文はそのままです。/),
    ).toBeVisible();
    await page.screenshot({
      path: `.local-state/article-updates-qa/update-${design}-${test.info().project.name}.png`,
      fullPage: false,
    });
    await page.getByRole("button", { name: "更新された本文を読む" }).click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "New version with corrected",
    );
    await expect(
      page.getByRole("button", { name: "更新された本文を読む" }),
    ).toBeHidden();
    await page.reload();
    await page
      .getByRole("button", { name: "Updated source", exact: true })
      .click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "New version with corrected",
    );
  });

test("failure backs off, records a reason and retains a previously detected new version", async ({
  page,
}) => {
  await seed(page);
  let fail = false,
    calls = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    calls++;
    return r.fulfill(
      fail ? { status: 503, json: {} } : { json: { url, html } },
    );
  });
  await run(page);
  const before = (await stored(page))[0];
  await page.clock.setFixedTime(new Date(Date.now() + 2 * 86400000));
  fail = true;
  await run(page);
  const after = (await stored(page))[0];
  expect(after.bodyUpdate.latest).toEqual(before.bodyUpdate.latest);
  expect(after.content).toEqual(before.content);
  expect(after.bodyUpdate.error).toContain("更新を確認できませんでした");
  expect(after.bodyUpdate.failures).toBe(1);
  expect(after.bodyUpdate.retryAt).toBeGreaterThan(after.bodyUpdate.checkedAt);
  await run(page);
  expect(calls).toBe(2);
});

for (const mutation of ["flags", "delete", "unsubscribe", "content", "quota"])
  test(`in-flight ${mutation} cannot lose personal data or resurrect deleted content`, async ({
    page,
  }) => {
    await seed(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route("**/api/feeds/fetch", async (r) => {
      started();
      await gate;
      await r.fulfill({ json: { url, html } });
    });
    const result = run(page).then(
      (ids) => ({ ids, error: "" }),
      (e) => ({ ids: [], error: String(e) }),
    );
    await pending;
    await page.evaluate(async (mutation) => {
      const path = "/src/feed-store.ts",
        api = await import(path),
        db = await api.openFeedLibrary();
      if (mutation === "flags") {
        await api.flagArticle(db, "a", "read", false);
        await api.setArticleTags(db, "a", ["Personal"]);
      } else if (mutation === "unsubscribe")
        await api.setFeedSubscription(db, "https://example.org/rss", false);
      else if (mutation === "content") {
        const a = await api.readArticle(db, "a");
        await api.updateArticleContent(
          db,
          a,
          { content: { ...a.content, text: "Chosen in another tab." } },
          false,
          undefined,
          false,
          "replace",
        );
      } else if (mutation === "delete")
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("articles", "readwrite");
          tx.objectStore("articles").delete("a");
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      if (mutation === "quota") {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.name === "articles" && value.bodyUpdate)
            throw new DOMException("Full", "QuotaExceededError");
          return key === undefined
            ? original.call(this, value)
            : original.call(this, value, key);
        };
      }
      db.close();
    }, mutation);
    release();
    const outcome = await result,
      articles = await stored(page),
      a = articles[0];
    if (mutation === "flags") {
      expect(a.read).toBe(false);
      expect(a.manualTags).toContain("personal");
      expect(a.bodyUpdate.latest).toBeTruthy();
    } else if (mutation === "delete") expect(articles).toHaveLength(0);
    else {
      expect(a.bodyUpdate).toBeUndefined();
      expect(a.content.text).toContain(
        mutation === "content" ? "Chosen in another tab" : "Old body kept",
      );
    }
    expect(!!outcome.error).toBe(mutation === "quota");
  });

test("update references survive backup restore, while dangling update versions are refused", async ({
  page,
  browser,
}) => {
  await seed(page);
  await page.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ json: { url, html } }),
  );
  await run(page);
  const archive = await page.evaluate(async () => {
    const path = "/src/library-backup.ts",
      api = await import(path),
      exported = await api.exportLibrary();
    return await new Response(
      exported.blob.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
  });
  const context = await browser.newContext(),
    other = await context.newPage();
  try {
    await seed(other);
    const result = await other.evaluate(async (text) => {
      const path = "/src/library-backup.ts",
        api = await import(path);
      const file = async (text: string) =>
        new File(
          [
            await new Response(
              new Blob([text])
                .stream()
                .pipeThrough(new CompressionStream("gzip")),
            ).blob(),
          ],
          "updates.quilna.gz",
        );
      const preview = await api.validateBackup(await file(text));
      // Remove only the disposable fixture article so restoration exercises the exported record.
      const storePath = "/src/feed-store.ts",
        store = await import(storePath),
        db = await store.openFeedLibrary();
      await new Promise<void>((resolve) => {
        const tx = db.transaction("articles", "readwrite");
        tx.objectStore("articles").clear();
        tx.oncomplete = () => resolve();
      });
      await api.restoreBackup(preview.id);
      const article = await store.readArticle(db, "a");
      db.close();
      const lines = text
        .trim()
        .split("\n")
        .map((line: string) => JSON.parse(line));
      const row = lines.find(
        (line: { kind?: string }) => line.kind === "articles",
      );
      row.value.bodyUpdate.latest.versionId =
        "00000000-0000-0000-0000-000000000000";
      let error = "";
      try {
        await api.validateBackup(
          await file(
            lines.map((line: unknown) => JSON.stringify(line)).join("\n") +
              "\n",
          ),
        );
      } catch (e) {
        error = String(e);
      }
      return { article, error };
    }, archive);
    expect(result.article.bodyUpdate.latest.versionId).not.toBe(
      result.article.content.document.versionId,
    );
    expect(result.error).toContain("参照が一致しません");
  } finally {
    await context.close();
  }
});

test("same GUID with a changed source URL is reported without fetching another source", async ({
  page,
}) => {
  await seed(page);
  let requests = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    requests++;
    return r.fulfill({ json: { url, html } });
  });
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary(),
      a = await api.readArticle(db, "a");
    await api.mergeFeed(
      db,
      { url: a.feedUrl, title: "Changed", fetchedAt: new Date().toISOString() },
      [
        {
          ...a,
          url: "https://example.org/different",
          fetchedAt: new Date().toISOString(),
        },
      ],
    );
    db.close();
  });
  await run(page);
  const a = (await stored(page))[0];
  expect(a.url).toBe(url);
  expect(a.bodyUpdate.error).toContain("URLが変更");
  expect(requests).toBe(0);
});

test("a preference change during acquisition does not attach another audience or false failure", async ({
  page,
}) => {
  await seed(page);
  await page.route("**/api/feeds/fetch", async (r) => {
    await page.evaluate(() => {
      localStorage.setItem(
        "quilna.document-acquisition.v1",
        JSON.stringify({ mode: "private", account: "a".repeat(64) }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "quilna.document-acquisition.v1" }),
      );
    });
    return r.fulfill({ json: { url, html } });
  });
  await expect(run(page)).rejects.toThrow("取得先が変更");
  expect((await stored(page))[0].bodyUpdate).toBeUndefined();
});

test("changed RSS checks a recently imported body before its daily expiry", async ({
  page,
}) => {
  await seed(page, { due: false });
  const before = (await stored(page))[0];
  await page.clock.setFixedTime(new Date(Date.now() + 1000));
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary(),
      a = await api.readArticle(db, "a");
    await api.mergeFeed(
      db,
      {
        url: a.feedUrl,
        title: "Publisher",
        fetchedAt: new Date().toISOString(),
      },
      [{ ...a, body: "Changed summary", fetchedAt: new Date().toISOString() }],
    );
    db.close();
  });
  let calls = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    calls++;
    return r.fulfill({ json: { url, html } });
  });
  await run(page);
  expect(calls).toBe(1);
  expect((await stored(page))[0].content.text).toBe(before.content.text);
});

test("two tabs share the background lock and persisted start limit", async ({
  page,
  context,
}) => {
  await seed(page);
  const other = await context.newPage();
  await other.route("**/__update_fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await other.goto("/__update_fixture");
  let calls = 0;
  await context.route("**/api/feeds/fetch", (r) => {
    calls++;
    return r.fulfill({ json: { url, html } });
  });
  const start = (p: Page) =>
    p.evaluate(async () => {
      const paths = [
        "/src/feed-store.ts",
        "/src/article-auto-update.ts",
        "/src/document-acquisition.ts",
      ];
      const [api, update, acquisition] = await Promise.all(
          paths.map((p) => import(p)),
        ),
        db = await api.openFeedLibrary(),
        articles = (await api.readFeedLibrary(db)).articles;
      const state = window as unknown as {
        updater: { stop(): void; wake(): void };
        updateErrors: string[];
        updateDb: IDBDatabase;
      };
      state.updateErrors = [];
      state.updateDb = db;
      state.updater = new update.ArticleAutoUpdate({
        db: () => db,
        articles: () => articles,
        canRun: () => true,
        acquisition: new acquisition.DocumentAcquisition(),
        changed: async () => {},
        failed: (e: unknown) => state.updateErrors.push(String(e)),
      });
      (state.updater as unknown as { start(): void }).start();
    });
  try {
    await Promise.all([start(page), start(other)]);
    await expect
      .poll(async () => !!(await stored(page))[0].bodyUpdate?.latest)
      .toBe(true);
    await Promise.all(
      [page, other].map((p) =>
        p.evaluate(() =>
          (window as unknown as { updater: { wake(): void } }).updater.wake(),
        ),
      ),
    );
    expect(calls).toBe(1);
    for (const p of [page, other])
      expect(
        await p.evaluate(
          () => (window as unknown as { updateErrors: string[] }).updateErrors,
        ),
      ).toEqual([]);
  } finally {
    for (const p of [page, other])
      await p.evaluate(() => {
        const w = window as unknown as {
          updater: { stop(): void };
          updateDb: IDBDatabase;
        };
        w.updater.stop();
        w.updateDb.close();
      });
    await other.close();
  }
});

test("opening a cached original does not acknowledge an unseen RSS revision", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const paths = ["/src/feed-store.ts", "/src/source-document-store.ts"],
      [api, docs] = await Promise.all(paths.map((p) => import(p))),
      db = await api.openFeedLibrary(),
      a = await api.readArticle(db, "a");
    await docs.retainDocument(a.url, a.content); // Fresh catalog check, old retained representation.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").put({ ...a, content: undefined });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.clock.setFixedTime(new Date(Date.now() + 2000));
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      api = await import(path),
      db = await api.openFeedLibrary(),
      a = await api.readArticle(db, "a");
    await api.mergeFeed(
      db,
      {
        url: a.feedUrl,
        title: "Publisher",
        fetchedAt: new Date().toISOString(),
      },
      [
        {
          ...a,
          body: "More recent RSS revision",
          fetchedAt: new Date().toISOString(),
        },
      ],
    );
    db.close();
  });
  let calls = 0;
  await page.route("**/api/feeds/fetch", (r) => {
    if (r.request().postDataJSON().icon)
      return r.fulfill({ status: 404, json: {} });
    calls++;
    return r.fulfill({ json: { url, html } });
  });
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Saved original a", exact: true })
    .click();
  await expect(page.locator(".rss-source-text")).toContainText("Old body kept");
  expect(calls).toBe(0);
  await run(page);
  expect(calls).toBe(1);
  expect((await stored(page))[0].bodyUpdate.latest.versionId).not.toBe(
    (await stored(page))[0].content.document.versionId,
  );
});

test("choosing a newer current catalog version replaces a stale update notice without hiding older history", async ({
  page,
}) => {
  await seed(page);
  await page.route("**/api/feeds/fetch", (r) =>
    r.request().postDataJSON().icon
      ? r.fulfill({ status: 404, json: {} })
      : r.fulfill({ json: { url, html } }),
  );
  await run(page);
  await page.clock.setFixedTime(new Date(Date.now() + 2000));
  await page.evaluate(async (url) => {
    const path = "/src/source-document-store.ts",
      docs = await import(path),
      current = await docs.currentDocument(url);
    await docs.retainDocument(url, {
      ...current.version.content,
      title: "Third version",
      text: "Third version from a later source check. ".repeat(30),
      structure: undefined,
    });
  }, url);
  await page.goto("/?view=feeds");
  await page.getByRole("button", { name: "Old source", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "更新された本文を読む" }),
  ).toBeVisible();
  const history = page.locator(".rss-document-history");
  await history.locator("summary").click();
  await history
    .locator(".rss-document-version")
    .filter({ hasText: "Third version from" })
    .getByRole("button", { name: "この本文を表示" })
    .click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Third version from",
  );
  await expect(
    page.getByRole("button", { name: "更新された本文を読む" }),
  ).toBeHidden();
  await history
    .locator(".rss-document-version")
    .filter({ hasText: "Old body kept" })
    .getByRole("button", { name: "この本文を表示" })
    .click();
  await expect(page.locator(".rss-source-text")).toContainText("Old body kept");
  await page.getByRole("button", { name: "更新された本文を読む" }).click();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Third version from",
  );
});

for (const newerCheck of [false, true])
  test(`manual selection and concurrent update notices retain the newest successful check (${newerCheck})`, async ({
    page,
  }) => {
    await seed(page);
    await page.route("**/api/feeds/fetch", (r) =>
      r.fulfill({ json: { url, html } }),
    );
    await run(page);
    const result = await page.evaluate(
      async ({ newerCheck, url }) => {
        const paths = [
          "/src/feed-store.ts",
          "/src/source-document-store.ts",
          "/src/source-document.ts",
        ];
        const [api, docs, formats] = await Promise.all(
            paths.map((p) => import(p)),
          ),
          db = await api.openFeedLibrary(),
          snapshot = await api.readArticle(db, "a"),
          now = Date.now();
        const current = await docs.currentDocument(url);
        const third = await docs.retainDocument(url, {
            ...current.version.content,
            text: "Third body",
            structure: undefined,
          }),
          fourth = await docs.retainDocument(url, {
            ...current.version.content,
            text: "Fourth body",
            structure: undefined,
          });
        const selected = formats.versionContent(third.version),
          concurrent = formats.versionContent(fourth.version);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("articles", "readwrite");
          tx.objectStore("articles").put({
            ...snapshot,
            bodyUpdate: {
              ...snapshot.bodyUpdate,
              latest: concurrent.document,
              checkedAt: now + (newerCheck ? 10000 : 1000),
            },
          });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        await api.updateArticleContent(
          db,
          snapshot,
          { content: selected },
          false,
          undefined,
          false,
          "replace",
          now + 5000,
        );
        const after = await api.readArticle(db, "a");
        db.close();
        return {
          after,
          selected: selected.document,
          concurrent: concurrent.document,
        };
      },
      { newerCheck, url },
    );
    expect(result.after.content.text).toBe("Third body");
    expect(result.after.bodyUpdate.latest).toEqual(
      newerCheck ? result.concurrent : result.selected,
    );
  });
