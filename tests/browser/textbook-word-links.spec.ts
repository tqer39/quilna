import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { parseSharedTextbook } from "../../src/shared-textbook-format";

const raw = new TextDecoder().decode(
  await readFile("tests/fixtures/shared-textbook-v2.json"),
);
const request = (await parseSharedTextbook(raw)).request;
if (request.schemaVersion !== 2) throw Error("テーマ教材が必要です");
const topic = request.topic;
const bookId = "dc74d775-eab8-4384-81ae-d741162c0d49:7";
const panel = (page: Page) =>
  page.getByRole("region", {
    name: "深掘りできる教材",
    exact: true,
    includeHidden: true,
  });
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
    async ({ raw, name }) => {
      const feedPath = "/src/feed-store.ts",
        booksPath = "/src/shared-textbook-store.ts";
      await (await import(booksPath)).importSharedTextbook(raw);
      const db = await (await import(feedPath)).openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        for (const id of ["a", "b"]) {
          const text =
            `記事${id}から${name}を深掘りする。同じテーマは共通の教材を使います。 PRIVATE_TEXTBOOK_ARTICLE_CANARY `.repeat(
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
    { raw, name: topic.name },
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
}

const wordLinks = (page: Page) =>
  page.locator(".rss-source-text a.rss-textbook-word-link");
function edition(version: number) {
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
}

test("記事本文の語から理由入力なしで教材を開き、別の記事でも同じ回答を使う", async ({
  page,
  context,
}) => {
  const posts: string[] = [];
  context.on("request", (r) => {
    const url = new URL(r.url());
    if (
      (r.url() + (r.postData() ?? "")).includes(
        "PRIVATE_TEXTBOOK_ARTICLE_CANARY",
      ) ||
      /(^|\.)(openai\.com|anthropic\.com)$/.test(url.hostname) ||
      (r.method() !== "GET" &&
        /^\/api\/(proposals|topic-textbooks|textbooks)(?:\/|$)/.test(
          url.pathname,
        ))
    )
      posts.push(`${r.method()} ${r.url()}`);
  });
  await seed(page, context);
  await expect(wordLinks(page)).toHaveCount(1);
  await expect(wordLinks(page)).toHaveText(topic.name);
  await expect(panel(page).locator(":scope > details")).not.toHaveAttribute(
    "open",
    "",
  );
  expect(
    await page.locator("#rss-reading-extras").getAttribute("open"),
  ).toBeNull();
  const link = wordLinks(page);
  expect(
    new URL((await link.getAttribute("href"))!).searchParams.get("book"),
  ).toBe(bookId);
  expect(
    new URL((await link.getAttribute("href"))!).searchParams.has("article"),
  ).toBe(false);
  await link.scrollIntoViewIfNeeded();
  await link.focus();
  const y = await page.evaluate(() => scrollY),
    url = page.url();
  const opened = context.waitForEvent("page");
  await page.keyboard.press("Enter");
  const book = await opened;
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
  await book.close();
  await expect(page).toHaveURL(url);
  await expect(link).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await openArticle(page, "b");
  await expect(wordLinks(page)).toHaveCount(1);
  const records = await page.evaluate(
    async ({ id, bookId }) => {
      const links = "/src/article-textbooks.ts",
        books = "/src/shared-textbook-store.ts",
        api = await import(books);
      return {
        links: await (await import(links)).readTextbookLinks(id),
        answers: await api.readSharedAnswers(
          await api.readSharedTextbook(bookId),
        ),
      };
    },
    { id: "b", bookId },
  );
  expect(records.links).toEqual([]);
  expect(records.answers).toHaveLength(1);
  expect(posts).toEqual([]);
});

async function holdBookReads(context: BrowserContext) {
  await context.addInitScript(() => {
    const get = IDBObjectStore.prototype.getAll;
    let released = false;
    const completions: (() => void)[] = [];
    IDBObjectStore.prototype.getAll = function (...args) {
      if (!released && this.name === "books") {
        const tx = this.transaction,
          complete = tx.oncomplete;
        tx.oncomplete = (event) => {
          if (released) {
            complete?.call(tx, event);
            return;
          }
          completions.push(() => complete?.call(tx, event));
          Object.assign(window, {
            wordReadHeld: true,
            releaseWordRead: () => {
              released = true;
              for (const finish of completions.splice(0)) finish();
            },
          });
        };
      }
      return get.apply(this, args);
    };
  });
}

test("遅れて教材リンクが届いても本文の選択・ハイライトと読書位置を保持する", async ({
  page,
  context,
}) => {
  await holdBookReads(context);
  await seed(page, context);
  await page.waitForFunction(
    () => (window as unknown as { wordReadHeld: boolean }).wordReadHeld,
  );
  await expect(page.locator(".rss-highlights [role=status]")).toHaveText(
    "気になる言葉を残して、あとで読み返せます。",
  );
  const before = await page.evaluate((name) => {
    const body = document.querySelector(".rss-source-text")!,
      node = body.querySelector("p")!.firstChild!,
      start = node.textContent!.indexOf(name);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + name.length);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(node, start + name.length, node, start);
    return { text: body.textContent, y: scrollY };
  }, topic.name);
  await expect(
    page.getByRole("button", { name: "選択範囲をハイライト", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".rss-highlights [role=status]")).toHaveText(
    "気になる言葉を残して、あとで読み返せます。",
  );
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
    topic.name,
  );
  expect(
    await page.evaluate(() => {
      const s = document.getSelection()!,
        r = s.getRangeAt(0);
      return s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset;
    }),
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { releaseWordRead: () => void }).releaseWordRead(),
  );
  await expect(wordLinks(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
    topic.name,
  );
  expect(
    await page.evaluate(() => {
      const s = document.getSelection()!,
        r = s.getRangeAt(0);
      return s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset;
    }),
  ).toBe(true);
  expect(await page.locator(".rss-source-text").textContent()).toBe(
    before.text,
  );
  expect(await page.evaluate(() => scrollY)).toBe(before.y);
  await page
    .getByRole("button", { name: "選択範囲をハイライト", exact: true })
    .click();
  await expect(page.locator(".rss-highlights blockquote")).toHaveText(
    topic.name,
  );
});

test("教材の後の版と撤回を反映し、教材や過去の回答を消さない", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(wordLinks(page)).toHaveCount(1);
  await page.evaluate(async (text) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.importSharedTextbook(text);
  }, edition(8));
  await expect(wordLinks(page)).toHaveAttribute(
    "href",
    new RegExp("book=" + encodeURIComponent(bookId.replace(":7", ":8"))),
  );
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    for (const version of [7, 8])
      await api.writeTextbookNotice(
        await api.readSharedTextbook(id.replace(":7", ":" + version)),
        { kind: "withdrawn", reason: "合成検査で撤回", evidence: "合成の根拠" },
        null,
      );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
  }, bookId);
  await expect(wordLinks(page)).toHaveCount(0);
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/shared-textbook-store.ts";
      return (await (await import(path)).readSharedTextbook(id)).raw;
    }, bookId),
  ).toBe(raw);
});

