// UTF-16 ranges in retained plain text; markup is never persisted or mounted.
export type ArticleLink = { start: number; end: number; href: string };
export type ArticleHeading = { start: number; end: number; level: number };
export type ArticleStructure = {
  version: 1;
  links: ArticleLink[];
  headings: ArticleHeading[];
};
export function safeArticleLink(value: string, base?: string): string | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function validArticleStructure(
  text: string,
  value: unknown,
): value is ArticleStructure | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const s = value as ArticleStructure;
  if (
    s.version !== 1 ||
    !Array.isArray(s.links) ||
    !Array.isArray(s.headings) ||
    s.links.length > 2000 ||
    s.headings.length > 1000
  )
    return false;
  const ranges = (items: (ArticleLink | ArticleHeading)[]) => {
    let end = 0;
    return Array.from(items).every((r) => {
      if (
        !r ||
        !Number.isSafeInteger(r.start) ||
        !Number.isSafeInteger(r.end) ||
        r.start < end ||
        r.end <= r.start ||
        r.end > text.length
      )
        return false;
      for (const i of [r.start, r.end])
        if (
          i > 0 &&
          /[\uD800-\uDBFF]/.test(text[i - 1]) &&
          /[\uDC00-\uDFFF]/.test(text[i])
        )
          return false;
      end = r.end;
      return true;
    });
  };
  return (
    ranges(s.links) &&
    ranges(s.headings) &&
    s.links.every(
      (r) => typeof r.href === "string" && safeArticleLink(r.href) === r.href,
    ) &&
    s.headings.every(
      (r) => Number.isInteger(r.level) && r.level >= 1 && r.level <= 6,
    )
  );
}
export type ArticleInfo = {
  author?: string;
  siteName?: string;
  published?: string;
};
export function validArticleInfo(
  value: unknown,
): value is ArticleInfo | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ArticleInfo;
  return (
    [v.author, v.siteName].every(
      (s) =>
        s === undefined ||
        (typeof s === "string" && s.length > 0 && s.length <= 300),
    ) &&
    (v.published === undefined ||
      (typeof v.published === "string" &&
        v.published.length <= 40 &&
        Number.isFinite(Date.parse(v.published))))
  );
}
