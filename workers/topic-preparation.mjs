import { z } from "zod";
import { publicDocumentAccess } from "./public-document-access.mjs";
import { documentIdentity } from "../src/source-document.ts";
import {
  topicPreparationInputSchema,
  topicPreparationPageSchema,
  topicEvidenceSchema,
} from "../src/topic-preparation-protocol.ts";
import {
  evidenceExcerpt,
  topicTerms,
  bestTopicEvidence,
} from "../src/topic-evidence.ts";
import {
  readTopicPublicSource,
  topicSourceSnapshot,
} from "./topic-public-sources.mjs";
const rowSchema = z
  .object({ id: z.string().uuid(), source_url: z.string().max(2048) })
  .strict();
/** 公開済みの保存本文だけを探索する。元サイトの取得、LLM送信、個人DBの参照は行わない。 */
export async function prepareTopicEvidence(owner, input, env, now = Date.now) {
  const request = topicPreparationInputSchema.parse(input);
  const terms = topicTerms(request.topic);
  if (!terms.length) throw Error("topic-preparation-topic");
  if (
    env.PUBLIC_DOCUMENTS_ENABLED !== "true" ||
    env.DOCUMENTS_ENABLED !== "true" ||
    !env.DOCUMENTS ||
    typeof env.PUBLIC_DOCUMENT_RATE_LIMITER?.limit !== "function"
  )
    throw Error("topic-preparation-unconfigured");
  // 認証済みの探索も全体の負荷を制限し、匿名閲覧とは別の固定枠を使う。
  const quota = await env.PUBLIC_DOCUMENT_RATE_LIMITER.limit({
    key: "topic-preparation",
  });
  if (quota?.success !== true) {
    if (quota?.success === false) throw Error("rate-limit");
    throw Error("topic-preparation-unavailable");
  }
  if (!env.DOCUMENT_ACCESS_DB?.withSession)
    throw Error("topic-preparation-unconfigured");
  const result = await env.DOCUMENT_ACCESS_DB.withSession("first-primary")
    .prepare(
      `
    SELECT p.id, p.source_url FROM document_policies p
    JOIN document_publications u ON u.policy_id = p.id
    WHERE p.id > ? AND p.enabled = 1 AND u.enabled = 1
      AND p.expires > ? AND u.expires > ?
      AND u.policy_revision = p.revision AND u.source_revision = p.publication_revision
    ORDER BY p.id LIMIT 6`,
    )
    .bind(request.after ?? "", now(), now())
    .all();
  if (
    result.success !== true ||
    !Array.isArray(result.results) ||
    result.results.length > 6
  )
    throw Error("topic-preparation-unavailable");
  const rows = z
    .array(rowSchema.extend({ source_url: z.unknown() }))
    .parse(result.results);
  if (rows.some((r, n) => r.id <= (rows[n - 1]?.id ?? request.after ?? "")))
    throw Error("topic-preparation-unavailable");
  const selected = rows.slice(0, 5),
    sources = [];
  let unavailable = 0;
  for (const row of selected) {
    try {
      rowSchema.parse(row);
      const { documentId: id, version } = await readTopicPublicSource(
        env,
        row.source_url,
        now,
      );
      const excerpt = evidenceExcerpt(
        version.content.text,
        version.content.title,
        terms,
      );
      if (!excerpt) continue;
      const source = await topicSourceSnapshot(version, excerpt.excerpt);
      sources.push(
        topicEvidenceSchema.parse({
          source,
          documentId: id,
          versionId: version.id,
          score: excerpt.score,
          matchedTerms: excerpt.matchedTerms,
        }),
      );
    } catch {
      unavailable++;
    }
  }
  // 途中の待機中に取り消された公開許可を、同じページの候補へ残さない。
  const currentSources = [];
  for (const candidate of sources) {
    try {
      const access = await publicDocumentAccess(env, candidate.source.url, now);
      if (
        (await documentIdentity(access.scope, access.url)) !==
        candidate.documentId
      )
        throw Error();
      currentSources.push(candidate);
    } catch {
      unavailable++;
    }
  }
  return topicPreparationPageSchema.parse({
    account: owner,
    topic: request.topic,
    after: rows.length > 5 ? selected.at(-1).id : null,
    inspected: selected.length,
    unavailable,
    sources: bestTopicEvidence(currentSources),
  });
}
