import { z } from "zod";
import {
  libraryName,
  libraryAccount,
  openLibraryDatabase,
  guardLibraryConnection,
} from "./library-context";
import {
  topicGenerationInputSchema,
  topicQuoteSchema,
  type TopicGenerationInput,
  type TopicQuote,
  type TopicTextbookEnvelope,
} from "./topic-generation-protocol";
import {
  parseTextbookRequest,
  parseTextbookCandidate,
  parseSharedTextbook,
  parseReviewedTextbookCandidate,
} from "./shared-textbook-format";

export const topicOperationDatabase = libraryName("quilna.topic-generation.v1");
export const topicOperationLimit = 200;
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const schema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuid,
    rootId: uuid,
    reviewRoot: uuid.optional(),
    bookID: uuid,
    account: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    title: z.string().min(1).max(500),
    input: topicGenerationInputSchema,
    quote: topicQuoteSchema,
    previousQuotes: z.array(topicQuoteSchema).max(20).optional(),
  })
  .strict()
  .refine(
    (op) =>
      op.id === op.input.requestId &&
      op.quote.modelId === op.input.modelId &&
      op.quote.purpose === op.input.purpose &&
      op.quote.maxMilliYen === op.input.approvedMaxMilliYen &&
      op.quote.quoteDigest === op.input.approvedQuoteDigest &&
      (op.input.purpose === "book-addition"
        ? op.rootId === op.id && op.reviewRoot === undefined
        : op.rootId === op.input.generationRequestId &&
          op.reviewRoot === op.rootId),
  );
export type TopicOperation = z.infer<typeof schema>;
const unavailable = () =>
  Error(
    "作成の控えを読み書きできません。保存済みの控えは保持しています。再試行してください。",
  );
const unsupported = () =>
  Error(
    "作成の控えの形式を確認できません。記録は変更していません。対応するアプリの版を確認してください。",
  );
function owner() {
  const account = libraryAccount();
  if (!account) throw Error("教材の作成にはログインしたライブラリが必要です。");
  return account;
}
async function validate(value: unknown): Promise<TopicOperation> {
  const op = schema.parse(value);
  if (op.account !== owner()) throw unsupported();
  const request = await parseTextbookRequest(op.input.requestRaw);
  if (
    request.schemaVersion !== 2 ||
    request.id.toLowerCase() !== op.rootId ||
    request.topic.name !== op.title
  )
    throw unsupported();
  if (op.input.purpose === "book-addition") {
    if (
      op.input.generationRequestId ||
      op.input.generatorInvocation ||
      op.input.draftRaw !== undefined
    )
      throw unsupported();
  } else {
    if (
      op.id === op.rootId ||
      !op.input.generatorInvocation ||
      op.input.draftRaw === undefined
    )
      throw unsupported();
    await parseTextbookCandidate(op.input.requestRaw, op.input.draftRaw);
  }
  if (op.account !== owner()) throw unsupported();
  return op;
}
let connection: Promise<IDBDatabase> | undefined;
/** 控えの保存完了より前にはproviderの処理を始めない。 */
export function openTopicOperations(): Promise<IDBDatabase> {
  owner();
  if (connection)
    return connection.then((db) => {
      db.transaction("operations");
      return db;
    });
  let failed = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = openLibraryDatabase(topicOperationDatabase, 1);
    request.onupgradeneeded = () => {
      if (failed) {
        request.transaction!.abort();
        return;
      }
      request.result
        .createObjectStore("operations", { keyPath: "id" })
        .createIndex("reviewRoot", "reviewRoot", { unique: true });
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(unavailable());
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      try {
        const store = db.transaction("operations").objectStore("operations");
        if (
          db.objectStoreNames.length !== 1 ||
          store.keyPath !== "id" ||
          store.autoIncrement ||
          store.indexNames.length !== 1 ||
          !store.indexNames.contains("reviewRoot") ||
          store.index("reviewRoot").keyPath !== "reviewRoot" ||
          !store.index("reviewRoot").unique ||
          store.index("reviewRoot").multiEntry
        )
          throw unsupported();
        guardLibraryConnection(
          db,
          () => {
            if (connection === pending) connection = undefined;
          },
          unavailable,
        );
        resolve(db);
      } catch {
        db.close();
        reject(unsupported());
      }
    };
  });
  connection = pending;
  void pending.catch(() => {
    if (connection === pending) connection = undefined;
  });
  return pending;
}
export async function listTopicOperations(): Promise<TopicOperation[]> {
  const db = await openTopicOperations();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction("operations"),
      get = tx
        .objectStore("operations")
        .getAll(undefined, topicOperationLimit + 1);
    tx.oncomplete = () => resolve(get.result);
    tx.onerror = tx.onabort = () => reject(unavailable());
  });
  if (rows.length > topicOperationLimit) throw unsupported();
  let operations;
  try {
    operations = await Promise.all(rows.map(validate));
  } catch {
    throw unsupported();
  }
  const roots = new Map(
    operations
      .filter((op) => op.input.purpose === "book-addition")
      .map((op) => [op.id, op]),
  );
  for (const op of operations) {
    const root = roots.get(op.rootId);
    if (
      !root ||
      root.bookID !== op.bookID ||
      root.input.requestRaw !== op.input.requestRaw
    )
      throw unsupported();
  }
  return operations.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
