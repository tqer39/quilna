import type { ArticleLink } from "./article-structure";

export type TextbookWord = { label: string; href: string };

/** 本文は書き換えず、既存リンク・コードと重ならない最初の技術語だけを入口にする。 */
export function textbookWordLinks(
  text: string,
  words: readonly TextbookWord[],
  reserved: readonly { start: number; end: number }[] = [],
): ArticleLink[] {
  const found: (ArticleLink & { expression: RegExp })[] = [];
  const latin = /[\p{Script=Latin}\p{Number}\p{Mark}_]/u;
  for (const { label, href } of words) {
    const name = label.trim();
    if (!name || !/[\p{Letter}\p{Number}]/u.test(name)) continue;
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const edge = "[\\p{Script=Latin}\\p{Number}\\p{Mark}_]";
    const katakana = /[\p{Script=Katakana}ー]/u;
    const first = Array.from(name)[0],
      last = Array.from(name).at(-1)!;
    const after =
      name.length === 1 ? "[\\p{Script=Latin}\\p{Number}\\p{Mark}_#+]" : edge;
    const expression = new RegExp(
      (latin.test(first)
        ? `(?<!${edge})`
        : katakana.test(first)
          ? "(?<![\\p{Script=Katakana}ー])"
          : "") +
        literal +
        (latin.test(last)
          ? `(?!${after})`
          : katakana.test(last)
            ? "(?![\\p{Script=Katakana}ー])"
            : ""),
      "giu",
    );
    for (const match of text.matchAll(expression)) {
      const start = match.index,
        end = start + match[0].length;
      if (reserved.some((r) => r.start < end && r.end > start)) continue;
      found.push({ start, end, href, expression });
      break;
    }
  }
  // 長い名称を優先してから本文順に戻し、同じ位置の別の行き先を勝手に選ばない。
  found.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const links: ArticleLink[] = [];
  for (const link of found) {
    if (
      found.some(
        (other) =>
          other.start === link.start &&
          other.end === link.end &&
          other.href !== link.href,
      )
    )
      continue;
    for (const match of text.matchAll(link.expression)) {
      const start = match.index,
        end = start + match[0].length;
      if (
        [...reserved, ...links].some(
          (other) => other.start < end && other.end > start,
        )
      )
        continue;
      links.push({ start, end, href: link.href });
      break;
    }
  }
  return links.sort((a, b) => a.start - b.start).slice(0, 30);
}
