import { Readability } from "@mozilla/readability";
import type { ArticleContent } from "./article-content";
import { articleTextLimit, type ArticleCodeRange } from "./document-format";
import { serializeArticle } from "./article-serialization";

export function extractArticleDocument(
  html: string,
  url: string,
  doc: Document,
  prepareFragment?: (fragment: DocumentFragment) => void,
): ArticleContent {
  if (html.length > 2_000_000)
    throw Error("記事が大きすぎるため取り込めませんでした。");
  // Never mount remote nodes. A template avoids subresource requests during parsing.
  const template = doc.createElement("template");
  // HTML tokenization normalizes literal CR/CRLF, but not &#13; references.
  template.innerHTML = html.replace(/\r\n?/g, "\n");
  const language =
    /<html\b[^>]*\blang=["']([a-zA-Z-]+)["']/i.exec(html)?.[1] ?? "";
  // Bound work before selector traversal, cloning, and Readability recursion.
  const stack: { node: Node; depth: number }[] = [
    { node: template.content, depth: 0 },
  ];
  let elements = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 256 || (node.nodeType === 1 && ++elements > 20000))
      throw Error("記事の構造が大きすぎるため取り込めませんでした。");
    for (const child of Array.from(node.childNodes))
      stack.push({ node: child, depth: depth + 1 });
  }
  prepareFragment?.(template.content);
  // Native template parsing discards these wrappers; DOM-only parsers retain them.
  for (const wrapper of Array.from(
    template.content.querySelectorAll("html,head,body"),
  ))
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  template.content
    .querySelectorAll(
      "script,style,iframe,object,embed,img,picture,video,audio,source,link,meta,base,form,nav,footer,template,svg,math,[hidden],[aria-hidden='true']",
    )
    .forEach((n) => n.remove());
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      if (!["class", "id", "lang", "dir"].includes(attr.name))
        element.removeAttribute(attr.name);
    }
  }
  // Readability rewrites consecutive br elements into paragraphs. Preserve code
  // line breaks first, inside the inert fragment, before that prose cleanup.
  template.content
    .querySelectorAll("pre br, code br")
    .forEach((br) => br.replaceWith("\n"));
  doc.body.append(doc.importNode(template.content, true));
  doc.documentElement.lang = language;
  doc.title =
    doc.body.querySelector("title")?.textContent ||
    doc.body.querySelector("h1")?.textContent ||
    "";
  doc.body.querySelectorAll("title").forEach((n) => n.remove());
  let codeRanges: ArticleCodeRange[] = [];
  const parsed = new Readability(doc, {
    maxElemsToParse: 20000,
    charThreshold: 140,
    serializer: (node) => {
      const serialized = serializeArticle(node);
      codeRanges = serialized.codeRanges;
      return serialized.text;
    },
  }).parse();
  const text = parsed?.content;
  if (!text || text.length < 140)
    throw Error(
      "記事本文を見つけられませんでした。ログインやサイト側の制限がある場合は元の記事を開いてください。",
    );
  if (text.length > articleTextLimit)
    throw Error(
      "本文が20万文字を超えるため取り込めませんでした。元の記事を開いてください。",
    );
  return {
    text,
    url,
    title: parsed?.title?.slice(0, 500) || new URL(url).hostname,
    language: language.slice(0, 35),
    fetchedAt: new Date().toISOString(),
    codeRanges,
  };
}
