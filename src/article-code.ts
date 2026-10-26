// UTF-16 offsets into the accompanying text, never HTML or executable markup.
export type ArticleCodeRange = { start: number; end: number; block: boolean };

export function legacyArticleText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

export function validCodeRanges(
  text: string,
  ranges: unknown,
): ranges is ArticleCodeRange[] | undefined {
  if (ranges === undefined) return true; // Existing plain-text articles remain readable.
  if (!Array.isArray(ranges) || ranges.length > 20_000) return false;
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      !range ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < previousEnd ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > text.length ||
      typeof range.block !== "boolean"
    )
      return false;
    // Do not split an astral character at either endpoint.
    for (const offset of [range.start, range.end]) {
      if (
        offset > 0 &&
        offset < text.length &&
        /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[offset])
      )
        return false;
    }
    previousEnd = range.end;
  }
  return true;
}

export function articleSegments(text: string, ranges: ArticleCodeRange[] = []) {
  if (!validCodeRanges(text, ranges))
    throw Error("記事のコード範囲を確認できませんでした。");
  const segments: { text: string; code?: ArticleCodeRange }[] = [];
  let offset = 0;
  for (const code of ranges) {
    if (code.start > offset)
      segments.push({ text: text.slice(offset, code.start) });
    segments.push({ text: text.slice(code.start, code.end), code });
    offset = code.end;
  }
  if (offset < text.length) segments.push({ text: text.slice(offset) });
  return segments;
}

export function serializeArticle(node: Node): {
  text: string;
  codeRanges: ArticleCodeRange[];
} {
  const pieces: { text: string; block?: boolean }[] = [];
  let prose = "";
  const flush = () => {
    if (prose)
      pieces.push({
        text: prose.replace(/[^\S\n]+/g, " ").replace(/\n\s*\n/g, "\n\n"),
      });
    prose = "";
  };
  const walk = (current: Node) => {
    if (current.nodeType === Node.TEXT_NODE) {
      prose += current.textContent ?? "";
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (current as Element).tagName.toLowerCase();
    if (tag === "pre" || tag === "code") {
      const code = current.textContent ?? "";
      if (tag === "pre") prose += "\n\n";
      flush();
      if (code) pieces.push({ text: code, block: tag === "pre" });
      if (tag === "pre") prose += "\n\n";
      return; // A pre owns nested code/highlighting; do not record overlapping ranges.
    }
    for (const child of Array.from(current.childNodes)) walk(child);
    if (/^(p|div|li|h[1-6]|blockquote|br|tr)$/.test(tag)) prose += "\n\n";
  };
  walk(node);
  flush();
  // Trim surrounding prose only. Leading indentation/trailing newlines in code are data.
  if (pieces[0] && pieces[0].block === undefined)
    pieces[0].text = pieces[0].text.trimStart();
  if (pieces.at(-1)?.block === undefined && pieces.length)
    pieces[pieces.length - 1].text = pieces[pieces.length - 1].text.trimEnd();
  let text = "";
  const codeRanges: ArticleCodeRange[] = [];
  for (const piece of pieces) {
    const start = text.length;
    text += piece.text;
    if (piece.block !== undefined)
      codeRanges.push({ start, end: text.length, block: piece.block });
  }
  return { text, codeRanges };
}

export function appendArticleText(
  parent: HTMLElement,
  text: string,
  ranges: ArticleCodeRange[] = [],
  renderText: (text: string, start: number) => Node = (value) =>
    document.createTextNode(value),
) {
  let offset = 0;
  let paragraph: HTMLParagraphElement | undefined;
  const getParagraph = () => {
    if (!paragraph) {
      paragraph = document.createElement("p");
      parent.append(paragraph);
    }
    return paragraph;
  };
  for (const segment of articleSegments(text, ranges)) {
    if (segment.code) {
      const code = document.createElement("code");
      code.append(renderText(segment.text, offset));
      if (segment.code.block) {
        paragraph = undefined;
        const pre = document.createElement("pre");
        pre.append(code);
        parent.append(pre);
      } else getParagraph().append(code);
      offset += segment.text.length;
      continue;
    }
    for (const piece of segment.text.split(/(\n\s*\n)/)) {
      if (/^\n\s*\n$/.test(piece)) paragraph = undefined;
      else if (piece.trim() || paragraph)
        getParagraph().append(renderText(piece, offset));
      offset += piece.length;
    }
  }
}
