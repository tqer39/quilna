import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openReaderTools } from "./reader-tools";

const raw = new TextDecoder().decode(
  await readFile("tests/fixtures/shared-textbook-v2.json"),
);
const id = "dc74d775-eab8-4384-81ae-d741162c0d49:7";
const title = "テーマ別の合成教材：モデルと実行";
function nextEdition(version = 8) {
  const envelope = JSON.parse(raw);
  const record = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(envelope.record), (c) => c.charCodeAt(0)),
    ),
  );
  record.version = version;
  envelope.record = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(record)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );
  return JSON.stringify(envelope);
}
async function fixturePage(page: Page) {
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/__notice_fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Fixture</title>",
    }),
  );
  await page.goto("/__notice_fixture");
}
async function seed(page: Page, design: string) {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
  }, design);
  await fixturePage(page);
  await page.evaluate(
    async (files) => {
      const path = "/src/shared-textbook-store.ts";
      const api = await import(path);
      for (const [i, file] of files.entries()) {
        const book = await api.importSharedTextbook(file);
        if (i === 0) {
          const lesson = book.draft.lessons[0];
          await api.answerSharedTextbook(
            book,
            lesson.content.id,
            lesson.content.question.correctOptionID,
          );
        }
      }
    },
    [raw, nextEdition()],
  );
  await page.goto(`/?view=textbooks&book=${encodeURIComponent(id)}`);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

