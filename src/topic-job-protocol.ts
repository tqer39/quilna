import { z } from "zod";
import { topicGenerationReplySchema } from "./topic-generation-protocol";

const id = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metadata = z
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
    createdAt: time,
    updatedAt: time,
    reason: z.enum([
      "",
      "operation-unconfirmed",
      "stored-input-unavailable",
      "access-unavailable",
    ]),
  })
  .strict();
export const topicJobSchema = metadata
  .extend({ result: topicGenerationReplySchema.nullable() })
  .refine((job) => job.updatedAt >= job.createdAt)
  .refine(
    (job) =>
      !["complete", "rejected"].includes(job.state) || job.result !== null,
  )
  .refine(
    (job) => job.state !== "complete" || job.result?.status === "complete",
  )
  .refine(
    (job) =>
      job.state !== "rejected" ||
      ["rejected", "account-forbidden"].includes(job.result?.status ?? ""),
  )
  .refine(
    (job) =>
      !["queued", "cancelled"].includes(job.state) || job.result === null,
  );
const summary = z.union([
  metadata.refine((job) => job.updatedAt >= job.createdAt),
  z.object({ id, state: z.literal("unavailable") }).strict(),
]);
const account = z.string().regex(/^[a-f0-9]{64}$/);
export const topicJobListSchema = z
  .object({
    account,
    jobs: z.array(summary).max(20),
    after: id.nullable(),
  })
  .strict()
  .refine(
    (page) => new Set(page.jobs.map((job) => job.id)).size === page.jobs.length,
  )
  .refine((page) => page.after === null || page.jobs.at(-1)?.id === page.after);
export const topicJobReplySchema = z
  .object({ account, job: topicJobSchema.nullable() })
  .strict();
export const topicJobRemovedSchema = z
  .object({ account, removed: z.literal(true) })
  .strict();
export const topicJobReadInputSchema = z.object({ id }).strict();
export const topicJobListInputSchema = z
  .object({ after: id.optional() })
  .strict();
export const topicJobConfirmInputSchema = z
  .object({ id, confirm: z.literal(true) })
  .strict();
export type TopicJob = z.infer<typeof topicJobSchema>;
export type TopicJobSummary = z.infer<typeof summary>;
export type TopicJobPage = z.infer<typeof topicJobListSchema>;
