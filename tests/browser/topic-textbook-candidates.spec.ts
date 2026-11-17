import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openReaderTools } from "./reader-tools";
import { parseSharedTextbook } from "../../src/shared-textbook-format";

const raw = new TextDecoder().decode(
  await readFile("tests/fixtures/shared-textbook-v2.json"),
);
const request = (await parseSharedTextbook(raw)).request;
if (request.schemaVersion !== 2) throw Error("テーマ教材のfixtureが必要です");
const topic = request.topic;
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
  await page.evaluate(
    async ({ raw, topicName }) => {
      const feedPath = "/src/feed-store.ts",
        booksPath = "/src/shared-textbook-store.ts";
      await (await import(booksPath)).importSharedTextbook(raw);
      const db = await (await import(feedPath)).openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        for (const id of ["a", "b"]) {
          const text = `この記事は${topicName}を深掘りする入口です。 `.repeat(
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
    },
    { raw, topicName: topic.name },
  );
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

const candidates = (page: Page) =>
  panel(page).getByRole("list", { name: "本文から見つかった教材候補" });
async function links(page: Page, id = "a") {
  return page.evaluate(async (id) => {
    const path = "/src/article-textbooks.ts";
    return (await import(path)).readTextbookLinks(id);
  }, id);
}
test("候補の別タブ確認では保存せず、理由を明示して同じ教材を二つの記事で再利用する", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toContainText(topic.name);
  expect(await links(page)).toEqual([]);
  const preview = candidates(page).getByRole("link");
  await preview.focus();
  const opened = context.waitForEvent("page");
  await page.keyboard.press("Enter");
  const book = await opened;
  await expect(
    book.getByRole("navigation", { name: "教材の目次" }),
  ).toBeVisible();
  expect(await book.evaluate(() => document.referrer)).toBe("");
  expect(new URL(book.url()).searchParams.has("article")).toBe(false);
  await book.close();
  await expect(preview).toBeFocused();
  expect(await links(page)).toEqual([]);
  for (const article of ["a", "b"]) {
    if (article === "b") await openArticle(page, "b");
    await candidates(page)
      .getByRole("button", { name: "この候補を関連づける", exact: true })
      .click();
    const reason = panel(page).getByLabel("この記事と関連する理由（必須）", {
      exact: true,
    });
    await expect(reason).toHaveValue(new RegExp(topic.name));
    expect(await links(page, article)).toEqual([]);
    await reason.fill(`記事${article}から共通テーマを深掘りする`);
    await panel(page)
      .getByRole("button", { name: "関連する理由を保存", exact: true })
      .click();
    await expect(
      panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
    ).toContainText(`記事${article}から共通テーマ`);
    await expect(candidates(page)).toBeHidden();
  }
  expect((await links(page, "a"))[0].target).toEqual(
    (await links(page, "b"))[0].target,
  );
});
test("非表示を記事ごとに保持し、キーボードで明示的に戻せる", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await seed(page, context);
  await expect(candidates(page)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("topic-candidates-320.png"),
    fullPage: true,
  });
  const hide = candidates(page).getByRole("button", {
    name: "この記事ではこのテーマを候補に出さない",
  });
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(candidates(page)).toBeHidden();
  await expect(
    panel(page).getByText(/この記事ではこのテーマの候補を非表示にしました/),
  ).toBeVisible();
  await openArticle(page, "b");
  await expect(candidates(page)).toContainText(topic.name);
  await openArticle(page, "a");
  await expect(candidates(page)).toBeHidden();
  await panel(page)
    .getByText("非表示にしたテーマを確認 · 1件", { exact: true })
    .click();
  const restore = panel(page).getByRole("button", {
    name: "このテーマの候補を再び確認する",
  });
  await restore.focus();
  await page.keyboard.press("Enter");
  await expect(candidates(page)).toContainText(topic.name);
  expect(await links(page)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("不明な設定を消さず候補を止め、手動の関連づけは使える", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toContainText(topic.name);
  await page.evaluate(async () => {
    const path = "/src/topic-textbook-preferences.ts";
    const api = await import(path);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(api.topicPreferenceDatabase, 1);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(Error("設定DBがblocked"));
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("hidden", "readwrite");
        tx.objectStore("hidden").put({
          id: JSON.stringify(["a", "bad"]),
          articleId: "a",
          future: true,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  });
  await openArticle(page, "b");
  await openArticle(page, "a");
  await expect(candidates(page)).toBeHidden();
  await expect(
    panel(page).getByText(/教材候補の非表示設定の保存形式を確認できません/),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "教材を関連づける", exact: true })
    .click();
  await panel(page)
    .getByLabel("保存済みのテーマ教材", { exact: true })
    .selectOption(bookId);
  await panel(page)
    .getByLabel("この記事と関連する理由（必須）", { exact: true })
    .fill("設定を保持したまま手動確認");
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(
    panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
  ).toContainText("設定を保持したまま手動確認");
  const rows = await page.evaluate(async () => {
    const path = "/src/topic-textbook-preferences.ts",
      api = await import(path);
    return new Promise<unknown[]>((resolve) => {
      const req = indexedDB.open(api.topicPreferenceDatabase, 1);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("hidden"),
          q = tx.objectStore("hidden").getAll();
        q.onsuccess = () => resolve(q.result);
        tx.oncomplete = () => db.close();
      };
    });
  });
  expect(rows).toEqual([
    { id: JSON.stringify(["a", "bad"]), articleId: "a", future: true },
  ]);
});

test("撤回した教材を候補から外し、教材と回答を保持する", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toBeVisible();
  const before = await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id),
      lesson = book.draft.lessons[0];
    await api.answerSharedTextbook(
      book,
      lesson.content.id,
      lesson.content.question.correctOptionID,
    );
    await api.writeTextbookNotice(
      book,
      { kind: "withdrawn", reason: "検証で撤回", evidence: "合成の検証記録" },
      null,
    );
    return book.raw;
  }, bookId);
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み" })
    .click();
  await expect(candidates(page)).toBeHidden();
  const after = await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id);
    return { raw: book.raw, answers: await api.readSharedAnswers(book) };
  }, bookId);
  expect(after.raw).toBe(before);
  expect(after.answers).toHaveLength(1);
});

