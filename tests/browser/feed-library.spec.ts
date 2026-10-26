import { expect, test } from "@playwright/test";

const database = "quilna.synthetic.batch-read";
async function fixture(page: import("@playwright/test").Page) {
  // Isolated test profile and database, without starting the reader/collector.
  await page.goto("/favicon.ico");
  await page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("feeds", { keyPath: "url" });
        request.result.createObjectStore("articles", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
    });
    const path = "/src/feed-store.ts";
    const { readFeedLibrary } = await import(path);
    const empty = await readFeedLibrary(db);
    if (empty.articles.length || empty.feeds.length) throw Error("Not empty");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["feeds", "articles"], "readwrite");
      tx.objectStore("feeds").put({
        url: "https://example.org/rss",
        title: "before",
        fetchedAt: "2026-10-24T00:00:00Z",
      });
      const ids = [
        "",
        "é",
        "e\u0301",
        "📖",
        ...Array.from({ length: 1000 }, (_, i) => String(i).padStart(4, "0")),
      ];
      for (const id of ids)
        tx.objectStore("articles").put({
          id,
          title: id,
          body: "before",
          feedUrl: "",
          url: "",
          fetchedAt: "2026-10-24T00:00:00Z",
          published: null,
          read: false,
          saved: false,
        });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }, database);
}

test("bounded library reads preserve one complete snapshot while a writer waits", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async (name) => {
    const open = () =>
      new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
      });
    const db = await open(),
      writer = await open();
    const path = "/src/feed-store.ts";
    const { readFeedLibrary } = await import(path);
    const original = IDBObjectStore.prototype.getAll;
    const sizes: number[] = [];
    const transactions = new Set<IDBTransaction>();
    let write: Promise<void> | undefined;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = original.apply(this, args);
      if (this.name === "articles" && this.transaction.db.name === name) {
        transactions.add(this.transaction);
        request.addEventListener("success", () => {
          sizes.push(request.result.length);
          if (write) return;
          // Queued during the first batch, before any later batch is requested.
          write = new Promise<void>((resolve, reject) => {
            const tx = writer.transaction(["feeds", "articles"], "readwrite");
            tx.objectStore("feeds").put({
              url: "https://example.org/rss",
              title: "after",
              fetchedAt: "2026-10-25T00:00:00Z",
            });
            const store = tx.objectStore("articles");
            const get = store.get("0999");
            get.onsuccess = () => {
              store.put({ ...get.result, body: "after" });
              store.put({ ...get.result, id: "new", body: "added" });
            };
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(tx.error);
          });
        });
      }
      return request;
    };
    try {
      const snapshot = await readFeedLibrary(db);
      IDBObjectStore.prototype.getAll = original;
      await write;
      const current = await readFeedLibrary(db);
      const ids = [
        "",
        "é",
        "e\u0301",
        "📖",
        ...Array.from({ length: 1000 }, (_, i) => String(i).padStart(4, "0")),
      ].sort(indexedDB.cmp.bind(indexedDB));
      return {
        sizes,
        transactions: transactions.size,
        complete:
          JSON.stringify(snapshot.articles.map((a: { id: string }) => a.id)) ===
          JSON.stringify(ids),
        beforeFeed: snapshot.feeds[0].title,
        allBefore: snapshot.articles.every(
          (a: { body: string }) => a.body === "before",
        ),
        afterFeed: current.feeds[0].title,
        afterBody: current.articles.find((a: { id: string }) => a.id === "0999")
          .body,
        afterCount: current.articles.length,
      };
    } finally {
      IDBObjectStore.prototype.getAll = original;
      db.close();
      writer.close();
    }
  }, database);
  expect(result.sizes.length).toBeGreaterThan(1);
  expect(Math.max(...result.sizes)).toBeLessThanOrEqual(500);
  expect(result).toMatchObject({
    transactions: 1,
    complete: true,
    beforeFeed: "before",
    allBefore: true,
    afterFeed: "after",
    afterBody: "after",
    afterCount: 1005,
  });
});

for (const failure of ["invalid", "abort"] as const) {
  test(`a late ${failure} batch rejects the whole read without changing stored articles`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page);
    const result = await page.evaluate(
      async ({ name, failure }) => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
        });
        if (failure === "invalid")
          await new Promise<void>((resolve) => {
            const tx = db.transaction("articles", "readwrite");
            const store = tx.objectStore("articles"),
              get = store.get("0999");
            get.onsuccess = () => store.put({ ...get.result, read: "invalid" });
            tx.oncomplete = () => resolve();
          });
        const path = "/src/feed-store.ts";
        const { readFeedLibrary } = await import(path);
        const original = IDBObjectStore.prototype.getAll;
        let batches = 0,
          requests = 0;
        IDBObjectStore.prototype.getAll = function (...args) {
          const request = original.apply(this, args);
          if (this.name === "articles" && this.transaction.db.name === name) {
            const tx = this.transaction;
            const ordinal = ++requests;
            request.addEventListener("success", () => {
              batches++;
            });
            // Register after the reader's synchronous onsuccess assignment.
            // Abort after its second callback has queued the next request,
            // rather than interrupting that callback halfway through.
            if (failure === "abort" && ordinal === 2)
              queueMicrotask(() =>
                request.addEventListener("success", () => tx.abort()),
              );
          }
          return request;
        };
        let error = "",
          published = false;
        try {
          await readFeedLibrary(db);
          published = true;
        } catch (reason) {
          error = (reason as Error).message;
        } finally {
          IDBObjectStore.prototype.getAll = original;
        }
        const stored = await new Promise<{ count: number; read: unknown }>(
          (resolve) => {
            const tx = db.transaction("articles", "readonly");
            const store = tx.objectStore("articles"),
              count = store.count(),
              get = store.get("0999");
            tx.oncomplete = () =>
              resolve({ count: count.result, read: get.result.read });
          },
        );
        db.close();
        return { batches, error, published, stored };
      },
      { name: database, failure },
    );
    expect(result.batches).toBeGreaterThanOrEqual(2);
    expect(result.published).toBe(false);
    expect(result.error).toContain(
      failure === "invalid" ? "保存データの形式" : "読み込めません",
    );
    expect(result.stored).toEqual({
      count: 1004,
      read: failure === "invalid" ? "invalid" : false,
    });
    expect(errors).toEqual([]);
  });
}