for (const design of ["studio", "editorial", "focus"]) {
  test(`${design}: 訂正先へ明示的に移動し、旧教材・回答を保持したまま撤回を記録する`, async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === "mobile")
      await page.setViewportSize({ width: 320, height: 844 });
    await seed(page, design);
    await expect(
      page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
    ).toHaveCount(0);
    await page.getByText("教材の訂正・撤回を記録", { exact: true }).click();
    await page
      .getByLabel("記録の種類", { exact: true })
      .selectOption("correction");
    await page
      .getByLabel("訂正先の保存済み版", { exact: true })
      .selectOption(id.replace(":7", ":8"));
    await page
      .getByLabel("訂正・撤回の理由", { exact: true })
      .fill("保存の境界に説明を追加した版を確認する");
    await page
      .getByLabel("判断の根拠", { exact: true })
      .fill("このライブラリの利用者が両方の版を比較した確認記録");
    await page
      .getByRole("button", { name: "この版の記録を保存", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
    ).toContainText("保存の境界に説明を追加");
    await expect(page).toHaveURL(new RegExp(`book=${encodeURIComponent(id)}`));
    await page.reload();
    await expect(
      page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
    ).toContainText("このライブラリの利用者");
    await page
      .getByRole("link", { name: "訂正先の版を読む", exact: true })
      .click();
    await expect(page).toHaveURL(
      /book=dc74d775-eab8-4384-81ae-d741162c0d49%3A8/,
    );
    await page.goBack();
    await page.getByText("教材の訂正・撤回を記録", { exact: true }).click();
    await page
      .getByLabel("記録の種類", { exact: true })
      .selectOption("withdrawn");
    await page
      .getByLabel("訂正・撤回の理由", { exact: true })
      .fill("この版を継続学習に使わない");
    await page
      .getByRole("button", { name: "この版の記録を保存", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
    ).toContainText("継続学習には使わないでください");
    await expect(page.getByRole("radio").first()).toBeDisabled();
    await expect(page.getByText(/回答 1件/)).toBeVisible();
    const saved = await page.evaluate(async () => {
      const path = "/src/shared-textbook-store.ts";
      return (await (await import(path)).listSharedTextbooks()).map(
        (b: { raw: string }) => b.raw,
      );
    });
    expect(saved).toContain(raw);
    expect(saved).toContain(nextEdition());
    await page
      .getByRole("button", { name: "教材一覧へ戻る", exact: true })
      .click();
    const row = page.getByRole("button", {
      name: `${title} · 版 7を読む`,
      exact: true,
    });
    await expect(row.locator("..")).toContainText("撤回の記録あり");
    await row.click();
    await page.reload();
    await expect(
      page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
    ).toContainText("この版を継続学習に使わない");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("schema 1からの移行で教材と回答をそのまま保持し、壊れた保守記録を初期化しない", async ({
  page,
}) => {
  await fixturePage(page);
  const result = await page.evaluate(
    async ({ raw, id }) => {
      const format = "/src/shared-textbook-format.ts",
        store = "/src/shared-textbook-store.ts";
      const book = await (await import(format)).parseSharedTextbook(raw);
      const lesson = book.draft.lessons[0].content;
      const answer = {
        id: crypto.randomUUID(),
        textbook: book.digest,
        section: lesson.id,
        question: lesson.question.id,
        option: lesson.question.correctOptionID,
        correct: true,
        time: "2026-11-17T00:00:00.000Z",
      };
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("quilna.shared-textbooks.v1", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("books", { keyPath: "id" }).put({ id, raw });
          const answers = db.createObjectStore("answers", { keyPath: "id" });
          answers.createIndex("textbook", "textbook");
          answers.put(answer);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      });
      const api = await import(store),
        retained = await api.readSharedTextbook(id);
      const answers = await api.readSharedAnswers(retained);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("quilna.shared-textbooks.v1");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const version = db.version;
      const olderRefused = await new Promise<boolean>((resolve) => {
        const request = indexedDB.open("quilna.shared-textbooks.v1", 1);
        request.onerror = () => resolve(request.error?.name === "VersionError");
        request.onsuccess = () => {
          request.result.close();
          resolve(false);
        };
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("notices", "readwrite");
        tx.objectStore("notices").put({
          id,
          schemaVersion: 99,
          marker: "FUTURE_PRESERVE",
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      let rejected = false;
      try {
        await api.readTextbookNotice(retained);
      } catch {
        rejected = true;
      }
      const marker = await new Promise<unknown>((resolve) => {
        const r = db.transaction("notices").objectStore("notices").get(id);
        r.onsuccess = () => resolve(r.result);
      });
      db.close();
      return {
        version,
        olderRefused,
        raw: retained.raw,
        answers,
        answer,
        rejected,
        marker,
      };
    },
    { raw, id },
  );
  expect(result.version).toBe(2);
  expect(result.olderRefused).toBe(true);
  expect(result.raw).toBe(raw);
  expect(result.answers).toEqual([result.answer]);
  expect(result.rejected).toBe(true);
  expect(result.marker).toEqual({
    id,
    schemaVersion: 99,
    marker: "FUTURE_PRESERVE",
  });
  await page.goto(`/?view=textbooks&book=${encodeURIComponent(id)}`);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeDisabled();
  await expect(
    page
      .getByText("対応するアプリの版で確認してください。", { exact: false })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "教材一覧へ戻る", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `${title} · 版 7を読む`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "保存した教材", exact: true }),
  ).toContainText("この版の訂正・撤回の記録を確認できません");
});

test("競合・削除後の再作成・保存失敗で版と回答を保持し、撤回確定後の回答追記を拒む", async ({
  page,
}) => {
  await seed(page, "studio");
  const result = await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id),
      replacement = await api.readSharedTextbook(id.replace(":7", ":8"));
    const input = {
      kind: "withdrawn",
      reason: "誤りの確認",
      evidence: "元の出典との比較記録",
    };
    const saved = await api.writeTextbookNotice(book, input, null);
    let conflicts = 0,
      answerRejected = false,
      writeRejected = false;
    try {
      await api.writeTextbookNotice(book, input, null);
    } catch {
      conflicts++;
    }
    const lesson = book.draft.lessons[0].content;
    try {
      await api.answerSharedTextbook(
        book,
        lesson.id,
        lesson.question.correctOptionID,
      );
    } catch {
      answerRejected = true;
    }
    await api.removeTextbookNotice(book, saved.revision);
    const corrected = await api.writeTextbookNotice(
      book,
      { ...input, kind: "correction", replacement },
      null,
    );
    try {
      await api.removeTextbookNotice(book, saved.revision);
    } catch {
      conflicts++;
    }
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "notices")
        throw new DOMException("容量不足", "QuotaExceededError");
      return original.apply(this, args);
    };
    try {
      await api.writeTextbookNotice(book, input, corrected.revision);
    } catch {
      writeRejected = true;
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    return {
      conflicts,
      answerRejected,
      writeRejected,
      corrected,
      retained: await api.readTextbookNotice(book),
      answers: (await api.readSharedAnswers(book)).length,
      raw: (await api.readSharedTextbook(id)).raw,
    };
  }, id);
  expect(result.conflicts).toBe(2);
  expect(result.answerRejected).toBe(true);
  expect(result.writeRejected).toBe(true);
  expect(result.retained).toEqual(result.corrected);
  expect(result.answers).toBe(1);
  expect(result.raw).toBe(raw);
});

