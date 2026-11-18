import { z } from "zod";
import { topicGenerationInputSchema } from "../src/topic-generation-protocol.ts";

const id = z.string().uuid();
export const topicJobPayloads = Object.freeze({
  enqueue: z.object({ input: topicGenerationInputSchema }).strict(),
  retry: z
    .object({ input: topicGenerationInputSchema, confirm: z.literal(true) })
    .strict(),
  read: z.object({ id }).strict(),
  refresh: z.object({ id }).strict(),
  list: z.object({ after: id.optional() }).strict(),
  remove: z.object({ id, confirm: z.literal(true) }).strict(),
  cancel: z.object({ id, confirm: z.literal(true) }).strict(),
  resume: z.object({ id, confirm: z.literal(true) }).strict(),
});
export const topicJobDispatches = new Set(["enqueue", "retry", "resume"]);
export const topicJobCommandSchema = z.discriminatedUnion(
  "action",
  Object.entries(topicJobPayloads).map(([action, payload]) =>
    payload.extend({
      action: z.literal(action),
      owner: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
);