async function changeBody(
  page: Page,
  id: string,
  text: string,
  codeRanges: { start: number; end: number; block: boolean }[] = [],
) {
  await page.evaluate(
    async ({ id, text, codeRanges }) => {
      const path = "/src/feed-store.ts",
        db = await (await import(path)).openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite"),
          store = tx.objectStore("articles"),
          req = store.get(id);
        req.onsuccess = () => {
          const article = req.result;
          store.put({
            ...article,
            body: text,
            content: { ...article.content, text, codeRanges },
          });
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { id, text, codeRanges },
  );
}

test("コードと出典の語には重ねず、本文の語だけを教材リンクにする", async ({
  page,
  context,
}) => {
  await seed(page, context);
  const text = `${topic.name}\n\nhttps://example.org/${topic.name}\n\n本文の${topic.name}を読む。`;
  await changeBody(page, "b", text, [
    { start: 0, end: topic.name.length, block: true },
  ]);
  await openArticle(page, "b");
  await expect(wordLinks(page)).toHaveCount(1);
  await expect(
    page.locator(".rss-source-text code .rss-textbook-word-link"),
  ).toHaveCount(0);
  await expect(page.locator(".rss-source-text a a")).toHaveCount(0);
  await expect(wordLinks(page)).toHaveText(topic.name);
  await expect(
    page.locator(
      ".rss-source-text a.rss-body-link:not(.rss-textbook-word-link)",
    ),
  ).toHaveAttribute("href", new URL(`https://example.org/${topic.name}`).href);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".rss-source-text")
    .screenshot({ path: test.info().outputPath("word-links-320.png") });
});

test("読めない教材一覧でも記事と既存の記録を保持し、読み直しでリンクを回復する", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(wordLinks(page)).toHaveCount(1);
  await page.evaluate(async () => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(api.sharedTextbookDatabase, 2);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("books", "readwrite");
        tx.objectStore("books").put({
          id: "broken",
          raw: "保持する不明な教材",
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
  });
  await expect(wordLinks(page)).toHaveCount(0);
  await expect(
    page.getByText(
      "教材のリンクを確認できませんでした。記事と保存済みの記録は保持しています。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(".rss-source-text")).toContainText(topic.name);
  const kept = await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    const book = await api.readSharedTextbook(id);
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(api.sharedTextbookDatabase, 2);
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("books", "readwrite"),
          get = tx.objectStore("books").get("broken");
        get.onsuccess = () => {
          if (get.result.raw !== "保持する不明な教材")
            throw Error("不明な記録が変更された");
          tx.objectStore("books").delete("broken");
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
    return book.raw;
  }, bookId);
  expect(kept).toBe(raw);
  await expect(wordLinks(page)).toHaveCount(1);
});

test("同じ名前の別テーマは一覧で選び、回答や教材を統合しない", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await expect(wordLinks(page)).toHaveCount(1);
  const second = await page.evaluate(async (raw) => {
    const decode = (s: string) =>
      new TextDecoder().decode(
        Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
      );
    const encode = (s: string) =>
      btoa(
        Array.from(new TextEncoder().encode(s), (n) =>
          String.fromCharCode(n),
        ).join(""),
      );
    const envelope = JSON.parse(raw),
      record = JSON.parse(decode(envelope.record)),
      request = JSON.parse(decode(record.request)),
      review = JSON.parse(decode(record.review));
    record.bookID = crypto.randomUUID();
    request.topic.id = crypto.randomUUID();
    const requestRaw = JSON.stringify(request);
    review.requestDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(requestRaw),
        ),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    record.request = encode(requestRaw);
    record.review = encode(JSON.stringify(review));
    envelope.record = encode(JSON.stringify(record));
    const path = "/src/shared-textbook-store.ts",
      api = await import(path),
      book = await api.importSharedTextbook(JSON.stringify(envelope));
    return book.id;
  }, raw);
  await expect(wordLinks(page)).toHaveAttribute("href", new RegExp("term="));
  const opened = context.waitForEvent("page");
  await wordLinks(page).click();
  const catalog = await opened;
  await expect(
    catalog
      .getByRole("region", { name: "保存した教材", exact: true })
      .getByRole("button", { name: /版 7を読む$/ }),
  ).toHaveCount(2);
  await expect(
    catalog.getByText(`「${topic.name}」の教材`, { exact: true }),
  ).toBeVisible();
  expect(second).not.toBe(bookId);
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(api.sharedTextbookDatabase, 2);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("notices", "readwrite");
        tx.objectStore("notices").put({
          id,
          schemaVersion: 99,
          marker: "保持する不明な記録",
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
  }, second);
  await openArticle(page, "b");
  await expect(page.locator(".rss-textbook-links-status")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(wordLinks(page)).toHaveAttribute("href", /term=/);
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(api.sharedTextbookDatabase, 2);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("notices", "readwrite"),
          get = tx.objectStore("notices").get(id);
        get.onsuccess = () => {
          if (get.result.marker !== "保持する不明な記録") {
            tx.abort();
            return;
          }
          tx.objectStore("notices").delete(id);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  }, second);
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.writeTextbookNotice(
      await api.readSharedTextbook(id),
      {
        kind: "withdrawn",
        reason: "同名の別教材を撤回",
        evidence: "合成の根拠",
      },
      null,
    );
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
  }, second);
  await expect(
    catalog
      .getByRole("region", { name: "保存した教材", exact: true })
      .getByRole("button", { name: /版 7を読む$/ }),
  ).toHaveCount(1);
  await catalog
    .getByRole("link", { name: "すべての教材", exact: true })
    .click();
  await expect(
    catalog
      .getByRole("region", { name: "保存した教材", exact: true })
      .getByRole("button", { name: /版 7を読む$/ }),
  ).toHaveCount(2);
  await catalog.close();
});

