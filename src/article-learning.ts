import { validHighlight, type ArticleHighlight } from "./article-highlights";

// Explicit reflections are independent of read/save flags and mutable highlights.
export type LearningRecord = {
  id: string;
  articleId: string;
  source: ArticleHighlight;
  reflection: string;
  createdAt: string;
  revision: number;
};
export const learningDatabase = "quilna.learning.v1";
export const learningLimit = 200;
export function validLearningRecord(value: unknown): value is LearningRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as LearningRecord;
  return (
    typeof r.id === "string" &&
    /^[\da-f-]{36}$/.test(r.id) &&
    validHighlight(r.source) &&
    r.articleId === r.source.articleId &&
    typeof r.reflection === "string" &&
    !!r.reflection.trim() &&
    r.reflection.length <= 4000 &&
    typeof r.createdAt === "string" &&
    Number.isFinite(Date.parse(r.createdAt)) &&
    Number.isSafeInteger(r.revision) &&
    r.revision > 0
  );
}
let connection: Promise<IDBDatabase> | undefined;
export function openLearning(): Promise<IDBDatabase> {
  if (connection) return connection;
  let failed = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(learningDatabase, 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("records", { keyPath: "id" })
        .createIndex("articleId", "articleId");
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(
        Error("学びの保存領域を開けませんでした。既存の記録は保持しています。"),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        if (connection === pending) connection = undefined;
      };
      resolve(db);
    };
  });
  connection = pending;
  void pending.catch(() => {
    if (connection === pending) connection = undefined;
  });
  return pending;
}
export async function readLearning(
  articleId: string,
): Promise<LearningRecord[]> {
  const db = await openLearning();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readonly");
    const get = tx
      .objectStore("records")
      .index("articleId")
      .getAll(articleId, learningLimit + 1);
    tx.oncomplete = () => {
      if (
        get.result.length > learningLimit ||
        !get.result.every(validLearningRecord)
      )
        reject(
          Error(
            "学びの保存形式を確認できません。既存の記録は変更していません。",
          ),
        );
      else
        resolve(
          get.result.sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          ),
        );
    };
    tx.onerror = tx.onabort = () =>
      reject(Error("学びの記録を読み込めませんでした。"));
  });
}
export async function writeLearning(
  record: LearningRecord,
  expected: number | null,
  remove = false,
) {
  if (!validLearningRecord(record))
    throw Error(
      "学んだことを1〜4000文字で入力してください。引用元も確認してください。",
    );
  const db = await openLearning();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite"),
      store = tx.objectStore("records");
    const get = store.get(record.id),
      count = store.index("articleId").count(record.articleId);
    let message =
      "学びを保存できませんでした。記録と入力を保持しています。再試行してください。";
    const refuse = (text: string) => {
      message = text;
      tx.abort();
    };
    count.onsuccess = () => {
      const old = get.result as LearningRecord | undefined;
      if (old !== undefined && !validLearningRecord(old))
        return refuse(
          "保存済みの学びを確認できません。記録は変更していません。",
        );
      if (remove && !old) return;
      if (expected === null ? !!old : old?.revision !== expected)
        return refuse(
          "別の画面で記録が変わりました。編集中の内容を控え、編集をやめて一覧から開き直してください。",
        );
      if (
        old &&
        (JSON.stringify(old.source) !== JSON.stringify(record.source) ||
          old.createdAt !== record.createdAt)
      )
        return refuse(
          "学びの引用元は変更できません。新しい記録として保存してください。",
        );
      if (!old && count.result >= learningLimit)
        return refuse(`この記事の学びは${learningLimit}件まで保存できます。`);
      if (!remove && record.revision !== (expected ?? 0) + 1)
        return refuse("学びの編集版を確認できません。");
      try {
        if (remove) store.delete(record.id);
        else store.put(record);
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(Error(message));
  });
}
