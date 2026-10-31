import type { ArticleCodeRange } from "./document-format";
import { safeArticleLink, type ArticleStructure } from "./article-structure";

// Map boundaries through the same whitespace normalization used by legacy imports.
function replaceMapped(text: string, pattern: RegExp, replacement: string) {
  const edits: { start: number; end: number; output: number; delta: number }[] =
    [];
  let delta = 0;
  const result = text.replace(pattern, (match, offset: number) => {
    const output = offset + delta;
    delta += replacement.length - match.length;
    edits.push({ start: offset, end: offset + match.length, output, delta });
    return replacement;
  });
  return {
    text: result,
    map(index: number) {
      let low = 0,
        high = edits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (edits[mid].start <= index) low = mid + 1;
        else high = mid;
      }
      const e = edits[low - 1];
      return !e
        ? index
        : index >= e.end
          ? index + e.delta
          : e.output + Math.min(index - e.start, replacement.length);
    },
  };
}
export function serializeArticle(
  node: Node,
  base?: string,
): {
  text: string;
  codeRanges: ArticleCodeRange[];
  structure: ArticleStructure;
} {
  const pieces: {
    text: string;
    rawStart: number;
    rawLength: number;
    block?: boolean;
    map: (i: number) => number;
  }[] = [];
  const links: { start: number; end: number; href: string }[] = [];
  const headings: { start: number; end: number; level: number }[] = [];
  let prose = "",
    rawLength = 0;
  const add = (value: string) => {
    prose += value;
    rawLength += value.length;
  };
  const flush = () => {
    if (prose) {
      const first = replaceMapped(prose, /[^\S\n]+/g, " ");
      const second = replaceMapped(first.text, /\n\s*\n/g, "\n\n");
      pieces.push({
        text: second.text,
        rawStart: rawLength - prose.length,
        rawLength: prose.length,
        map: (i) => second.map(first.map(i)),
      });
    }
    prose = "";
  };
  const walk = (current: Node) => {
    if (current.nodeType === 3) {
      add(current.textContent ?? "");
      return;
    }
    if (current.nodeType !== 1) return;
    const element = current as Element,
      tag = element.tagName.toLowerCase();
    if (tag === "pre" || tag === "code") {
      const code = current.textContent ?? "";
      if (tag === "pre") add("\n\n");
      flush();
      if (code)
        pieces.push({
          text: code,
          rawStart: rawLength,
          rawLength: code.length,
          block: tag === "pre",
          map: (i) => i,
        });
      rawLength += code.length;
      if (tag === "pre") add("\n\n");
      return;
    }
    const start = rawLength;
    for (const child of Array.from(current.childNodes)) walk(child);
    if (tag === "a" && links.length < 2000) {
      const href = safeArticleLink(element.getAttribute("href") ?? "", base);
      if (element.hasAttribute("href") && href && rawLength > start)
        links.push({ start, end: rawLength, href });
    }
    if (/^h[1-6]$/.test(tag) && headings.length < 1000 && rawLength > start)
      headings.push({ start, end: rawLength, level: Number(tag[1]) });
    if (/^(p|div|li|h[1-6]|blockquote|br|tr)$/.test(tag)) add("\n\n");
  };
  walk(node);
  flush();
  let text = "";
  const codeRanges: ArticleCodeRange[] = [];
  const offsets: number[] = [];
  for (const [i, piece] of pieces.entries()) {
    const trimStart =
      i === 0 && piece.block === undefined
        ? piece.text.length - piece.text.trimStart().length
        : 0;
    const trimmed = piece.text.slice(trimStart);
    piece.text =
      i === pieces.length - 1 && piece.block === undefined
        ? trimmed.trimEnd()
        : trimmed;
    const map = piece.map;
    piece.map = (n) =>
      Math.max(0, Math.min(piece.text.length, map(n) - trimStart));
    offsets.push(text.length);
    const start = text.length;
    text += piece.text;
    if (piece.block !== undefined)
      codeRanges.push({ start, end: text.length, block: piece.block });
  }
  const mapped = (raw: number) => {
    let low = 0,
      high = pieces.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pieces[mid].rawStart <= raw) low = mid + 1;
      else high = mid;
    }
    const i = Math.max(0, low - 1),
      piece = pieces[i];
    return piece
      ? offsets[i] + piece.map(Math.min(raw - piece.rawStart, piece.rawLength))
      : 0;
  };
  const convert = <T extends { start: number; end: number }>(ranges: T[]) =>
    ranges
      .map((r) => ({ ...r, start: mapped(r.start), end: mapped(r.end) }))
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start);
  return {
    text,
    codeRanges,
    structure: {
      version: 1,
      links: convert(links),
      headings: convert(headings),
    },
  };
}