test("遅れてリンクが追加されてもコードのコピー操作のフォーカスを保つ", async ({
  page,
  context,
}) => {
  await holdBookReads(context);
  await seed(page, context);
  const code = `const answer = "${"long-code-".repeat(100)}";\n`;
  const text = `${code}\n${topic.name}を深掘りする。`;
  await changeBody(page, "b", text, [
    { start: 0, end: code.length, block: true },
  ]);
  await openArticle(page, "b");
  await expect(page.locator(".rss-highlights [role=status]")).toHaveText(
    "気になる言葉を残して、あとで読み返せます。",
  );
  await page.waitForFunction(
    () => (window as unknown as { wordReadHeld: boolean }).wordReadHeld,
  );
  const copy = page.getByRole("button", {
    name: "コードをコピー",
    exact: true,
  });
  await copy.focus();
  const y = await page.evaluate(() => scrollY);
  const left = await page.locator(".rss-source-text pre").evaluate((pre) => {
    pre.scrollLeft = 80;
    return pre.scrollLeft;
  });
  expect(left).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".rss-highlights [role=status]")).toHaveText(
    "気になる言葉を残して、あとで読み返せます。",
  );
  await expect(copy).toBeFocused();
  expect(
    await page
      .locator(".rss-source-text pre")
      .evaluate((pre) => pre.scrollLeft),
  ).toBe(left);
  await page.evaluate(() =>
    (window as unknown as { releaseWordRead: () => void }).releaseWordRead(),
  );
  await expect(wordLinks(page)).toHaveCount(1);
  await expect(copy).toBeFocused();
  expect(
    await page
      .locator(".rss-source-text pre")
      .evaluate((pre) => pre.scrollLeft),
  ).toBe(left);
  expect(await page.evaluate(() => scrollY)).toBe(y);
});

