import type { ArticleCodeRange } from "./document-format";

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
    if (current.nodeType === 3) {
      prose += current.textContent ?? "";
      return;
    }
    if (current.nodeType !== 1) return;
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
