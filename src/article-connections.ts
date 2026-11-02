import type { FeedArticle } from "./feed-parser";

export type ArticleReference = { id: string; title: string; url: string };
export type ArticleConnection = {
  id: string;
  members: [string, string];
  from: ArticleReference;
  to: ArticleReference;
  state: "linked" | "hidden";
  reason: string;
  createdAt: string;
  revision: number;
};
export const connectionDatabase = "quilna.connections.v1";
export const connectionLimit = 200;
export function articleReference(a: FeedArticle): ArticleReference {
  return {
    id: a.id,
    title: a.content?.title || a.title,
    url: a.content?.url || a.url,
  };
}
export function connectionKey(a: string, b: string) {
  return JSON.stringify([a, b].sort());
}
function reference(value: unknown): value is ArticleReference {
  if (!value || typeof value !== "object") return false;
  const r = value as ArticleReference;
  if (
    ![r.id, r.title, r.url].every(
      (v) => typeof v === "string" && v.length <= 40000,
    ) ||
    !r.id
  )
    return false;
  if (!r.url) return true;
  try {
    return ["https:", "http:"].includes(new URL(r.url).protocol);
  } catch {
    return false;
  }
}
export function validConnection(value: unknown): value is ArticleConnection {
  if (!value || typeof value !== "object") return false;
  const c = value as ArticleConnection;
  return (
    reference(c.from) &&
    reference(c.to) &&
    c.from.id !== c.to.id &&
    c.id === connectionKey(c.from.id, c.to.id) &&
    Array.isArray(c.members) &&
    JSON.stringify(c.members) === c.id &&
    ["linked", "hidden"].includes(c.state) &&
    typeof c.reason === "string" &&
    c.reason.length <= 2000 &&
    (c.state === "hidden" ? c.reason === "" : !!c.reason.trim()) &&
    typeof c.createdAt === "string" &&
    Number.isFinite(Date.parse(c.createdAt)) &&
    Number.isSafeInteger(c.revision) &&
    c.revision > 0
  );
}
let connection: Promise<IDBDatabase> | undefined;
export function openConnections(): Promise<IDBDatabase> {
  if (connection) return connection;
  let failed = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(connectionDatabase, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("connections", {
        keyPath: "id",
      });
      store.createIndex("members", "members", { multiEntry: true });
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(
        Error(
          "情報のつながりの保存領域を開けませんでした。既存の記録は保持しています。",
        ),
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
export async function readConnections(
  articleId: string,
): Promise<ArticleConnection[]> {
  const db = await openConnections();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("connections", "readonly");
    const get = tx
      .objectStore("connections")
      .index("members")
      .getAll(articleId, connectionLimit + 1);
    tx.oncomplete = () => {
      if (
        get.result.length > connectionLimit ||
        !get.result.every(validConnection)
      )
        reject(
          Error("つながりの保存形式を確認できません。記録は変更していません。"),
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
      reject(Error("つながりを読み込めませんでした。"));
  });
}
export async function writeConnection(
  c: ArticleConnection,
  expected: number | null,
  remove = false,
) {
  if (!validConnection(c))
    throw Error(
      "つながりの理由は1〜2000文字で入力してください。出典も確認してください。",
    );
  const db = await openConnections();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("connections", "readwrite"),
      store = tx.objectStore("connections");
    const get = store.get(c.id),
      first = store.index("members").count(c.members[0]),
      second = store.index("members").count(c.members[1]);
    let message =
      "つながりを保存できませんでした。入力と記録を保持しています。再試行してください。";
    const refuse = (text: string) => {
      message = text;
      tx.abort();
    };
    second.onsuccess = () => {
      const old = get.result as ArticleConnection | undefined;
      if (old !== undefined && !validConnection(old))
        return refuse(
          "保存済みのつながりの形式を確認できません。変更していません。",
        );
      if (remove && !old) return;
      if (expected === null ? !!old : old?.revision !== expected)
        return refuse(
          "別の画面でつながりが変わりました。再読み込みして編集し直してください。",
        );
      if (
        old &&
        (JSON.stringify(old.from) !== JSON.stringify(c.from) ||
          JSON.stringify(old.to) !== JSON.stringify(c.to) ||
          old.createdAt !== c.createdAt)
      )
        return refuse(
          "保存した出典は変更できません。関連を解除して作り直してください。",
        );
      if (
        !old &&
        (first.result >= connectionLimit || second.result >= connectionLimit)
      )
        return refuse(
          `つながりと非表示の記録は、各記事${connectionLimit}件までです。`,
        );
      if (!remove && c.revision !== (expected ?? 0) + 1)
        return refuse("編集の版を確認できません。");
      try {
        if (remove) store.delete(c.id);
        else store.put(c);
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(Error(message));
  });
}