test("前の記事の遅い教材確認で次の記事にリンクを作らない", async ({
  page,
  context,
}) => {
  await holdBookReads(context);
  await seed(page, context);
  await page.waitForFunction(
    () => (window as unknown as { wordReadHeld: boolean }).wordReadHeld,
  );
  const text = "この別の記事には教材と一致する名前がありません。";
  await changeBody(page, "b", text);
  await openArticle(page, "b");
  await page.evaluate(() =>
    (window as unknown as { releaseWordRead: () => void }).releaseWordRead(),
  );
  await expect(page.locator(".rss-textbook-links-status")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(wordLinks(page)).toHaveCount(0);
  await expect(page.locator(".rss-source-text")).toHaveText(text);
});

test("本文の教材リンクを検証済みアカウントごとに分離し、以前の回答を保持する", async ({
  page,
  context,
}) => {
  let owner = "a".repeat(64);
  await context.route("**/api/**", (r) => r.fulfill({ status: 404, json: {} }));
  await context.route("**/api/library/status", (r) => {
    const expected = r.request().headers()["x-library-account"];
    return r.fulfill({
      status: expected && expected !== owner ? 403 : 200,
      json: { schema: 1, account: owner, legacy: false },
    });
  });
  await context.route(
    (url) => url.pathname === "/",
    async (r) => {
      const response = await r.fetch();
      await r.fulfill({
        response,
        body: (await response.text()).replace(
          "</head>",
          '<meta name="account-libraries" content="required"></head>',
        ),
      });
    },
  );
  await page.route("**/__account_words", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="account-libraries" content="required"><title>Account fixture</title>',
    }),
  );
  const open = async (withBook: boolean) => {
    await page.goto("/__account_words");
    await page.evaluate(
      async ({ raw, name, withBook }) => {
        const ctx = "/src/library-context.ts",
          context = await import(ctx);
        await context.initializeLibraryContext();
        localStorage.setItem(
          context.libraryName("quilna.feed.refresh.v1"),
          "0",
        );
        localStorage.setItem(
          context.libraryName("quilna.article.updates.v1"),
          "false",
        );
        const books = "/src/shared-textbook-store.ts",
          api = await import(books);
        if (withBook) {
          const book = await api.importSharedTextbook(raw);
          if (!(await api.readSharedAnswers(book)).length) {
            const lesson = book.draft.lessons[0];
            await api.answerSharedTextbook(
              book,
              lesson.content.id,
              lesson.content.question.correctOptionID,
            );
          }
        }
        const feed = "/src/feed-store.ts",
          db = await (await import(feed)).openFeedLibrary();
        const text = `この記事では${name}を学びます。`;
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("articles", "readwrite");
          tx.objectStore("articles").put({
            id: "a",
            title: "教材記事 a",
            url: "https://example.org/account-article",
            feedUrl: "",
            published: null,
            fetchedAt: "2026-11-17T00:00:00Z",
            body: text,
            read: true,
            saved: true,
            content: {
              text,
              title: "教材記事 a",
              url: "https://example.org/account-article",
              language: "ja",
              fetchedAt: "2026-11-17T00:00:00Z",
              codeRanges: [],
            },
          });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
      },
      { raw, name: topic.name, withBook },
    );
    await page.goto("/?view=feeds");
    await openArticle(page, "a");
    await expect(
      page.locator(".rss-textbook-links-status"),
    ).not.toHaveAttribute("aria-busy", "true");
  };
  await open(true);
  await expect(wordLinks(page)).toHaveCount(1);
  owner = "b".repeat(64);
  await open(false);
  await expect(wordLinks(page)).toHaveCount(0);
  owner = "a".repeat(64);
  await open(false);
  await expect(wordLinks(page)).toHaveCount(1);
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/shared-textbook-store.ts",
        api = await import(path);
      return (await api.readSharedAnswers(await api.readSharedTextbook(id)))
        .length;
    }, bookId),
  ).toBe(1);
});

