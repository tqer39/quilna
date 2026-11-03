import { libraryName, openLibraryDatabase } from "./library-context";
import { parsePaperExcerpt, type PaperExcerpt } from "./paper-text-format";
export const paperExcerptDatabase = libraryName("quilna.paper-excerpts.v1");
const failed = () =>
  Error(
    "論文引用を保存領域で確認できません。既存の記録は保持しています。再試行してください。",
  );
/** Keep cited bodies separate from bibliographic observations and refuse incompatible databases without resetting them. */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let refused = false;
    const request = openLibraryDatabase(paperExcerptDatabase, 1);
    request.onupgradeneeded = () => {
      if (refused) {
        request.transaction!.abort();
        return;
      }
      request.result.createObjectStore("excerpts");
    };
    request.onblocked = request.onerror = () => {
      refused = true;
      reject(failed());
    };
    request.onsuccess = () => {
      const db = request.result;
      if (
        refused ||
        db.objectStoreNames.length !== 1 ||
        !db.objectStoreNames.contains("excerpts")
      ) {
        db.close();
        reject(failed());
        return;
      }
      const store = db.transaction("excerpts").objectStore("excerpts");
      if (
        store.keyPath !== null ||
        store.autoIncrement ||
        store.indexNames.length
      ) {
        db.close();
        reject(failed());
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
/** Validate persisted bytes and their immutable key before exposing any source paragraph. */
async function stored(key: IDBValidKey, value: unknown) {
  if (typeof value !== "string") throw failed();
  const record = await parsePaperExcerpt(value);
  if (record.digest !== key) throw failed();
  return record;
}
/** Resolve an exact retained citation without fetching its source again. */
export async function readPaperExcerpt(key: string) {
  const db = await open();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("excerpts"),
        request = tx.objectStore("excerpts").get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(failed());
    });
    return value === undefined ? undefined : stored(key, value);
  } finally {
    db.close();
  }
}
/** Atomically retain at most 100 citation records without eviction; identical recaptures reuse the original record and dates. */
export async function savePaperExcerpt(input: PaperExcerpt) {
  const record = await parsePaperExcerpt(JSON.stringify(input)),
    db = await open();
  let old: unknown;
  let full = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("excerpts", "readwrite"),
        store = tx.objectStore("excerpts"),
        get = store.get(record.digest),
        count = store.count();
      count.onsuccess = () => {
        old = get.result;
        if (old !== undefined) return;
        if (count.result >= 100) {
          full = true;
          tx.abort();
          return;
        }
        store.add(JSON.stringify(record), record.digest);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          full
            ? Error(
                "論文引用の保存上限100件に達しています。既存の記録は保持しています。新しい引用はファイルに保存できます。",
              )
            : failed(),
        );
    });
    if (old !== undefined)
      return { record: await stored(record.digest, old), reused: true };
    return { record, reused: false };
  } finally {
    db.close();
  }
}
/** Read one bounded page and refuse corrupt records without changing any stored bytes. */
export async function listPaperExcerpts(after?: string) {
  const db = await open(),
    rows: { key: IDBValidKey; value: unknown }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("excerpts"),
        request = tx
          .objectStore("excerpts")
          .openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length === 21) return;
        rows.push({ key: cursor.key, value: cursor.value });
        if (rows.length < 21) cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failed());
    });
    const page = rows.slice(0, 20);
    return {
      records: await Promise.all(page.map((r) => stored(r.key, r.value))),
      next: rows.length > 20 ? String(page.at(-1)!.key) : undefined,
    };
  } finally {
    db.close();
  }
}
