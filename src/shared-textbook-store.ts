import { libraryName, openLibraryDatabase } from "./library-context";
import { z } from "zod";
import {
  parseSharedTextbook,
  sharedEnvelopeRecord,
  type SharedTextbook,
} from "./shared-textbook-format";

export const sharedTextbookDatabase = libraryName("quilna.shared-textbooks.v1");
/** Keep storage failure explicit while retaining earlier books and private answers. */
const unavailable = () =>
  Error(
    "教材の保存領域を利用できません。既存の教材と回答は保持しています。再試行してください。",
  );
/** Explain that a conflicting immutable edition was refused rather than replaced. */
const conflict = () =>
  Error(
    "同じ教材・版で内容の異なるファイルが保存済みです。上書きしませんでした。",
  );
const answerSchema = z
  .object({
    id: z.string().uuid(),
    textbook: z.string().regex(/^[a-f0-9]{64}$/),
    section: z.string(),
    question: z.string(),
    option: z.string(),
    correct: z.boolean(),
    time: z.string().datetime(),
  })
  .strict();
export type SharedAnswer = z.infer<typeof answerSchema>;

const editionID = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9]\d{0,9}$/);
const boundedNote = z
  .string()
  .min(1)
  .max(2000)
  .refine((s) => !!s.trim() && !s.includes("\0"));
const noticeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: editionID,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().uuid(),
    kind: z.enum(["correction", "withdrawn"]),
    reason: boundedNote,
    evidence: boundedNote,
    writer: z.literal("library-reader"),
    updatedAt: z.string().datetime(),
    replacement: z
      .object({ id: editionID, digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((n) => (n.kind === "correction") === !!n.replacement);
export type TextbookNotice = z.infer<typeof noticeSchema>;

/** 旧版の本文・回答を保持したまま、既知の保存構造だけを移行する。 */
function compatibleLayout(
  db: IDBDatabase,
  tx: IDBTransaction,
  notices: boolean,
) {
  try {
    const books = tx.objectStore("books"),
      answers = tx.objectStore("answers");
    const index = answers.index("textbook");
    return (
      db.objectStoreNames.length === (notices ? 3 : 2) &&
      books.keyPath === "id" &&
      !books.autoIncrement &&
      books.indexNames.length === 0 &&
      answers.keyPath === "id" &&
      !answers.autoIncrement &&
      answers.indexNames.length === 1 &&
      index.keyPath === "textbook" &&
      !index.unique &&
      !index.multiEntry &&
      (!notices ||
        (tx.objectStore("notices").keyPath === "id" &&
          !tx.objectStore("notices").autoIncrement &&
          tx.objectStore("notices").indexNames.length === 0))
    );
  } catch {
    return false;
  }
}

/** Open the separate imported-book database without upgrading or resetting a future schema. */
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = openLibraryDatabase(sharedTextbookDatabase, 2);
    let settled = false;
    request.onupgradeneeded = (event) => {
      if (settled) {
        request.transaction!.abort();
        return;
      }
      const db = request.result;
      if (event.oldVersion === 0) {
        db.createObjectStore("books", { keyPath: "id" });
        const answers = db.createObjectStore("answers", { keyPath: "id" });
        answers.createIndex("textbook", "textbook");
      } else if (!compatibleLayout(db, request.transaction!, false)) {
        request.transaction!.abort();
        return;
      }
      db.createObjectStore("notices", { keyPath: "id" });
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      const db = request.result;
      let compatible = false;
      try {
        compatible = compatibleLayout(
          db,
          db.transaction(["books", "answers", "notices"]),
          true,
        );
      } catch {
        /* 不明な構造も既存データを保持して拒む。 */
      }
      if (!compatible) {
        db.close();
        reject(unavailable());
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = request.onblocked = () => {
      settled = true;
      reject(unavailable());
    };
  });
}

/** 保守メモは作成者の署名ではなく、現在のライブラリ利用者の私的な判断として検査する。 */
function retainedNotice(row: unknown, book: SharedTextbook) {
  if (row === undefined) return undefined;
  const parsed = noticeSchema.safeParse(row);
  if (!parsed.success)
    throw Error(
      "訂正・撤回の記録の保存形式を確認できません。既存の記録を変更せず、対応するアプリの版で確認してください。",
    );
  const notice = parsed.data;
  if (
    book.request.schemaVersion !== 2 ||
    notice.id !== book.id ||
    notice.digest !== book.digest
  )
    throw unavailable();
  return notice;
}

export type TextbookNoticeState = {
  notice?: TextbookNotice;
  error?: Error;
  replacementState?: "available" | "withdrawn" | "unavailable";
};
/** 表示名ではなく、教材・テーマの同一性と後の版であることを確認する。 */
function correctionTarget(book: SharedTextbook, target: SharedTextbook) {
  return (
    book.request.schemaVersion === 2 &&
    target.request.schemaVersion === 2 &&
    target.request.topic.id.toLowerCase() ===
      book.request.topic.id.toLowerCase() &&
    target.record.bookID.toLowerCase() === book.record.bookID.toLowerCase() &&
    target.record.version > book.record.version
  );
}
/** 一度の読み込みで版ごとに結果を分離し、破損した1記録で別教材を読めなくしない。 */
export async function readTextbookNotices(
  books: SharedTextbook[],
): Promise<TextbookNoticeState[]> {
  type Row = { raw?: unknown; target?: unknown; targetNotice?: unknown };
  let rows: Row[];
  try {
    rows = await transaction<Row[]>(
      ["books", "notices"],
      "readonly",
      (tx, done) => {
        const rows: Row[] = books.map(() => ({}));
        done(rows);
        for (const [i, book] of books.entries()) {
          const get = tx.objectStore("notices").get(book.id);
          get.onsuccess = () => {
            rows[i].raw = get.result;
            try {
              const notice = retainedNotice(get.result, book);
              if (notice?.replacement) {
                const target = tx
                  .objectStore("books")
                  .get(notice.replacement.id);
                const note = tx
                  .objectStore("notices")
                  .get(notice.replacement.id);
                target.onsuccess = () => {
                  rows[i].target = target.result;
                };
                note.onsuccess = () => {
                  rows[i].targetNotice = note.result;
                };
              }
            } catch {
              /* この版の不明な記録は保存したまま、他の版の読み込みを続ける。 */
            }
          };
        }
      },
    );
  } catch {
    return books.map(() => ({ error: unavailable() }));
  }
  return Promise.all(
    rows.map(async (row, i): Promise<TextbookNoticeState> => {
      try {
        const notice = retainedNotice(row.raw, books[i]);
        if (!notice?.replacement) return { notice };
        try {
          retainedRecord(row.target, notice.replacement.id);
          const target = await parseSharedTextbook(
            (row.target as { raw: string }).raw,
          );
          if (
            target.id !== notice.replacement.id ||
            target.digest !== notice.replacement.digest ||
            !correctionTarget(books[i], target)
          )
            throw unavailable();
          const targetNotice = retainedNotice(row.targetNotice, target);
          return {
            notice,
            replacementState:
              targetNotice?.kind === "withdrawn" ? "withdrawn" : "available",
          };
        } catch {
          return { notice, replacementState: "unavailable" };
        }
      } catch (error) {
        return { error: error instanceof Error ? error : unavailable() };
      }
    }),
  );
}
/** 一つの版の不明な記録は明示的に拒否し、保存した内容は変更しない。 */
export async function readTextbookNotice(book: SharedTextbook) {
  const [state] = await readTextbookNotices([book]);
  if (state.error) throw state.error;
  return state.notice;
}

/** 同じ教材・テーマの後の版だけを訂正先とし、回答や既存の関連づけを移動しない。 */
export async function writeTextbookNotice(
  book: SharedTextbook,
  input: {
    kind: TextbookNotice["kind"];
    reason: string;
    evidence: string;
    replacement?: SharedTextbook;
  },
  expected: string | null,
) {
  const verified = await parseSharedTextbook(book.raw);
  const replacement =
    input.replacement && (await parseSharedTextbook(input.replacement.raw));
  if (
    verified.request.schemaVersion !== 2 ||
    (expected !== null && !z.string().uuid().safeParse(expected).success)
  )
    throw unavailable();
  if (replacement && !correctionTarget(verified, replacement))
    throw Error("同じテーマ・教材の後の版を訂正先に選んでください。");
  const notice = noticeSchema.parse({
    schemaVersion: 1,
    id: verified.id,
    digest: verified.digest,
    revision: crypto.randomUUID(),
    kind: input.kind,
    reason: input.reason.trim(),
    evidence: input.evidence.trim(),
    writer: "library-reader",
    updatedAt: new Date().toISOString(),
    ...(replacement
      ? { replacement: { id: replacement.id, digest: replacement.digest } }
      : {}),
  });
  await transaction<void>(
    ["books", "notices"],
    "readwrite",
    (tx, done, fail) => {
      const books = tx.objectStore("books"),
        notices = tx.objectStore("notices");
      const own = books.get(verified.id),
        previous = notices.get(verified.id);
      const target = replacement && books.get(replacement.id);
      const targetNotice = replacement && notices.get(replacement.id);
      const last = targetNotice ?? previous;
      last.onsuccess = () => {
        try {
          if (
            retainedRecord(own.result, verified.id) !==
            sharedEnvelopeRecord(verified.raw)
          )
            throw unavailable();
          const old = retainedNotice(previous.result, verified);
          if ((old?.revision ?? null) !== expected)
            throw Error(
              "別の画面で訂正・撤回の記録が変わりました。再読み込みして確認してください。",
            );
          if (
            replacement &&
            (retainedRecord(target!.result, replacement.id) !==
              sharedEnvelopeRecord(replacement.raw) ||
              retainedNotice(targetNotice!.result, replacement)?.kind ===
                "withdrawn")
          )
            throw Error(
              "訂正先の保存済み版を確認できないか、撤回されています。",
            );
          notices.put(notice);
          done();
        } catch (error) {
          fail(error instanceof Error ? error : unavailable());
        }
      };
    },
  );
  return notice;
}

/** 削除後の同じ版への新規記録も別のrevisionとし、古い画面からの取り消しを拒む。 */
export async function removeTextbookNotice(
  book: SharedTextbook,
  expected: string,
) {
  await transaction<void>(["notices"], "readwrite", (tx, done, fail) => {
    const store = tx.objectStore("notices"),
      request = store.get(book.id);
    request.onsuccess = () => {
      try {
        if (retainedNotice(request.result, book)?.revision !== expected)
          throw Error(
            "別の画面で訂正・撤回の記録が変わりました。再読み込みして確認してください。",
          );
        store.delete(book.id);
        done();
      } catch (error) {
        fail(error instanceof Error ? error : unavailable());
      }
    };
  });
}
/** Refuse a corrupt retained row before immutable-version comparison or answer append. */
function retainedRecord(row: unknown, id: string) {
  if (
    !row ||
    typeof row !== "object" ||
    !("id" in row) ||
    row.id !== id ||
    !("raw" in row) ||
    typeof row.raw !== "string" ||
    Object.keys(row).sort().join() !== "id,raw"
  )
    throw unavailable();
  return sharedEnvelopeRecord(row.raw);
}
/** Resolve only at commit and close every connection; aborted work remains an explicit failure. */
async function transaction<T>(
  names: string[],
  mode: IDBTransactionMode,
  work: (
    tx: IDBTransaction,
    done: (value: T) => void,
    fail: (error: Error) => void,
  ) => void,
) {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let result: T, failure: Error | undefined;
      /** Retain the intended failure and abort the whole transaction before publishing success. */
      const fail = (error: Error) => {
        failure = error;
        tx.abort();
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure ?? unavailable());
      try {
        work(
          tx,
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

/** Atomically add a validated file or accept an exact record reimport, never replacing a conflicting edition. */
export async function importSharedTextbook(raw: string) {
  const book = await parseSharedTextbook(raw);
  await transaction<void>(["books"], "readwrite", (tx, done, fail) => {
    const store = tx.objectStore("books"),
      existing = store.get(book.id),
      count = store.count();
    count.onsuccess = () => {
      try {
        if (existing.result !== undefined) {
          if (
            retainedRecord(existing.result, book.id) !==
            sharedEnvelopeRecord(book.raw)
          ) {
            fail(conflict());
            return;
          }
        } else {
          if (count.result >= 100) {
            fail(
              Error(
                "教材の保存上限（100版）に達しました。既存の教材は保持しています。",
              ),
            );
            return;
          }
          store.add({ id: book.id, raw: book.raw });
        }
        done();
      } catch {
        fail(unavailable());
      }
    };
  });
  return book;
}

/** Read and validate one exact URL-selected edition without scanning the library. */
export async function readSharedTextbook(id: string) {
  const row = await transaction<unknown>(["books"], "readonly", (tx, done) => {
    const request = tx.objectStore("books").get(id);
    request.onsuccess = () => done(request.result);
  });
  if (row === undefined) return undefined;
  retainedRecord(row, id);
  const book = await parseSharedTextbook((row as { raw: string }).raw);
  if (book.id !== id) throw unavailable();
  return book;
}

/** Validate every retained edition before exposing a complete, bounded library snapshot. */
export async function listSharedTextbooks(): Promise<SharedTextbook[]> {
  const rows = await transaction<unknown[]>(
    ["books"],
    "readonly",
    (tx, done) => {
      const request = tx.objectStore("books").getAll(undefined, 101);
      request.onsuccess = () => done(request.result);
    },
  );
  if (rows.length > 100) throw unavailable();
  const books: SharedTextbook[] = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      !("raw" in row) ||
      typeof row.raw !== "string"
    )
      throw unavailable();
    const book = await parseSharedTextbook(row.raw);
    retainedRecord(row, book.id);
    books.push(book);
  }
  return books.sort(
    (a, b) =>
      b.record.createdAt - a.record.createdAt || a.id.localeCompare(b.id),
  );
}

/** Read only this exact record's private answers and reject damaged references or outcomes. */
export async function readSharedAnswers(
  book: SharedTextbook,
): Promise<SharedAnswer[]> {
  const rows = await transaction<unknown[]>(
    ["answers"],
    "readonly",
    (tx, done) => {
      const request = tx
        .objectStore("answers")
        .index("textbook")
        .getAll(book.digest, 10_001);
      request.onsuccess = () => done(request.result);
    },
  );
  if (rows.length > 10_000) throw unavailable();
  return rows
    .map((row) => {
      const result = answerSchema.safeParse(row);
      if (!result.success) throw unavailable();
      const answer = result.data,
        question = book.draft.lessons.find(
          (s) => s.content.id === answer.section,
        )?.content.question;
      if (
        answer.textbook !== book.digest ||
        !question ||
        question.id !== answer.question ||
        !question.options.some((o) => o.id === answer.option) ||
        answer.correct !== (question.correctOptionID === answer.option)
      )
        throw unavailable();
      return answer;
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Append an answer only after confirming its immutable retained edition and per-edition capacity. */
export async function answerSharedTextbook(
  book: SharedTextbook,
  section: string,
  option: string,
) {
  // Revalidate the source archive rather than trusting mutable caller metadata.
  const verified = await parseSharedTextbook(book.raw),
    question = verified.draft.lessons.find((s) => s.content.id === section)
      ?.content.question;
  if (!question || !question.options.some((o) => o.id === option))
    throw unavailable();
  const answer = answerSchema.parse({
    id: crypto.randomUUID(),
    textbook: verified.digest,
    section,
    question: question.id,
    option,
    correct: option === question.correctOptionID,
    time: new Date().toISOString(),
  });
  await transaction<void>(
    ["books", "answers", "notices"],
    "readwrite",
    (tx, done, fail) => {
      const books = tx.objectStore("books"),
        answers = tx.objectStore("answers"),
        stored = books.get(verified.id),
        notice = tx.objectStore("notices").get(verified.id),
        count = answers.index("textbook").count(verified.digest);
      count.onsuccess = () => {
        try {
          if (retainedNotice(notice.result, verified)?.kind === "withdrawn") {
            fail(
              Error(
                "撤回として記録された版には新しい回答を保存できません。以前の回答は保持しています。",
              ),
            );
            return;
          }
          if (
            retainedRecord(stored.result, verified.id) !==
            sharedEnvelopeRecord(verified.raw)
          ) {
            fail(unavailable());
            return;
          }
          if (count.result >= 10_000) {
            fail(
              Error(
                "この教材の回答保存上限（10,000件）に達しました。以前の回答は保持しています。",
              ),
            );
            return;
          }
          answers.add(answer);
          done();
        } catch (error) {
          fail(
            error instanceof Error && !(error instanceof DOMException)
              ? error
              : unavailable(),
          );
        }
      };
    },
  );
  return answer;
}
