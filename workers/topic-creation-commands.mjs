import { z } from "zod";
import { topicQuoteSchema } from "../src/topic-generation-protocol.ts";
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
export const topicCreationCommandSchema = z.discriminatedUnion(
  "action",
  Object.entries(topicCreationPayloads).map(([action, payload]) =>
    (["approve", "retry", "review-again"].includes(action)
      ? payload.extend({ currentQuotes: z.array(topicQuoteSchema).max(40) })
      : payload
    ).extend({
      action: z.literal(action),
      owner: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
);
