import { test, expect } from "@playwright/test";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefMetadata, paperSnapshot } from "../../src/paper-format";

test("capacity racing saves retain all existing observations and paged history", async ({
  page,
}) => {
  await page.goto("/?view=papers");
  const seed = await paperSnapshot(
    crossrefMetadata(fixture, fixture.message.DOI),
    "2026-11-01T00:00:00.000Z",
  );
  const result = await page.evaluate(async (seed) => {
    const storePath = "/src/paper-store.ts",
      formatPath = "/src/paper-format.ts",
      store: typeof import("../../src/paper-store") = await import(storePath),
      format: typeof import("../../src/paper-format") = await import(
        formatPath
      );
    const snapshots = await Promise.all(
      Array.from({ length: 999 }, (_, i) =>
        format.paperSnapshot(
          {
            ...seed.metadata,
            doi: `10.5555/cap-${String(i).padStart(4, "0")}`,
          },
          seed.capturedAt,
        ),
      ),
    );
    // The normal API created the database; seed existing immutable values in one transaction.
    await store.listPapers();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(store.paperDatabase, 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      for (const p of snapshots)
        tx.objectStore("snapshots").put(JSON.stringify(p), store.paperKey(p));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const candidates = await Promise.all(
      ["a", "b"].map((id) =>
        format.paperSnapshot(
          { ...seed.metadata, doi: `10.5555/new-${id}` },
          seed.capturedAt,
        ),
      ),
    );
    const race = await Promise.allSettled(
      candidates.map((p) => store.savePaper(p)),
    );
    const found: typeof snapshots = [],
      cursors = new Set<string>();
    let after: string | undefined;
    do {
      const page = await store.listPapers(after);
      if (page.snapshots.length > 20) throw Error("oversized page");
      found.push(...page.snapshots);
      after = page.next;
      if (after) {
        if (cursors.has(after)) throw Error("repeated cursor");
        cursors.add(after);
      }
    } while (after);
    const repeat = await store.savePaper(snapshots[0]);
    return {
      outcomes: race.map((r) => r.status),
      count: found.length,
      existing: snapshots.every((p) =>
        found.some((v) => JSON.stringify(v) === JSON.stringify(p)),
      ),
      unique: new Set(found.map(store.paperKey)).size,
      repeat,
    };
  }, seed);
  expect(result.outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
  expect(result.outcomes.filter((s) => s === "rejected")).toHaveLength(1);
  expect(result.count).toBe(1000);
  expect(result.unique).toBe(1000);
  expect(result.existing).toBe(true);
  expect(result.repeat.reused).toBe(true);
});
test("storage transaction errors fail without a success record and allow a subsequent explicit retry", async ({
  page,
}) => {
  await page.goto("/?view=papers");
  const p = await paperSnapshot(crossrefMetadata(fixture, fixture.message.DOI));
  const result = await page.evaluate(async (p) => {
    const path = "/src/paper-store.ts",
      api: typeof import("../../src/paper-store") = await import(path);
    const original = IDBObjectStore.prototype.add;
    let refused = false;
    const quiet = (e: ErrorEvent) => {
      if (e.error?.name === "QuotaExceededError") e.preventDefault();
    };
    window.addEventListener("error", quiet);
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === "snapshots") {
        throw new DOMException(
          "Synthetic capacity failure",
          "QuotaExceededError",
        );
      }
      return original.apply(this, args);
    };
    try {
      await api.savePaper(p);
    } catch {
      refused = true;
    } finally {
      IDBObjectStore.prototype.add = original;
      window.removeEventListener("error", quiet);
    }
    const before = await api.listPapers();
    const retry = await api.savePaper(p);
    const after = await api.listPapers();
    return { refused, before, retry, after };
  }, p);
  expect(result.refused).toBe(true);
  expect(result.before.snapshots).toEqual([]);
  expect(result.retry.reused).toBe(false);
  expect(result.after.snapshots).toEqual([p]);
});
test("corrupt and future databases retain exact bytes and refuse overwrite/reset", async ({
  page,
}) => {
  await page.goto("/?view=papers");
  const p = await paperSnapshot(crossrefMetadata(fixture, fixture.message.DOI));
  const result = await page.evaluate(async (p) => {
    const path = "/src/paper-store.ts",
      api: typeof import("../../src/paper-store") = await import(path);
    await api.savePaper(p);
    const open = (version: number) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(api.paperDatabase, version);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    let db = await open(1);
    const key = api.paperKey(p),
      bytes = "CORRUPT-RECORD-MUST-REMAIN";
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    let readRefused = false,
      saveRefused = false,
      futureRead = false,
      futureSave = false;
    try {
      await api.listPapers();
    } catch {
      readRefused = true;
    }
    try {
      await api.savePaper(p);
    } catch {
      saveRefused = true;
    }
    db = await open(2);
    db.close();
    try {
      await api.listPapers();
    } catch {
      futureRead = true;
    }
    try {
      await api.savePaper(p);
    } catch {
      futureSave = true;
    }
    db = await open(2);
    const retained = await new Promise<unknown>((resolve, reject) => {
      const r = db.transaction("snapshots").objectStore("snapshots").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const version = db.version;
    db.close();
    return {
      readRefused,
      saveRefused,
      futureRead,
      futureSave,
      retained,
      version,
    };
  }, p);
  expect(result).toEqual({
    readRefused: true,
    saveRefused: true,
    futureRead: true,
    futureSave: true,
    retained: "CORRUPT-RECORD-MUST-REMAIN",
    version: 2,
  });
});
