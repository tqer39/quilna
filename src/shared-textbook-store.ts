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

/** Open the separate imported-book database without upgrading or resetting a future schema. */
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = openLibraryDatabase(sharedTextbookDatabase, 1);
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("books", { keyPath: "id" });
      const answers = db.createObjectStore("answers", { keyPath: "id" });
      answers.createIndex("textbook", "textbook");
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = request.onblocked = () => {
      settled = true;
      reject(unavailable());
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
    ["books", "answers"],
    "readwrite",
    (tx, done, fail) => {
      const books = tx.objectStore("books"),
        answers = tx.objectStore("answers"),
        stored = books.get(verified.id),
        count = answers.index("textbook").count(verified.digest);
      count.onsuccess = () => {
        try {
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
        } catch {
          fail(unavailable());
        }
      };
    },
  );
  return answer;
}