test("非表示の保存abortを成功と表示せず、以前の設定を保持して再試行できる", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toBeVisible();
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      const request = add.apply(this, args);
      if (this.name === "hidden") {
        const tx = this.transaction;
        request.addEventListener("success", () => tx.abort(), { once: true });
        IDBObjectStore.prototype.add = add;
      }
      return request;
    };
  });
  await candidates(page)
    .getByRole("button", { name: "この記事ではこのテーマを候補に出さない" })
    .click();
  await expect(
    panel(page).getByText(/教材候補の非表示設定を読み書きできません/),
  ).toBeVisible();
  await expect(candidates(page)).toBeVisible();
  await candidates(page)
    .getByRole("button", { name: "この記事ではこのテーマを候補に出さない" })
    .click();
  await expect(candidates(page)).toBeHidden();
});

for (const kind of ["future", "layout"] as const) {
  test(`${kind}: 未対応の保存領域を初期化せず拒否する`, async ({ page }) => {
    await page.route("**/__preferences", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Preferences fixture</title>",
      }),
    );
    await page.goto("/__preferences");
    const result = await page.evaluate(async (kind) => {
      const path = "/src/topic-textbook-preferences.ts",
        api = await import(path);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(
          api.topicPreferenceDatabase,
          kind === "future" ? 2 : 1,
        );
        req.onupgradeneeded = () =>
          req.result
            .createObjectStore("future", { keyPath: "id" })
            .put({ id: "retain", private: "既存設定" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      let refused = false;
      try {
        await api.readHiddenTextbookTopics("a");
      } catch {
        refused = true;
      }
      return {
        refused,
        rows: await new Promise<unknown[]>((resolve, reject) => {
          const req = indexedDB.open(api.topicPreferenceDatabase);
          req.onsuccess = () => {
            const d = req.result,
              tx = d.transaction("future"),
              get = tx.objectStore("future").getAll();
            get.onsuccess = () => resolve(get.result);
            tx.oncomplete = () => d.close();
          };
          req.onerror = () => reject(req.error);
        }),
      };
    }, kind);
    expect(result).toEqual({
      refused: true,
      rows: [{ id: "retain", private: "既存設定" }],
    });
  });
}

