import { z } from "zod";
import { topicSourceSchema } from "./shared-textbook-format.ts";
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (s) =>
        new TextEncoder().encode(s).length <= max &&
        !/[\uD800-\uDFFF\0]/u.test(s),
    );
export const topicPreparationInputSchema = z
  .object({
    topic: text(500),
    after: z.string().uuid().optional(),
  })
  .strict();
export const topicEvidenceSchema = z
  .object({
    source: topicSourceSchema.extend({
      url: z
        .string()
        .url()
        .max(2048)
        .refine((s) => {
          try {
            const u = new URL(s);
            return (
              u.protocol === "https:" &&
              !u.username &&
              !u.password &&
              u.href === s
            );
          } catch {
            return false;
          }
        }),
    }),
    documentId: z.string().uuid(),
    versionId: z.string().uuid(),
    score: z.number().int().min(1).max(120),
    matchedTerms: z.array(text(500)).min(1).max(8),
  })
  .strict()
  .refine((c) => c.source.id === c.versionId);
export const topicPreparationPageSchema = z
  .object({
    account: z.string().regex(/^[a-f0-9]{64}$/),
    topic: text(500),
    after: z.string().uuid().nullable(),
    inspected: z.number().int().min(0).max(5),
    unavailable: z.number().int().min(0).max(5),
    sources: z.array(topicEvidenceSchema).max(3),
  })
  .strict()
  .refine((p) => p.unavailable <= p.inspected)
  .refine((p) => p.sources.length <= p.inspected - p.unavailable)
  .refine(
    (p) =>
      new Set(p.sources.map((s) => s.documentId)).size === p.sources.length,
  );
export type TopicEvidence = z.infer<typeof topicEvidenceSchema>;
export type TopicPreparationPage = z.infer<typeof topicPreparationPageSchema>;
