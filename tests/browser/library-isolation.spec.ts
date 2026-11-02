import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import crossref from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefMetadata, paperSnapshot } from "../../src/paper-format";

const rawBook = new TextDecoder().decode(
  await readFile("tests/fixtures/shared-textbook-v1.json"),
);
const paper = await paperSnapshot(
  crossrefMetadata(crossref, crossref.message.DOI),
  "2026-11-01T00:00:00.000Z",
);
const paperXML = new TextDecoder().decode(await readFile("tests/fixtures/europepmc-work.xml"));
const alice = { schema: 1, account: "a".repeat(64), legacy: true };
const bob = { schema: 1, account: "b".repeat(64), legacy: false };
/** Keep the account boundary local and synthetic; only the status route is controlled. */
async function fixture(context: BrowserContext) {
  const state = {
    identity: alice,
    required: true,
    unavailable: false,
    statusGate: null as Promise<void> | null,
    statusRequests: 0,
    initialStatusRequests: 0,
  };
  await context.route("**/api/**", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await context.route("**/api/library/status", async (route) => {
    state.statusRequests++;
    if (!route.request().headers()["x-library-account"])
      state.initialStatusRequests++;
    if (state.statusGate) await state.statusGate;
    const expected = route.request().headers()["x-library-account"];
    return route.fulfill({
      status: state.unavailable
        ? 503
        : expected && expected !== state.identity.account
          ? 403
          : 200,
      json: state.unavailable
        ? { status: "library-unavailable" }
        : state.identity,
    });
  });
  await context.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        response,
        body: state.required
          ? body.replace(
              "</head>",
              '<meta name="account-libraries" content="required"></head>',
            )
          : body,
      });
    },
  );
  await context.route("**/__library-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local library fixture</title>",
    }),
  );
  return state;
}
/** Save valid records through maintained storage APIs, including private answers and immutable facts. */
async function seed(page: Page, owner: string) {
  return page.evaluate(
    async ({ owner, rawBook, paper, paperXML }) => {
      const paths = [
        "/src/feed-store.ts",
        "/src/article-highlights.ts",
        "/src/article-learning.ts",
        "/src/shared-textbook-store.ts",
        "/src/paper-store.ts",
        "/src/library-context.ts",
        "/src/history.ts",
      ];
      const feeds: typeof import("../../src/feed-store") = await import(
        paths[0]
      );
      const highlights: typeof import("../../src/article-highlights") =
        await import(paths[1]);
      const learning: typeof import("../../src/article-learning") =
        await import(paths[2]);
      const books: typeof import("../../src/shared-textbook-store") =
        await import(paths[3]);
      const papers: typeof import("../../src/paper-store") = await import(
        paths[4]
      );
      const { libraryName }: typeof import("../../src/library-context") =
        await import(paths[5]);
      const history: typeof import("../../src/history") = await import(
        paths[6]
      );
      const db = await feeds.openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        tx.objectStore("articles").put({
          id: "same-article",
          feedUrl: "",
          title: `Private ${owner}`,
          url: "https://example.org/article",
          body: "Evidence",
          published: null,
          fetchedAt: "2026-11-01T00:00:00Z",
          read: true,
          saved: true,
        });
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
      const highlight = {
        id: "00000000-0000-4000-8000-000000000001",
        articleId: "same-article",
        title: `Private ${owner}`,
        url: "https://example.org/article",
        view: "original" as const,
        language: "en",
        version: await highlights.highlightVersion(
          "Evidence",
          "Evidence",
          "original",
          "en",
        ),
        start: 0,
        end: 8,
        quote: "Evidence",
        note: `Note ${owner}`,
        createdAt: "2026-11-01T00:00:00Z",
        revision: 1,
      };
      await highlights.writeHighlight(highlight, null);
      const connectionPath = "/src/article-connections.ts",
        quotePath = "/src/quote-connections.ts";
      const connections: typeof import("../../src/article-connections") =
        await import(connectionPath);
      const quotes: typeof import("../../src/quote-connections") = await import(
        quotePath
      );
      const members: [string, string] = ["other-article", "same-article"];
      await connections.writeConnection(
        {
          id: connections.connectionKey(...members),
          members,
          from: {
            id: "same-article",
            title: `Private ${owner}`,
            url: highlight.url,
          },
          to: {
            id: "other-article",
            title: `Other ${owner}`,
            url: "https://example.org/other",
          },
          state: "linked",
          reason: `Article relation ${owner}`,
          createdAt: highlight.createdAt,
          revision: 1,
        },
        null,
      );
      const other = {
        ...highlight,
        id: "00000000-0000-4000-8000-000000000003",
        articleId: "other-article",
        note: `Other note ${owner}`,
      };
      await quotes.writeQuoteConnection(
        {
          id: connections.connectionKey(highlight.id, other.id),
          members: [highlight.id, other.id],
          articles: members,
          from: highlight,
          to: other,
          reason: `Quote relation ${owner}`,
          createdAt: highlight.createdAt,
          revision: 1,
        },
        null,
      );

      await learning.writeLearning(
        {
          id: "00000000-0000-4000-8000-000000000002",
          articleId: highlight.articleId,
          source: highlight,
          reflection: `Reflection ${owner}`,
          createdAt: highlight.createdAt,
          revision: 1,
        },
        null,
      );
      const book = await books.importSharedTextbook(rawBook),
        section = book.draft.lessons[0].content;
      await books.answerSharedTextbook(
        book,
        section.id,
        section.question.options[0].id,
      );
      await papers.savePaper(paper);
      const jatsPath = "/src/paper-jats.ts", excerptPath = "/src/paper-text-format.ts", excerptStorePath = "/src/paper-excerpt-store.ts";
      const jats: typeof import("../../src/paper-jats") = await import(jatsPath);
      const format: typeof import("../../src/paper-text-format") = await import(excerptPath);
      const excerpts: typeof import("../../src/paper-excerpt-store") = await import(excerptStorePath);
      const source = await jats.parsePaperJATS(paperXML, "PMC1234567", paper, "2026-11-03T00:00:01.000Z");
      const selected = source.facts.blocks[owner === "alice" ? 0 : 1];
      await excerpts.savePaperExcerpt(await format.paperExcerpt(source, selected.path, 0, selected.text.length));
      const record = history.emptyHistory();
      localStorage.setItem(
        libraryName(history.storageKey),
        JSON.stringify(record),
      );
      localStorage.setItem(
        libraryName("quilna.reader.design.v1"),
        owner === "alice" ? "editorial" : "focus",
      );
      return {
        historyId: record.userId,
        paperDigest: paper.digest,
        book: book.id,
      };
    },
    { owner, rawBook, paper, paperXML },
  );
}
/** Read the selected namespace without relying on UI notices or inspecting another account's raw DB. */
async function inspect(page: Page) {
  return page.evaluate(async () => {
    const paths = [
      "/src/feed-store.ts",
      "/src/article-highlights.ts",
      "/src/article-learning.ts",
      "/src/shared-textbook-store.ts",
      "/src/paper-store.ts",
      "/src/library-context.ts",
    ];
    const feeds: typeof import("../../src/feed-store") = await import(paths[0]);
    const highlights: typeof import("../../src/article-highlights") =
      await import(paths[1]);
    const learning: typeof import("../../src/article-learning") = await import(
      paths[2]
    );
    const books: typeof import("../../src/shared-textbook-store") =
      await import(paths[3]);
    const papers: typeof import("../../src/paper-store") = await import(
      paths[4]
    );
    const { libraryName }: typeof import("../../src/library-context") =
      await import(paths[5]);
    const db = await feeds.openFeedLibrary();
    const articles = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("articles"),
        get = tx.objectStore("articles").getAll();
      tx.oncomplete = () => resolve(get.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
    const connectionPath = "/src/article-connections.ts",
      quotePath = "/src/quote-connections.ts";
    const connections: typeof import("../../src/article-connections") =
      await import(connectionPath);
    const quotes: typeof import("../../src/quote-connections") = await import(
      quotePath
    );
    const excerptStorePath = "/src/paper-excerpt-store.ts";
    const excerpts: typeof import("../../src/paper-excerpt-store") = await import(excerptStorePath);
    const imported = await books.listSharedTextbooks();
    return {
      database: feeds.feedDatabase,
      articles,
      highlights: await highlights.readHighlights("same-article"),
      learning: await learning.readLearning("same-article"),
      connections: await connections.readConnections("same-article"),
      quoteConnections:
        await quotes.readArticleQuoteConnections("same-article"),
      books: imported.map((book) => book.id),
      answers: await Promise.all(
        imported.map((book) => books.readSharedAnswers(book)),
      ),
      papers: (await papers.listPapers()).snapshots.map((p) => p.digest),
      excerpts: (await excerpts.listPaperExcerpts()).records.map((r) => r.text),
      history: localStorage.getItem(libraryName("fieldnotes.history.v1")),
      design: localStorage.getItem(libraryName("quilna.reader.design.v1")),
    };
  });
}
async function ready(page: Page) {
  await expect(page.getByLabel("サイト・RSSのURL")).toBeVisible();
}

test("same profile alice→bob→alice retains legacy records and separates notes, learning, book answers, papers and preferences", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/__library-fixture");
  const original = await seed(page, "alice");
  await page.goto("/?view=feeds");
  await ready(page);
  const a = await inspect(page);
  expect(a.database).toBe("tsumiki.rss.v1");
  expect(a.highlights[0].note).toBe("Note alice");
  expect(a.connections[0].reason).toBe("Article relation alice");
  expect(a.quoteConnections[0].reason).toBe("Quote relation alice");
  expect(a.answers[0]).toHaveLength(1);
  expect(a.excerpts).toEqual(["Evidence😀 & exact quote."]);
  state.identity = bob;
  await page.reload();
  await ready(page);
  const empty = await inspect(page);
  expect(empty.database).toBe(`tsumiki.rss.v1.account.${bob.account}`);
  for (const key of [
    "articles",
    "highlights",
    "learning",
    "connections",
    "quoteConnections",
    "books",
    "answers",
    "papers",
    "excerpts",
  ] as const)
    expect(empty[key]).toEqual([]);
  expect(empty.history).toBeNull();
  expect(empty.design).toBeNull();
  const second = await seed(page, "bob");
  expect(second.historyId).not.toBe(original.historyId);
  await page.reload();
  await ready(page);
  expect((await inspect(page)).highlights[0].note).toBe("Note bob");
  expect((await inspect(page)).excerpts).toEqual(["CO_{2} x^{3}."]);
  state.identity = alice;
  await page.reload();
  await ready(page);
  expect(await inspect(page)).toEqual(a);
});