test("非表示設定は検証したアカウントごとに分離する", async ({ page }) => {
  let owner = "a".repeat(64);
  await page.route("**/api/library/status", (r) =>
    r.fulfill({ json: { schema: 1, account: owner, legacy: false } }),
  );
  await page.route("**/__account_preferences", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="account-libraries" content="required"><title>Account preferences</title>',
    }),
  );
  const open = async () => {
    await page.goto("/__account_preferences");
    await page.evaluate(async () => {
      const path = "/src/library-context.ts";
      await (await import(path)).initializeLibraryContext();
    });
  };
  await open();
  await page.evaluate(async (topic) => {
    const path = "/src/topic-textbook-preferences.ts";
    await (
      await import(path)
    ).setTextbookTopicHidden(
      "a",
      { topicId: topic.id, topicName: topic.name },
      true,
    );
  }, topic);
  const rows = () =>
    page.evaluate(async () => {
      const path = "/src/topic-textbook-preferences.ts";
      return (await import(path)).readHiddenTextbookTopics("a");
    });
  owner = "b".repeat(64);
  await open();
  expect(await rows()).toEqual([]);
  owner = "a".repeat(64);
  await open();
  expect(await rows()).toMatchObject([{ articleId: "a", topicId: topic.id }]);
});

test("遅延した旧表示の候補は現在の言語や編集済みの理由を置き換えない", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toBeVisible();
  await page.evaluate(() => {
    const get = IDBIndex.prototype.getAll;
    const state = window as unknown as {
      candidateReadHeld: boolean;
      releaseCandidateRead: () => void;
    };
    let once = true;
    IDBIndex.prototype.getAll = function (...args) {
      if (once && this.objectStore.name === "hidden") {
        once = false;
        const tx = this.objectStore.transaction,
          complete = tx.oncomplete;
        tx.oncomplete = (event) => {
          state.candidateReadHeld = true;
          state.releaseCandidateRead = () => complete?.call(tx, event);
        };
      }
      return get.apply(this, args);
    };
  });
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み" })
    .click();
  await page.waitForFunction(
    () =>
      (window as unknown as { candidateReadHeld?: boolean }).candidateReadHeld,
  );
  try {
    await page.getByLabel("原文の言語", { exact: true }).selectOption("fr");
    await expect(
      candidates(page).getByRole("button", {
        name: "この候補を関連づける",
        exact: true,
      }),
    ).toBeEnabled();
    await candidates(page)
      .getByRole("button", { name: "この候補を関連づける", exact: true })
      .click();
    const reason = panel(page).getByLabel("この記事と関連する理由（必須）", {
      exact: true,
    });
    await reason.fill("新しい表示で編集した理由");
    await page.evaluate(() =>
      (
        window as unknown as { releaseCandidateRead: () => void }
      ).releaseCandidateRead(),
    );
    await expect(reason).toHaveValue("新しい表示で編集した理由");
    await panel(page)
      .getByRole("button", { name: "関連する理由を保存", exact: true })
      .click();
    await expect(
      panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
    ).toContainText("新しい表示で編集した理由");
    expect((await links(page))[0].source.language).toBe("fr");
  } finally {
    await page.evaluate(() =>
      (
        window as unknown as { releaseCandidateRead?: () => void }
      ).releaseCandidateRead?.(),
    );
  }
});

