import { publicDocumentAccess } from "./public-document-access.mjs";
import { readBody } from "./http.mjs";
import {
  documentIdentity,
  validDocumentVersion,
  verifyDocumentIdentity,
} from "../src/source-document.ts";
import { sharedTextbookDigest } from "../src/shared-textbook-format.ts";
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
/** 取得を開始せず、現在の公開許可で読める保存原文だけを返す。呼出し側が先に流量を制限する。 */
export async function readTopicPublicSource(
  env,
  url,
  now = Date.now,
  versionId,
) {
  const access = await publicDocumentAccess(env, url, now);
  const id = await documentIdentity(access.scope, access.url);
  const response = await env.DOCUMENTS.get(env.DOCUMENTS.idFromName(id)).fetch(
    new Request("https://document.internal/public-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: access.url,
        scope: access.scope,
        ...(versionId ? { versionId } : {}),
      }),
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
  const current = await publicDocumentAccess(env, url, now);
  if (current.scope !== access.scope || current.url !== access.url)
    throw Error("document-unavailable");
  return { version, documentId: id, access };
}
/** 準備時と送信時で、題名・出典日時・抜粋の作り方を共通にする。 */
export async function topicSourceSnapshot(version, excerpt) {
  return {
    id: version.id,
    title: boundedTitle(version.content.title) || "題名のない公開資料",
    url: version.sourceURL,
    capturedAt: epoch(version.content.fetchedAt),
    publishedAt: version.content.info?.published
      ? epoch(version.content.info.published)
      : null,
    updatedAt: null,
    sourceFingerprint: await sharedTextbookDigest(bytes.encode(excerpt)),
    excerpt,
  };
}
