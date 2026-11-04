import {
  safeArticleLink,
  validArticleOrdinal,
  validArticleSpan,
  type ArticleStructure,
  type ArticleInfo,
} from "./article-structure";
import { normalizeSourceTags } from "./source-tags";
import { Readability } from "@mozilla/readability";
import type { ArticleContent } from "./article-content";
import { articleTextLimit, type ArticleCodeRange } from "./document-format";
import { serializeArticle } from "./article-serialization";

export function extractArticleDocument(
  html: string,
  url: string,
  doc: Document,
  prepareFragment?: (fragment: DocumentFragment) => void,
  parseFragment?: (html: string) => DocumentFragment,
): ArticleContent {
  if (html.length > 2_000_000)
    throw Error("記事が大きすぎるため取り込めませんでした。");
  // Never mount remote nodes. A template avoids subresource requests during parsing.
  const template = doc.createElement("template");
  // HTML tokenization normalizes literal CR/CRLF, but not &#13; references.
  const normalizedHTML = html.replace(/\r\n?/g, "\n");
  if (!parseFragment) template.innerHTML = normalizedHTML;
  const fragment = parseFragment?.(normalizedHTML) ?? template.content;
  const language =
    /<html\b[^>]*\blang=["']([a-zA-Z-]+)["']/i.exec(html)?.[1] ?? "";
  // Bound work before selector traversal, cloning, and Readability recursion.
  const stack: { node: Node; depth: number }[] = [{ node: fragment, depth: 0 }];
  let elements = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 256 || (node.nodeType === 1 && ++elements > 20000))
      throw Error("記事の構造が大きすぎるため取り込めませんでした。");
    for (const child of Array.from(node.childNodes))
      stack.push({ node: child, depth: depth + 1 });
  }
  // Zenn publishes article topics in inert page data rather than standard meta tags.
  let siteTags: string[] = [];
  if (new URL(url).hostname === "zenn.dev") {
    const data = fragment.querySelector(
      'script#__NEXT_DATA__[type="application/json"]',
    )?.textContent;
    if (data) {
      try {
        const topics: unknown = JSON.parse(data)?.props?.pageProps?.topics;
        if (Array.isArray(topics))
          siteTags = topics.flatMap((topic) =>
            topic && typeof topic.name === "string" ? [topic.name] : [],
          );
      } catch {
        // Missing or changed publisher metadata must not prevent reading the body.
      }
    }
  }
  const sourceTags = normalizeSourceTags([
    ...siteTags,
    ...Array.from(fragment.querySelectorAll("meta")).flatMap((meta) => {
      const name = (
        meta.getAttribute("property") ||
        meta.getAttribute("name") ||
        ""
      ).toLowerCase();
      const content = meta.getAttribute("content") || "";
      return name === "article:tag"
        ? [content]
        : name === "keywords"
          ? content.split(/[,、]/)
          : [];
    }),
    ...Array.from(
      fragment.querySelectorAll('article a[rel~="tag"]'),
      (node) => node.textContent || "",
    ),
  ]);
  const meta = (name: string) =>
    Array.from(fragment.querySelectorAll("meta"))
      .find(
        (m) =>
          (
            m.getAttribute("name") ||
            m.getAttribute("property") ||
            ""
          ).toLowerCase() === name,
      )
      ?.getAttribute("content")
      ?.trim();
  const info: ArticleInfo = {};
  const author = meta("author"),
    siteName = meta("og:site_name"),
    published = meta("article:published_time");
  if (author) info.author = author.slice(0, 300);
  if (siteName) info.siteName = siteName.slice(0, 300);
  if (published && Number.isFinite(Date.parse(published)))
    info.published = new Date(published).toISOString();
  // Qiita calendars put counters and sharing/signup controls beside an explicit
  // description. Scope this preference to that publisher and page type, keeping
  // matching words and legitimate links inside the description intact.
  const source = new URL(url);
  if (
    source.hostname === "qiita.com" &&
    /^\/advent-calendar\/\d{4}\/[^/]+\/?$/.test(source.pathname)
  ) {
    const descriptions = fragment.querySelectorAll(
      "article > .ac-MdContent.mdContent-inner",
    );
    if (descriptions.length === 1) {
      const article = descriptions[0].parentElement!;
      const main = article.closest("main");
      if (main) {
        const heading = main.querySelector("h1");
        main.replaceChildren(
          ...(heading && !article.contains(heading)
            ? [heading, article]
            : [article]),
        );
      }
    }
  }
  prepareFragment?.(fragment);
  // Native template parsing discards these wrappers; DOM-only parsers retain them.
  for (const wrapper of Array.from(fragment.querySelectorAll("html,head,body")))
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  fragment
    .querySelectorAll(
      "script,style,iframe,object,embed,img,picture,video,audio,source,link,meta,base,form,nav,footer,template,svg,math,[hidden],[aria-hidden='true']",
    )
    .forEach((n) => n.remove());
  for (const element of Array.from(fragment.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      if (attr.name === "href" && element.tagName.toLowerCase() === "a") {
        const href = safeArticleLink(attr.value, url);
        if (href) element.setAttribute("href", href);
        else element.removeAttribute("href");
        continue;
      }
      const tag = element.tagName.toLowerCase();
      if (tag === "ol" && attr.name === "reversed") continue;
      if (
        ((tag === "ol" && attr.name === "start") ||
          (tag === "li" && attr.name === "value")) &&
        validArticleOrdinal(attr.value)
      )
        continue;
      if (
        ["th", "td"].includes(tag) &&
        (attr.name === "colspan" || attr.name === "rowspan") &&
        validArticleSpan(attr.name, attr.value)
      )
        continue;
      if (!["class", "id", "lang", "dir"].includes(attr.name))
        element.removeAttribute(attr.name);
    }
  }
  // Readability rewrites consecutive br elements into paragraphs. Preserve code
  // line breaks first, inside the inert fragment, before that prose cleanup.
  fragment
    .querySelectorAll("pre br, code br")
    .forEach((br) => br.replaceWith("\n"));
  doc.body.append(doc.importNode(fragment, true));
  doc.documentElement.lang = language;
  doc.title =
    doc.body.querySelector("title")?.textContent ||
    doc.body.querySelector("h1")?.textContent ||
    "";
  doc.body.querySelectorAll("title").forEach((n) => n.remove());
  let codeRanges: ArticleCodeRange[] = [];
  let structure: ArticleStructure = { version: 1, links: [], headings: [] };
  const parsed = new Readability(doc, {
    maxElemsToParse: 20000,
    charThreshold: 140,
    serializer: (node) => {
      const serialized = serializeArticle(node, url);
      codeRanges = serialized.codeRanges;
      structure = serialized.structure;
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
    structure,
    ...(Object.keys(info).length ? { info } : {}),
    ...(sourceTags.length ? { sourceTags } : {}),
  };
}
