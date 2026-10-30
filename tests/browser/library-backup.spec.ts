import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

async function fixture(page: Page, design = "studio") {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  }, design);
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__backup", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Reader backup</title>",
    }),
  );
  await page.goto("/__backup");
  await page.evaluate(async () => {
    const libraryPath = "/src/feed-store.ts",
      highlightPath = "/src/article-highlights.ts";
    const { openFeedLibrary } = await import(libraryPath);
    const { writeHighlight, highlightVersion } = await import(highlightPath);
    const db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ["a", "b"])
        tx.objectStore("articles").put({
          id,
          title: `Quote article ${id}`,
          url: `https://example.org/${id}`,
          feedUrl: "",
          published: null,
          fetchedAt: "2026-10-30T00:00:00Z",
          body: `Evidence ${id}. Another point.`,
          sourceTags: ["RSS category"],
          read: true,
          saved: id === "a",
          content: {
            text: `Evidence ${id}. Another point.`,
            title: `Quote article ${id}`,
            url: `https://example.org/${id}`,
            language: "en",
            sourceTags: ["Original category"],
            fetchedAt: "2026-10-30T00:00:00Z",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    for (const [index, id] of ["a", "b", "a"].entries()) {
      const text = `Evidence ${id}. Another point.`;
      const start = index === 2 ? 12 : 0,
        quote = index === 2 ? "Another point." : `Evidence ${id}.`;
      await writeHighlight(
        {
          id: `00000000-0000-4000-8000-00000000000${index}`,
          articleId: id,
          title: `Quote article ${id}`,
          url: `https://example.org/${id}`,
          view: "original",
          language: "en",
          version: await highlightVersion(text, text, "original", "en"),
          start,
          end: start + quote.length,
          quote,
          note: `メモ ${index}`,
          createdAt: "2026-10-30T00:00:00Z",
          revision: 1,
        },
        null,
      );
    }
  });
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Quote article a", exact: true })
    .click();
}
const panel = (page: Page) =>
  page.getByRole("region", {
    name: "記事ライブラリのバックアップ",
    exact: true,
  });
async function settings(page: Page) {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await panel(page).locator("summary").click();
}
async function enrich(page: Page) {
  await page.evaluate(async () => {
    const libraryPath = "/src/feed-store.ts",
      hPath = "/src/article-highlights.ts",
      cPath = "/src/article-connections.ts",
      qPath = "/src/quote-connections.ts",
      lPath = "/src/article-learning.ts";
    const library = await import(libraryPath),
      h = await import(hPath),
      c = await import(cPath),
      q = await import(qPath),
      l = await import(lPath);
    const db = await library.openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["feeds", "articles"], "readwrite");
      tx.objectStore("feeds").put({
        url: "https://example.org/feed",
        title: "Archive feed",
        fetchedAt: "2026-10-30T00:00:00Z",
      });
      const store = tx.objectStore("articles"),
        get = store.get("a");
      get.onsuccess = () =>
        store.put({
          ...get.result,
          manualTags: ["学習", "TypeScript"],
          contentError: undefined,
          translation: {
            text: "根拠 A。 別の要点。",
            sourceText: get.result.content.text,
            sourceLanguage: "en",
            targetLanguage: "ja",
          },
        });
      const text = 'const value = "🦆";\n  console.log(value);\n';
      store.put({
        id: "\uffff\uffff",
        feedUrl: "https://example.org/feed",
        title: "Unicode code",
        url: "https://example.org/code",
        published: null,
        body: text,
        fetchedAt: "2026-10-30T00:00:00Z",
        read: false,
        saved: true,
        content: {
          text,
          url: "https://example.org/code",
          title: "Unicode code",
          language: "en",
          fetchedAt: "2026-10-30T00:00:00Z",
          codeRanges: [{ start: 0, end: text.length, block: true }],
        },
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const a = (await h.readHighlights("a"))[0],
      b = (await h.readHighlights("b"))[0];
    await c.writeConnection(
      {
        id: c.connectionKey("a", "b"),
        members: ["a", "b"],
        from: { id: "a", title: "Quote article a", url: a.url },
        to: { id: "b", title: "Quote article b", url: b.url },
        state: "hidden",
        reason: "",
        createdAt: a.createdAt,
        revision: 1,
      },
      null,
    );
    const members = [a.id, b.id].sort();
    await q.writeQuoteConnection(
      {
        id: c.connectionKey(a.id, b.id),
        members,
        articles: ["a", "b"],
        from: a,
        to: b,
        reason: "引用のつながり",
        createdAt: a.createdAt,
        revision: 1,
      },
      null,
    );
    await l.writeLearning(
      {
        id: crypto.randomUUID(),
        articleId: "a",
        source: a,
        reflection: "引用から学んだこと",
        createdAt: a.createdAt,
        revision: 1,
      },
      null,
    );
    localStorage.setItem(
      "never-export-secret",
      "synthetic-secret-not-for-backup",
    );
  });
}
async function archive(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/library-backup.ts";
    const { blob, counts } = await (await import(path)).exportLibrary();
    return {
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      counts,
      text: await new Response(
        blob.stream().pipeThrough(new DecompressionStream("gzip")),
      ).text(),
    };
  });
}
async function emptyPage(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("quilna.feed.refresh.v1", "0"),
  );
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.goto("/?view=feeds");
}
async function selectBackup(
  page: Page,
  bytes: number[] | Uint8Array,
  name = "fixture.quilna.gz",
) {
  const path = test.info().outputPath(name);
  await writeFile(path, new Uint8Array(bytes));
  await page.getByLabel("復元するQuilnaバックアップ").setInputFiles(path);
}
async function upload(page: Page, bytes: number[] | Uint8Array) {
  await selectBackup(page, bytes);
  await panel(page)
    .getByRole("button", { name: "選んだファイルを検証" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "検証が完了しました",
  );
}
for (const design of ["studio", "editorial", "focus"])
  test(`${design} downloads the full reader library and restores it into a fresh browser`, async ({
    page,
    browser,
  }, info) => {
    await fixture(page, design);
    await enrich(page);
    await settings(page);
    await panel(page)
      .getByRole("button", { name: "バックアップを作成" })
      .click();
    await expect(panel(page).getByRole("status")).toContainText(
      "ファイルを作成しました",
    );
    const downloadEvent = page.waitForEvent("download");
    await panel(page)
      .getByRole("link", { name: "作成したバックアップをダウンロード" })
      .click();
    const download = await downloadEvent,
      file = await download.path();
    expect(file).not.toBeNull();
    const bytes = await readFile(file!);
    const original = await archive(page);
    expect(original.text).not.toContain("synthetic-secret-not-for-backup");
    expect(original.counts).toEqual({
      documents: 0,
      documentVersions: 0,
      feeds: 1,
      articles: 3,
      highlights: 3,
      connections: 1,
      quoteConnections: 1,
      learning: 1,
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const destination = await context.newPage();
    await destination.addInitScript(
      (design) => localStorage.setItem("quilna.reader.design.v1", design),
      design,
    );
    await destination.goto(page.url().split("?")[0]);
    await emptyPage(destination);
    await settings(destination);
    await upload(destination, bytes);
    // Validation alone never changes the library.
    expect((await archive(destination)).counts.articles).toBe(0);
    await panel(destination)
      .getByRole("button", { name: "不足している記録を復元" })
      .click();
    await expect(panel(destination).getByRole("status")).toContainText(
      "追加 10件",
    );
    const restored = await archive(destination);
    const entries = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x))
        .filter((x) => x.type === "entry")
        .sort((a, b) =>
          JSON.stringify([a.kind, a.key]).localeCompare(
            JSON.stringify([b.kind, b.key]),
          ),
        );
    expect(entries(restored.text)).toEqual(entries(original.text));
    await panel(destination)
      .getByRole("button", { name: "不足している記録を復元" })
      .click();
    await expect(panel(destination).getByRole("status")).toContainText(
      "追加 0件 / 同じ記録 10件",
    );
    await destination.setViewportSize({ width: 320, height: 800 });
    expect(
      await destination.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const dialog = destination.locator("dialog.rss-settings");
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await panel(destination)
      .getByRole("button", { name: "不足している記録を復元" })
      .focus();
    await destination.screenshot({ path: info.outputPath("backup.png") });
    await destination
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    await destination
      .getByRole("button", { name: "Quote article a", exact: true })
      .click();
    await destination.locator("#rss-learning-records summary").click();
    await expect(destination.locator("#rss-learning-records")).toContainText(
      "引用から学んだこと",
    );
    await context.close();
  });

async function compressed(page: Page, text: string) {
  return page.evaluate(
    async (text) =>
      Array.from(
        new Uint8Array(
          await new Response(
            new Blob([text])
              .stream()
              .pipeThrough(new CompressionStream("gzip")),
          ).arrayBuffer(),
        ),
      ),
    text,
  );
}
test("existing edits, read/save flags and annotations win over a conflicting backup", async ({
  page,
}) => {
  await fixture(page);
  await enrich(page);
  const original = await archive(page);
  await page.evaluate(async () => {
    const libPath = "/src/feed-store.ts",
      hPath = "/src/article-highlights.ts",
      lPath = "/src/article-learning.ts";
    const lib = await import(libPath),
      db = await lib.openFeedLibrary();
    await lib.flagArticle(db, "a", "read", false);
    await lib.flagArticle(db, "a", "saved", false);
    const h = await import(hPath),
      quote = (await h.readHighlights("a"))[0];
    await h.writeHighlight(
      { ...quote, note: "今のメモ", revision: quote.revision + 1 },
      quote.revision,
    );
    const l = await import(lPath),
      record = (await l.readLearning("a"))[0];
    await l.writeLearning(
      { ...record, reflection: "今の学び", revision: record.revision + 1 },
      record.revision,
    );
  });
  await settings(page);
  await upload(page, original.bytes);
  await panel(page)
    .getByRole("button", { name: "不足している記録を復元" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "追加 0件 / 同じ記録 7件 / 内容が異なる既存記録 3件",
  );
  const after = (await archive(page)).text
    .split("\n")
    .filter(Boolean)
    .map((x) => JSON.parse(x));
  const a = after.find((x) => x.kind === "articles" && x.key === "a").value;
  expect([a.read, a.saved]).toEqual([false, false]);
  expect(
    after.find(
      (x) => x.kind === "highlights" && x.value.quote === "Evidence a.",
    ).value.note,
  ).toBe("今のメモ");
  expect(after.find((x) => x.kind === "learning").value.reflection).toBe(
    "今の学び",
  );
});

test("invalid, duplicate, truncated, oversized and future archives never change library data", async ({
  page,
}) => {
  await fixture(page);
  await enrich(page);
  const original = await archive(page),
    lines = original.text
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
  const cases = [
    lines.slice(0, -1),
    [
      { ...lines[0], header: { ...lines[0].header, version: 99 } },
      ...lines.slice(1),
    ],
    [
      lines[0],
      { type: "entry", kind: "articles", key: "bad", value: { id: "bad" } },
      ...lines.slice(1),
    ],
    [
      ...lines.slice(0, -1),
      lines[1],
      { ...lines.at(-1), counts: { ...lines.at(-1).counts, feeds: 2 } },
    ],
    [
      ...lines.slice(0, -1),
      { ...lines.at(-1), counts: { ...lines.at(-1).counts, articles: 999 } },
    ],
    [
      lines[0],
      {
        ...lines[1],
        value: { ...lines[1].value, extra: "x".repeat(8 * 1024 * 1024) },
      },
      ...lines.slice(2),
    ],
  ];
  for (const data of cases) {
    const bytes = await compressed(
      page,
      data.map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
    const failure = await page.evaluate(async (bytes) => {
      const path = "/src/library-backup.ts";
      try {
        await (
          await import(path)
        ).validateBackup(new File([new Uint8Array(bytes)], "bad.quilna.gz"));
        return "unexpected success";
      } catch (error) {
        return (error as Error).message;
      }
    }, bytes);
    expect(failure).toContain("検証できませんでした");
    const after = await archive(page);
    expect(after.text.split("\n").slice(1)).toEqual(
      original.text.split("\n").slice(1),
    );
  }
  const corrupt = original.bytes.slice(0, -5);
  expect(
    await page.evaluate(async (bytes) => {
      const path = "/src/library-backup.ts";
      try {
        await (
          await import(path)
        ).validateBackup(
          new File([new Uint8Array(bytes)], "truncated.quilna.gz"),
        );
        return false;
      } catch {
        return true;
      }
    }, corrupt),
  ).toBe(true);
});

test("validation quota failure keeps the library and permits retry of the selected file", async ({
  page,
}) => {
  await fixture(page);
  const original = await archive(page);
  await settings(page);
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (this.transaction.db.name === "quilna.backup-stage.v1")
        throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args);
    };
    Object.assign(window, {
      restoreBackupAdd: () => {
        IDBObjectStore.prototype.add = add;
      },
    });
  });
  await selectBackup(page, original.bytes, "fixture.quilna.gz");
  await panel(page)
    .getByRole("button", { name: "選んだファイルを検証" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "検証できませんでした",
  );
  await expect(
    panel(page).getByRole("button", { name: "不足している記録を復元" }),
  ).toBeDisabled();
  expect((await archive(page)).text.split("\n").slice(1)).toEqual(
    original.text.split("\n").slice(1),
  );
  await page.evaluate(() =>
    (window as unknown as { restoreBackupAdd: () => void }).restoreBackupAdd(),
  );
  await panel(page)
    .getByRole("button", { name: "選んだファイルを検証" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "検証が完了しました",
  );
});

test("partial restoration survives reload and retries without duplicates", async ({
  page,
}) => {
  await fixture(page);
  await settings(page);
  const entries = Array.from({ length: 201 }, (_, i) => {
    const id = `bulk-${String(i).padStart(3, "0")}`;
    return {
      type: "entry",
      kind: "articles",
      key: id,
      value: {
        id,
        title: id,
        url: "https://example.org/" + id,
        feedUrl: "",
        published: null,
        body: "Archive article",
        read: true,
        saved: true,
        fetchedAt: "2026-10-30T00:00:00Z",
      },
    };
  });
  const lines = [
    {
      type: "header",
      header: {
        format: "quilna-reader-library",
        version: 1,
        createdAt: "2026-10-30T00:00:00Z",
      },
    },
    ...entries,
    {
      type: "footer",
      counts: {
        feeds: 0,
        articles: 201,
        highlights: 0,
        connections: 0,
        quoteConnections: 0,
        learning: 0,
      },
    },
  ];
  await upload(
    page,
    await compressed(
      page,
      lines.map((x) => JSON.stringify(x)).join("\n") + "\n",
    ),
  );
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      if (
        this.transaction.db.name === "tsumiki.rss.v1" &&
        args[0].id === "bulk-100"
      )
        throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args);
    };
  });
  await panel(page)
    .getByRole("button", { name: "不足している記録を復元" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "今回100件を追加済み",
  );
  expect((await archive(page)).counts.articles).toBe(102);
  await page.reload();
  await settings(page);
  await expect(panel(page)).toContainText("検証済み：fixture.quilna.gz");
  await panel(page)
    .getByRole("button", { name: "不足している記録を復元" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "追加 101件 / 同じ記録 100件",
  );
  expect((await archive(page)).counts.articles).toBe(203);
});

