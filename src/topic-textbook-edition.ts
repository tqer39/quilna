import {
  parseSharedTextbook,
  parseReviewedTextbookCandidate,
  parseTextbookCandidate,
} from "./shared-textbook-format.ts";
import {
  topicQuoteSchema,
  topicTextbookEnvelopeSchema,
  type TopicQuote,
  type TopicTextbookEnvelope,
} from "./topic-generation-protocol.ts";

const invalid = () => Error("topic-edition-invalid");
const encode = (raw: string) =>
  btoa(
    Array.from(new TextEncoder().encode(raw), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );

/** 背景処理でも、台帳の候補と実際の内容・承認モデルの対応を検査する。 */
export async function validateTopicDraft(
  requestRaw: string,
  value: TopicTextbookEnvelope,
  quote: TopicQuote,
) {
  const draft = topicTextbookEnvelopeSchema.parse(value);
  const approved = topicQuoteSchema.parse(quote);
  if (
    draft.kind !== "topic-textbook-draft" ||
    approved.purpose !== "book-addition" ||
    draft.invocation.provider !== approved.provider ||
    draft.invocation.model !== approved.model
  )
    throw invalid();
  const content = await parseTextbookCandidate(requestRaw, draft.json);
  if (
    content.request.schemaVersion !== 2 ||
    content.requestDigest !== draft.requestDigest ||
    content.draftDigest !== draft.draftDigest
  )
    throw invalid();
  return draft;
}

/** 個人の同意・作成控えを含めず、同じ入力から同じ不変版を作る。意味の正しさは保証しない。 */
export async function createTopicTextbookEdition({
  bookID,
  createdAt,
  requestRaw,
  draft,
  checked,
  generationQuote,
  reviewQuote,
}: {
  bookID: string;
  createdAt: string;
  requestRaw: string;
  draft: TopicTextbookEnvelope;
  checked: TopicTextbookEnvelope;
  generationQuote: TopicQuote;
  reviewQuote: TopicQuote;
}) {
  const generated = await validateTopicDraft(
    requestRaw,
    draft,
    generationQuote,
  );
  const reviewed = topicTextbookEnvelopeSchema.parse(checked);
  const approved = topicQuoteSchema.parse(reviewQuote);
  if (
    reviewed.kind !== "topic-textbook-review" ||
    !reviewed.allChecksPassed ||
    approved.purpose !== "evidence-check" ||
    reviewed.invocation.provider !== approved.provider ||
    reviewed.invocation.model !== approved.model ||
    generated.invocation.id.toLowerCase() ===
      reviewed.invocation.id.toLowerCase() ||
    !Number.isFinite(Date.parse(createdAt))
  )
    throw invalid();
  const content = await parseReviewedTextbookCandidate(
    requestRaw,
    generated.json,
    reviewed.json,
  );
  if (
    !content.allChecksPassed ||
    content.requestDigest !== reviewed.requestDigest ||
    content.draftDigest !== reviewed.draftDigest
  )
    throw invalid();
  return parseSharedTextbook(
    JSON.stringify({
      format: "TsumikiText",
      schemaVersion: 2,
      record: encode(
        JSON.stringify({
          schemaVersion: 2,
          bookID,
          version: 1,
          createdAt: Date.parse(createdAt) / 1000 - 978307200,
          request: encode(requestRaw),
          draft: encode(generated.json),
          review: encode(reviewed.json),
          generator: generated.invocation,
          reviewer: reviewed.invocation,
        }),
      ),
    }),
  );
}