test("撤回版は新しい関連づけから外し、既存の記事リンクには警告と過去の版を残す", async ({
  page,
  context,
}) => {
  await seed(page, "studio");
  const result = await page.evaluate(async (id) => {
    const storePath = "/src/shared-textbook-store.ts",
      linksPath = "/src/article-textbooks.ts",
      feedPath = "/src/feed-store.ts";
    const api = await import(storePath),
      links = await import(linksPath);
    const book = await api.readSharedTextbook(id);
    const text = "独立した教材の同じ版を参照する記事です。".repeat(60);
    const source = await links.textbookLinkSource({
      articleId: "notice-article",
      title: "撤回版への参照",
      url: "https://example.org/notice",
      text,
      original: text,
      view: "original",
      language: "ja",
    });
    const link = {
      id: links.textbookLinkKey(source.articleId, book.id),
      source,
      target: links.textbookLinkTarget(book),
      reason: "以前この版に結び付けた理由",
      createdAt: new Date().toISOString(),
      revision: 1,
    };
    await links.writeTextbookLink(link, null);
    await api.writeTextbookNotice(
      book,
      {
        kind: "withdrawn",
        reason: "根拠を再確認する",
        evidence: "このライブラリの確認記録",
      },
      null,
    );
    let refused = false;
    try {
      const source2 = { ...source, articleId: "other-article" };
      await links.writeTextbookLink(
        {
          ...link,
          id: links.textbookLinkKey(source2.articleId, book.id),
          source: source2,
        },
        null,
      );
    } catch {
      refused = true;
    }
    const db = await (await import(feedPath)).openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").put({
        id: source.articleId,
        title: source.title,
        url: source.url,
        feedUrl: "",
        published: null,
        fetchedAt: "2026-11-17T00:00:00Z",
        body: text,
        read: true,
        saved: true,
        content: {
          text,
          title: source.title,
          url: source.url,
          language: "ja",
          fetchedAt: "2026-11-17T00:00:00Z",
          codeRanges: [],
        },
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return {
      refused,
      records: await links.readTextbookLinks(source.articleId),
    };
  }, id);
  expect(result.refused).toBe(true);
  expect(result.records).toHaveLength(1);
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "撤回版への参照", exact: true })
    .click();
  await openReaderTools(page);
  const panel = page.getByRole("region", {
    name: "深掘りできる教材",
    exact: true,
  });
  await panel.locator(":scope > details > summary").click();
  await expect(panel).toContainText("継続学習には使わないでください");
  await panel
    .getByRole("button", { name: "関連する理由を編集", exact: true })
    .click();
  await panel
    .getByLabel("この記事と関連する理由（必須）", { exact: true })
    .fill("撤回後も保持する元の記事との関係");
  await panel
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(panel).toContainText("撤回後も保持する元の記事との関係");
  await expect(
    panel.getByRole("link", { name: "教材を読む（別タブ）", exact: true }),
  ).toHaveAttribute("href", new RegExp(encodeURIComponent(id)));
  await panel
    .getByRole("button", { name: "教材を関連づける", exact: true })
    .click();
  const choice = panel.getByLabel("保存済みのテーマ教材", { exact: true });
  await expect(choice.locator(`option[value="${id}"]`)).toHaveCount(0);
  await expect(
    choice.locator(`option[value="${id.replace(":7", ":8")}"]`),
  ).toHaveCount(1);
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id),
      replacement = await api.readSharedTextbook(id.replace(":7", ":8"));
    const notice = await api.readTextbookNotice(book);
    await api.writeTextbookNotice(
      book,
      {
        kind: "correction",
        reason: "訂正先に案内する",
        evidence: "比較の記録",
        replacement,
      },
      notice.revision,
    );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage(book.id);
    channel.close();
  }, id);
  const corrected = panel.getByRole("link", {
    name: "訂正先の版を読む（別タブ）",
    exact: true,
  });
  await expect(corrected).toHaveAttribute("rel", "noopener noreferrer");
  const originalURL = page.url();
  const popup = context.waitForEvent("page");
  await corrected.click();
  const opened = await popup;
  await expect(opened).toHaveURL(
    new RegExp(encodeURIComponent(id.replace(":7", ":8"))),
  );
  expect(await opened.evaluate(() => document.referrer)).toBe("");
  await opened.close();
  await expect(page).toHaveURL(originalURL);
  await expect(
    panel.getByLabel("この記事と関連する理由（必須）", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "関連づけの下書きを取り消す", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "この記事との関連づけを外す", exact: true })
    .click();
  await expect(panel).toContainText("この記事に関連づけた教材はまだありません");
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/shared-textbook-store.ts",
        api = await import(path);
      const book = await api.readSharedTextbook(id);
      return {
        raw: book.raw,
        answers: (await api.readSharedAnswers(book)).length,
      };
    }, id),
  ).toEqual({ raw, answers: 1 });
});

