import { z } from "zod";

// The existing native file envelope keeps its name for compatibility. No
// provider client, credential store or personal learning store enters this module.
export const sharedTextbookMaximumBytes = 540_000;
/** Encode text for byte-based file and field bounds rather than UTF-16 character counts. */
const utf8 = (s: string) => new TextEncoder().encode(s);
/** Keep every portable payload closed to unknown fields, including nested private extensions. */
const object = <T extends z.ZodRawShape>(fields: T) =>
  z.object(fields).strict();
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Bound UTF-8 content while refusing empty text, NULs and unpaired surrogate code units. */
const text = (maximum: number) =>
  z
    .string()
    .refine(
      (s) =>
        /[^\p{White_Space}]/u.test(s) &&
        !s.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(s) &&
        utf8(s).length <= maximum,
    );
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const citation = object({ sourceID: uuid, quote: text(1500) });
const citations = z.array(citation).min(1).max(4);
/** Allow missing source metadata to stay unknown instead of inventing values. */
const nullable = <T extends z.ZodType>(schema: T) => schema.nullish();
const sourceSchema = object({
  id: uuid,
  articleID: text(1024),
  feedID: text(1024),
  remoteID: nullable(text(4096)),
  title: text(2000),
  url: nullable(
    text(4096).refine((s) => {
      try {
        const u = new URL(s);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          !!u.hostname &&
          !u.username &&
          !u.password
        );
      } catch {
        return false;
      }
    }),
  ),
  publishedAt: nullable(z.number().finite()),
  updatedAt: nullable(z.number().finite()),
  capturedAt: z.number().finite(),
  sourceFingerprint: digest,
  excerpt: text(6000),
  translation: nullable(
    object({
      articleID: text(1024),
      sourceFingerprint: digest,
      targetLanguage: text(64),
      translationDigest: digest,
    }),
  ),
});
const requestSchema = object({
  schemaVersion: z.literal(1),
  id: uuid,
  learningGoal: text(1000),
  sources: z.array(sourceSchema).min(1).max(3),
});
const lessonSchema = object({
  content: object({
    id: identifier,
    title: text(500),
    objective: text(1000),
    paragraphs: z.array(text(3000)).min(1).max(6),
    question: object({
      id: identifier,
      prompt: text(2000),
      options: z
        .array(
          object({ id: identifier, text: text(1000), explanation: text(2000) }),
        )
        .min(2)
        .max(5),
      correctOptionID: identifier,
    }),
  }),
  prerequisiteSectionIDs: z.array(identifier).max(8),
  assumedKnowledge: z.array(text(500)).max(8),
  workedExample: text(4000),
  explanationEvidence: citations,
  exampleEvidence: citations,
  questionEvidence: citations,
  optionEvidence: z.record(identifier, citations),
});
const draftSchema = object({
  schemaVersion: z.literal(1),
  title: text(500),
  lessons: z.array(lessonSchema).min(1).max(8),
});
const criteria = [
  "factualGrounding",
  "prerequisites",
  "workedExample",
  "questionUnambiguous",
  "correctAnswerSupported",
  "distractorsExplained",
] as const;
const reviewSchema = object({
  requestDigest: digest,
  draftDigest: digest,
  sections: z
    .array(
      object({
        sectionID: identifier,
        checks: z
          .array(
            object({
              criterion: z.enum(criteria),
              passed: z.boolean(),
              reason: text(2000),
            }),
          )
          .length(6),
      }),
    )
    .min(1)
    .max(8),
});
const invocation = object({ id: uuid, provider: text(100), model: text(200) });
const recordSchema = object({
  schemaVersion: z.literal(1),
  bookID: uuid,
  version: z.number().int().min(1).max(2147483647),
  createdAt: z.number().finite(),
  request: z.string(),
  draft: z.string(),
  review: z.string(),
  generator: invocation,
  reviewer: invocation,
});
const envelopeSchema = object({
  format: z.literal("TsumikiText"),
  schemaVersion: z.literal(1),
  record: z.string(),
});
/** Report a bounded validation failure without disclosing untrusted payloads or parser details. */
const invalid = () =>
  Error(
    "教材ファイルの形式・出典・版の対応を確認できません。保存済みのデータは変更していません。",
  );

