import { z } from "zod";
import { cloudFeedURL } from "./feed-fetch.mjs";

export const publicReader = "0".repeat(64);
const grant = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expires: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  publication_expires: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  evidence: z.string().trim().min(5).max(2000),
  publication_evidence: z.string().trim().min(5).max(2000),
});

/** 公開の許可は、既存の共有許可やメンバー権限から推測しない。 */
export async function publicDocumentAccess(env, source, now = Date.now) {
  if (
    env.PUBLIC_DOCUMENTS_ENABLED !== "true" ||
    env.DOCUMENTS_ENABLED !== "true" ||
    !env.DOCUMENTS ||
    !env.DOCUMENT_ACCESS_DB?.withSession
  )
    throw Error("document-unconfigured");
  let url;
  try {
    url = cloudFeedURL(
      source,
      env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).hostname] : [],
    ).href;
  } catch {
    throw Error("document-unavailable");
  }
  // 別名は公開先として自動承認せず、正確な取得元URLだけを解決する。
  const row = await env.DOCUMENT_ACCESS_DB.withSession("first-primary")
    .prepare(
      `SELECT p.id, p.revision, p.expires, p.evidence,
        u.expires AS publication_expires, u.evidence AS publication_evidence
      FROM document_policies p
      JOIN document_publications u ON u.policy_id = p.id
      WHERE p.source_url = ? AND p.enabled = 1 AND u.enabled = 1
        AND u.policy_revision = p.revision AND u.source_revision = p.publication_revision`,
    )
    .bind(url)
    .first();
  const parsed = grant.safeParse(row);
  if (
    !parsed.success ||
    Math.min(parsed.data.expires, parsed.data.publication_expires) <= now()
  )
    throw Error("document-unavailable");
  return { url, scope: `shared:${parsed.data.id}:${parsed.data.revision}` };
}
