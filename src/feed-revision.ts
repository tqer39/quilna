import type { FeedArticle } from "./feed-parser";
import { articleURL } from "./feed-parser";

/** The latest feed observation is separate from the reader's saved snapshot. */
export type FeedRevision = {
  fingerprint: string;
  changedAt: string;
  observedAt: string;
  url: string;
};
export function feedRepresentation(article: FeedArticle): string {
  return JSON.stringify([
    article.title,
    article.url,
    article.body,
    article.published,
    article.sourceUpdated ?? null,
    [...new Set(article.sourceTags ?? [])].sort(),
  ]);
}
export async function feedFingerprint(article: FeedArticle): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(feedRepresentation(article)),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function validFeedRevision(
  value: unknown,
): value is FeedRevision | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as FeedRevision;
  return (
    typeof v.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(v.fingerprint) &&
    [v.changedAt, v.observedAt].every(
      (d) =>
        typeof d === "string" &&
        d.length <= 40 &&
        Number.isFinite(Date.parse(d)),
    ) &&
    Date.parse(v.changedAt) <= Date.parse(v.observedAt) &&
    typeof v.url === "string" &&
    v.url.length <= 40000 &&
    (!v.url || articleURL(v.url, v.url) === v.url)
  );
}