test("a changed legacy assignment or disabled flag preserves the old library and refuses a shared fallback", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/__library-fixture");
  await seed(page, "alice");
  await page.goto("/?view=feeds");
  await ready(page);
  const before = await inspect(page);
  state.identity = { ...bob, legacy: true };
  await page.reload();
  await expect(page.getByText(/ライブラリを開けませんでした/)).toBeVisible();
  await expect(page.getByText("Private alice", { exact: true })).toHaveCount(0);
  state.identity = alice;
  state.required = false;
  state.unavailable = true;
  await page.reload();
  await expect(page.getByText(/ライブラリを開けませんでした/)).toBeVisible();
  state.required = true;
  state.unavailable = false;
  await page.reload();
  await ready(page);
  expect(await inspect(page)).toEqual(before);
});

test("other account boot invalidates every old tab, while a loaded account can keep reading offline", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/__library-fixture");
  await seed(page, "alice");
  await page.goto("/?view=feeds");
  await ready(page);
  await expect(
    page.getByRole("button", { name: "Private alice", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Private alice", exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  state.identity = bob;
  const other = await context.newPage();
  await other.goto("/?view=feeds");
  await ready(other);
  await expect
    .poll(async () => (await inspect(page)).database)
    .toBe(`tsumiki.rss.v1.account.${bob.account}`);
  await expect(
    page.getByRole("button", { name: "Private alice", exact: true }),
  ).toHaveCount(0);
  expect((await inspect(other)).articles).toEqual([]);
});

for (const damage of ["future", "corrupt", "shape"] as const) {
  test(`a ${damage} assignment registry is preserved without opening a shared fallback`, async ({
    page,
    context,
  }) => {
    await fixture(context);
    await page.goto("/__library-fixture");
    await seed(page, "alice");
    await page.evaluate(async (damage) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(
          "quilna.library-bindings.v1",
          damage === "future" ? 2 : 1,
        );
        open.onupgradeneeded = () =>
          open.result.createObjectStore("bindings", {
            keyPath: damage === "shape" ? "id" : "key",
          });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("bindings", "readwrite");
        tx.objectStore("bindings").put({
          key: "account:" + "a".repeat(64),
          ...(damage === "shape" ? { id: "untouched" } : {}),
          schema: 2,
          account: "a".repeat(64),
          legacy: true,
          evidence: "retain unknown data",
        });
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, damage);
    await page.goto("/?view=feeds");
    await expect(page.getByText(/ライブラリを開けませんでした/)).toBeVisible();
    const retained = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("quilna.library-bindings.v1");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const version = db.version;
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction("bindings"),
          get = tx.objectStore("bindings").getAll();
        tx.oncomplete = () => resolve(get.result);
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
      return { version, rows };
    });
    expect(retained).toEqual({
      version: damage === "future" ? 2 : 1,
      rows: [
        {
          key: "account:" + alice.account,
          ...(damage === "shape" ? { id: "untouched" } : {}),
          schema: 2,
          account: alice.account,
          legacy: true,
          evidence: "retain unknown data",
        },
      ],
    });
    // Direct raw inspection is limited to proving retained old data was not erased.
    expect(
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open("tsumiki.rss.v1");
          r.onsuccess = () => resolve(r.result);
        });
        const records = await new Promise<unknown[]>((resolve) => {
          const tx = db.transaction("articles"),
            get = tx.objectStore("articles").getAll();
          tx.oncomplete = () => resolve(get.result);
        });
        db.close();
        return records;
      }),
    ).toEqual([expect.objectContaining({ title: "Private alice" })]);
  });
}

