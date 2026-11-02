import { validHighlight, type ArticleHighlight } from "./article-highlights";
import { connectionKey } from "./article-connections";

export type QuoteConnection = {
  id: string;
  members: [string, string];
  articles: string[];
  from: ArticleHighlight;
  to: ArticleHighlight;
  reason: string;
  createdAt: string;
  revision: number;
};
export const quoteConnectionDatabase = "quilna.quote-connections.v1";
export const quoteConnectionLimit = 200;
export function validQuoteConnection(value: unknown): value is QuoteConnection {
  if (!value || typeof value !== "object") return false;
  const c = value as QuoteConnection;
  return (
    validHighlight(c.from) &&
    validHighlight(c.to) &&
    c.from.id !== c.to.id &&
    c.id === connectionKey(c.from.id, c.to.id) &&
    Array.isArray(c.members) &&
    JSON.stringify(c.members) === c.id &&
    Array.isArray(c.articles) &&
    JSON.stringify(c.articles) ===
      JSON.stringify([...new Set([c.from.articleId, c.to.articleId])].sort()) &&
    typeof c.reason === "string" &&
    !!c.reason.trim() &&
    c.reason.length <= 2000 &&
    typeof c.createdAt === "string" &&
    Number.isFinite(Date.parse(c.createdAt)) &&
    Number.isSafeInteger(c.revision) &&
    c.revision > 0
  );
}
let connection: Promise<IDBDatabase> | undefined;
export function openQuoteConnections(): Promise<IDBDatabase> {
  if (connection) return connection;
  let failed = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(quoteConnectionDatabase, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("connections", {
        keyPath: "id",
      });
      store.createIndex("members", "members", { multiEntry: true });
      store.createIndex("articles", "articles", { multiEntry: true });
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(
        Error(
          "引用のつながりの保存領域を開けませんでした。既存の記録は保持しています。",
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
export const readQuoteConnections = (quoteId: string) =>
  readIndex("members", quoteId);
export const readArticleQuoteConnections = (articleId: string) =>
  readIndex("articles", articleId);
async function readIndex(
  index: "members" | "articles",
  id: string,
): Promise<QuoteConnection[]> {
  const db = await openQuoteConnections();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("connections", "readonly");
    const get = tx
      .objectStore("connections")
      .index(index)
      .getAll(id, quoteConnectionLimit + 1);
    tx.oncomplete = () => {
      if (
        get.result.length > quoteConnectionLimit ||
        !get.result.every(validQuoteConnection)
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
export async function writeQuoteConnection(
  c: QuoteConnection,
  expected: number | null,
  remove = false,
) {
  if (!validQuoteConnection(c))
    throw Error(
      "つながりの理由は1〜2000文字で入力してください。出典も確認してください。",
    );
  const db = await openQuoteConnections();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("connections", "readwrite"),
      store = tx.objectStore("connections");
    const get = store.get(c.id),
      first = store.index("members").count(c.members[0]),
      second = store.index("members").count(c.members[1]),
      firstArticle = store.index("articles").count(c.from.articleId),
      secondArticle = store.index("articles").count(c.to.articleId);
    let message =
      "つながりを保存できませんでした。入力と記録を保持しています。再試行してください。";
    const refuse = (text: string) => {
      message = text;
      tx.abort();
    };
    secondArticle.onsuccess = () => {
      const old = get.result as QuoteConnection | undefined;
      if (old !== undefined && !validQuoteConnection(old))
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
        (first.result >= quoteConnectionLimit ||
          second.result >= quoteConnectionLimit ||
          firstArticle.result >= quoteConnectionLimit ||
          secondArticle.result >= quoteConnectionLimit)
      )
        return refuse(
          `引用のつながりは、各記事・各引用${quoteConnectionLimit}件までです。`,
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