test("another backup tab is excluded and a replaced preview cannot be restored", async ({
  page,
}) => {
  await fixture(page);
  const original = await archive(page);
  await settings(page);
  await upload(page, original.bytes);
  await page.evaluate(() => {
    void navigator.locks.request(
      "quilna.reader-backup.v1",
      () =>
        new Promise<void>((resolve) =>
          Object.assign(window, {
            backupLocked: true,
            releaseBackupLock: resolve,
          }),
        ),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { backupLocked?: boolean }).backupLocked,
      ),
    )
    .toBe(true);
  await panel(page).getByRole("button", { name: "バックアップを作成" }).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "別の画面でバックアップ",
  );
  await page.evaluate(() =>
    (
      window as unknown as { releaseBackupLock: () => void }
    ).releaseBackupLock(),
  );
  const other = await page.context().newPage();
  await emptyPage(other);
  await other.evaluate(async (bytes) => {
    const path = "/src/library-backup.ts";
    await (
      await import(path)
    ).validateBackup(
      new File([new Uint8Array(bytes)], "replacement.quilna.gz"),
    );
  }, original.bytes);
  await panel(page)
    .getByRole("button", { name: "不足している記録を復元" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "検証済みファイルが変わりました",
  );
  await panel(page)
    .getByRole("button", { name: "検証済みファイルを再確認" })
    .click();
  await expect(panel(page)).toContainText("replacement.quilna.gz");
  await other.close();
});