test("古い確認結果の遅延配送で保存した撤回を消さず、入力した理由も保持する", async ({
  page,
}) => {
  await seed(page, "studio");
  await page.getByText("教材の訂正・撤回を記録", { exact: true }).click();
  await page
    .getByLabel("記録の種類", { exact: true })
    .selectOption("withdrawn");
  await page
    .getByLabel("訂正・撤回の理由", { exact: true })
    .fill("遅延した確認でも保持する理由");
  await page.getByLabel("判断の根拠", { exact: true }).fill("確認した根拠");
  await expect(
    page
      .getByLabel("訂正先の保存済み版", { exact: true })
      .locator(`option[value="${id.replace(":7", ":8")}"]`),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "この版の記録を保存", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as unknown as {
      noticeHeld: boolean;
      releaseNotice: () => void;
    };
    let first = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (
        first &&
        this.name === "quilna.shared-textbooks.v1" &&
        tx.mode === "readonly" &&
        tx.objectStoreNames.length === 2 &&
        tx.objectStoreNames.contains("notices")
      ) {
        first = false;
        let completed:
          ((this: IDBTransaction, event: Event) => unknown) | null = null;
        Object.defineProperty(tx, "oncomplete", {
          set(v) {
            completed = v;
          },
          get() {
            return completed;
          },
        });
        tx.addEventListener("complete", (event) => {
          state.noticeHeld = true;
          state.releaseNotice = () => completed?.call(tx, event);
        });
      }
      return tx;
    };
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { noticeHeld: boolean }).noticeHeld,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "この版の記録を保存", exact: true })
    .click();
  const record = page.getByRole("region", {
    name: "この教材版の訂正・撤回",
    exact: true,
  });
  await expect(record).toContainText("継続学習には使わないでください");
  await page.evaluate(async () => {
    (window as unknown as { releaseNotice: () => void }).releaseNotice();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await expect(record).toContainText("遅延した確認でも保持する理由");
  await expect(
    page.getByLabel("訂正・撤回の理由", { exact: true }),
  ).toHaveValue("遅延した確認でも保持する理由");
});

