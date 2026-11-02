import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash,
  css,
  go,
  javascript,
  json,
  python,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, grammar] of Object.entries(languages))
  hljs.registerLanguage(name, grammar);

type Token = { text: string; classes: string[] };
const cache = new Map<string, Token[]>();
let cachedLength = 0;

/** Presentation only: never replace stored source or the reader's offset-bearing text nodes. */
export function codeTokens(text: string): Token[] {
  const plain: Token[] = [{ text, classes: [] }];
  if (!text || text.length > 10_000) return plain;
  const cached = cache.get(text);
  if (cached) return cached;
  let tokens = plain;
  try {
    const result = hljs.highlightAuto(text, Object.keys(languages));
    if (
      result.language &&
      result.relevance >= 2 &&
      result.value.length <= 500_000
    ) {
      // Parse generated markup inertly, then recreate only text and class-only spans.
      const template = document.createElement("template");
      template.innerHTML = result.value;
      const parsed: Token[] = [];
      const visit = (node: Node, classes: string[], depth: number) => {
        if (depth > 40 || parsed.length > 4000) throw Error("Token limit");
        if (node.nodeType === Node.TEXT_NODE) {
          parsed.push({ text: node.textContent ?? "", classes });
          return;
        }
        if (node instanceof Element) {
          if (node.tagName !== "SPAN") throw Error("Unexpected syntax markup");
          classes = [
            ...classes,
            ...Array.from(node.classList).filter((c) =>
              /^hljs-[a-z0-9_-]+$/.test(c),
            ),
          ];
        }
        for (const child of Array.from(node.childNodes))
          visit(child, classes, depth + 1);
      };
      visit(template.content, [], 0);
      if (parsed.map((token) => token.text).join("") === text) tokens = parsed;
    }
  } catch {
    // Failed or unsupported highlighting must never prevent reading/copying code.
  }
  while (cache.size >= 32 || cachedLength + text.length > 64_000) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
    cachedLength -= first.length;
  }
  cache.set(text, tokens);
  cachedLength += text.length;
  return tokens;
}
