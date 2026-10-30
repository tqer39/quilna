import type { ArticleContent } from "./article-content";
import { articleTextLimit, validCodeRanges } from "./document-format";
import { sourceURL } from "./feed-discovery";
import {
  validSourceValidators,
  type SourceValidators,
} from "./http-validators.mjs";

// This is a local namespace, not a cross-user authorization mechanism.
export const browserDocumentScope = "browser-private";
export const documentFreshnessMs = 24 * 60 * 60 * 1000;
export type DocumentReference = {
  documentId: string;
  versionId: string;
  scope: string;
  sourceURL: string;
};
export type SourceDocument = {
  id: string;
  scope: string;
  sourceURL: string;
  currentVersionId: string;
  checkedAt: string;
  revision: number;
  validators?: SourceValidators;
};
export type DocumentVersion = {
  id: string;
  documentId: string;
  scope: string;
  sourceURL: string;
  representationHash: string;
  formatVersion: 1;
  createdAt: string;
  content: ArticleContent;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const documentUUID = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(v);
const scope = (v: unknown): v is string =>
  typeof v === "string" && !!v && v.length <= 200;
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
export function documentURL(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    return sourceURL(v) === v;
  } catch {
    return false;
  }
}
export function validDocumentReference(v: unknown): v is DocumentReference {
  return (
    object(v) &&
    documentUUID(v.documentId) &&
    documentUUID(v.versionId) &&
    scope(v.scope) &&
    documentURL(v.sourceURL)
  );
}
export function validSourceDocument(v: unknown): v is SourceDocument {
  return (
    object(v) &&
    documentUUID(v.id) &&
    scope(v.scope) &&
    documentURL(v.sourceURL) &&
    documentUUID(v.currentVersionId) &&
    (v.validators === undefined || validSourceValidators(v.validators)) &&
    timestamp(v.checkedAt) &&
    Number.isSafeInteger(v.revision) &&
    (v.revision as number) > 0
  );
}
export function validDocumentContent(v: unknown): v is ArticleContent {
  return (
    object(v) &&
    typeof v.text === "string" &&
    !!v.text &&
    v.text.length <= articleTextLimit &&
    documentURL(v.url) &&
    typeof v.title === "string" &&
    v.title.length <= 40000 &&
    typeof v.language === "string" &&
    v.language.length <= 40000 &&
    timestamp(v.fetchedAt) &&
    validCodeRanges(v.text, v.codeRanges) &&
    v.document === undefined
  );
}
export function validDocumentVersion(v: unknown): v is DocumentVersion {
  return (
    object(v) &&
    documentUUID(v.id) &&
    documentUUID(v.documentId) &&
    scope(v.scope) &&
    documentURL(v.sourceURL) &&
    typeof v.representationHash === "string" &&
    /^[\da-f]{64}$/.test(v.representationHash) &&
    v.formatVersion === 1 &&
    timestamp(v.createdAt) &&
    validDocumentContent(v.content)
  );
}
export function sourceContent(content: ArticleContent): ArticleContent {
  return {
    text: content.text,
    url: content.url,
    title: content.title,
    language: content.language,
    fetchedAt: content.fetchedAt,
    ...(content.codeRanges === undefined
      ? {}
      : {
          codeRanges: content.codeRanges.map((r) => ({
            start: r.start,
            end: r.end,
            block: r.block,
          })),
        }),
  };
}
export async function representationHash(content: ArticleContent) {
  const c = sourceContent(content);
  if (!validDocumentContent(c))
    throw Error(
      "文書の本文形式を確認できません。保存済みの内容は保持しています。",
    );
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      1,
      c.text,
      c.url,
      c.title,
      c.language,
      c.codeRanges ?? null,
    ]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
// Stable scoped identities allow independent browser backups to retain references.
// IDs are identifiers only; a future service must still authorize every lookup.
export async function documentIdentity(scope: string, url: string) {
  return stableIdentity(["quilna.document.v1", scope, sourceURL(url)]);
}
export async function versionIdentity(documentId: string, hash: string) {
  return stableIdentity(["quilna.document-version.v1", documentId, hash]);
}
async function stableIdentity(parts: string[]) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(parts)),
    ),
  );
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function verifyDocumentIdentity(
  value: SourceDocument | DocumentVersion,
) {
  const id = await documentIdentity(value.scope, value.sourceURL);
  if ("representationHash" in value) {
    return (
      value.documentId === id &&
      (await representationHash(value.content)) === value.representationHash &&
      value.id === (await versionIdentity(id, value.representationHash))
    );
  }
  return value.id === id;
}
export function versionContent(version: DocumentVersion): ArticleContent {
  return {
    ...version.content,
    document: {
      documentId: version.documentId,
      versionId: version.id,
      scope: version.scope,
      sourceURL: version.sourceURL,
    },
  };
}
