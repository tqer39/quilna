import { openFeedLibrary, feedDatabase } from "./feed-store";
import { openHighlights, highlightDatabase } from "./article-highlights";
import { openConnections, connectionDatabase } from "./article-connections";
import {
  openQuoteConnections,
  quoteConnectionDatabase,
} from "./quote-connections";
import { openLearning, learningDatabase } from "./article-learning";
import {
  backupKinds,
  backupBatchSize,
  backupByteLimit,
  backupLineLimit,
  BackupCounter,
  backupEntry,
  parseBackupEntry,
  capacityKeys,
  validBackupHeader,
  validBackupCounts,
  validBackupPreview,
  sameBackupValue,
  type BackupKind,
  type BackupEntry,
  type BackupHeader,
  type BackupPreview,
} from "./library-backup-format";

export const backupStageDatabase = "quilna.backup-stage.v1";
export const backupLock = "quilna.reader-backup.v1";
type Progress = (message: string) => void;
type Target = { db: IDBDatabase; store: string };
type Targets = Record<BackupKind, Target>;
export type RestoreResult = {
  added: number;
  identical: number;
  conflicts: number;
};
function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted)
    throw Error(
      "処理を中止しました。復元済みの記録と元の記録は保持しています。",
    );
}
async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw Error(
      "このブラウザでは安全なバックアップ処理に対応していません。対応ブラウザでお試しください。",
    );
  return navigator.locks.request(backupLock, { ifAvailable: true }, (lock) => {
    if (!lock)
      throw Error(
        "別の画面でバックアップまたは復元を処理しています。完了後に再試行してください。",
      );
    return run();
  });
}
async function targets(): Promise<Targets> {
  const feed = await openFeedLibrary();
  try {
    return {
      feeds: { db: feed, store: "feeds" },
      articles: { db: feed, store: "articles" },
      highlights: { db: await openHighlights(), store: "highlights" },
      connections: { db: await openConnections(), store: "connections" },
      quoteConnections: {
        db: await openQuoteConnections(),
        store: "connections",
      },
      learning: { db: await openLearning(), store: "records" },
    };
  } catch (error) {
    feed.close();
    throw error;
  }
}
function schema(store: IDBObjectStore, kind: BackupKind) {
  if (store.keyPath !== (kind === "feeds" ? "url" : "id"))
    throw Error("保存領域の形式を確認できません。記録は変更していません。");
}
export async function exportLibrary(
  progress: Progress = () => {},
  signal?: AbortSignal,
) {
  return exclusive(async () => {
    if (typeof CompressionStream === "undefined")
      throw Error("このブラウザは圧縮ファイルの書き出しに対応していません。");
    const header: BackupHeader = {
      format: "quilna-reader-library",
      version: 1,
      createdAt: new Date().toISOString(),
    };
    const counter = new BackupCounter(),
      chunks: Blob[] = [];
    let bytes = 0;
    const append = (value: unknown) => {
      const line = new Blob([JSON.stringify(value) + "\n"]);
      bytes += line.size;
      if (line.size > backupLineLimit || bytes > backupByteLimit)
        throw Error(
          "バックアップの上限（展開後2GiB・1記録8MiB）を超えました。不完全なファイルは作成していません。",
        );
      chunks.push(line);
    };
    append({ type: "header", header });
    const opened = await targets();
    try {
      for (const kinds of [
        ["feeds", "articles"],
        ["highlights"],
        ["connections"],
        ["quoteConnections"],
        ["learning"],
      ] as BackupKind[][]) {
        abortIfNeeded(signal);
        await new Promise<void>((resolve, reject) => {
          const db = opened[kinds[0]].db;
          const tx = db.transaction(
            kinds.map((k) => opened[k].store),
            "readonly",
          );
          let failure: unknown;
          const read = (kind: BackupKind, after?: string) => {
            const store = tx.objectStore(opened[kind].store);
            schema(store, kind);
            const get = store.getAll(
              after === undefined ? null : IDBKeyRange.lowerBound(after, true),
              backupBatchSize,
            );
            get.onsuccess = () => {
              try {
                abortIfNeeded(signal);
                for (const value of get.result) {
                  const entry = backupEntry(kind, value);
                  counter.add(entry);
                  append({ type: "entry", ...entry });
                }
                progress(
                  `${Object.values(counter.counts).reduce((a, b) => a + b, 0)}件を読み出しています…`,
                );
                if (get.result.length === backupBatchSize)
                  read(kind, backupEntry(kind, get.result.at(-1)).key);
              } catch (error) {
                failure = error;
                tx.abort();
              }
            };
          };
          try {
            kinds.forEach((k) => read(k));
          } catch (error) {
            failure = error;
            tx.abort();
          }
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () =>
            reject(
              failure ??
                Error(
                  "バックアップを読み出せませんでした。元の記録は保持しています。",
                ),
            );
        });
      }
    } finally {
      opened.feeds.db.close();
    }
    append({ type: "footer", counts: counter.counts });
    abortIfNeeded(signal);
    progress("ファイルを圧縮しています…");
    const blob = await new Response(
      new Blob(chunks).stream().pipeThrough(new CompressionStream("gzip")),
    ).blob();
    abortIfNeeded(signal);
    return { blob, header, counts: counter.counts };
  });
}
async function openStage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open(backupStageDatabase, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("entries", { keyPath: ["kind", "key"] });
      request.result.createObjectStore("meta");
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(
        Error(
          "復元用の一時保存領域を開けませんでした。記事は変更していません。",
        ),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
function stageWrite(
  db: IDBDatabase,
  entries: BackupEntry[],
  preview?: BackupPreview,
  clear = false,
) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["entries", "meta"], "readwrite");
    try {
      if (clear) {
        tx.objectStore("entries").clear();
        tx.objectStore("meta").clear();
      }
      for (const entry of entries) tx.objectStore("entries").add(entry);
      if (preview) tx.objectStore("meta").put(preview, "ready");
    } catch {
      tx.abort();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(
        Error(
          "ファイルの検証用データを保存できませんでした。重複IDまたは保存容量を確認してください。記事は変更していません。",
        ),
      );
  });
}
async function stagePreview(
  db: IDBDatabase,
): Promise<BackupPreview | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta"),
      get = tx.objectStore("meta").get("ready");
    tx.oncomplete = () => {
      if (get.result === undefined || validBackupPreview(get.result))
        resolve(get.result);
      else
        reject(
          Error(
            "検証済みファイルの情報を確認できません。ファイルを選び直してください。",
          ),
        );
    };
    tx.onerror = tx.onabort = () =>
      reject(Error("検証済みファイルを読み込めませんでした。"));
  });
}
export async function pendingBackup() {
  const db = await openStage();
  try {
    return await stagePreview(db);
  } finally {
    db.close();
  }
}
export async function discardBackup(expectedId?: string) {
  return exclusive(async () => {
    const db = await openStage();
    try {
      const preview = await stagePreview(db);
      if (preview?.id !== expectedId)
        throw Error(
          "検証済みファイルが変わりました。内容を再確認してください。",
        );
      await stageWrite(db, [], undefined, true);
    } finally {
      db.close();
    }
  });
}
export async function validateBackup(
  file: File,
  progress: Progress = () => {},
  signal?: AbortSignal,
): Promise<BackupPreview> {
  return exclusive(async () => {
    if (typeof DecompressionStream === "undefined")
      throw Error("このブラウザはバックアップの読み込みに対応していません。");
    if (file.size > backupByteLimit || !file.size)
      throw Error("空のファイル、または2GiBを超えるファイルは読み込めません。");
    const db = await openStage();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await stageWrite(db, [], undefined, true);
      const counter = new BackupCounter();
      let header: BackupHeader | undefined,
        footer = false,
        buffer = "",
        bytes = 0,
        batch: BackupEntry[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const line = async (text: string) => {
        if (
          !text ||
          text.length > backupLineLimit ||
          new TextEncoder().encode(text).byteLength + 1 > backupLineLimit
        )
          throw Error("ファイルの行サイズまたは形式を確認できません。");
        const value = JSON.parse(text);
        if (!header) {
          if (value?.type !== "header" || !validBackupHeader(value.header))
            throw Error(
              "対応するQuilnaバックアップではありません。形式または版を確認してください。",
            );
          header = value.header;
          return;
        }
        if (footer) throw Error("ファイルの終端より後に記録があります。");
        if (value?.type === "footer") {
          if (
            !validBackupCounts(value.counts) ||
            !backupKinds.every((k) => value.counts[k] === counter.counts[k])
          )
            throw Error(
              "バックアップの件数が一致しません。完全なファイルを選んでください。",
            );
          footer = true;
          return;
        }
        if (value?.type !== "entry")
          throw Error("バックアップに不明な記録があります。");
        const entry = parseBackupEntry(value);
        counter.add(entry);
        batch.push(entry);
        if (batch.length === backupBatchSize) {
          await stageWrite(db, batch);
          batch = [];
          progress(
            `${Object.values(counter.counts).reduce((a, b) => a + b, 0)}件を検証しています…`,
          );
        }
      };
      reader = file
        .stream()
        .pipeThrough(new DecompressionStream("gzip"))
        .getReader();
      for (;;) {
        abortIfNeeded(signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > backupByteLimit)
          throw Error("展開後のファイルが2GiBの上限を超えています。");
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const text = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          await line(text);
        }
        if (buffer.length > backupLineLimit)
          throw Error("バックアップの1記録が大きすぎます。");
      }
      buffer += decoder.decode();
      if (buffer || !header || !footer)
        throw Error(
          "バックアップが途中で切れています。元のファイルを選び直してください。",
        );
      abortIfNeeded(signal);
      const preview: BackupPreview = {
        id: crypto.randomUUID(),
        header,
        counts: counter.counts,
        fileName: file.name.slice(0, 1000),
      };
      await stageWrite(db, batch, preview);
      return preview;
    } catch (error) {
      await stageWrite(db, [], undefined, true).catch(() => {});
      throw Error(
        `バックアップを検証できませんでした。記事は変更していません。 ${(error as Error).message}`,
      );
    } finally {
      await reader?.cancel().catch(() => {});
      db.close();
    }
  });
}
function stagedBatch(
  db: IDBDatabase,
  kind: BackupKind,
  after?: string,
): Promise<BackupEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("entries");
    const range = IDBKeyRange.bound(
      after === undefined ? [kind] : [kind, after],
      [kind, []],
      after !== undefined,
      true,
    );
    const get = tx.objectStore("entries").getAll(range, backupBatchSize);
    tx.oncomplete = () => {
      try {
        resolve(get.result.map(parseBackupEntry));
      } catch (error) {
        reject(error);
      }
    };
    tx.onerror = tx.onabort = () =>
      reject(
        Error("検証済みファイルを読み込めませんでした。再試行してください。"),
      );
  });
}
function restoreBatch(
  target: Target,
  kind: BackupKind,
  entries: BackupEntry[],
  signal?: AbortSignal,
): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const tx = target.db.transaction(target.store, "readwrite"),
      store = tx.objectStore(target.store);
    const result: RestoreResult = { added: 0, identical: 0, conflicts: 0 };
    let failure: unknown,
      index = 0;
    const refuse = (error: unknown) => {
      failure = error;
      tx.abort();
    };
    const next = () => {
      try {
        abortIfNeeded(signal);
        schema(store, kind);
        const entry = entries[index++];
        if (!entry) return;
        const get = store.get(entry.key);
        get.onsuccess = () => {
          try {
            if (get.result !== undefined) {
              const old = backupEntry(kind, get.result);
              if (sameBackupValue(old.value, entry.value)) result.identical++;
              else result.conflicts++;
              next();
              return;
            }
            const limits = capacityKeys(entry),
              counts = limits.map(([name, key]) =>
                name ? store.index(name).count(key) : store.count(),
              );
            const write = () => {
              try {
                abortIfNeeded(signal);
                if (counts.some((count, i) => count.result >= limits[i][2]))
                  throw Error(
                    "復元先の購読数または記事・引用ごとの保存上限に達しました。",
                  );
                const add = store.add(entry.value);
                add.onsuccess = () => {
                  result.added++;
                  next();
                };
              } catch (error) {
                refuse(error);
              }
            };
            if (counts.length) counts.at(-1)!.onsuccess = write;
            else write();
          } catch (error) {
            refuse(error);
          }
        };
      } catch (error) {
        refuse(error);
      }
    };
    next();
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () =>
      reject(
        failure ??
          Error(
            "保存領域へ復元できませんでした。容量を確認して再試行してください。",
          ),
      );
  });
}
export async function restoreBackup(
  expectedId: string,
  progress: Progress = () => {},
  signal?: AbortSignal,
): Promise<RestoreResult> {
  return exclusive(async () => {
    const stage = await openStage();
    let opened: Targets | undefined;
    const result: RestoreResult = { added: 0, identical: 0, conflicts: 0 };
    try {
      const preview = await stagePreview(stage);
      if (!preview || preview.id !== expectedId)
        throw Error(
          "検証済みファイルが変わりました。内容を再確認してください。",
        );
      // Open every destination before writing any records (future schemas refuse).
      opened = await targets();
      for (const kind of backupKinds) {
        let after: string | undefined,
          count = 0;
        for (;;) {
          abortIfNeeded(signal);
          const batch = await stagedBatch(stage, kind, after);
          if (!batch.length) break;
          const done = await restoreBatch(opened[kind], kind, batch, signal);
          result.added += done.added;
          result.identical += done.identical;
          result.conflicts += done.conflicts;
          count += batch.length;
          after = batch.at(-1)!.key;
          progress(
            `復元中：${result.added}件を追加、既存${result.identical + result.conflicts}件を保持…`,
          );
        }
        if (count !== preview.counts[kind])
          throw Error(
            "検証済みファイルの件数が変わりました。元のファイルを選び直してください。",
          );
      }
      return result;
    } catch (error) {
      throw Error(
        `${(error as Error).message} 今回${result.added}件を追加済みです。既存の記録は上書きしていません。検証済みファイルから再試行できます。`,
      );
    } finally {
      stage.close();
      opened?.feeds.db.close();
      for (const name of [
        feedDatabase,
        highlightDatabase,
        connectionDatabase,
        quoteConnectionDatabase,
        learningDatabase,
      ]) {
        if (typeof BroadcastChannel !== "undefined") {
          const channel = new BroadcastChannel(name);
          channel.postMessage("changed");
          channel.close();
        }
      }
    }
  });
}
