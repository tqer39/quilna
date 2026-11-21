import { libraryName, openLibraryDatabase } from "./library-context";
import {
  validateTrendSnapshot,
  type TrendSnapshot,
  type TrendSource,
} from "./trend-discovery";

export const trendDatabase = libraryName("quilna.trends.v1");
const unavailable = () =>
  Error("話題の保存領域を確認できません。既存の記録は変更していません。");

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = openLibraryDatabase(trendDatabase, 1);
    let refused = false;
    request.onupgradeneeded = () => request.result.createObjectStore("sources");
    request.onerror = request.onblocked = () => {
      refused = true;
      reject(unavailable());
    };
    request.onsuccess = () => {
      const db = request.result;
      if (
        refused ||
        db.objectStoreNames.length !== 1 ||
        !db.objectStoreNames.contains("sources")
      ) {
        db.close();
        reject(unavailable());
        return;
      }
      const store = db.transaction("sources").objectStore("sources");
      if (
        store.keyPath !== null ||
        store.autoIncrement ||
        store.indexNames.length
      ) {
        db.close();
        reject(unavailable());
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export async function readTrendSnapshot(
  source: TrendSource,
): Promise<TrendSnapshot | undefined> {
  const db = await open();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction("sources");
      const request = transaction.objectStore("sources").get(source);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(unavailable());
    });
    if (value === undefined) return;
    const snapshot = validateTrendSnapshot(value);
    if (snapshot.source !== source) throw unavailable();
    return snapshot;
  } finally {
    db.close();
  }
}

export async function saveTrendSnapshot(
  input: TrendSnapshot,
): Promise<TrendSnapshot> {
  const snapshot = validateTrendSnapshot(input);
  const db = await open();
  try {
    return await new Promise<TrendSnapshot>((resolve, reject) => {
      const transaction = db.transaction("sources", "readwrite");
      const store = transaction.objectStore("sources");
      const request = store.get(snapshot.source);
      let retained = snapshot;
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) {
            const previous = validateTrendSnapshot(request.result);
            if (previous.source !== snapshot.source) throw unavailable();
            // 遅れて完了した古い取得で、別タブの新しい観測を上書きしない。
            if (
              Date.parse(previous.fetchedAt) >= Date.parse(snapshot.fetchedAt)
            ) {
              retained = previous;
              return;
            }
          }
          store.put(snapshot, snapshot.source);
        } catch {
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(retained);
      transaction.onabort = transaction.onerror = () => reject(unavailable());
    });
  } finally {
    db.close();
  }
}
