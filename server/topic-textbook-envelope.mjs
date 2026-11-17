import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const invocation = z
  .object({
    id: z.string().uuid(),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
  })
  .strict();
// 共通台帳を読むWorkersでも、Node固有APIなしで検査できる枠にする。
const fields = {
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
  z.object({ kind: z.literal("topic-textbook-draft"), ...fields }).strict(),
  z
    .object({
      kind: z.literal("topic-textbook-review"),
      ...fields,
      allChecksPassed: z.boolean(),
    })
    .strict(),
]);