async function confirmCandidate(page: Page, reason: string) {
  await candidates(page)
    .getByRole("button", { name: "この候補を関連づける", exact: true })
    .click();
  await panel(page)
    .getByLabel("この記事と関連する理由（必須）", { exact: true })
    .fill(reason);
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(
    panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
  ).toContainText(reason);
}
test("教材一覧が壊れても既存リンクの表示・理由編集・解除を続けられる", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await confirmCandidate(page, "保持する理由");
  await page.evaluate(async () => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(api.sharedTextbookDatabase, 2);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("books", "readwrite");
        tx.objectStore("books").put({ id: "broken", raw: "壊れた教材" });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  await openArticle(page, "b");
  await openArticle(page, "a");
  await expect(
    panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
  ).toContainText("保持する理由");
  await panel(page)
    .getByRole("button", { name: "関連する理由を編集", exact: true })
    .click();
  await panel(page)
    .getByLabel("この記事と関連する理由（必須）", { exact: true })
    .fill("読み込み失敗後も編集した理由");
  await panel(page)
    .getByRole("button", { name: "関連する理由を保存", exact: true })
    .click();
  await expect(
    panel(page).getByRole("list", { name: "この記事に関連づけた教材" }),
  ).toContainText("読み込み失敗後も編集した理由");
  await expect(candidates(page)).toBeHidden();
  await panel(page)
    .getByRole("button", { name: "この記事との関連づけを外す", exact: true })
    .click();
  await expect.poll(() => links(page)).toEqual([]);
});

test("確定した新版以下を候補へ戻さず、さらに新しい版だけを確認できる", async ({
  page,
  context,
}) => {
  await seed(page, context);
  const edition = (version: number) => {
    const envelope = JSON.parse(raw),
      record = JSON.parse(
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
  };
  const add = (text: string) =>
    page.evaluate(async (text) => {
      const path = "/src/shared-textbook-store.ts";
      await (await import(path)).importSharedTextbook(text);
    }, text);
  await add(edition(8));
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み" })
    .click();
  await expect(candidates(page)).toContainText("版 8");
  await confirmCandidate(page, "新版を確定する理由");
  await expect(candidates(page)).toBeHidden();
  await add(edition(9));
  await panel(page)
    .getByRole("button", { name: "教材の関連づけを再読み込み" })
    .click();
  await expect(candidates(page)).toContainText("版 9");
  expect((await links(page))[0].target.id).toBe(bookId.replace(":7", ":8"));
});

for (const problem of [
  "unknown",
  "withdrawn-replacement",
  "missing-replacement",
] as const) {
  test(`${problem}: 確認できない保守状態を候補に使わない`, async ({
    page,
    context,
  }) => {
    await seed(page, context);
    await expect(candidates(page)).toBeVisible();
    const envelope = JSON.parse(raw),
      record = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(envelope.record), (c) => c.charCodeAt(0)),
        ),
      );
    record.version = 8;
    envelope.record = btoa(
      Array.from(new TextEncoder().encode(JSON.stringify(record)), (n) =>
        String.fromCharCode(n),
      ).join(""),
    );
    await page.evaluate(
      async ({ id, problem, next }) => {
        const path = "/src/shared-textbook-store.ts",
          api = await import(path),
          book = await api.readSharedTextbook(id);
        if (problem !== "unknown") {
          const replacement = await api.importSharedTextbook(next);
          await api.writeTextbookNotice(
            book,
            {
              kind: "correction",
              reason: "新版へ訂正",
              evidence: "合成の根拠",
              replacement,
            },
            null,
          );
          if (problem === "withdrawn-replacement")
            await api.writeTextbookNotice(
              replacement,
              {
                kind: "withdrawn",
                reason: "訂正先も撤回",
                evidence: "合成の追加根拠",
              },
              null,
            );
        }
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(api.sharedTextbookDatabase, 2);
          req.onsuccess = () => {
            const db = req.result,
              tx = db.transaction(["books", "notices"], "readwrite");
            if (problem === "unknown")
              tx.objectStore("notices").put({
                id,
                schemaVersion: 99,
                marker: "保持する不明な記録",
              });
            if (problem === "missing-replacement")
              tx.objectStore("books").delete(id.replace(":7", ":8"));
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        });
      },
      { id: bookId, problem, next: JSON.stringify(envelope) },
    );
    await panel(page)
      .getByRole("button", { name: "教材の関連づけを再読み込み" })
      .click();
    await expect(candidates(page)).toBeHidden();
    expect(await links(page)).toEqual([]);
  });
}