test("an aborted assignment write retains the old library and explicit retry recovers it", async ({
  page,
  context,
}) => {
  await fixture(context);
  await page.goto("/__library-fixture");
  await seed(page, "alice");
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (
        this.name === "quilna.library-bindings.v1" &&
        tx.mode === "readwrite" &&
        !localStorage.getItem("__registry-aborted-once")
      ) {
        localStorage.setItem("__registry-aborted-once", "yes");
        queueMicrotask(() => tx.abort());
      }
      return tx;
    };
  });
  await page.goto("/?view=feeds");
  await expect(page.getByText(/ライブラリを開けませんでした/)).toBeVisible();
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await ready(page);
  const records = await inspect(page);
  expect(records.highlights[0].note).toBe("Note alice");
  expect(records.answers[0]).toHaveLength(1);
  expect(records.articles).toEqual([
    expect.objectContaining({ title: "Private alice" }),
  ]);
});

test("restored pages remain hidden until account verification completes", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/__library-fixture");
  await seed(page, "alice");
  await page.goto("/?view=feeds");
  await ready(page);
  let release!: () => void;
  state.statusGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = state.statusRequests;
  state.identity = bob;
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  try {
    await expect.poll(() => state.statusRequests).toBeGreaterThan(before);
    await expect(page.locator("html")).toHaveCSS("display", "none");
  } finally {
    release();
  }
  await ready(page);
  expect((await inspect(page)).articles).toEqual([]);
});