test("discard removes staging only, and a late preview cannot enable a newly selected file", async ({
  page,
}) => {
  await fixture(page);
  const original = await archive(page);
  await settings(page);
  await upload(page, original.bytes);
  await page.evaluate(() => {
    const dispatch = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<typeof dispatch>
    ) {
      const tx = dispatch.apply(this, args);
      if (this.name === "quilna.backup-stage.v1" && args[0] === "meta") {
        tx.addEventListener("complete", (event) => {
          event.stopImmediatePropagation();
          Object.assign(window, {
            releaseBackupPreview: () => tx.oncomplete?.call(tx, event),
          });
        });
      }
      return tx;
    };
  });
  await panel(page)
    .getByRole("button", { name: "検証済みファイルを再確認" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { releaseBackupPreview?: unknown })
            .releaseBackupPreview,
      ),
    )
    .toBe("function");
  await selectBackup(page, original.bytes, "new.quilna.gz");
  await page.evaluate(() =>
    (
      window as unknown as { releaseBackupPreview: () => void }
    ).releaseBackupPreview(),
  );
  await expect(
    panel(page).getByRole("button", { name: "不足している記録を復元" }),
  ).toBeDisabled();
  await page.reload();
  await settings(page);
  await expect(panel(page)).toContainText("検証済み：fixture.quilna.gz");
  page.once("dialog", (dialog) => dialog.dismiss());
  await panel(page)
    .getByRole("button", { name: "検証用の一時ファイルを破棄" })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "不足している記録を復元" }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await panel(page)
    .getByRole("button", { name: "検証用の一時ファイルを破棄" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText(
    "一時ファイルを破棄しました",
  );
  await expect(
    panel(page).getByRole("button", { name: "不足している記録を復元" }),
  ).toBeDisabled();
  expect((await archive(page)).text.split("\n").slice(1)).toEqual(
    original.text.split("\n").slice(1),
  );
  expect(
    await page.evaluate(async () => {
      const path = "/src/library-backup.ts";
      return (await import(path)).pendingBackup();
    }),
  ).toBeUndefined();
});

