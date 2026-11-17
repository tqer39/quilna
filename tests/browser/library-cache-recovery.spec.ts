import { test, expect, type Page } from "@playwright/test";

const modules = [
  {
    label: "ハイライト",
    path: "/src/article-highlights.ts",
    open: "openHighlights",
    read: "readHighlights",
    write: "writeHighlight",
    store: "highlights",
    kind: "highlight",
  },
  {
    label: "記事の関係",
    path: "/src/article-connections.ts",
    open: "openConnections",
    read: "readConnections",
    write: "writeConnection",
    store: "connections",
    kind: "article",
  },
  {
    label: "学び",
    path: "/src/article-learning.ts",
    open: "openLearning",
    read: "readLearning",
    write: "writeLearning",
    store: "records",
    kind: "learning",
  },
  {
    label: "引用の関係",
    path: "/src/quote-connections.ts",
    open: "openQuoteConnections",
    read: "readArticleQuoteConnections",
    write: "writeQuoteConnection",
    store: "connections",
    kind: "quote",
  },
];
async function fixture(page: Page) {
  await page.route("**/__cache_fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>保存接続の検証</title>",
    }),
  );
  await page.goto("/__cache_fixture");
}
for (const module of modules) {
  for (const mode of [
    "normal",
    "forced-event",
    "missed-read",
    "missed-write",
  ]) {
    test(`${module.label}: ${mode} 後に保存値を保持して明示的な再試行で回復する`, async ({
      page,
    }) => {
      await fixture(page);
      const result = await page.evaluate(
        async ({ module, mode }) => {
          const api = await import(module.path);
          const source = {
            id: "ac334bc2-50c4-4ee5-b29e-33a203f118d1",
            articleId: "a",
            title: "保存した記事",
            url: "https://example.org/a",
            view: "original",
            language: "ja",
            version: "a".repeat(64),
            start: 0,
            end: 2,
            quote: "引用",
            note: "個人メモ",
            createdAt: "2026-11-17T00:00:00Z",
            revision: 1,
          };
          const other = {
            ...source,
            id: "bc334bc2-50c4-4ee5-b29e-33a203f118d1",
            articleId: "b",
          };
          const members =
            module.kind === "quote" ? [source.id, other.id].sort() : ["a", "b"];
          const record =
            module.kind === "highlight"
              ? source
              : module.kind === "learning"
                ? {
                    id: source.id,
                    articleId: "a",
                    source,
                    reflection: "学んだ内容",
                    createdAt: source.createdAt,
                    revision: 1,
                  }
                : module.kind === "article"
                  ? {
                      id: JSON.stringify(members),
                      members,
                      from: {
                        id: "a",
                        title: "記事A",
                        url: "https://example.org/a",
                      },
                      to: {
                        id: "b",
                        title: "記事B",
                        url: "https://example.org/b",
                      },
                      state: "linked",
                      reason: "関係の理由",
                      createdAt: source.createdAt,
                      revision: 1,
                    }
                  : {
                      id: JSON.stringify(members),
                      members,
                      articles: ["a", "b"],
                      from: source,
                      to: other,
                      reason: "引用の関係",
                      createdAt: source.createdAt,
                      revision: 1,
                    };
          await api[module.write](record, null);
          const db: IDBDatabase = await api[module.open]();
          const snapshot = async (target: IDBDatabase) => ({
            version: target.version,
            stores: await Promise.all(
              Array.from(target.objectStoreNames).map(
                (name) =>
                  new Promise((resolve, reject) => {
                    const tx = target.transaction(name),
                      store = tx.objectStore(name),
                      get = store.getAll();
                    const metadata = {
                      name,
                      keyPath: store.keyPath,
                      autoIncrement: store.autoIncrement,
                      indexes: Array.from(store.indexNames).map((name) => {
                        const index = store.index(name);
                        return {
                          name,
                          keyPath: index.keyPath,
                          unique: index.unique,
                          multiEntry: index.multiEntry,
                        };
                      }),
                    };
                    tx.oncomplete = () =>
                      resolve({ ...metadata, records: get.result });
                    tx.onerror = tx.onabort = () => reject(tx.error);
                  }),
              ),
            ),
          });
          const before = await snapshot(db);
          if (mode === "normal") db.close();
          else IDBDatabase.prototype.close.call(db);
          if (mode === "forced-event") db.dispatchEvent(new Event("close"));
          let firstError = "",
            retryError = "",
            after;
          try {
            if (mode === "missed-write")
              await api[module.write](
                {
                  ...record,
                  note: "再送禁止の編集",
                  reflection: "再送禁止の編集",
                  reason: "再送禁止の編集",
                  revision: 2,
                },
                1,
              );
            else await api[module.read]("a");
          } catch (error) {
            firstError = String(error);
          }
          try {
            after = await api[module.read]("a");
          } catch (error) {
            retryError = String(error);
          }
          const raw = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open(db.name, db.version);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          const disk = await snapshot(raw);
          raw.close();
          const fresh = await api[module.open]();
          db.dispatchEvent(new Event("close"));
          const retainedFresh = (await api[module.open]()) === fresh;
          // 回復後の書き込みも、呼び出し側が明示した一度だけ実行する。
          await api[module.write]({ ...record, revision: 2 }, 1);
          const written = await api[module.read]("a");
          fresh.close();
          return {
            before,
            disk,
            firstError,
            retryError,
            after,
            record,
            retainedFresh,
            written,
          };
        },
        { module, mode },
      );
      expect(result.disk).toEqual(result.before);
      expect(result.firstError === "").toBe(!mode.startsWith("missed-"));
      if (mode.startsWith("missed-"))
        expect(result.firstError).toContain("保存領域との接続が閉じています");
      expect(result.retryError).toBe("");
      expect(result.after).toEqual([result.record]);
      expect(result.retainedFresh).toBe(true);
      expect(result.written).toEqual([{ ...result.record, revision: 2 }]);
    });
  }
  for (const operation of ["export", "restore"]) {
    test(`${module.label}: 通知のないcloseを${operation}が他領域への書き込み前に検出する`, async ({
      page,
    }) => {
      await fixture(page);
      const result = await page.evaluate(
        async ({ module, operation }) => {
          const api = await import(module.path),
            backupPath = "/src/library-backup.ts",
            backup = await import(backupPath),
            feedPath = "/src/feed-store.ts",
            feed = await import(feedPath);
          const articleDb = await feed.openFeedLibrary();
          const article = {
            id: "a",
            title: "保存記事",
            url: "https://example.org/a",
            feedUrl: "",
            published: null,
            fetchedAt: "2026-11-17T00:00:00Z",
            body: "保存本文",
            read: true,
            saved: true,
          };
          const change = (remove: boolean) =>
            new Promise<void>((resolve, reject) => {
              const tx = articleDb.transaction("articles", "readwrite");
              if (remove) tx.objectStore("articles").delete("a");
              else tx.objectStore("articles").put(article);
              tx.oncomplete = () => resolve();
              tx.onerror = tx.onabort = () => reject(tx.error);
            });
          await change(false);
          const exported = await backup.exportLibrary(),
            preview = await backup.validateBackup(
              new File([exported.blob], "known.quilna.gz"),
            );
          if (operation === "restore") await change(true);
          const db = await api[module.open]();
          IDBDatabase.prototype.close.call(db);
          const run = () =>
            operation === "export"
              ? backup.exportLibrary()
              : backup.restoreBackup(preview.id);
          let firstError = "",
            retryError = "";
          try {
            await run();
          } catch (error) {
            firstError = String(error);
          }
          const addedBeforeFailure = await new Promise<boolean>(
            (resolve, reject) => {
              const r = articleDb
                .transaction("articles")
                .objectStore("articles")
                .get("a");
              r.onsuccess = () => resolve(!!r.result);
              r.onerror = () => reject(r.error);
            },
          );
          try {
            await run();
          } catch (error) {
            retryError = String(error);
          }
          const after = await new Promise((resolve, reject) => {
            const r = articleDb
              .transaction("articles")
              .objectStore("articles")
              .get("a");
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          articleDb.close();
          return { firstError, retryError, addedBeforeFailure, after, article };
        },
        { module, operation },
      );
      if (operation === "restore") {
        expect(result.firstError).toContain("保存領域との接続が閉じています");
        expect(result.firstError).toContain("今回0件を追加済み");
      } else
        expect(result.firstError).toContain("保存領域との接続が閉じています");
      expect(result.retryError).toBe("");
      expect(result.addedBeforeFailure).toBe(operation === "export");
      expect(result.after).toEqual(result.article);
    });
  }
}
for (const module of modules)
  for (const event of ["error", "blocked"]) {
    test(`${module.label}: 初回${event}後の遅い成功を閉じて次の接続を保持する`, async ({
      page,
    }) => {
      await fixture(page);
      const result = await page.evaluate(
        async ({ module, event }) => {
          const api = await import(module.path),
            open = indexedDB.open.bind(indexedDB);
          const original = await api[module.open]();
          const name = original.name,
            version = original.version;
          original.close();
          const late = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = open(name, version);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          const request = Object.assign(new EventTarget(), {
            result: late,
            error: new DOMException("controlled open failure", "UnknownError"),
            onerror: null,
            onblocked: null,
            onsuccess: null,
          }) as unknown as IDBOpenDBRequest;
          let intercepted = false;
          indexedDB.open = ((...args: Parameters<IDBFactory["open"]>) => {
            if (!intercepted && args[0] === name) {
              intercepted = true;
              return request;
            }
            return open(...args);
          }) as IDBFactory["open"];
          const pending = api[module.open]();
          if (event === "error")
            request.onerror!.call(request, new Event("error"));
          else
            request.onblocked!.call(
              request,
              new IDBVersionChangeEvent("blocked", {
                oldVersion: 0,
                newVersion: 1,
              }),
            );
          let firstError = "";
          try {
            await pending;
          } catch (error) {
            firstError = String(error);
          }
          const fresh = await api[module.open]();
          request.dispatchEvent(new Event("success"));
          request.onsuccess!.call(request, new Event("success"));
          let lateClosed = false;
          try {
            IDBDatabase.prototype.transaction.call(late, module.store);
          } catch (error) {
            lateClosed =
              error instanceof DOMException &&
              error.name === "InvalidStateError";
          }
          const retainedFresh = (await api[module.open]()) === fresh;
          indexedDB.open = open;
          fresh.close();
          return { firstError, lateClosed, retainedFresh, intercepted };
        },
        { module, event },
      );
      expect(result.intercepted).toBe(true);
      expect(result.firstError).toContain("既存の記録は保持しています");
      expect(result.lateClosed).toBe(true);
      expect(result.retainedFresh).toBe(true);
    });
  }
