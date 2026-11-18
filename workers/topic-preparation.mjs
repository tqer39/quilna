import { z } from "zod";
import { publicDocumentAccess } from "./public-document-access.mjs";
import { readBody } from "./http.mjs";
import {
  documentIdentity,
  validDocumentVersion,
  verifyDocumentIdentity,
} from "../src/source-document.ts";
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
import { sharedTextbookDigest } from "../src/shared-textbook-format.ts";
const rowSchema = z
  .object({ id: z.string().uuid(), source_url: z.string().max(2048) })
  .strict();
const bytes = new TextEncoder();
const epoch = (s) => Date.parse(s) / 1000 - 978307200;
function boundedTitle(s) {
  let title = "",
    size = 0;
  for (const char of s) {
    const length = bytes.encode(char).length;
    if (size + length > 2000) break;
    title += char;
    size += length;
  }
  return title.trim();
}
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
      const access = await publicDocumentAccess(env, row.source_url, now);
      const id = await documentIdentity(access.scope, access.url);
      const response = await env.DOCUMENTS.get(
        env.DOCUMENTS.idFromName(id),
      ).fetch(
        new Request("https://document.internal/public-read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: access.url, scope: access.scope }),
        }),
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error("document-unavailable");
      }
      const version = await readBody(response, 2000000);
      if (
        !validDocumentVersion(version) ||
        version.documentId !== id ||
        version.scope !== access.scope ||
        version.sourceURL !== access.url ||
        !(await verifyDocumentIdentity(version))
      )
        throw Error("document-unavailable");
      const excerpt = evidenceExcerpt(
        version.content.text,
        version.content.title,
        terms,
      );
      const current = await publicDocumentAccess(env, row.source_url, now);
      if (current.scope !== access.scope || current.url !== access.url)
        throw Error("document-unavailable");
      if (!excerpt) continue;
      const source = {
        id: version.id,
        title: boundedTitle(version.content.title) || "題名のない公開資料",
        url: access.url,
        capturedAt: epoch(version.content.fetchedAt),
        publishedAt: version.content.info?.published
          ? epoch(version.content.info.published)
          : null,
        updatedAt: null,
        sourceFingerprint: await sharedTextbookDigest(
          bytes.encode(excerpt.excerpt),
        ),
        excerpt: excerpt.excerpt,
      };
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