test("future destination schema refuses before any article writes", async ({
  page,
}) => {
  await fixture(page);
  const original = await archive(page);
  const result = await page.evaluate(async (bytes) => {
    const path = "/src/library-backup.ts",
      learningPath = "/src/article-learning.ts",
      feedPath = "/src/feed-store.ts";
    const backup = await import(path),
      learning = await import(learningPath),
      feeds = await import(feedPath);
    const preview = await backup.validateBackup(
      new File([new Uint8Array(bytes)], "fixture.quilna.gz"),
    );
    await learning.openLearning();
    const future = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(learning.learningDatabase, 99);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    future.close();
    const db = await feeds.openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    let message = "";
    try {
      await backup.restoreBackup(preview.id);
    } catch (error) {
      message = (error as Error).message;
    }
    const count = await new Promise<number>((resolve) => {
      const get = db.transaction("articles").objectStore("articles").count();
      get.onsuccess = () => resolve(get.result);
    });
    db.close();
    return { message, count };
  }, original.bytes);
  expect(result.message).toContain("今回0件を追加済み");
  expect(result.count).toBe(0);
});

test("cancelled validation clears incomplete staging and keeps the library", async ({
  page,
}) => {
  await fixture(page);
  const original = await archive(page);
  const result = await page.evaluate(async (bytes) => {
    const path = "/src/library-backup.ts";
    const backup = await import(path),
      controller = new AbortController();
    controller.abort();
    let message = "";
    try {
      await backup.validateBackup(
        new File([new Uint8Array(bytes)], "cancelled.quilna.gz"),
        undefined,
        controller.signal,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    return { message, preview: await backup.pendingBackup() };
  }, original.bytes);
  expect(result.message).toContain("処理を中止しました");
  expect(result.preview).toBeUndefined();
  expect((await archive(page)).text.split("\n").slice(1)).toEqual(
    original.text.split("\n").slice(1),
  );
});

test("destination capacity includes existing records and failed exports provide no download", async ({
  page,
}) => {
  await fixture(page);
  await enrich(page);
  const original = await archive(page);
  await settings(page);
  await upload(page, original.bytes);
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const db = await (await import(path)).openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("feeds", "readwrite"),
        store = tx.objectStore("feeds");
      store.clear();
      for (let i = 0; i < 50; i++)
        store.add({
          url: `https://example.org/existing-${i}`,
          title: `Feed ${i}`,
          fetchedAt: "2026-10-30T00:00:00Z",
        });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  const before = await archive(page);
  await panel(page)
    .getByRole("button", { name: "不足している記録を復元" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "上限に達しました",
  );
  await expect(panel(page).getByRole("status")).toContainText(
    "今回0件を追加済み",
  );
  expect((await archive(page)).text.split("\n").slice(1)).toEqual(
    before.text.split("\n").slice(1),
  );
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (
      ...args: Parameters<typeof get>
    ) {
      if (this.transaction.db.name === "tsumiki.rss.v1")
        throw new DOMException("unavailable", "UnknownError");
      return get.apply(this, args);
    };
  });
  await panel(page).getByRole("button", { name: "バックアップを作成" }).click();
  await expect(panel(page).getByRole("status")).not.toContainText(
    "ファイルを作成しました",
  );
  await expect(
    panel(page).getByRole("button", { name: "バックアップを作成" }),
  ).toBeEnabled();
  await expect(
    panel(page).getByRole("link", {
      name: "作成したバックアップをダウンロード",
    }),
  ).toBeHidden();
});
