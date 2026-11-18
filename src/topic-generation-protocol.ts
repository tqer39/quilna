import { z } from "zod";

const object = <T extends z.ZodRawShape>(fields: T) =>
  z.object(fields).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const topicGenerationInputSchema = object({
  requestId: uuid,
  purpose: z.enum(["book-addition", "evidence-check"]),
  modelId: z.string().min(1).max(100).optional(),
  requestRaw: z.string().min(1).max(96000),
  generationRequestId: uuid.optional(),
  generatorInvocation: uuid.optional(),
  draftRaw: z.string().min(1).max(96000).optional(),
  approvedPublicText: z.literal(true),
  retryUnsent: z.literal(true).optional(),
  approvedMaxMilliYen: z.number().int().positive().max(500000).optional(),
  approvedQuoteDigest: digest.optional(),
});
export type TopicGenerationInput = z.infer<typeof topicGenerationInputSchema>;
export const topicGenerationOutcomeSchema = z.enum([
  "complete",
  "refused",
  "incomplete",
  "invalid-output",
  "input-limit",
  "cancelled",
  "credential-unavailable",
]);
const invocation = object({
  id: z.string().uuid(),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
});
const envelopeFields = {
  requestDigest: digest,
  draftDigest: digest,
  json: z
    .string()
    .min(1)
    .max(120000)
    .refine((value) => new TextEncoder().encode(value).length <= 120000),
  invocation,
};
export const topicTextbookEnvelopeSchema = z.discriminatedUnion("kind", [
  object({ kind: z.literal("topic-textbook-draft"), ...envelopeFields }),
  object({
    kind: z.literal("topic-textbook-review"),
    ...envelopeFields,
    allChecksPassed: z.boolean(),
  }),
]);
export type TopicTextbookEnvelope = z.infer<typeof topicTextbookEnvelopeSchema>;
const account = z.string().regex(/^[a-f0-9]{64}$/);
export const topicGenerationFailureStatusSchema = z.enum([
  "account-forbidden",
  "unconnected",
  "model-unapproved",
  "cost-unconfigured",
  "count-unconfigured",
  "input-limit",
  "id-conflict",
  "busy",
  "cost-policy-changed",
  "budget-exhausted",
  "provider-budget-exhausted",
  "credential-changed",
  "not-found",
  "cost-unapproved",
  "cost-limit",
  "quote-changed",
  "materials-unavailable",
]);
export const topicGenerationReplySchema = z.discriminatedUnion("status", [
  object({
    status: z.literal("complete"),
    draft: topicTextbookEnvelopeSchema,
    outcome: z.literal("complete").optional(),
    account,
  }),
  object({
    status: z.enum(["reserved", "unknown"]),
    draft: z.null(),
    outcome: topicGenerationOutcomeSchema.optional(),
    account,
  }),
  object({
    status: z.literal("rejected"),
    draft: z.null(),
    outcome: topicGenerationOutcomeSchema.optional(),
    retryable: z.literal(true).optional(),
    account,
  }),
  object({
    status: topicGenerationFailureStatusSchema,
    draft: z.null().optional(),
    account,
  }),
]);
export type TopicGenerationReply = z.infer<typeof topicGenerationReplySchema>;
export const topicQuoteSchema = object({
  modelId: z.string().min(1).max(100),
  provider: z.literal("openai"),
  model: z.string().min(1).max(100),
  purpose: z.enum(["book-addition", "evidence-check"]),
  maxMilliYen: z.number().int().positive().max(500000),
  quoteDigest: digest,
  inputTokens: z.number().int().positive().max(8000),
  outputTokens: z.number().int().positive().max(2000),
  dataConditions: z.string().min(1).max(2000),
  priceCheckedAt: z.string().datetime(),
  costCheckedAt: z.string().datetime(),
});
export type TopicQuote = z.infer<typeof topicQuoteSchema>;
export const topicCapabilitiesSchema = object({
  mode: z.enum(["unconnected", "test-only"]),
  account,
  csrfToken: z.string().min(20).max(100),
  quotes: z.array(topicQuoteSchema).max(40),
  creations: object({
    available: z.boolean(),
    enabled: z.boolean(),
  }).optional(),
  budget: object({
    limitMilliYen: z.literal(500000),
    spentMilliYen: z.number().int().min(0).max(500000),
    heldMilliYen: z.number().int().min(0).max(500000),
    fixedMilliYen: z.number().int().min(0).max(500000).nullable(),
    safetyMilliYen: z.number().int().min(0).max(500000).nullable(),
  }),
});
export type TopicCapabilities = z.infer<typeof topicCapabilitiesSchema>;