test("同じ教材の保守記録をアカウント間で分離し、失効した文書から追記しない", async ({
  page,
}) => {
  let owner = "a".repeat(64);
  let holdReload = false,
    releaseReload: (() => void) | undefined;
  await page.route("**/api/library/status", (route) =>
    route.fulfill({
      json: { schema: 1, account: owner, legacy: false },
    }),
  );
  await page.route("**/__account_notice_fixture", async (route) => {
    if (holdReload)
      await new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="account-libraries" content="required"><title>Account fixture</title>',
    });
  });
  const open = async () => {
    await page.goto("/__account_notice_fixture");
    await page.evaluate(async (raw) => {
      const context = "/src/library-context.ts";
      await (await import(context)).initializeLibraryContext();
      const path = "/src/shared-textbook-store.ts";
      await (await import(path)).importSharedTextbook(raw);
    }, raw);
  };
  await open();
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.writeTextbookNotice(
      await api.readSharedTextbook(id),
      { kind: "withdrawn", reason: "Aliceの判断", evidence: "Aliceの確認記録" },
      null,
    );
  }, id);
  owner = "b".repeat(64);
  await open();
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/shared-textbook-store.ts",
        api = await import(path);
      return api.readTextbookNotice(await api.readSharedTextbook(id));
    }, id),
  ).toBeUndefined();
  owner = "a".repeat(64);
  await open();
  holdReload = true;
  const result = await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id),
      saved = await api.readTextbookNotice(book);
    const context = "/src/library-context.ts";
    // 登録したライブラリ用のガードを失効させ、保存済み内容には触れない。
    (await import(context)).librarySignedOut();
    let refused = false;
    try {
      await api.writeTextbookNotice(
        book,
        { kind: "withdrawn", reason: "失効後の変更", evidence: "拒否する" },
        saved.revision,
      );
    } catch {
      refused = true;
    }
    return { reason: saved.reason, refused };
  }, id);
  expect(result).toEqual({ reason: "Aliceの判断", refused: true });
  await expect.poll(() => !!releaseReload).toBe(true);
  const reloaded = page.waitForEvent("domcontentloaded");
  releaseReload!();
  await reloaded;
  expect(
    await page.evaluate(async (id) => {
      const context = "/src/library-context.ts";
      await (await import(context)).initializeLibraryContext();
      const path = "/src/shared-textbook-store.ts",
        api = await import(path);
      return (await api.readTextbookNotice(await api.readSharedTextbook(id)))
        .reason;
    }, id),
  ).toBe("Aliceの判断");
});

for (const layout of ["missing-index", "extra-store"]) {
  test(`不明なschema 1構造(${layout})の移行を中止して教材と未知の記録を保持する`, async ({
    page,
  }) => {
    await fixturePage(page);
    const result = await page.evaluate(
      async ({ id, raw, layout }) => {
        await new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("quilna.shared-textbooks.v1", 1);
          r.onupgradeneeded = () => {
            r.result
              .createObjectStore("books", { keyPath: "id" })
              .put({ id, raw });
            const answers = r.result.createObjectStore("answers", {
              keyPath: "id",
            });
            if (layout !== "missing-index")
              answers.createIndex("textbook", "textbook");
            if (layout === "extra-store")
              r.result.createObjectStore("unknown").put("PRESERVE", "marker");
          };
          r.onsuccess = () => {
            r.result.close();
            resolve();
          };
          r.onerror = () => reject(r.error);
        });
        const path = "/src/shared-textbook-store.ts";
        let refused = false;
        try {
          await (await import(path)).listSharedTextbooks();
        } catch {
          refused = true;
        }
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open("quilna.shared-textbooks.v1");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const retained = await new Promise<unknown>((resolve) => {
          const r = db.transaction("books").objectStore("books").get(id);
          r.onsuccess = () => resolve(r.result);
        });
        const value = {
          refused,
          version: db.version,
          stores: Array.from(db.objectStoreNames),
          retained,
        };
        db.close();
        return value;
      },
      { id, raw, layout },
    );
    expect(result.refused).toBe(true);
    expect(result.version).toBe(1);
    expect(result.stores).toEqual(
      layout === "extra-store"
        ? ["answers", "books", "unknown"]
        : ["answers", "books"],
    );
    expect(result.retained).toEqual({ id, raw });
  });
}