test("非表示を操作元では一度だけ確認し、別タブの候補にも反映する", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toBeVisible();
  const other = await context.newPage();
  await other.goto("/?view=feeds");
  await openArticle(other, "a");
  await expect(candidates(other)).toBeVisible();
  await page.evaluate(() => {
    const get = IDBIndex.prototype.getAll;
    const state = window as unknown as { preferenceReads: number };
    state.preferenceReads = 0;
    IDBIndex.prototype.getAll = function (...args) {
      if (this.objectStore.name === "hidden") state.preferenceReads++;
      return get.apply(this, args);
    };
  });
  await candidates(page)
    .getByRole("button", { name: "この記事ではこのテーマを候補に出さない" })
    .click();
  await expect(candidates(page)).toBeHidden();
  await expect(candidates(other)).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as { preferenceReads: number }).preferenceReads,
    ),
  ).toBe(1);
  await other.close();
});

for (const limit of ["article", "total"] as const) {
  test(`${limit}: 非表示の上限で既存設定を残し、明示的な解除後に追加できる`, async ({
    page,
    context,
  }) => {
    await seed(page, context);
    await expect(candidates(page)).toBeVisible();
    const result = await page.evaluate(
      async ({ limit, topic }) => {
        const path = "/src/topic-textbook-preferences.ts",
          api = await import(path);
        const count = limit === "article" ? 100 : api.topicPreferenceLimit;
        const topics = Array.from({ length: count }, (_, i) => ({
          articleId: limit === "article" ? "capacity" : `capacity-${i}`,
          topicId: crypto.randomUUID(),
          topicName: "保持するテーマ",
        }));
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(api.topicPreferenceDatabase, 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("hidden", "readwrite");
          for (const row of topics)
            tx.objectStore("hidden").add({
              ...row,
              id: JSON.stringify([row.articleId, row.topicId]),
              createdAt: new Date().toISOString(),
            });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
        const target = limit === "article" ? "capacity" : "new";
        let error = "";
        try {
          await api.setTextbookTopicHidden(
            target,
            { topicId: topic.id, topicName: topic.name },
            true,
          );
        } catch (e) {
          error = (e as Error).message;
        }
        const retained = await api.readHiddenTextbookTopics(
          topics[0].articleId,
        );
        await api.setTextbookTopicHidden(topics[0].articleId, topics[0], false);
        await api.setTextbookTopicHidden(
          target,
          { topicId: topic.id, topicName: topic.name },
          true,
        );
        return {
          error,
          retained: retained.length,
          added: (await api.readHiddenTextbookTopics(target)).some(
            (r: { topicId: string }) => r.topicId === topic.id,
          ),
        };
      },
      { limit, topic },
    );
    expect(result.error).toContain("上限");
    expect(result.retained).toBe(limit === "article" ? 100 : 1);
    expect(result.added).toBe(true);
  });
}

test("私的な非表示設定は記事バックアップと教材ファイルに含めない", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(candidates(page)).toBeVisible();
  const result = await page.evaluate(
    async ({ topic, id }) => {
      const prefs = "/src/topic-textbook-preferences.ts",
        backup = "/src/library-backup.ts",
        books = "/src/shared-textbook-store.ts";
      await (
        await import(prefs)
      ).setTextbookTopicHidden(
        "a",
        { topicId: topic.id, topicName: "PRIVATE_HIDDEN_TOPIC" },
        true,
      );
      const output = await (await import(backup)).exportLibrary();
      const text = await new Response(
        output.blob.stream().pipeThrough(new DecompressionStream("gzip")),
      ).text();
      return {
        text,
        raw: (await (await import(books)).readSharedTextbook(id)).raw,
      };
    },
    { topic, id: bookId },
  );
  expect(result.text).toContain("教材記事 a");
  expect(result.text).not.toContain("PRIVATE_HIDDEN_TOPIC");
  expect(result.raw).toBe(raw);
});
