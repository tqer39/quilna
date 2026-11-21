import { parseTextbookRequest } from "../src/shared-textbook-format.ts";
import {
  readTopicPublicSource,
  topicSourceSnapshot,
} from "./topic-public-sources.mjs";
import { publicDocumentAccess } from "./public-document-access.mjs";

async function materialRequest(requestRaw) {
  let request;
  try {
    request = await parseTextbookRequest(requestRaw);
  } catch {
    throw Error("topic-materials-request");
  }
  if (request.schemaVersion !== 2) throw Error("topic-materials-request");
  return request;
}
async function takeQuota(env, key, count) {
  if (
    env.PUBLIC_DOCUMENTS_ENABLED !== "true" ||
    env.DOCUMENTS_ENABLED !== "true" ||
    !env.DOCUMENTS ||
    typeof env.PUBLIC_DOCUMENT_RATE_LIMITER?.limit !== "function"
  )
    throw Error("topic-materials-unconfigured");
  for (let n = 0; n < count; n++) {
    const quota = await env.PUBLIC_DOCUMENT_RATE_LIMITER.limit({
      key: key,
    });
    if (quota?.success !== true)
      throw Error(
        quota?.success === false ? "rate-limit" : "topic-materials-unavailable",
      );
  }
}
/** 公開資料の同意だけで由来を信用せず、保存した版の原文・metadataと照合する。 */
export async function verifyTopicMaterials(
  requestRaw,
  env,
  now = Date.now,
  { dispatch = false } = {},
) {
  const request = await materialRequest(requestRaw);
  await takeQuota(
    env,
    dispatch ? "topic-creation-dispatch" : "topic-creation-material",
    1,
  );
  return retainedMaterials(request, env, now);
}
/** 段階の最大3回分を計数前に確保し、送信直前にも最新の許可/版を照合する。 */
export async function authorizeTopicMaterials(requestRaw, env, now = Date.now) {
  const request = await materialRequest(requestRaw);
  await takeQuota(env, "topic-creation-dispatch", 3);
  let remaining = 3;
  return async () => {
    if (remaining-- <= 0) throw Error("topic-materials-unavailable");
    return retainedMaterials(request, env, now);
  };
}
async function retainedMaterials(request, env, now) {
  const retained = [];
  for (const source of request.sources) {
    if (typeof source.url !== "string" || source.url.length > 2048)
      throw Error("topic-materials-invalid");
    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw Error("topic-materials-invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.href !== source.url
    )
      throw Error("topic-materials-invalid");
    const saved = await readTopicPublicSource(
      env,
      source.url,
      now,
      source.id.toLowerCase(),
    );
    const expected = await topicSourceSnapshot(saved.version, source.excerpt);
    if (
      !saved.version.content.text.includes(source.excerpt) ||
      source.id.toLowerCase() !== expected.id.toLowerCase() ||
      source.title !== expected.title ||
      source.url !== expected.url ||
      source.capturedAt !== expected.capturedAt ||
      (source.publishedAt ?? null) !== expected.publishedAt ||
      (source.updatedAt ?? null) !== expected.updatedAt ||
      source.sourceFingerprint !== expected.sourceFingerprint
    )
      throw Error("topic-materials-invalid");
    retained.push(saved);
  }
  if (new Set(retained.map((s) => s.documentId)).size !== retained.length)
    throw Error("topic-materials-invalid");
  for (const saved of retained) {
    const current = await publicDocumentAccess(env, saved.access.url, now);
    if (
      current.url !== saved.access.url ||
      current.scope !== saved.access.scope
    )
      throw Error("topic-materials-invalid");
  }
  return structuredClone(request);
}
