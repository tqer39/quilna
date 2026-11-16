import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openReaderTools } from "./reader-tools";
import type { TextbookLink } from "../../src/article-textbooks";

const raw = new TextDecoder().decode(
  await readFile("tests/fixtures/shared-textbook-v2.json"),
);
const bookId = "dc74d775-eab8-4384-81ae-d741162c0d49:7";
const panel = (page: Page) =>
  page.getByRole("region", { name: "深掘りできる教材", exact: true });
async function seed(page: Page, context: BrowserContext, design = "studio") {
  await context.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.feed.refresh.v1", "0");
    localStorage.setItem("quilna.article.updates.v1", "false");
  }, design);
  await context.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await context.route("**/api/feeds/fetch", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__textbooks", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Textbook fixture</title>",
    }),
  );
  await page.goto("/__textbooks");
  await page.evaluate(async (raw) => {
    const feedPath = "/src/feed-store.ts",
      booksPath = "/src/shared-textbook-store.ts";
    await (await import(booksPath)).importSharedTextbook(raw);
    const db = await (await import(feedPath)).openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ["a", "b"]) {
        const text =
          `Article ${id} discusses separating model output from stored results. `.repeat(
            60,
          );
        tx.objectStore("articles").put({
          id,
          title: `教材記事 ${id}`,
          url: `https://example.org/${id}`,
          feedUrl: "",
          published: null,
          fetchedAt: "2026-11-17T00:00:00Z",
          body: text,
          read: true,
          saved: true,
          content: {
            text,
            title: `教材記事 ${id}`,
            url: `https://example.org/${id}`,
            language: "en",
            fetchedAt: "2026-11-17T00:00:00Z",
            codeRanges: [],
          },
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, raw);
  await page.goto("/?view=feeds");
  await openArticle(page, "a");
}
async function openArticle(page: Page, id: string) {
  if (new URL(page.url()).searchParams.has("article")) {
    await page
      .getByRole("button", { name: /記事一覧へ$/ })
      .first()
      .click();
  }
  await page
    .getByRole("button", { name: `教材記事 ${id}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `教材記事 ${id}`, exact: true }),
  ).toBeVisible();
  await openReaderTools(page);
  await panel(page).locator(":scope > details > summary").click();
  await expect(
    panel(page).getByRole("button", { name: "教材を関連づける", exact: true }),
  ).toBeVisible();
}
async function records(page: Page, id = "a"): Promise<TextbookLink[]> {
  return page.evaluate(async (id) => {
    const path = "/src/article-textbooks.ts";
    return (await import(path)).readTextbookLinks(id);
  }, id);
}
async function begin(page: Page) {
  await panel(page)
    .getByRole("button", { name: "教材を関連づける", exact: true })
    .click();
  await panel(page)
    .getByLabel("保存済みのテーマ教材", { exact: true })
    .selectOption(bookId);
  await expect(
    panel(page).getByText(
      /表示中の本文・言語・原文／訳文と、下書きの参照元が異なります/,
    ),
  ).toBeHidden();
}
async function save(page: Page, reason: string) {
  await panel(page)
    .getByLabel("この記事と関連する理由（必須）", { exact: true })
    .fill(reason);
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(
    panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
  ).toContainText(reason);
  await expect(
    panel(page).getByRole("button", {
      name: "関連する理由を編集",
      exact: true,
    }),
  ).toBeEnabled();
}

for (const design of ["studio", "editorial", "focus"]) {
  test(`${design}: 二つの記事から同じ教材版を別タブで読み、元の記事の位置・回答・私的な関連理由を保つ`, async ({
    page,
    context,
  }) => {
    const unexpected: string[] = [];
    context.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (
        path.startsWith("/api/textbooks/") ||
        (path === "/api/feeds/fetch" && !r.postDataJSON()?.icon)
      )
        unexpected.push(path);
    });
    await seed(page, context, design);
    await begin(page);
    await save(
      page,
      "記事aの処理結果を確認する観点を深掘りする PRIVATE_REASON",
    );
    await openArticle(page, "b");
    await begin(page);
    await save(page, "記事bでも同じ基礎知識を使う");
    const a = await records(page, "a"),
      b = await records(page, "b");
    expect(a[0].target).toEqual(b[0].target);
    expect(a[0].source.articleId).toBe("a");
    expect(b[0].source.articleId).toBe("b");
    const read = panel(page).getByRole("link", {
      name: "教材を読む（別タブ）",
      exact: true,
    });
    expect(
      new URL((await read.getAttribute("href"))!).searchParams.has("article"),
    ).toBe(false);
    await read.scrollIntoViewIfNeeded();
    await read.focus();
    const scroll = await page.evaluate(() => scrollY),
      origin = page.url();
    const opened = context.waitForEvent("page");
    await page.keyboard.press("Enter");
    const book = await opened;
    await expect(book).toHaveURL(
      new RegExp(`book=${encodeURIComponent(bookId)}`),
    );
    await expect(
      book.getByRole("navigation", { name: "教材の目次" }),
    ).toBeVisible();
    expect(await book.evaluate(() => document.referrer)).toBe("");
    const question = book
      .getByRole("group", {
        name: "モデルの文章だけで確認できるのは？",
        exact: true,
      })
      .first();
    await question.getByLabel("文章が出力された", { exact: true }).check();
    await question
      .getByRole("button", { name: "回答して保存", exact: true })
      .click();
    await expect(
      book.getByText("正答です。回答を保存しました。", { exact: true }),
    ).toBeVisible();
    await book.getByText("教材ファイルを書き出す", { exact: true }).click();
    await book
      .getByLabel("出典と引用を確認し、この教材ファイルを書き出す", {
        exact: true,
      })
      .check();
    const download = book.waitForEvent("download");
    await book
      .getByRole("button", { name: "教材ファイルをダウンロード", exact: true })
      .click();
    const path = await (await download).path();
    expect(new TextDecoder().decode(await readFile(path!))).toBe(raw);
    await book.close();
    await expect(page).toHaveURL(origin);
    await expect(read).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await page.screenshot({
      path: test.info().outputPath("article-topic-textbooks.png"),
      fullPage: true,
    });
    await panel(page)
      .getByRole("button", { name: "この記事との関連づけを外す", exact: true })
      .click();
    await expect(panel(page).getByRole("list")).toContainText("まだありません");
    expect(await records(page, "a")).toHaveLength(1);
    expect(await records(page, "b")).toHaveLength(0);
    const retained = await page.evaluate(async (id) => {
      const path = "/src/shared-textbook-store.ts",
        api = await import(path),
        book = await api.readSharedTextbook(id);
      return {
        raw: book.raw,
        answers: (await api.readSharedAnswers(book)).length,
      };
    }, bookId);
    expect(retained).toEqual({ raw, answers: 1 });
    expect(unexpected).toEqual([]);
  });
}

test("保存失敗と版競合で下書きを保ち、明示的な確認で編集を続ける", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    const state = window as unknown as { failTextbookLink: boolean };
    state.failTextbookLink = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (
        this.transaction.db.name === "quilna.article-textbooks.v1" &&
        state.failTextbookLink
      )
        throw new DOMException("fixture", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  const input = panel(page).getByLabel("この記事と関連する理由（必須）", {
    exact: true,
  });
  await input.fill("保存失敗でも保持する理由");
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存済みの記録は保持しています",
  );
  await expect(input).toHaveValue("保存失敗でも保持する理由");
  expect(await records(page)).toHaveLength(0);
  await page.evaluate(() => {
    (window as unknown as { failTextbookLink: boolean }).failTextbookLink =
      false;
  });
  await save(page, "保存失敗でも保持する理由");
  await panel(page)
    .getByRole("button", { name: "関連する理由を編集", exact: true })
    .click();
  await input.fill("自分の下書き");
  await page.evaluate(async () => {
    const path = "/src/article-textbooks.ts",
      api = await import(path),
      [record] = await api.readTextbookLinks("a");
    await api.writeTextbookLink(
      {
        ...record,
        reason: "別画面の最新の理由",
        revision: record.revision + 1,
      },
      record.revision,
    );
  });
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("別の画面");
  await expect(input).toHaveValue("自分の下書き");
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み", exact: true })
    .click();
  await expect(panel(page).getByRole("list")).toContainText(
    "別画面の最新の理由",
  );
  await panel(page)
    .getByRole("button", {
      name: "最新の理由を確認して下書きの編集を続ける",
      exact: true,
    })
    .click();
  await save(page, "自分の下書き");
  expect((await records(page))[0].revision).toBe(3);
});

test("関連づけをバックアップで復元し、既存の理由を上書きせず古い形式も読み込める", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "バックアップする私的な理由");
  const result = await page.evaluate(async () => {
    const linkPath = "/src/article-textbooks.ts",
      backupPath = "/src/library-backup.ts";
    const links = await import(linkPath),
      backup = await import(backupPath);
    const [original] = await links.readTextbookLinks("a");
    const exported = await backup.exportLibrary();
    const text = await new Response(
      exported.blob.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    const preview = await backup.validateBackup(
      new File([exported.blob], "fixture.quilna.gz"),
    );
    await links.writeTextbookLink(
      { ...original, reason: "復元より新しい理由", revision: 2 },
      1,
    );
    const conflict = await backup.restoreBackup(preview.id);
    const [kept] = await links.readTextbookLinks("a");
    await links.writeTextbookLink(kept, kept.revision, true);
    const restored = await backup.restoreBackup(preview.id);
    const [after] = await links.readTextbookLinks("a");
    const legacy = [];
    for (const version of [1, 2]) {
      const counts: Record<string, number> = {
        feeds: 0,
        articles: 0,
        highlights: 0,
        connections: 0,
        quoteConnections: 0,
        learning: 0,
      };
      if (version === 2)
        Object.assign(counts, { documents: 0, documentVersions: 0 });
      const raw =
        [
          JSON.stringify({
            type: "header",
            header: {
              format: "quilna-reader-library",
              version,
              createdAt: new Date().toISOString(),
            },
          }),
          JSON.stringify({ type: "footer", counts }),
        ].join("\n") + "\n";
      const blob = await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      const p = await backup.validateBackup(
        new File([blob], "legacy.quilna.gz"),
      );
      legacy.push(await backup.restoreBackup(p.id));
    }
    return {
      version: exported.header.version,
      count: exported.counts.textbookLinks,
      included: text.includes(original.reason),
      conflict,
      kept: kept.reason,
      restored,
      after,
      original,
      legacy,
    };
  });
  expect(result.version).toBe(3);
  expect(result.count).toBe(1);
  expect(result.included).toBe(true);
  expect(result.conflict.conflicts).toBe(1);
  expect(result.kept).toBe("復元より新しい理由");
  expect(result.restored.added).toBe(1);
  expect(result.after).toEqual(result.original);
  expect(result.legacy).toEqual([
    { added: 0, identical: 0, conflicts: 0 },
    { added: 0, identical: 0, conflicts: 0 },
  ]);
});

test("記事を切り替えても未保存の理由を保持し、本文更新で参照元を移さない", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  const input = panel(page).getByLabel("この記事と関連する理由（必須）", {
    exact: true,
  });
  await input.fill("記事aの保存前の理由");
  await openArticle(page, "b");
  await openArticle(page, "a");
  await expect(input).toHaveValue("記事aの保存前の理由");
  await save(page, "記事aの保存前の理由");
  const before = (await records(page))[0];
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts",
      db = await (await import(path)).openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles"),
        get = store.get("a");
      get.onsuccess = () => {
        const article = get.result;
        article.content.text = "変更後の本文";
        store.put(article);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "教材記事 a", exact: true }),
  ).toBeVisible();
  await openReaderTools(page);
  await panel(page).locator(":scope > details > summary").click();
  await expect(panel(page).getByRole("list")).toContainText(
    "登録時と表示中の本文・言語・原文／訳文が異なります",
  );
  expect((await records(page))[0]).toEqual(before);
});

test("未知の保存形式を消さず拒否し、保存済みの関連づけを保持する", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "将来形式でも残す理由");
  const original = (await records(page))[0];
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("quilna.article-textbooks.v1", 9);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("future").put("将来の記録", "keep");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存形式を確認できません",
  );
  await expect(
    panel(page).getByRole("button", { name: "教材を関連づける", exact: true }),
  ).toBeDisabled();
  const retained = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("quilna.article-textbooks.v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const result = await new Promise<{ link: unknown; future: unknown }>(
      (resolve, reject) => {
        const tx = db.transaction(["links", "future"]),
          link = tx.objectStore("links").get(id),
          future = tx.objectStore("future").get("keep");
        tx.oncomplete = () =>
          resolve({ link: link.result, future: future.result });
        tx.onerror = () => reject(tx.error);
      },
    );
    db.close();
    return result;
  }, original.id);
  expect(retained).toEqual({ link: original, future: "将来の記録" });
});

test("別画面による削除と先行作成の後も、理由を保持して明示的に保存を続けられる", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "最初の理由");
  await panel(page)
    .getByRole("button", { name: "関連する理由を編集", exact: true })
    .click();
  const input = panel(page).getByLabel("この記事と関連する理由（必須）", {
    exact: true,
  });
  await input.fill("削除後も残す下書き");
  await page.evaluate(async () => {
    const path = "/src/article-textbooks.ts",
      api = await import(path),
      [record] = await api.readTextbookLinks("a");
    await api.writeTextbookLink(record, record.revision, true);
  });
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("別の画面");
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み", exact: true })
    .click();
  await panel(page)
    .getByRole("button", {
      name: "最新の理由を確認して下書きの編集を続ける",
      exact: true,
    })
    .click();
  await expect(input).toHaveValue("削除後も残す下書き");
  await save(page, "削除後も残す下書き");
  const [original] = await records(page);
  await panel(page)
    .getByRole("button", { name: "この記事との関連づけを外す", exact: true })
    .click();
  await expect(panel(page).getByRole("list")).toContainText("まだありません");
  await begin(page);
  await input.fill("先行作成と競合した下書き");
  await page.evaluate(async (record) => {
    const path = "/src/article-textbooks.ts",
      api = await import(path);
    await api.writeTextbookLink(
      {
        ...record,
        reason: "別画面で先行作成",
        createdAt: "2026-11-17T00:00:01.000Z",
        revision: 1,
      },
      null,
    );
  }, original);
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("別の画面");
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み", exact: true })
    .click();
  await panel(page)
    .getByRole("button", {
      name: "最新の理由を確認して下書きの編集を続ける",
      exact: true,
    })
    .click();
  await save(page, "先行作成と競合した下書き");
  expect((await records(page))[0]).toMatchObject({
    reason: "先行作成と競合した下書き",
    createdAt: "2026-11-17T00:00:01.000Z",
    revision: 2,
  });
});

test("古い版への新記録の混入と版3の不完全な件数表を拒否し、教材がないリンクを正しく示す", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "復元する関連理由");
  const errors = await page.evaluate(async () => {
    const bp = "/src/library-backup.ts",
      backup = await import(bp),
      exported = await backup.exportLibrary();
    const raw = await new Response(
      exported.blob.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    const records = raw
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    const failures: boolean[] = [];
    for (const version of [1, 2, 3]) {
      const copy = structuredClone(records);
      copy[0].header.version = version;
      const counts = copy.at(-1).counts;
      delete counts.textbookLinks;
      if (version === 1) {
        delete counts.documents;
        delete counts.documentVersions;
      }
      const text = copy.map((x) => JSON.stringify(x)).join("\n") + "\n";
      const blob = await new Response(
        new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      try {
        await backup.validateBackup(new File([blob], "invalid.quilna.gz"));
        failures.push(false);
      } catch {
        failures.push(true);
      }
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("quilna.shared-textbooks.v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      tx.objectStore("books").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return failures;
  });
  expect(errors).toEqual([true, true, true]);
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み", exact: true })
    .click();
  await expect(panel(page).getByRole("list")).toContainText(
    "このライブラリで教材の版を確認できません",
  );
  expect(await records(page)).toHaveLength(1);
});

test("開いた教材欄は原文の言語切り替え直後に版の照合を更新する", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "表示を切り替えて照合する理由");
  const mismatch = panel(page).getByText(
    "登録時と表示中の本文・言語・原文／訳文が異なります。関連理由は登録時の表示内容に結び付いています。",
    { exact: true },
  );
  await expect(mismatch).toHaveCount(0);
  await page.getByLabel("原文の言語", { exact: true }).selectOption("fr");
  await expect(panel(page).locator(":scope > details")).toHaveAttribute(
    "open",
    "",
  );
  await expect(mismatch).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "関連する理由を編集", exact: true })
    .click();
  await expect(
    panel(page).getByText(/下書きを取り消してから、保存済みの関連づけを外して/),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", {
      name: "この記事との関連づけを外す",
      exact: true,
    }),
  ).toBeDisabled();
  await panel(page)
    .getByRole("button", { name: "関連づけの下書きを取り消す", exact: true })
    .click();
  await expect(
    panel(page).getByText(
      /表示中の本文・言語・原文／訳文と、下書きの参照元が異なります/,
    ),
  ).toBeHidden();
  await expect(
    panel(page).getByRole("button", {
      name: "この記事との関連づけを外す",
      exact: true,
    }),
  ).toBeEnabled();
  await page.getByLabel("原文の言語", { exact: true }).selectOption("en");
  await expect(mismatch).toHaveCount(0);
  await expect(panel(page).getByRole("list")).toContainText(
    "表示を切り替えて照合する理由",
  );
});

for (const layout of [
  "wrong-key",
  "wrong-index",
  "missing-store",
  "future-version",
  "extra-store",
  "extra-index",
  "auto-increment",
  "unique-index",
  "multi-index",
])
  test(`不明な既存DB構造(${layout})を拒否し保存内容を変えない`, async ({
    page,
    context,
  }) => {
    await seed(page, context);
    await begin(page);
    await save(page, "不明なDBへ書き込まない理由");
    const link = (await records(page))[0];
    await page.goto("/__textbooks");
    const previewId = await page.evaluate(async () => {
      const path = "/src/library-backup.ts",
        backup = await import(path),
        exported = await backup.exportLibrary();
      return (
        await backup.validateBackup(
          new File([exported.blob], "known.quilna.gz"),
        )
      ).id;
    });
    // 新しい文書で既知の接続を閉じ、不明なDBを開く処理そのものを検査する。
    await page.reload();
    const result = await page.evaluate(
      async ({ layout, link, previewId }) => {
        const path = "/src/article-textbooks.ts",
          links = await import(path),
          backupPath = "/src/library-backup.ts",
          backup = await import(backupPath),
          name = links.textbookLinkDatabase;
        await new Promise<void>((resolve, reject) => {
          const r = indexedDB.deleteDatabase(name);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
          r.onblocked = () => reject(Error("unexpected blocker"));
        });
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open(name, layout === "future-version" ? 2 : 1);
          r.onupgradeneeded = () => {
            const store = r.result.createObjectStore(
              layout === "missing-store" ? "unknown" : "links",
              {
                keyPath: layout === "wrong-key" ? "target.id" : "id",
                autoIncrement: layout === "auto-increment",
              },
            );
            store.createIndex(
              "articleId",
              layout === "wrong-index" ? "target.id" : "source.articleId",
              {
                unique: layout === "unique-index",
                multiEntry: layout === "multi-index",
              },
            );
            store.put(link);
            if (layout === "extra-index")
              store.createIndex("unexpected", "reason");
            if (layout === "extra-store")
              r.result
                .createObjectStore("unexpected", { keyPath: "id" })
                .put({ id: "foreign", value: "keep" });
          };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const snapshot = async () => ({
          version: db.version,
          stores: await Promise.all(
            Array.from(db.objectStoreNames).map((name) => {
              const store = db.transaction(name).objectStore(name);
              return new Promise((resolve) => {
                const r = store.getAll();
                r.onsuccess = () =>
                  resolve({
                    name,
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    indexes: Array.from(store.indexNames).map((name) => {
                      const i = store.index(name);
                      return {
                        name,
                        keyPath: i.keyPath,
                        unique: i.unique,
                        multiEntry: i.multiEntry,
                      };
                    }),
                    records: r.result,
                  });
              });
            }),
          ),
        });
        const before = await snapshot(),
          candidate = {
            ...link,
            id: links.textbookLinkKey("other-article", link.target.id),
            source: { ...link.source, articleId: "other-article" },
          };
        if (!links.validTextbookLink(candidate))
          throw Error("fixture link must be valid");
        const errors = [];
        for (const operation of [
          () => links.readTextbookLinks(link.source.articleId),
          () => links.writeTextbookLink(candidate, null),
          () => backup.exportLibrary(),
          () => backup.restoreBackup(previewId),
        ]) {
          try {
            await operation();
            errors.push(null);
          } catch (error) {
            errors.push(
              error instanceof Error ? error.message : "unexpected error",
            );
          }
        }
        const after = await snapshot();
        db.close();
        return { errors, before, after };
      },
      { layout, link, previewId },
    );
    const formatError =
      "教材との関連づけの保存形式を確認できません。記録は変更していません。対応するアプリの版を確認してください。";
    expect(result.errors).toEqual([
      formatError,
      formatError,
      formatError,
      `${formatError} 今回0件を追加済みです。既存の記録は上書きしていません。検証済みファイルから再試行できます。`,
    ]);
    expect(result.after).toEqual(result.before);
  });

test("教材の候補を待つ間に表示が変わっても下書きを保存できる", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    window.addEventListener(
      "focus",
      (event) => {
        if (event.target === window) event.stopImmediatePropagation();
      },
      true,
    );
  });
  await page.route("**/src/shared-textbook-store.ts*", async (route) => {
    const response = await route.fetch(),
      body = await response.text();
    const signature = "async function listSharedTextbooks() {";
    expect(body).toContain(signature);
    await route.fulfill({
      response,
      body: body.replace(
        signature,
        signature +
          " if(globalThis.__holdTextbookCandidates) globalThis.__candidateWaitEntered = true; await globalThis.__holdTextbookCandidates;",
      ),
    });
  });
  await seed(page, context);
  await page.evaluate(() => {
    let release;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(window, {
      __holdTextbookCandidates: pending,
      __releaseTextbookCandidates: release,
    });
  });
  try {
    await panel(page)
      .getByRole("button", { name: "教材を関連づける", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __candidateWaitEntered?: boolean })
          .__candidateWaitEntered === true,
    );
    await page.getByLabel("原文の言語", { exact: true }).selectOption("fr");
    await expect(
      panel(page).getByLabel("保存済みのテーマ教材", { exact: true }),
    ).toBeHidden();
  } finally {
    await page.evaluate(() => {
      const host = window as unknown as {
        __releaseTextbookCandidates?: () => void;
      };
      host.__releaseTextbookCandidates?.();
      delete host.__releaseTextbookCandidates;
    });
  }
  await panel(page)
    .getByLabel("保存済みのテーマ教材", { exact: true })
    .selectOption(bookId);
  await expect(
    panel(page).getByText(
      /表示中の本文・言語・原文／訳文と、下書きの参照元が異なります/,
    ),
  ).toBeVisible();
  const notice = panel(page).getByText(
    /表示中の本文・言語・原文／訳文と、下書きの参照元が異なります/,
  );
  await expect(
    panel(page).getByLabel("この記事と関連する理由（必須）", { exact: true }),
  ).toHaveAccessibleDescription(/下書きの参照元が異なります/);
  await page.getByLabel("原文の言語", { exact: true }).selectOption("en");
  await expect(notice).toBeHidden();
  await page.getByLabel("原文の言語", { exact: true }).selectOption("fr");
  await expect(notice).toBeVisible();
  await save(page, "候補待ち中の表示切り替えを保持する理由");
  await expect(notice).toBeHidden();
  expect((await records(page))[0].source.language).toBe("en");
});

for (const action of ["save", "remove"])
  test(`${action}: 処理待ち中の表示変更と失敗後も記録を保持して再試行できる`, async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      window.addEventListener(
        "focus",
        (event) => {
          if (event.target === window) event.stopImmediatePropagation();
        },
        true,
      );
    });
    await page.route("**/src/article-textbooks.ts*", async (route) => {
      const response = await route.fetch(),
        body = await response.text(),
        signature = /async function writeTextbookLink\([^)]*\)\s*\{/;
      expect(body).toMatch(signature);
      await route.fulfill({
        response,
        body: body.replace(
          signature,
          (match) =>
            match +
            ' if(globalThis.__holdLinkWrite) { globalThis.__linkWriteEntered = true; await globalThis.__holdLinkWrite; throw Error("制御した関連づけの書き込み失敗"); }',
        ),
      });
    });
    await seed(page, context);
    await begin(page);
    await save(page, "処理前の関連理由");
    const before = await records(page);
    if (action === "save") {
      await panel(page)
        .getByRole("button", { name: "関連する理由を編集", exact: true })
        .click();
      await panel(page)
        .getByLabel("この記事と関連する理由（必須）", { exact: true })
        .fill("失敗しても残す下書き");
    }
    await page.evaluate(() => {
      let release;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(window, {
        __holdLinkWrite: pending,
        __releaseLinkWrite: release,
      });
    });
    try {
      await panel(page)
        .getByRole("button", {
          name:
            action === "save"
              ? "関連する理由を保存"
              : "この記事との関連づけを外す",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () =>
          (window as unknown as { __linkWriteEntered?: boolean })
            .__linkWriteEntered === true,
      );
      await page.getByLabel("原文の言語", { exact: true }).selectOption("fr");
    } finally {
      await page.evaluate(() => {
        const host = window as unknown as {
          __releaseLinkWrite?: () => void;
          __holdLinkWrite?: Promise<void>;
        };
        host.__releaseLinkWrite?.();
        delete host.__holdLinkWrite;
        delete host.__releaseLinkWrite;
      });
    }
    await expect(panel(page).getByRole("status")).toContainText(
      "制御した関連づけの書き込み失敗",
    );
    expect(await records(page)).toEqual(before);
    if (action === "save") {
      await expect(
        panel(page).getByLabel("この記事と関連する理由（必須）", {
          exact: true,
        }),
      ).toHaveValue("失敗しても残す下書き");
      await save(page, "失敗後に再試行した関連理由");
    } else {
      await panel(page)
        .getByRole("button", {
          name: "この記事との関連づけを外す",
          exact: true,
        })
        .click();
      await expect.poll(() => records(page)).toEqual([]);
    }
  });

test("一時的な接続失敗を保存形式の非互換と混同せず、接続を開き直せる", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "接続を開き直して保持する理由");
  const before = await records(page);
  await page.goto("/__textbooks");
  const result = await page.evaluate(async () => {
    const path = "/src/article-textbooks.ts",
      links = await import(path),
      transaction = IDBDatabase.prototype.transaction;
    let message = "";
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (this.name === links.textbookLinkDatabase && args[0] === "links")
        throw new DOMException(
          "controlled closed connection",
          "InvalidStateError",
        );
      return transaction.apply(this, args);
    };
    try {
      await links.readTextbookLinks("a");
    } catch (error) {
      message = error instanceof Error ? error.message : "unexpected error";
    } finally {
      IDBDatabase.prototype.transaction = transaction;
    }
    return { message, after: await links.readTextbookLinks("a") };
  });
  expect(result.message).toBe(
    "教材との関連づけを読み書きできません。保存済みの記録は保持しています。再試行してください。",
  );
  expect(result.after).toEqual(before);
});

for (const closedBy of [
  "normal",
  "forced-event",
  "missed-read",
  "missed-write",
])
  test(`閉じた関連づけDB(${closedBy})から再開して記録を保持する`, async ({
    page,
    context,
  }) => {
    await seed(page, context);
    await begin(page);
    await save(page, "閉じた接続から回復して保持する理由");
    const before = await records(page);
    const result = await page.evaluate(async (closedBy) => {
      const path = "/src/article-textbooks.ts",
        links = await import(path),
        db = await links.openTextbookLinks(),
        rows = await links.readTextbookLinks("a");
      if (closedBy === "normal") db.close();
      else IDBDatabase.prototype.close.call(db);
      if (closedBy === "forced-event") db.dispatchEvent(new Event("close"));
      let firstMessage = "",
        retryMessage = "",
        after;
      try {
        if (closedBy === "missed-write")
          await links.writeTextbookLink(
            { ...rows[0], reason: "保存されてはいけない編集", revision: 2 },
            1,
          );
        else await links.readTextbookLinks("a");
      } catch (error) {
        firstMessage =
          error instanceof Error ? error.message : "unexpected error";
      }
      try {
        after = await links.readTextbookLinks("a");
      } catch (error) {
        retryMessage =
          error instanceof Error ? error.message : "unexpected error";
      }
      const raw = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(links.textbookLinkDatabase);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const disk = await new Promise((resolve) => {
        const r = raw.transaction("links").objectStore("links").getAll();
        r.onsuccess = () => resolve(r.result);
      });
      raw.close();
      const fresh = await links.openTextbookLinks();
      db.dispatchEvent(new Event("close"));
      const keepsNewConnection = (await links.openTextbookLinks()) === fresh;
      return { firstMessage, retryMessage, after, disk, keepsNewConnection };
    }, closedBy);
    expect(result.disk).toEqual(before);
    expect(result.firstMessage).toBe(
      closedBy.startsWith("missed-")
        ? "教材との関連づけを読み書きできません。保存済みの記録は保持しています。再試行してください。"
        : "",
    );
    expect(result.retryMessage).toBe("");
    expect(result.after).toEqual(before);
    expect(result.keepsNewConnection).toBe(true);
  });

for (const operation of ["export", "restore"])
  test(`close通知を受け取らなくても${operation}の明示的な再試行で回復する`, async ({
    page,
    context,
  }) => {
    await seed(page, context);
    await begin(page);
    await save(page, "バックアップの再試行でも保持する理由");
    const before = await records(page);
    await page.goto("/__textbooks");
    const result = await page.evaluate(async (operation) => {
      const path = "/src/article-textbooks.ts",
        links = await import(path),
        backupPath = "/src/library-backup.ts",
        backup = await import(backupPath),
        exported = await backup.exportLibrary(),
        preview = await backup.validateBackup(
          new File([exported.blob], "known.quilna.gz"),
        ),
        db = await links.openTextbookLinks();
      IDBDatabase.prototype.close.call(db);
      const run = () =>
        operation === "export"
          ? backup.exportLibrary()
          : backup.restoreBackup(preview.id);
      let first = "",
        retry = "";
      try {
        await run();
      } catch (error) {
        first = String(error);
      }
      try {
        await run();
      } catch (error) {
        retry = String(error);
      }
      // 通常の読み込みによるキャッシュ修復より先に、独立した接続で保存内容を確認する。
      const raw = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(links.textbookLinkDatabase);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const disk = await new Promise((resolve) => {
        const r = raw.transaction("links").objectStore("links").getAll();
        r.onsuccess = () => resolve(r.result);
      });
      raw.close();
      return { first, retry, disk };
    }, operation);
    expect(result.disk).toEqual(before);
    expect(result.first).not.toBe("");
    expect(result.retry).toBe("");
  });

test("閉じた接続から画面で再読み込みし、理由の保存を明示的にやり直せる", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await begin(page);
  await save(page, "再接続前の理由");
  const before = await records(page);
  await page.evaluate(async () => {
    const path = "/src/article-textbooks.ts",
      links = await import(path);
    IDBDatabase.prototype.close.call(await links.openTextbookLinks());
  });
  const reload = panel(page).getByRole("button", {
    name: "教材の関連づけを再読み込み",
    exact: true,
  });
  await reload.click();
  await expect(panel(page).getByRole("status")).toContainText(
    "教材との関連づけを読み書きできません",
  );
  await reload.click();
  await panel(page)
    .getByRole("button", { name: "関連する理由を編集", exact: true })
    .click();
  await save(page, "再接続後に明示的に保存した理由");
  expect(await records(page)).toEqual([
    { ...before[0], reason: "再接続後に明示的に保存した理由", revision: 2 },
  ]);
});
