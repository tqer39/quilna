import type { FeedArticle } from "./feed-parser";
import {
  documentFreshnessMs,
  validDocumentReference,
  type DocumentReference,
} from "./source-document";

export type ArticleUpdate = {
  checkedAt: number;
  fingerprint?: string;
  failures: number;
  retryAt: number;
  latest?: DocumentReference;
  error?: string;
};
export const articleUpdatePreferenceKey = "quilna.article.updates.v1";
export function automaticArticleUpdates(): boolean {
  try {
    return localStorage.getItem(articleUpdatePreferenceKey) !== "false";
  } catch {
    return false;
  }
}
export function validArticleUpdate(v: unknown): v is ArticleUpdate | undefined {
  if (v === undefined) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const u = v as ArticleUpdate;
  return (
    [u.checkedAt, u.retryAt].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15,
    ) &&
    Number.isInteger(u.failures) &&
    u.failures >= 0 &&
    u.failures <= 8 &&
    (u.fingerprint === undefined ||
      (typeof u.fingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(u.fingerprint))) &&
    (u.latest === undefined || validDocumentReference(u.latest)) &&
    (u.error === undefined ||
      (typeof u.error === "string" && u.error.length <= 2000))
  );
}
export function nextArticleUpdate(a: FeedArticle): number {
  if (!a.content || !a.url) return Infinity;
  if (a.bodyUpdate?.error) return a.bodyUpdate.retryAt;
  if (
    a.feedRevision &&
    (a.bodyUpdate
      ? a.feedRevision.fingerprint !== a.bodyUpdate.fingerprint
      : Date.parse(a.feedRevision.changedAt) > Date.parse(a.content.fetchedAt))
  )
    return 0;
  return (
    (a.bodyUpdate?.checkedAt ?? Date.parse(a.content.fetchedAt)) +
    documentFreshnessMs
  );
}
export function hasArticleUpdate(a: FeedArticle): boolean {
  const latest = a.bodyUpdate?.latest;
  return !!latest && latest.versionId !== a.content?.document?.versionId;
}
// Personal flags, translations, reading position and tags may change while a
// request runs. Only changes to the source/selected version invalidate it.
export function articleUpdateIdentity(a: FeedArticle): string {
  return JSON.stringify([a.url, a.content, a.feedRevision, a.bodyUpdate]);
}
