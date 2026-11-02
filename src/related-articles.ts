import type { FeedArticle } from "./feed-parser";
import { effectiveTags } from "./article-tags";
import { normalizeSearch } from "./article-search";
export type RelatedArticle = { article: FeedArticle; tags: string[] };
const yieldWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// Work only while the optional panel is open; navigation cancels a large scan.
export async function relatedArticles(
  current: FeedArticle,
  articles: readonly FeedArticle[],
  excluded: Set<string>,
  signal: AbortSignal,
  yieldBatch = yieldWork,
): Promise<RelatedArticle[]> {
  const tags = new Set(effectiveTags(current));
  const result: RelatedArticle[] = [];
  if (!tags.size) return result;
  for (let i = 0; i < articles.length; i++) {
    if (i % 500 === 0) {
      await yieldBatch();
      signal.throwIfAborted();
    }
    const article = articles[i];
    if (
      article.id === current.id ||
      excluded.has(article.id) ||
      (!article.read && !article.saved)
    )
      continue;
    const common = effectiveTags(article).filter((tag) => tags.has(tag));
    if (!common.length) continue;
    result.push({ article, tags: common });
    result.sort(
      (a, b) =>
        b.tags.length - a.tags.length ||
        (b.article.published ?? b.article.fetchedAt).localeCompare(
          a.article.published ?? a.article.fetchedAt,
        ) ||
        a.article.id.localeCompare(b.article.id),
    );
    result.length = Math.min(result.length, 3);
  }
  return result;
}
export async function findConnectionTargets(
  currentId: string,
  articles: readonly FeedArticle[],
  query: string,
  signal: AbortSignal,
  yieldBatch = yieldWork,
) {
  const q = normalizeSearch(query).trim();
  const found: FeedArticle[] = [];
  for (let i = 0; i < articles.length; i++) {
    if (i % 500 === 0) {
      await yieldBatch();
      signal.throwIfAborted();
    }
    const a = articles[i];
    if (
      a.id !== currentId &&
      normalizeSearch(a.title + "\n" + (a.content?.title ?? "")).includes(q)
    )
      found.push(a);
    if (found.length === 20) break;
  }
  return found;
}
