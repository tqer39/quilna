import { z } from "zod";
import { libraryName, openLibraryDatabase } from "./library-context";

export const topicPreferenceDatabase = libraryName(
  "quilna.topic-textbook-preferences.v1",
);
export const topicPreferenceLimit = 20000;
const schema = z
  .object({
    id: z.string().max(81000),
    articleId: z.string().min(1).max(40000),
    topicId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
    topicName: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (s) => !!s.trim() && !s.includes("\0") && !/[\uD800-\uDFFF]/u.test(s),
      ),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((r) => r.id === JSON.stringify([r.articleId, r.topicId]));
export type HiddenTextbookTopic = z.infer<typeof schema>;
const unavailable = () =>
  Error(
    "教材候補の非表示設定を読み書きできません。以前の設定・教材・記事・回答は保持しています。再試行してください。",
  );
const unsupported = () =>
  Error(
    "教材候補の非表示設定の保存形式を確認できません。記録を変更せず、対応するアプリの版で確認してください。",
  );

/** 他の保存領域や不明な将来形式に触れず、このライブラリの設定だけを開く。 */
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = openLibraryDatabase(topicPreferenceDatabase, 1);
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction!.abort();
        return;
      }
      request.result
        .createObjectStore("hidden", { keyPath: "id" })
        .createIndex("articleId", "articleId");
    };
    request.onerror = () => {
      settled = true;
      reject(
        request.error?.name === "VersionError" ? unsupported() : unavailable(),
      );
    };
    request.onblocked = () => {
      settled = true;
      reject(unavailable());
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      try {
        const store = db.transaction("hidden").objectStore("hidden"),
          index = store.index("articleId");
        if (
          db.objectStoreNames.length !== 1 ||
          store.keyPath !== "id" ||
          store.autoIncrement ||
          store.indexNames.length !== 1 ||
          index.keyPath !== "articleId" ||
          index.unique ||
          index.multiEntry
        )
          throw unsupported();
        db.onversionchange = () => db.close();
        resolve(db);
      } catch {
        db.close();
        reject(unsupported());
      }
    };
  });
}
/** 成功はコミット後だけに返し、失敗時は既存の設定をそのまま残す。 */
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (
    store: IDBObjectStore,
    done: (result: T) => void,
    fail: (error: Error) => void,
  ) => void,
) {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("hidden", mode);
      let result: T, failure: Error | undefined;
      const fail = (error: Error) => {
        failure = error;
        tx.abort();
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure ?? unavailable());
      try {
        work(
          tx.objectStore("hidden"),
          (value) => {
            result = value;
          },
          fail,
        );
      } catch {
        fail(unavailable());
      }
    });
  } finally {
    db.close();
  }
}

/** 不明な設定を無視して候補を再表示せず、記事単位の完全な判断を取得する。 */
export async function readHiddenTextbookTopics(
  articleId: string,
): Promise<HiddenTextbookTopic[]> {
  const rows = await transaction<unknown[]>("readonly", (store, done) => {
    const request = store.index("articleId").getAll(articleId, 101);
    request.onsuccess = () => done(request.result);
  });
  if (rows.length > 100) throw unsupported();
  return rows
    .map((row) => {
      const parsed = schema.safeParse(row);
      if (!parsed.success || parsed.data.articleId !== articleId)
        throw unsupported();
      return parsed.data;
    })
    .sort(
      (a, b) =>
        a.topicName.localeCompare(b.topicName) ||
        a.topicId.localeCompare(b.topicId),
    );
}

/** 非表示は明示した記事・テーマだけに適用し、確定リンクや学習履歴へ波及させない。 */
export async function setTextbookTopicHidden(
  articleId: string,
  topic: { topicId: string; topicName: string },
  hidden: boolean,
) {
  const row = schema.parse({
    id: JSON.stringify([articleId, topic.topicId]),
    articleId,
    topicId: topic.topicId,
    topicName: topic.topicName,
    createdAt: new Date().toISOString(),
  });
  await transaction<void>("readwrite", (store, done, fail) => {
    const get = store.get(row.id),
      perArticle = store.index("articleId").count(articleId),
      total = store.count();
    total.onsuccess = () => {
      try {
        if (get.result !== undefined && !schema.safeParse(get.result).success)
          throw unsupported();
        if (hidden && get.result === undefined) {
          if (perArticle.result >= 100 || total.result >= topicPreferenceLimit)
            throw Error(
              "教材候補の非表示設定の上限（記事ごと100テーマ・合計20,000件）に達しました。以前の設定は保持しています。",
            );
          store.add(row);
        } else if (!hidden) store.delete(row.id);
        done();
      } catch (error) {
        fail(error instanceof Error ? error : unavailable());
      }
    };
  });
}
