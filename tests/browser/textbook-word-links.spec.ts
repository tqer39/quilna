import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
            `記事${id}から${name}を深掘りする。同じテーマは共通の教材を使います。 `.repeat(
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
    if (r.method() === "POST" && new URL(r.url()).pathname.includes("textbook"))
      posts.push(r.url());
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

test("遅れて教材リンクが届いても本文の選択・ハイライトと読書位置を保持する", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    const get = IDBObjectStore.prototype.getAll;
    let released = false;
    const completions: (() => void)[] = [];
    IDBObjectStore.prototype.getAll = function (...args) {
      if (!released && this.name === "books") {
        const tx = this.transaction,
          complete = tx.oncomplete;
        tx.oncomplete = (event) => {
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
    selection.removeAllRanges();
    selection.addRange(range);
    return { text: body.textContent, y: scrollY };
  }, topic.name);
  await expect(
    page.getByRole("button", { name: "選択範囲をハイライト", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    (window as unknown as { releaseWordRead: () => void }).releaseWordRead(),
  );
  await expect(wordLinks(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
    topic.name,
  );
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
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
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
    const channel = new BroadcastChannel(api.sharedTextbookDatabase);
    channel.postMessage("changed");
    channel.close();
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
  await catalog.close();
});
