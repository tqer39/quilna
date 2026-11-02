// References use UTF-16 offsets into an exact original/translation version.
export type HighlightSource = {
  articleId: string;
  title: string;
  url: string;
  view: "original" | "translation";
  language: string;
  version: string;
};
export type ArticleHighlight = HighlightSource & {
  id: string;
  start: number;
  end: number;
  quote: string;
  note: string;
  createdAt: string;
  revision: number;
};
export const highlightDatabase = "quilna.highlights.v1";
export const highlightLimit = 200;
const bounded = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max;
export function validHighlight(value: unknown): value is ArticleHighlight {
  if (!value || typeof value !== "object") return false;
  const h = value as ArticleHighlight;
  return (
    typeof h.id === "string" &&
    /^[\da-f-]{36}$/.test(h.id) &&
    bounded(h.articleId, 40000) &&
    bounded(h.title, 40000) &&
    bounded(h.url, 40000) &&
    (!h.url || /^https?:\/\//.test(h.url)) &&
    ["original", "translation"].includes(h.view) &&
    bounded(h.language, 35) &&
    typeof h.version === "string" &&
    /^[\da-f]{64}$/.test(h.version) &&
    Number.isSafeInteger(h.start) &&
    h.start >= 0 &&
    Number.isSafeInteger(h.end) &&
    h.end > h.start &&
    h.end <= 400000 &&
    bounded(h.quote, 4000) &&
    h.quote.length === h.end - h.start &&
    bounded(h.note, 2000) &&
    typeof h.createdAt === "string" &&
    Number.isFinite(Date.parse(h.createdAt)) &&
    Number.isSafeInteger(h.revision) &&
    h.revision > 0
  );
}
export async function highlightVersion(
  original: string,
  displayed: string,
  view: HighlightSource["view"],
  language: string,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([original, displayed, view, language]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function highlightMatches(
  h: ArticleHighlight,
  source: HighlightSource,
  text: string,
) {
  return (
    h.articleId === source.articleId &&
    h.version === source.version &&
    h.view === source.view &&
    h.language === source.language &&
    text.slice(h.start, h.end) === h.quote
  );
}
let connection: Promise<IDBDatabase> | undefined;
export function openHighlights(): Promise<IDBDatabase> {
  if (connection) return connection;
  let failed = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(highlightDatabase, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("highlights", {
        keyPath: "id",
      });
      store.createIndex("articleId", "articleId");
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(
        Error(
          "ハイライトの保存領域を開けませんでした。既存の記録は保持しています。",
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
export async function readHighlights(
  articleId: string,
): Promise<ArticleHighlight[]> {
  const db = await openHighlights();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("highlights", "readonly");
    const get = tx
      .objectStore("highlights")
      .index("articleId")
      .getAll(articleId, highlightLimit + 1);
    tx.oncomplete = () => {
      if (
        get.result.length > highlightLimit ||
        !get.result.every(validHighlight)
      )
        reject(
          Error(
            "ハイライトの保存形式を確認できません。既存の記録は変更していません。",
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
      reject(Error("ハイライトを読み込めませんでした。"));
  });
}
// Revision comparison and write share one transaction, including across tabs.
export async function writeHighlight(
  h: ArticleHighlight,
  expected: number | null,
  remove = false,
) {
  if (!validHighlight(h))
    throw Error("引用またはメモの形式を確認してください。");
  const db = await openHighlights();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("highlights", "readwrite");
    const store = tx.objectStore("highlights");
    const get = store.get(h.id);
    const count = store.index("articleId").count(h.articleId);
    let message =
      "ハイライトを保存できませんでした。内容を保持しています。再試行してください。";
    count.onsuccess = () => {
      const previous: unknown = get.result;
      if (
        previous !== undefined &&
        (!validHighlight(previous) || previous.articleId !== h.articleId)
      ) {
        message =
          "保存済みのハイライトを確認できません。記録は変更していません。";
        tx.abort();
        return;
      }
      const old = previous as ArticleHighlight | undefined;
      if (expected === null && old && JSON.stringify(old) === JSON.stringify(h))
        return;
      if (remove && !old) return;
      if (
        !remove &&
        old &&
        expected !== null &&
        (
          [
            "articleId",
            "title",
            "url",
            "view",
            "language",
            "version",
            "start",
            "end",
            "quote",
            "createdAt",
          ] as const
        ).some((key) => old[key] !== h[key])
      ) {
        message =
          "引用元の版や位置は変更できません。新しい引用として保存してください。";
        tx.abort();
        return;
      }
      if (expected === null ? !!old : old?.revision !== expected) {
        message =
          "別の画面で記録が変わりました。一覧を再読み込みし、編集し直してください。";
        tx.abort();
        return;
      }
      if (expected === null && count.result >= highlightLimit) {
        message = `この記事のハイライトは${highlightLimit}件まで保存できます。`;
        tx.abort();
        return;
      }
      if (!remove && h.revision !== (expected ?? 0) + 1) {
        message = "ハイライトの版を確認できません。";
        tx.abort();
        return;
      }
      try {
        if (remove) store.delete(h.id);
        else store.put(h);
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(Error(message));
  });
}
