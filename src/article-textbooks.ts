import { z } from "zod";
import {
  guardLibraryConnection,
  libraryName,
  openLibraryDatabase,
} from "./library-context";
import { highlightVersion, type HighlightSource } from "./article-highlights";
import { readSharedTextbook } from "./shared-textbook-store";
import type { SharedTextbook } from "./shared-textbook-format";

export const textbookLinkDatabase = libraryName("quilna.article-textbooks.v1");
export const textbookLinkLimit = 20;
export const textbookLinkTotalLimit = 20_000;
const object = <T extends z.ZodRawShape>(fields: T) =>
  z.object(fields).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sourceSchema = object({
  articleId: z.string().min(1).max(40000),
  title: z.string().min(1).max(40000),
  url: z
    .string()
    .max(40000)
    .refine((s) => {
      if (!s) return true;
      try {
        const u = new URL(s);
        return (
          ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
        );
      } catch {
        return false;
      }
    }),
  version: digest,
  view: z.enum(["original", "translation"]),
  language: z.string().max(35),
  excerpt: z.string().max(2000),
});
const targetSchema = object({
  id: z
    .string()
    .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9]\d{0,9}$/)
    .refine((s) => Number(s.split(":")[1]) <= 2147483647),
  digest,
  title: z.string().min(1).max(500),
  topicId: z.string().regex(uuid),
  topicName: z.string().min(1).max(500),
});
const schema = object({
  id: z.string().max(250000),
  source: sourceSchema,
  target: targetSchema,
  reason: z
    .string()
    .max(2000)
    .refine((s) => !!s.trim()),
  createdAt: z.string().datetime(),
  revision: z.number().int().min(1).max(2147483647),
}).refine((v) => v.id === textbookLinkKey(v.source.articleId, v.target.id));
export type TextbookLink = z.infer<typeof schema>;
export type TextbookReading = Omit<HighlightSource, "version"> & {
  text: string;
  original: string;
};

/** 記事と不変の教材版の組を使い、同じ関連づけの重複作成を防ぐ。 */
export function textbookLinkKey(articleId: string, bookId: string) {
  return JSON.stringify([articleId, bookId]);
}
/** 復元でも同じ厳密な形を検査し、個人記録を黙って削除・正規化しない。 */
export function validTextbookLink(value: unknown): value is TextbookLink {
  return schema.safeParse(value).success;
}
/** 表示中の原文または訳文を固定し、後の本文更新で関連理由の参照先を移さない。 */
export async function textbookLinkSource(view: TextbookReading) {
  const frozen = { ...view };
  return sourceSchema.parse({
    articleId: frozen.articleId,
    title: frozen.title,
    url: frozen.url,
    version: await highlightVersion(
      frozen.original,
      frozen.text,
      frozen.view,
      frozen.language,
    ),
    view: frozen.view,
    language: frozen.language,
    excerpt: Array.from(frozen.text).slice(0, 1000).join(""),
  });
}
/** 名前の一致を同一性とせず、選んだテーマと教材版を正確に保持する。 */
export function textbookLinkTarget(book: SharedTextbook) {
  if (book.request.schemaVersion !== 2)
    throw Error("テーマ別の教材を選んでください。");
  return targetSchema.parse({
    id: book.id,
    digest: book.digest,
    title: book.draft.title,
    topicId: book.request.topic.id.toLowerCase(),
    topicName: book.request.topic.name,
  });
}
const unavailable = () =>
  Error(
    "教材との関連づけを読み書きできません。保存済みの記録は保持しています。再試行してください。",
  );
const unsupportedFormat = () =>
  Error(
    "教材との関連づけの保存形式を確認できません。記録は変更していません。対応するアプリの版を確認してください。",
  );