test("repeated initialization keeps one document assignment without rebinding", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/__library-fixture");
  await seed(page, "alice");
  await page.goto("/?view=feeds");
  await ready(page);
  const before = await inspect(page),
    requests = state.initialStatusRequests;
  await page.evaluate(async () => {
    const path = "/src/library-context.ts";
    const api: typeof import("../../src/library-context") = await import(path);
    await Promise.all([
      api.initializeLibraryContext(),
      api.initializeLibraryContext(),
    ]);
  });
  expect(state.initialStatusRequests).toBe(requests);
  expect(await inspect(page)).toEqual(before);
});

test("failed logout keeps the account library visible and allows explicit retry", async ({
  page,
  context,
}) => {
  await fixture(context);
  await page.goto("/__library-fixture");
  await seed(page, "alice");
  await page.goto("/?view=feeds");
  await ready(page);
  const before = await inspect(page);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const logout = page.getByRole("button", { name: "ログアウト", exact: true });
  await logout.click();
  await expect(page.getByRole("dialog")).toContainText(
    "ログアウトを確認できませんでした",
  );
  await expect(logout).toBeEnabled();
  expect(await inspect(page)).toEqual(before);
  await expect(page.locator("html")).not.toHaveCSS("display", "none");
});

test("demo lesson interactions write only the selected account history", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/?view=lesson#read");
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("fieldnotes.history.v1") ?? "null")
            ?.resume?.blockId,
      ),
    )
    .toBe("explore");
  const a = await page.evaluate(() =>
    localStorage.getItem("fieldnotes.history.v1"),
  );
  state.identity = bob;
  // Changing only the hash is a same-document navigation, not a new login boot.
  await page.goto("/__library-fixture");
  await page.goto("/?view=lesson#read");
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  const bKey = `fieldnotes.history.v1.account.${bob.account}`;
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key) ?? "null")?.resume?.blockId,
        bKey,
      ),
    )
    .toBe("explore");
  const b = await page.evaluate((key) => localStorage.getItem(key), bKey);
  expect(JSON.parse(b!).userId).not.toBe(JSON.parse(a!).userId);
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes.history.v1")),
  ).toBe(a);
  state.identity = alice;
  await page.goto("/__library-fixture");
  await page.goto("/?view=lesson#read");
  await expect(
    page.getByRole("button", { name: "次へ →", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("fieldnotes.history.v1")!).userId,
    ),
  ).toBe(JSON.parse(a!).userId);
});