// Reject duplicate decoded keys (including escaped spellings) and excessive
// nesting before validating every envelope, record and embedded byte payload.
/** Parse bounded archive JSON without silently accepting duplicate object keys. */
export function parseSharedJSON(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const token of raw.match(
    /"(?:\\.|[^"\\])*"|[{}:,]|\[|\]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
  ) ?? []) {
    if (token === "{" || token === "[") {
      if (stack.length >= 32) throw invalid();
      stack.push(token === "{" ? { keys: new Set(), key: true } : null);
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") {
      const frame = stack.at(-1);
      if (frame) frame.key = true;
    } else if (token.startsWith('"')) {
      const frame = stack.at(-1);
      if (frame?.key) {
        const key: string = JSON.parse(token);
        if (frame.keys.has(key)) throw invalid();
        frame.keys.add(key);
        frame.key = false;
      }
    }
  }
  return value;
}
/** Decode only bounded canonical base64 so opaque bytes cannot conceal extra payloads. */
const decode = (encoded: string, maximum: number) => {
  if (!encoded || encoded.length > Math.ceil(maximum / 3) * 4) throw invalid();
  const binary = atob(encoded);
  if (btoa(binary) !== encoded || binary.length > maximum) throw invalid();
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};
/** Decode embedded bytes strictly as UTF-8 before duplicate-key and shape validation. */
const jsonBytes = (bytes: Uint8Array) =>
  parseSharedJSON(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
/** Check identity collections without normalizing or silently dropping duplicate entries. */
const unique = (values: string[]) => new Set(values).size === values.length;
/** Hash exact retained bytes rather than reserialized objects. */
export async function sharedTextbookDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export type SharedLesson = z.infer<typeof lessonSchema>;
export type SharedSource = z.infer<typeof sourceSchema>;
export type SharedCitation = z.infer<typeof citation>;
export type SharedTextbook = Awaited<ReturnType<typeof parseSharedTextbook>>;

// Used inside an IndexedDB transaction to compare immutable record bytes; the
// incoming archive has already passed the asynchronous digest/semantic checks.
/** Read a strict bounded envelope for synchronous transaction-time record comparison. */
export function sharedEnvelopeRecord(raw: string) {
  if (utf8(raw).length > sharedTextbookMaximumBytes) throw invalid();
  return envelopeSchema.parse(parseSharedJSON(raw)).record;
}

/** Validate immutable content, source links and sender-reported checks without asserting semantic truth. */
export async function parseSharedTextbook(raw: string) {
  try {
    const encoded = sharedEnvelopeRecord(raw),
      recordBytes = decode(encoded, 400_000);
    const record = recordSchema.parse(jsonBytes(recordBytes));
    const requestBytes = decode(record.request, 48_000),
      draftBytes = decode(record.draft, 96_000),
      reviewBytes = decode(record.review, 120_000);
    const request = requestSchema.parse(jsonBytes(requestBytes)),
      draft = draftSchema.parse(jsonBytes(draftBytes)),
      review = reviewSchema.parse(jsonBytes(reviewBytes));
    if (
      !unique(request.sources.map((s) => s.id.toLowerCase())) ||
      !unique(request.sources.map((s) => s.articleID)) ||
      request.sources.some(
        (s) =>
          s.translation &&
          (s.translation.articleID !== s.articleID ||
            s.translation.sourceFingerprint !== s.sourceFingerprint),
      )
    )
      throw invalid();
    const earlier = new Set<string>(),
      questions = new Set<string>();
    for (const lesson of draft.lessons) {
      const { content } = lesson,
        q = content.question;
      if (
        earlier.has(content.id) ||
        questions.has(q.id) ||
        !unique(lesson.prerequisiteSectionIDs) ||
        lesson.prerequisiteSectionIDs.some((id) => !earlier.has(id))
      )
        throw invalid();
      earlier.add(content.id);
      questions.add(q.id);
      if (
        !unique(q.options.map((o) => o.id)) ||
        !q.options.some((o) => o.id === q.correctOptionID) ||
        !unique(
          q.options.map((o) =>
            o.text.replace(/\p{White_Space}+/gu, " ").trim(),
          ),
        ) ||
        Object.keys(lesson.optionEvidence).sort().join("\0") !==
          q.options
            .map((o) => o.id)
            .sort()
            .join("\0")
      )
        throw invalid();
      for (const refs of [
        lesson.explanationEvidence,
        lesson.exampleEvidence,
        lesson.questionEvidence,
        ...Object.values(lesson.optionEvidence),
      ]) {
        for (const ref of refs) {
          const source = request.sources.find(
            (s) => s.id.toLowerCase() === ref.sourceID.toLowerCase(),
          );
          if (!source || !source.excerpt.includes(ref.quote)) throw invalid();
        }
      }
    }
    const [requestHash, draftHash, recordHash] = await Promise.all([
      sharedTextbookDigest(requestBytes),
      sharedTextbookDigest(draftBytes),
      sharedTextbookDigest(recordBytes),
    ]);
    if (
      review.requestDigest !== requestHash ||
      review.draftDigest !== draftHash ||
      record.generator.id.toLowerCase() === record.reviewer.id.toLowerCase() ||
      !unique(review.sections.map((s) => s.sectionID)) ||
      review.sections
        .map((s) => s.sectionID)
        .sort()
        .join("\0") !==
        draft.lessons
          .map((s) => s.content.id)
          .sort()
          .join("\0") ||
      review.sections.some(
        (s) =>
          !unique(s.checks.map((c) => c.criterion)) ||
          s.checks.some((c) => !c.passed),
      )
    )
      throw invalid();
    return {
      raw,
      record,
      request,
      draft,
      review,
      digest: recordHash,
      id: `${record.bookID.toLowerCase()}:${record.version}`,
    };
  } catch {
    throw invalid();
  }
}
