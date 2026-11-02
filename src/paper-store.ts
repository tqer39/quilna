import { libraryName, openLibraryDatabase } from "./library-context";
import { parsePaper, type PaperSnapshot } from "./paper-format";

export const paperDatabase = libraryName("quilna.papers.v1");
const failed = () =>
  Error(
    "書誌情報を保存領域で確認できません。既存の記録は保持しています。再試行してください。",
  );
/** Open the separate bibliographic library without clearing damaged or newer databases. */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let refused = false;
    const r = openLibraryDatabase(paperDatabase, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("snapshots");
    r.onblocked = r.onerror = () => {
      refused = true;
      reject(failed());
    };
    r.onsuccess = () => {
      if (refused) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
  });
}
/** Stable fact identity keeps changed deposits separate while identical recaptures reuse the first observation. */
export const paperKey = (p: PaperSnapshot) =>
  JSON.stringify([p.metadata.doi, p.digest]);
/** Validate every persisted value and its key before returning it to the UI. */
async function stored(key: IDBValidKey, value: unknown) {
  if (typeof value !== "string") throw failed();
  const snapshot = await parsePaper(value);
  if (paperKey(snapshot) !== key) throw failed();
  return snapshot;
}
/** Save one immutable observation atomically, refusing conflicts or the 1,000-snapshot capacity. */
export async function savePaper(input: PaperSnapshot) {
  const p = await parsePaper(JSON.stringify(input)),
    key = paperKey(p),
    db = await open();
  let old: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite"),
        s = tx.objectStore("snapshots"),
        get = s.get(key),
        count = s.count();
      count.onsuccess = () => {
        old = get.result;
        if (old !== undefined) return;
        if (count.result >= 1000) {
          tx.abort();
          return;
        }
        s.add(JSON.stringify(p), key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failed());
    });
    if (old !== undefined) {
      const existing = await stored(key, old);
      if (JSON.stringify(existing.metadata) !== JSON.stringify(p.metadata))
        throw failed();
      return { snapshot: existing, reused: true };
    }
    return { snapshot: p, reused: false };
  } finally {
    db.close();
  }
}
/** Read only one bounded page; corruption refuses the page without deleting any stored values. */
export async function listPapers(after?: string) {
  const db = await open(),
    rows: { key: IDBValidKey; value: unknown }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots"),
        cursor = tx
          .objectStore("snapshots")
          .openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || rows.length === 21) return;
        rows.push({ key: c.key, value: c.value });
        if (rows.length < 21) c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failed());
    });
    const page = rows.slice(0, 20),
      snapshots = await Promise.all(page.map((r) => stored(r.key, r.value)));
    return {
      snapshots,
      next: rows.length > 20 ? String(page.at(-1)!.key) : undefined,
    };
  } finally {
    db.close();
  }
}
