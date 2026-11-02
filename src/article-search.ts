import { effectiveTags } from "./article-tags";
import type { FeedArticle } from "./feed-parser";
export const normalizeSearch = (text: string) =>
  text.normalize("NFKC").toLowerCase();
function matches(text: string, terms: string[]) {
  for (const term of terms) if (!text.includes(term)) return false;
  return true;
}
export class ArticleSearch {
  private queries = new Map<string, { terms: string[]; ids: Set<string> }>();
  // Preserve the former aggregate bound (16 queries × 5,000 IDs), while
  // allowing a broad result to share that budget instead of always rescanning.
  private static readonly cachedIdsLimit = 80_000;
  private trimQueries() {
    let ids = 0;
    for (const cached of this.queries.values()) ids += cached.ids.size;
    while (this.queries.size > 16 || ids > ArticleSearch.cachedIdsLimit) {
      const oldest = this.queries.keys().next().value!;
      ids -= this.queries.get(oldest)!.ids.size;
      this.queries.delete(oldest);
    }
  }
  private documents = new Map<
    string,
    { original: string[]; normalized: string }
  >();
  private generation = 0;
  ready = false;
  async prepare(
    articles: FeedArticle[],
    yieldWork = () => new Promise<void>((r) => setTimeout(r, 0)),
  ) {
    const generation = ++this.generation;
    this.queries.clear();
    this.ready = false;
    const next = new Map<string, { original: string[]; normalized: string }>();
    for (let i = 0; i < articles.length; i++) {
      if (i % 500 === 0) {
        await yieldWork();
        if (generation !== this.generation) return false;
      }
      const a = articles[i];
      const original = [
        effectiveTags(a).join(" "),
        a.title,
        a.body,
        a.content?.title ?? "",
        a.content?.text ?? "",
        a.translation?.sourceText === (a.content?.text || a.body)
          ? a.translation.text
          : "",
      ];
      const previous = this.documents.get(a.id);
      next.set(
        a.id,
        previous && previous.original.every((v, index) => v === original[index])
          ? previous
          : { original, normalized: normalizeSearch(original.join("\n")) },
      );
    }
    if (generation !== this.generation) return false;
    this.documents = next;
    this.ready = true;
    return true;
  }
  invalidate() {
    this.generation++;
    this.queries.clear();
    this.ready = false;
  }
  update(a: FeedArticle) {
    if (!this.ready) throw Error("検索の準備が終わっていません。");
    const original = [
      effectiveTags(a).join(" "),
      a.title,
      a.body,
      a.content?.title ?? "",
      a.content?.text ?? "",
      a.translation?.sourceText === (a.content?.text || a.body)
        ? a.translation.text
        : "",
    ];
    const normalized = normalizeSearch(original.join("\n"));
    this.documents.set(a.id, {
      original,
      normalized,
    });
    for (const cached of this.queries.values()) {
      if (matches(normalized, cached.terms)) cached.ids.add(a.id);
      else cached.ids.delete(a.id);
    }
    this.trimQueries();
  }
  search(query: string): Set<string> {
    if (!this.ready) throw Error("検索の準備が終わっていません。");
    const terms = normalizeSearch(query).trim().split(/\s+/u).filter(Boolean);
    const key = JSON.stringify(terms);
    const cached = this.queries.get(key);
    if (cached) {
      this.queries.delete(key);
      this.queries.set(key, cached);
      return new Set(cached.ids);
    }
    const found = new Set<string>();
    for (const [id, document] of this.documents)
      if (matches(document.normalized, terms)) found.add(id);
    // Bound memory even for queries matching the entire library. Incremental
    // writes repair cached matches above instead of rescanning every document.
    if (terms.length && found.size <= ArticleSearch.cachedIdsLimit) {
      this.queries.set(key, { terms, ids: new Set(found) });
      this.trimQueries();
    }
    return found;
  }
}
