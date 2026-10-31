import { readerIcon } from "./reader-icons";
import { safeArticleLink, type ArticleStructure } from "./article-structure";
import { decorateArticleLink } from "./link-preview";
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
  button.append(readerIcon("copy"));
  button.title = "コードをコピー";
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
  structure?: ArticleStructure,
) {
  if (!structure) {
    const links = [];
    for (const match of text.matchAll(/https?:\/\/[^\s<>"「」]+/gu)) {
      const start = match.index!,
        value = match[0].replace(/[.,;:!?、。)）]+$/u, "");
      if (ranges.some((r) => r.start < start + value.length && r.end > start))
        continue;
      const href = safeArticleLink(value);
      if (href) links.push({ start, end: start + value.length, href });
      if (links.length === 2000) break;
    }
    structure = { version: 1, links, headings: [] };
  }
  const renderPlain = renderText;
  renderText = (value, start) => {
    const fragment = document.createDocumentFragment();
    let offset = start;
    for (const link of structure?.links ?? []) {
      if (link.end <= offset) continue;
      if (link.start >= start + value.length) break;
      if (link.start > offset)
        fragment.append(
          renderPlain(value.slice(offset - start, link.start - start), offset),
        );
      const from = Math.max(offset, link.start),
        to = Math.min(start + value.length, link.end);
      const anchor = document.createElement("a");
      anchor.href = link.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.className = "rss-body-link";
      anchor.append(renderPlain(value.slice(from - start, to - start), from));
      fragment.append(anchor);
      if (from === link.start) decorateArticleLink(anchor, link.href);
      offset = to;
    }
    if (offset < start + value.length)
      fragment.append(renderPlain(value.slice(offset - start), offset));
    return fragment;
  };
  const previousControls = copyControls.get(parent);
  const currentControls = new Map<
    number,
    { text: string; host: HTMLElement }
  >();
  copyControls.set(parent, currentControls);
  let offset = 0;
  let syntaxBudget = 20_000;
  let syntaxBlocks = 0;
  let paragraph: HTMLElement | undefined;
  const getParagraph = () => {
    if (!paragraph) {
      const heading = structure?.headings.find(
        (h) =>
          h.end > offset &&
          (h.start <= offset || !text.slice(offset, h.start).trim()),
      );
      paragraph = document.createElement(
        heading ? `h${Math.max(2, heading.level)}` : "p",
      );
      if (heading) {
        paragraph.id = `rss-section-${heading.start}`;
        paragraph.tabIndex = -1;
      }
      paragraph.dataset.readingStart = String(offset);
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
        pre.dataset.readingStart = String(offset);
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