test("別タブの実際の取り込みで、記事へフォーカスを戻さず教材リンクを更新する", async ({
  page,
  context,
}) => {
  await context.addInitScript(() =>
    window.addEventListener(
      "focus",
      (event) => {
        if (event.target === window) event.stopImmediatePropagation();
      },
      true,
    ),
  );
  await page.route("**/__word_import_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Word link fixture</title>",
    }),
  );
  await page.goto("/__word_import_fixture");
  await page.evaluate(
    async ({ raw, name }) => {
      const books = "/src/shared-textbook-store.ts",
        highlightPath = "/src/article-highlight-view.ts",
        wordsPath = "/src/article-textbook-words.ts";
      await (await import(books)).importSharedTextbook(raw);
      const { ArticleHighlightView } = await import(highlightPath),
        { ArticleTextbookWords } = await import(wordsPath);
      const view = {
        articleId: "import-fixture",
        title: "取り込みの通知",
        url: "https://example.org/article",
        original: name,
        text: name,
        view: "original",
        language: "ja",
        ranges: [],
      };
      const body = document.createElement("div");
      body.className = "rss-source-text";
      const highlights = new ArticleHighlightView(
        () => {},
        () => {},
      );
      const words = new ArticleTextbookWords(
        (current: typeof view, links: unknown[]) =>
          highlights.setTextbookLinks(current, links),
      );
      document.body.append(
        body,
        highlights.mount(view, body),
        words.mount(view, body),
      );
    },
    { raw, name: topic.name },
  );
  await expect(wordLinks(page)).toHaveAttribute(
    "href",
    new RegExp("book=" + encodeURIComponent(bookId)),
  );
  await expect(page.locator(".rss-textbook-links-status")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  const other = await context.newPage();
  await other.goto("/?view=textbooks");
  const file = test.info().outputPath("edition-8.json");
  await writeFile(file, edition(8));
  await other
    .getByLabel("教材JSONファイル（540,000バイト以下）")
    .setInputFiles(file);
  await other
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect(other.getByRole("status")).toContainText("教材を取り込みました");
  await expect(wordLinks(page)).toHaveAttribute(
    "href",
    new RegExp("book=" + encodeURIComponent(bookId.replace(":7", ":8"))),
  );
  await other.close();
});