/** 不明な既存DBのkeyPathで、別の記事の関連づけを上書きしない。 */
function hasLinkLayout(db: IDBDatabase): boolean {
  try {
    if (db.objectStoreNames.length !== 1) return false;
    const store = db.transaction("links").objectStore("links");
    const index = store.index("articleId");
    return (
      store.keyPath === "id" &&
      !store.autoIncrement &&
      store.indexNames.length === 1 &&
      index.keyPath === "source.articleId" &&
      !index.unique &&
      !index.multiEntry
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError")
      return false;
    throw error;
  }
}
let connection: Promise<IDBDatabase> | undefined;
/** 記事DBと分離して開き、記事検索や教材ファイルに個人の関連情報を混ぜない。 */
export function openTextbookLinks(): Promise<IDBDatabase> {
  if (connection)
    return connection.then((db) => {
      // 復元が他の保存領域へ書く前に、通知のなかったcloseも検出する。
      db.transaction("links");
      return db;
    });
  let failed = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = openLibraryDatabase(textbookLinkDatabase, 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore("links", { keyPath: "id" })
        .createIndex("articleId", "source.articleId");
    };
    request.onerror = () => {
      failed = true;
      reject(
        request.error?.name === "VersionError"
          ? unsupportedFormat()
          : unavailable(),
      );
    };
    request.onblocked = () => {
      failed = true;
      reject(unavailable());
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      let compatible;
      try {
        compatible = hasLinkLayout(db);
      } catch {
        db.close();
        reject(unavailable());
        return;
      }
      if (!compatible) {
        db.close();
        reject(unsupportedFormat());
        return;
      }
      guardLibraryConnection(
        db,
        () => {
          if (connection === pending) connection = undefined;
        },
        unavailable,
      );
      resolve(db);
    };
  });
  connection = pending;
  void pending.catch(() => {
    if (connection === pending) connection = undefined;
  });
  return pending;
}
/** 現在の記事に結び付く少数の記録だけを読み、不明な保存内容は保持して失敗させる。 */
export async function readTextbookLinks(
  articleId: string,
): Promise<TextbookLink[]> {
  const db = await openTextbookLinks();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("links"),
        get = tx
          .objectStore("links")
          .index("articleId")
          .getAll(articleId, textbookLinkLimit + 1);
      tx.oncomplete = () => {
        try {
          if (get.result.length > textbookLinkLimit) throw unavailable();
          const rows = get.result.map((value: unknown) => schema.parse(value));
          resolve(
            rows.sort(
              (a, b) =>
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id),
            ),
          );
        } catch {
          reject(unavailable());
        }
      };
      tx.onerror = tx.onabort = () => reject(unavailable());
    } catch {
      reject(unavailable());
    }
  });
}
/** 同一トランザクションで版競合と容量を検査し、変更できるのは関連理由だけとする。 */
export async function writeTextbookLink(
  input: TextbookLink,
  expected: number | null,
  remove = false,
) {
  const link = schema.parse(input);
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))
    throw unavailable();
  if (!remove && link.revision !== (expected ?? 0) + 1) throw unavailable();
  if (remove && expected === null) throw unavailable();
  if (expected === null) {
    const book = await readSharedTextbook(link.target.id);
    if (
      !book ||
      JSON.stringify(textbookLinkTarget(book)) !== JSON.stringify(link.target)
    )
      throw Error(
        "選んだ教材の版を確認できません。教材を取り込み直してから再試行してください。",
      );
  }
  const db = await openTextbookLinks();
  return new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction("links", "readwrite"),
        store = tx.objectStore("links"),
        get = store.get(link.id),
        count = store.index("articleId").count(link.source.articleId),
        total = store.count();
      let failure = unavailable();
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure);
      total.onsuccess = () => {
        try {
          const raw = get.result;
          if (raw !== undefined && !validTextbookLink(raw)) throw unavailable();
          const old = raw === undefined ? undefined : schema.parse(raw);
          if ((old?.revision ?? null) !== expected)
            throw Error(
              "別の画面で関連づけが変更されています。再読み込みして確認してください。",
            );
          if (
            old &&
            (JSON.stringify(old.source) !== JSON.stringify(link.source) ||
              JSON.stringify(old.target) !== JSON.stringify(link.target) ||
              old.createdAt !== link.createdAt)
          )
            throw Error(
              "参照する記事や教材の版は変更できません。必要なら別の関連づけを作成してください。",
            );
          if (
            !old &&
            (count.result >= textbookLinkLimit ||
              total.result >= textbookLinkTotalLimit)
          )
            throw Error(
              "関連づけの保存上限（記事ごと20件・全体20,000件）に達しました。既存の記録は保持しています。",
            );
          if (remove) store.delete(link.id);
          else store.put(link);
        } catch (error) {
          failure =
            error instanceof Error && !(error instanceof DOMException)
              ? error
              : unavailable();
          tx.abort();
        }
      };
    } catch {
      reject(unavailable());
    }
  });
}