test("破損した候補を分離し、正常な訂正先を表示して記録の長さ・根拠・同一性を検査する", async ({
  page,
}) => {
  await seed(page, "studio");
  await page.evaluate(async (file) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.importSharedTextbook(file);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("quilna.shared-textbooks.v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("notices", "readwrite");
      tx.objectStore("notices").put({
        id: book.id,
        schemaVersion: 99,
        marker: "KEEP_BAD_NOTICE",
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, nextEdition(9));
  await page.getByText("教材の訂正・撤回を記録", { exact: true }).click();
  const target = page.getByLabel("訂正先の保存済み版", { exact: true });
  await expect(
    target.locator(`option[value="${id.replace(":7", ":8")}"]`),
  ).toHaveCount(1);
  await expect(
    target.locator(`option[value="${id.replace(":7", ":9")}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(".textbook-notice-editor").getByRole("status"),
  ).toContainText("記録を確認できない版は訂正先の候補から外しています");
  const result = await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id),
      input = {
        kind: "withdrawn",
        reason: "確認した理由",
        evidence: "確認した根拠",
      };
    let invalid = 0;
    for (const field of ["reason", "evidence"]) {
      for (const value of ["", "   ", "a".repeat(2001), "a\0b"]) {
        try {
          await api.writeTextbookNotice(
            book,
            { ...input, [field]: value },
            null,
          );
        } catch {
          invalid++;
        }
      }
    }
    try {
      await api.writeTextbookNotice(
        book,
        { ...input, kind: "correction", replacement: book },
        null,
      );
    } catch {
      invalid++;
    }
    const valid = await api.writeTextbookNotice(
      book,
      { ...input, reason: "あ".repeat(2000), evidence: "b".repeat(2000) },
      null,
    );
    return {
      invalid,
      reason: valid.reason.length,
      evidence: valid.evidence.length,
      raw: (await api.readSharedTextbook(id)).raw,
    };
  }, id);
  expect(result).toEqual({ invalid: 9, reason: 2000, evidence: 2000, raw });
});

test("訂正先が別の画面で撤回されたら古い版からの誘導も止める", async ({
  page,
  context,
}) => {
  await seed(page, "studio");
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id),
      replacement = await api.readSharedTextbook(id.replace(":7", ":8"));
    await api.writeTextbookNotice(
      book,
      {
        kind: "correction",
        reason: "訂正済みの版を確認する",
        evidence: "比較した根拠",
        replacement,
      },
      null,
    );
  }, id);
  await page.reload();
  await expect(
    page.getByRole("link", { name: "訂正先の版を読む", exact: true }),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto("/__notice_fixture");
  await other.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const target = await api.readSharedTextbook(id.replace(":7", ":8"));
    await api.writeTextbookNotice(
      target,
      {
        kind: "withdrawn",
        reason: "訂正版も再確認が必要",
        evidence: "追加の確認記録",
      },
      null,
    );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage(target.id);
    channel.close();
  }, id);
  await expect(
    page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
  ).toContainText("訂正先の版も撤回されています");
  await expect(
    page.getByRole("link", { name: "訂正先の版を読む", exact: true }),
  ).toHaveCount(0);
  await other.close();
});

test("回答の完了待ち中は再確認でも操作を解放せず、撤回後の完了配送でも回答欄を閉じたままにする", async ({
  page,
  context,
}) => {
  await seed(page, "studio");
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as unknown as {
      answerHeld: boolean;
      noticeReads: number;
      releaseAnswer: () => void;
    };
    state.noticeReads = 0;
    let first = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (this.name !== "quilna.shared-textbooks.v1") return tx;
      if (
        tx.mode === "readonly" &&
        tx.objectStoreNames.length === 2 &&
        tx.objectStoreNames.contains("notices")
      )
        tx.addEventListener("complete", () => {
          state.noticeReads++;
        });
      if (
        first &&
        tx.mode === "readwrite" &&
        tx.objectStoreNames.contains("answers")
      ) {
        first = false;
        let completed:
          ((this: IDBTransaction, event: Event) => unknown) | null = null;
        Object.defineProperty(tx, "oncomplete", {
          set(v) {
            completed = v;
          },
          get() {
            return completed;
          },
        });
        tx.addEventListener("complete", (event) => {
          state.answerHeld = true;
          state.releaseAnswer = () => completed?.call(tx, event);
        });
      }
      return tx;
    };
  });
  await page.getByRole("radio").first().check();
  await page
    .getByRole("button", { name: "回答して保存", exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { answerHeld: boolean }).answerHeld,
      ),
    )
    .toBe(true);
  const reads = await page.evaluate(() => {
    const n = (window as unknown as { noticeReads: number }).noticeReads;
    window.dispatchEvent(new Event("focus"));
    return n;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { noticeReads: number }).noticeReads,
      ),
    )
    .toBeGreaterThan(reads);
  await expect(page.getByRole("radio").first()).toBeDisabled();
  const other = await context.newPage();
  await other.goto("/__notice_fixture");
  await other.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.writeTextbookNotice(
      await api.readSharedTextbook(id),
      {
        kind: "withdrawn",
        reason: "回答中に撤回を確認",
        evidence: "確認した根拠",
      },
      null,
    );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage(id);
    channel.close();
  }, id);
  await expect(
    page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
  ).toContainText("回答中に撤回を確認");
  await page.evaluate(async () => {
    (window as unknown as { releaseAnswer: () => void }).releaseAnswer();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await expect(page.getByRole("radio").first()).toBeDisabled();
  await expect(page.getByText(/回答 2件/)).toBeVisible();
  await other.close();
});

test("記録の保存失敗と別画面の競合でも入力を保持し、明示した再読み込みだけで置き換える", async ({
  page,
  context,
}) => {
  await seed(page, "studio");
  const editor = page.locator(".textbook-notice-editor");
  await editor.locator("summary").click();
  await page
    .getByLabel("記録の種類", { exact: true })
    .selectOption("withdrawn");
  await page
    .getByRole("button", { name: "この版の記録を保存", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("訂正・撤回の理由を");
  await page
    .getByLabel("訂正・撤回の理由", { exact: true })
    .fill("保持する自分の理由");
  await page
    .getByRole("button", { name: "この版の記録を保存", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("判断の根拠を");
  await page
    .getByLabel("判断の根拠", { exact: true })
    .fill("保持する自分の根拠");
  await expect(
    page
      .getByLabel("訂正先の保存済み版", { exact: true })
      .locator(`option[value="${id.replace(":7", ":8")}"]`),
  ).toHaveCount(1);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    const state = window as unknown as { failNotice: boolean };
    state.failNotice = true;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (this.name === "notices" && state.failNotice) this.transaction.abort();
      return request;
    };
  });
  const save = page.getByRole("button", {
    name: "この版の記録を保存",
    exact: true,
  });
  await save.click();
  await expect(editor.getByRole("status")).toContainText(
    "教材の保存領域を利用できません",
  );
  await expect(
    page.getByLabel("訂正・撤回の理由", { exact: true }),
  ).toHaveValue("保持する自分の理由");
  await page.evaluate(() => {
    (window as unknown as { failNotice: boolean }).failNotice = false;
  });
  const other = await context.newPage();
  await other.goto("/__notice_fixture");
  await other.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.writeTextbookNotice(
      await api.readSharedTextbook(id),
      {
        kind: "withdrawn",
        reason: "別画面で確認した理由",
        evidence: "別画面の確認内容",
      },
      null,
    );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage(id);
    channel.close();
  }, id);
  await expect(editor.getByRole("status")).toContainText(
    "別の画面で記録が変更されています",
  );
  await save.click();
  await expect(editor.getByRole("status")).toContainText(
    "別の画面で訂正・撤回の記録が変わりました",
  );
  await expect(
    page.getByLabel("訂正・撤回の理由", { exact: true }),
  ).toHaveValue("保持する自分の理由");
  await page
    .getByRole("button", {
      name: "入力を取り消して最新記録を読み直す",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("訂正・撤回の理由", { exact: true }),
  ).toHaveValue("別画面で確認した理由");
  await other.close();
});

test("一覧の背景再確認が取り込み後のフォーカスを奪わず、失敗時も表示を保持する", async ({
  page,
}) => {
  await seed(page, "studio");
  await page
    .getByRole("button", { name: "教材一覧へ戻る", exact: true })
    .click();
  const retained = page.getByRole("button", {
    name: `${title} · 版 7を読む`,
    exact: true,
  });
  await expect(retained).toBeVisible();
  await page
    .getByLabel("教材JSONファイル（540,000バイト以下）")
    .setInputFiles("tests/fixtures/shared-textbook-v2.json");
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    const getAll = IDBObjectStore.prototype.getAll;
    const state = window as unknown as {
      heldList: boolean;
      releaseList: () => void;
      metadataReads: number;
      failList: boolean;
    };
    state.metadataReads = 0;
    let first = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (this.name !== "quilna.shared-textbooks.v1" || tx.mode !== "readonly")
        return tx;
      if (
        tx.objectStoreNames.length === 2 &&
        tx.objectStoreNames.contains("notices")
      )
        tx.addEventListener("complete", () => {
          state.metadataReads++;
        });
      if (
        first &&
        tx.objectStoreNames.length === 1 &&
        tx.objectStoreNames.contains("books")
      ) {
        first = false;
        let completed:
          ((this: IDBTransaction, event: Event) => unknown) | null = null;
        Object.defineProperty(tx, "oncomplete", {
          set(v) {
            completed = v;
          },
          get() {
            return completed;
          },
        });
        tx.addEventListener("complete", (event) => {
          state.heldList = true;
          state.releaseList = () => completed?.call(tx, event);
        });
      }
      return tx;
    };
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === "books" && state.failList)
        throw new DOMException("再確認用の読み込み失敗", "UnknownError");
      return getAll.apply(this, args);
    };
  });
  await page
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { heldList: boolean }).heldList,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    (window as unknown as { releaseList: () => void }).releaseList();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { metadataReads: number }).metadataReads,
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await expect(retained).toBeFocused();
  await page.evaluate(() => {
    (window as unknown as { failList: boolean }).failList = true;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByText(
      "教材一覧の再確認に失敗しました。表示中の教材は保持しています。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(retained).toBeVisible();
  await expect(retained).toBeFocused();
  await page.evaluate(() => {
    (window as unknown as { failList: boolean }).failList = false;
  });
  await page
    .getByRole("button", { name: "教材一覧の再確認", exact: true })
    .click();
  await expect(retained).toBeVisible();
});

test("訂正の保存完了待ちに届いた訂正先の撤回通知を、完了後に確認し直す", async ({
  page,
  context,
}) => {
  await seed(page, "studio");
  await page.getByText("教材の訂正・撤回を記録", { exact: true }).click();
  await page
    .getByLabel("訂正先の保存済み版", { exact: true })
    .selectOption(id.replace(":7", ":8"));
  await page
    .getByLabel("訂正・撤回の理由", { exact: true })
    .fill("後の版で再確認する");
  await page.getByLabel("判断の根拠", { exact: true }).fill("確認した根拠");
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as unknown as {
      noticeWriteHeld: boolean;
      releaseNoticeWrite: () => void;
    };
    let first = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (
        first &&
        this.name === "quilna.shared-textbooks.v1" &&
        tx.mode === "readwrite" &&
        tx.objectStoreNames.length === 2 &&
        tx.objectStoreNames.contains("notices")
      ) {
        first = false;
        let completed:
          ((this: IDBTransaction, event: Event) => unknown) | null = null;
        Object.defineProperty(tx, "oncomplete", {
          set(v) {
            completed = v;
          },
          get() {
            return completed;
          },
        });
        tx.addEventListener("complete", (event) => {
          state.noticeWriteHeld = true;
          state.releaseNoticeWrite = () => completed?.call(tx, event);
        });
      }
      return tx;
    };
  });
  await page
    .getByRole("button", { name: "この版の記録を保存", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { noticeWriteHeld: boolean }).noticeWriteHeld,
      ),
    )
    .toBe(true);
  const other = await context.newPage();
  await other.goto("/__notice_fixture");
  await other.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.writeTextbookNotice(
      await api.readSharedTextbook(id.replace(":7", ":8")),
      {
        kind: "withdrawn",
        reason: "訂正の完了前に撤回した版",
        evidence: "新しい確認結果",
      },
      null,
    );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage(id);
    channel.close();
  }, id);
  await page.evaluate(() =>
    (
      window as unknown as { releaseNoticeWrite: () => void }
    ).releaseNoticeWrite(),
  );
  await expect(
    page.getByRole("region", { name: "この教材版の訂正・撤回", exact: true }),
  ).toContainText("訂正先の版も撤回されています");
  await expect(
    page.getByRole("link", { name: "訂正先の版を読む", exact: true }),
  ).toHaveCount(0);
  await other.close();
});
