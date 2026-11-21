import { z } from "zod";
import { topicQuoteSchema } from "./topic-generation-protocol.ts";
const id = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
export const topicCreationPayloads = Object.freeze({
  save: z.object({ requestRaw: z.string().min(1).max(96000) }).strict(),
  approve: z
    .object({
      id,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      confirm: z.literal(true),
      approvedPublicText: z.literal(true),
      generation: topicQuoteSchema,
      review: topicQuoteSchema,
    })
    .strict(),
  read: z.object({ id }).strict(),
  retry: z
    .object({
      id,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      quote: topicQuoteSchema,
      confirm: z.literal(true),
      approvedPublicText: z.literal(true),
    })
    .strict(),
  "review-again": z
    .object({
      id,
      reviewRequestId: id,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      quote: topicQuoteSchema,
      confirm: z.literal(true),
      approvedPublicText: z.literal(true),
    })
    .strict(),
  list: z.object({ after: id.optional() }).strict(),
  refresh: z.object({ id }).strict(),
  resume: z.object({ id, confirm: z.literal(true) }).strict(),
  remove: z
    .object({
      id,
      confirm: z.literal(true),
      discardGeneratedResult: z.literal(true).optional(),
    })
    .strict(),
});
export const topicCreationDispatches = new Set([
  "approve",
  "retry",
  "resume",
  "review-again",
]);
const account = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = z.enum([
  "draft",
  "generation",
  "review",
  "ready",
  "held",
  "rejected",
]);
const reason = z.enum([
  "",
  "operation-unconfirmed",
  "stage-rejected",
  "invalid-result",
  "capacity",
]);
const metadata = z
  .object({
    id,
    title: z.string().min(1).max(500),
    state,
    stage: z.enum(["generation", "review"]),
    createdAt: time,
    updatedAt: time,
    reason,
  })
  .strict();
const operation = z.union([
  z.object({ id, state: z.literal("unavailable") }).strict(),
  z
    .object({
      id,
      state: z.enum([
        "queued",
        "running",
        "complete",
        "rejected",
        "held",
        "cancelled",
      ]),
      reason: z.enum([
        "",
        "operation-unconfirmed",
        "stored-input-unavailable",
        "access-unavailable",
      ]),
      status: z.string().min(1).max(100).nullable(),
      outcome: z.string().min(1).max(100).nullable(),
      confirmedUnsent: z.boolean(),
      reviewPassed: z.boolean().nullable(),
    })
    .strict(),
]);
export const topicCreationSchema = metadata
  .extend({
    bookID: id,
    reviewRequestId: id,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    learningGoal: z.string().min(1).max(1000),
    requestRaw: z.string().min(1).max(96000),
    quotes: z
      .object({ generation: topicQuoteSchema, review: topicQuoteSchema })
      .strict()
      .nullable(),
    operation: operation.nullable(),
    book: z.string().max(540000).nullable(),
  })
  .refine(
    (r) =>
      r.updatedAt >= r.createdAt && (r.state === "ready") === (r.book !== null),
  )
  .refine((r) => (r.state === "draft" ? r.quotes === null : r.quotes !== null))
  .refine(
    (r) =>
      !r.quotes ||
      (r.quotes.generation.purpose === "book-addition" &&
        r.quotes.review.purpose === "evidence-check"),
  );
export const topicCreationReplySchema = z
  .object({ account, creation: topicCreationSchema.nullable() })
  .strict();
export const topicCreationListSchema = z
  .object({
    account,
    creations: z
      .array(
        z.union([
          metadata.refine((r) => r.updatedAt >= r.createdAt),
          z.object({ id, state: z.literal("unavailable") }).strict(),
        ]),
      )
      .max(20),
    next: id.nullable(),
  })
  .strict()
  .refine(
    (p) => new Set(p.creations.map((r) => r.id)).size === p.creations.length,
  )
  .refine((p) => p.next === null || p.next === p.creations.at(-1)?.id);
export const topicCreationRemovedSchema = z
  .object({ account, removed: z.literal(true) })
  .strict();
export type TopicCreation = z.infer<typeof topicCreationSchema>;
export type TopicCreationAction = keyof typeof topicCreationPayloads;
export type TopicCreationInput<A extends TopicCreationAction> = z.input<
  (typeof topicCreationPayloads)[A]
>;
export type TopicCreationReply<A extends TopicCreationAction> = A extends "list"
  ? z.infer<typeof topicCreationListSchema>
  : A extends "remove"
    ? z.infer<typeof topicCreationRemovedSchema>
    : z.infer<typeof topicCreationReplySchema>;