test("対象外の教材しかない名前の一覧で、保存されていないと誤表示しない", async ({
  page,
  context,
}) => {
  await seed(page, context);
  await page.evaluate(async (id) => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path);
    await api.writeTextbookNotice(
      await api.readSharedTextbook(id),
      { kind: "withdrawn", reason: "合成の撤回", evidence: "合成の根拠" },
      null,
    );
  }, bookId);
  await page.goto("/?view=textbooks&term=" + encodeURIComponent(topic.name));
  await expect(
    page.getByText(
      "この名前で新しく案内できる版はありません。保存済みの版は「すべての教材」から確認できます。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: "すべての教材", exact: true }).click();
  await expect(page.getByRole("button", { name: /版 7を読む$/ })).toBeVisible();
});

test("教材の取り込みは確定した新規保存だけを通知し、中断と重複を通知しない", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  const result = await page.evaluate(
    async ({ raw, later }) => {
      const path = "/src/shared-textbook-store.ts",
        api = await import(path);
      await api.importSharedTextbook(raw);
      const add = IDBObjectStore.prototype.add,
        transaction = IDBDatabase.prototype.transaction,
        post = BroadcastChannel.prototype.postMessage;
      let abortNext = true,
        committed = false;
      const notifications: { committed: boolean; id: string }[] = [];
      // 保存処理の oncomplete 登録より前に、実際の確定を観測する。
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (this.name.includes("shared-textbooks") && tx.mode === "readwrite") {
          tx.addEventListener("complete", () => {
            committed = true;
          });
        }
        return tx;
      };
      IDBObjectStore.prototype.add = function (...args) {
        const request = add.apply(this, args);
        if (this.name === "books") {
          const tx = this.transaction;
          if (abortNext) {
            abortNext = false;
            request.addEventListener("success", () => tx.abort());
          }
        }
        return request;
      };
      BroadcastChannel.prototype.postMessage = function (message) {
        if (message?.kind === "import")
          notifications.push({ committed, id: message.id });
        return post.call(this, message);
      };
      try {
        let rejected = false;
        try {
          await api.importSharedTextbook(later);
        } catch {
          rejected = true;
        }
        const afterAbort = notifications.length;
        await api.importSharedTextbook(raw);
        const afterDuplicate = notifications.length;
        await Promise.all([
          api.importSharedTextbook(later),
          api.importSharedTextbook(later),
        ]);
        return {
          rejected,
          afterAbort,
          afterDuplicate,
          notifications,
          original: (
            await api.readSharedTextbook(
              "dc74d775-eab8-4384-81ae-d741162c0d49:7",
            )
          ).raw,
        };
      } finally {
        IDBObjectStore.prototype.add = add;
        IDBDatabase.prototype.transaction = transaction;
        BroadcastChannel.prototype.postMessage = post;
      }
    },
    { raw, later: edition(8) },
  );
  expect(result.rejected).toBe(true);
  expect(result.afterAbort).toBe(0);
  expect(result.afterDuplicate).toBe(0);
  expect(result.notifications).toEqual([
    { committed: true, id: bookId.replace(":7", ":8") },
  ]);
  expect(result.original).toBe(raw);
});
