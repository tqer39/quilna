import { codeTokens } from "./code-syntax";

import { validCodeRanges, type ArticleCodeRange } from "./document-format";
export { validCodeRanges, type ArticleCodeRange } from "./document-format";

export function legacyArticleText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
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

export { serializeArticle } from "./article-serialization";

const copyControls = new WeakMap<
  HTMLElement,
  Map<number, { text: string; host: HTMLElement }>
>();

function codeCopyControl(text: string) {
  const host = document.createElement("div");
  host.className = "rss-code-tools";
  // Keep controls outside the source text used for selection and saved quotes.
  const root = host.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  button.type = "button";
  button.part.add("copy-button");
  button.textContent = "コピー";
  button.setAttribute("aria-label", "コードをコピー");
  const status = document.createElement("span");
  status.part.add("copy-status");
  status.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = "コピー中…";
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(text);
      status.textContent = "コピーしました";
    } catch {
      status.textContent =
        "コピーできませんでした。コードを選択してコピーしてください。";
    } finally {
      button.disabled = false;
    }
  });
  root.append(button, status);
  return host;
}

export function appendArticleText(
  parent: HTMLElement,
  text: string,
  ranges: ArticleCodeRange[] = [],
  renderText: (text: string, start: number) => Node = (value) =>
    document.createTextNode(value),
) {
  const previousControls = copyControls.get(parent);
  const currentControls = new Map<
    number,
    { text: string; host: HTMLElement }
  >();
  copyControls.set(parent, currentControls);
  let offset = 0;
  let syntaxBudget = 20_000;
  let syntaxBlocks = 0;
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
      if (
        segment.code.block &&
        segment.text.length <= syntaxBudget &&
        syntaxBlocks < 20
      ) {
        syntaxBudget -= segment.text.length;
        syntaxBlocks++;
        let position = offset;
        for (const token of codeTokens(segment.text)) {
          const node = renderText(token.text, position);
          if (token.classes.length) {
            const span = document.createElement("span");
            span.classList.add(...token.classes);
            span.append(node);
            code.append(span);
          } else code.append(node);
          position += token.text.length;
        }
      } else code.append(renderText(segment.text, offset));
      if (segment.code.block) {
        paragraph = undefined;
        const pre = document.createElement("pre");
        pre.append(code);
        const block = document.createElement("div");
        block.className = "rss-code-block";
        const previous = previousControls?.get(offset);
        const control =
          previous?.text === segment.text
            ? previous
            : { text: segment.text, host: codeCopyControl(segment.text) };
        currentControls.set(offset, control);
        block.append(control.host, pre);
        parent.append(block);
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
