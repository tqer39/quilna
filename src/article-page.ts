import { tagState } from "./article-tags";
import type { FeedArticle } from "./feed-parser";

// Count every match, retaining only the requested page and the final page for
// clamping after a background update. Never materialize an all-match array.
export function articlePage(
  articles: readonly FeedArticle[],
  options: {
    matched: ReadonlySet<string> | null;
    source: string;
    filter: string;
    tagFilter: string;
    page: number;
    pageSize: number;
  },
) {
  const { matched, source, filter, tagFilter, page, pageSize } = options;
  const tag = tagFilter.startsWith("tag:") ? tagFilter.slice(4) : null;
  const state = tagFilter && tag === null ? tagFilter.slice(6) : null;
  const start = page * pageSize;
  const items: FeedArticle[] = [];
  const tail: FeedArticle[] = [];
  let count = 0;
  for (const article of articles) {
    if (matched && !matched.has(article.id)) continue;
    if (source && article.feedUrl !== source) continue;
    if (filter === "saved" && !article.saved) continue;
    if (filter === "unread" && article.read) continue;
    if (tag !== null) {
      // Check each independent layer without allocating arrays per article.
      const hasTag =
        article.sourceTags?.includes(tag) ||
        article.content?.sourceTags?.includes(tag) ||
        article.manualTags?.includes(tag) ||
        article.tags?.suggestions.some((suggestion) => suggestion.tag === tag);
      if (!hasTag) continue;
    } else if (state !== null && tagState(article) !== state) continue;
    if (count >= start && count < start + pageSize) items.push(article);
    tail[count % pageSize] = article;
    count++;
  }
  const lastPage = Math.max(0, Math.ceil(count / pageSize) - 1);
  return {
    count,
    page: Math.min(page, lastPage),
    items:
      page > lastPage ? tail.slice(0, count % pageSize || pageSize) : items,
  };
}