/** 同じ依頼は不変にし、別タブの控えや有料結果の参照先を上書きしない。 */
export async function retainTopicOperation(
  value: TopicOperation,
): Promise<void> {
  const op = await validate(value),
    db = await openTopicOperations();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite"),
      store = tx.objectStore("operations"),
      previous = store.get(op.id),
      root = store.get(op.rootId),
      review = store.index("reviewRoot").get(op.rootId),
      count = store.count();
    let message = unavailable();
    count.onsuccess = () => {
      if (previous.result !== undefined) {
        const old = schema.safeParse(previous.result);
        if (!old.success || JSON.stringify(old.data) !== JSON.stringify(op)) {
          message = unsupported();
          tx.abort();
        }
        return;
      }
      if (
        op.input.purpose === "evidence-check" &&
        review.result !== undefined
      ) {
        message = Error(
          "この候補には検証の控えがあります。保存した控えから結果を確認してください。",
        );
        tx.abort();
        return;
      }
      if (count.result >= topicOperationLimit) {
        message = Error(
          "作成の控えが200件に達しました。不要な控えを確認して整理してください。",
        );
        tx.abort();
        return;
      }
      if (op.input.purpose === "evidence-check") {
        const parent = schema.safeParse(root.result);
        if (
          !parent.success ||
          parent.data.account !== op.account ||
          parent.data.input.purpose !== "book-addition" ||
          parent.data.bookID !== op.bookID ||
          parent.data.input.requestRaw !== op.input.requestRaw
        ) {
          message = unsupported();
          tx.abort();
          return;
        }
      }
      store.add(op);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(message);
  }).catch((error) => {
    if (error instanceof DOMException) throw unavailable();
    throw error;
  });
}
/** 予約前の拒否からの再確認はID・本文・モデルを保ち、以前の見積りも残す。 */
export async function renewTopicApproval(
  previous: TopicOperation,
  quote: TopicQuote,
  retryUnsent = false,
): Promise<TopicOperation> {
  await validate(previous);
  if (
    previous.input.modelId !== quote.modelId ||
    previous.input.purpose !== quote.purpose ||
    previous.quote.provider !== quote.provider ||
    previous.quote.model !== quote.model
  )
    throw unsupported();
  const changed = JSON.stringify(previous.quote) !== JSON.stringify(quote);
  if (changed && (previous.previousQuotes?.length ?? 0) >= 20)
    throw Error(
      "費用の再確認の上限20回に達しました。控えは保持しています。接続と設定を確認してください。",
    );
  const op = await validate({
    ...previous,
    input: {
      ...previous.input,
      ...(retryUnsent ? { retryUnsent: true as const } : {}),
      approvedMaxMilliYen: quote.maxMilliYen,
      approvedQuoteDigest: quote.quoteDigest,
    },
    quote,
    previousQuotes: changed
      ? [...(previous.previousQuotes ?? []), previous.quote]
      : (previous.previousQuotes ?? []),
  });
  const db = await openTopicOperations();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite"),
      store = tx.objectStore("operations"),
      get = store.get(previous.id);
    get.onsuccess = () => {
      if (JSON.stringify(get.result) !== JSON.stringify(previous)) {
        tx.abort();
        return;
      }
      store.put(op);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(unavailable());
  });
  return op;
}
export async function newTopicOperation(
  input: TopicGenerationInput,
  quote: TopicQuote,
  parent?: TopicOperation,
): Promise<TopicOperation> {
  const request = await parseTextbookRequest(input.requestRaw);
  if (request.schemaVersion !== 2) throw unsupported();
  return validate({
    schemaVersion: 1,
    id: input.requestId,
    rootId: parent?.id ?? input.requestId,
    ...(parent ? { reviewRoot: parent.id } : {}),
    bookID: parent?.bookID ?? crypto.randomUUID(),
    account: owner(),
    createdAt: new Date().toISOString(),
    title: request.topic.name,
    input,
    quote,
  });
}
/** 控えの削除は外部の処理の中止ではなく、利用者の明示操作だけで行う。 */
export async function removeTopicOperations(rootId: string) {
  const id = uuid.parse(rootId),
    db = await openTopicOperations();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite"),
      store = tx.objectStore("operations"),
      get = store.getAll(undefined, topicOperationLimit + 1);
    get.onsuccess = () => {
      const values = z
        .array(schema)
        .max(topicOperationLimit)
        .safeParse(get.result);
      if (!values.success || values.data.some((op) => op.account !== owner())) {
        tx.abort();
        return;
      }
      for (const op of values.data) if (op.rootId === id) store.delete(op.id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(unavailable());
  });
}
const encode = (raw: string) =>
  btoa(
    Array.from(new TextEncoder().encode(raw), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
/** 有料の入力・出力をそのまま不変版に包み、個人の控え・同意・回答を教材へ混ぜない。 */
export async function generatedTopicBook(
  root: TopicOperation,
  review: TopicOperation,
  draft: TopicTextbookEnvelope,
  checked: TopicTextbookEnvelope,
) {
  await validate(root);
  await validate(review);
  if (
    root.input.purpose !== "book-addition" ||
    review.rootId !== root.id ||
    root.bookID !== review.bookID ||
    review.input.requestRaw !== root.input.requestRaw ||
    draft.kind !== "topic-textbook-draft" ||
    checked.kind !== "topic-textbook-review" ||
    !checked.allChecksPassed ||
    review.input.draftRaw !== draft.json ||
    review.input.generatorInvocation !== draft.invocation.id.toLowerCase() ||
    draft.invocation.provider !== root.quote.provider ||
    draft.invocation.model !== root.quote.model ||
    checked.invocation.provider !== review.quote.provider ||
    checked.invocation.model !== review.quote.model
  )
    throw unsupported();
  const content = await parseReviewedTextbookCandidate(
    root.input.requestRaw,
    draft.json,
    checked.json,
  );
  if (
    content.requestDigest !== draft.requestDigest ||
    content.requestDigest !== checked.requestDigest ||
    content.draftDigest !== draft.draftDigest ||
    content.draftDigest !== checked.draftDigest
  )
    throw unsupported();
  const raw = JSON.stringify({
    format: "TsumikiText",
    schemaVersion: 2,
    record: encode(
      JSON.stringify({
        schemaVersion: 2,
        bookID: root.bookID,
        version: 1,
        createdAt: Date.parse(root.createdAt) / 1000 - 978307200,
        request: encode(root.input.requestRaw),
        draft: encode(draft.json),
        review: encode(checked.json),
        generator: draft.invocation,
        reviewer: checked.invocation,
      }),
    ),
  });
  return parseSharedTextbook(raw);
}
