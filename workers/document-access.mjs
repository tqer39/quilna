import { z } from "zod";
import { cloudFeedURL } from "./feed-fetch.mjs";

const ownerSchema = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expires: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    evidence: z.string().min(5).max(2000),
  })
  .strict();

// No public mutation endpoint. An operator must record the exact source and
// delivery permission, then explicitly grant members in the access database.
export async function documentAccess(
  env,
  owner,
  sourceURL,
  audience,
  now = Date.now,
) {
  ownerSchema.parse(owner);
  const url = cloudFeedURL(
    sourceURL,
    env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).hostname] : [],
  ).href;
  if (audience === "private") return { url, scope: `private:${owner}` };
  if (audience !== "shared") throw Error("document-request");
  if (!env.DOCUMENT_ACCESS_DB?.withSession)
    throw Error("document-unconfigured");
  // A new first-primary session for every check avoids reusing a stale replica
  // bookmark when a grant is withdrawn during network or storage work.
  let row = await env.DOCUMENT_ACCESS_DB.withSession("first-primary")
    .prepare(
      `SELECT p.id, p.revision, p.expires, p.evidence
      FROM document_policies p JOIN document_members m ON m.policy_id = p.id
      WHERE p.source_url = ? AND p.enabled = 1 AND m.owner_hash = ?`,
    )
    .bind(url, owner)
    .first();
  let resolvedURL = url,
    aliasExpires = Infinity;
  if (!row) {
    row = await env.DOCUMENT_ACCESS_DB.withSession("first-primary")
      .prepare(
        `SELECT p.id, p.revision, p.expires, p.evidence, p.source_url,
          a.expires AS alias_expires, a.evidence AS alias_evidence
        FROM document_aliases a
        JOIN document_policies p ON p.id = a.policy_id
        JOIN document_members m ON m.policy_id = p.id
        WHERE a.alias_url = ? AND a.enabled = 1 AND p.enabled = 1
          AND a.policy_revision = p.revision AND m.owner_hash = ?
          AND NOT EXISTS (SELECT 1 FROM document_policies WHERE source_url = a.alias_url)`,
      )
      .bind(url, owner)
      .first();
    if (row) {
      const alias = z
        .object({
          source_url: z.string(),
          alias_expires: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER),
          alias_evidence: z.string().min(5).max(2000),
        })
        .parse(row);
      aliasExpires = alias.alias_expires;
      resolvedURL = cloudFeedURL(
        alias.source_url,
        env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).hostname] : [],
      ).href;
      if (resolvedURL !== alias.source_url) throw Error("document-unavailable");
    }
  }
  if (!row) throw Error("document-unavailable");
  const policy = policySchema.parse({
    id: row.id,
    revision: row.revision,
    expires: row.expires,
    evidence: row.evidence,
  });
  if (Math.min(policy.expires, aliasExpires) <= now())
    throw Error("document-unavailable");
  return { url: resolvedURL, scope: `shared:${policy.id}:${policy.revision}` };
}

export const documentRequest = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("acquire"),
      url: z.string().max(2048),
      audience: z.enum(["private", "shared"]),
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      url: z.string().max(2048),
      audience: z.enum(["private", "shared"]),
      versionId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("history"),
      url: z.string().max(2048),
      audience: z.enum(["private", "shared"]),
      after: z.string().uuid().optional(),
    })
    .strict(),
]);

export function documentError(error) {
  const status = error.message;
  if (status === "document-unavailable") return { code: 404, status };
  if (status === "document-unconfigured") return { code: 503, status };
  if (["document-capacity", "document-conflict"].includes(status))
    return { code: 409, status };
  if (error instanceof z.ZodError || status === "document-request")
    return { code: 400, status: "document-request" };
  return { code: 502, status: "document-failed" };
}
