import { normalizeSourceTags } from "./source-tags";
import type { FeedRefreshFailure } from "./feed-auto-refresh";
import type { ArticleTags } from "./article-tags";
import type { ArticleContent, ArticleTranslation } from "./article-content";
export type FeedArticle = {
  id: string;
  feedUrl: string;
  title: string;
  url: string;
  published: string | null;
  body: string;
  saved: boolean;
  read: boolean;
  fetchedAt: string;
  content?: ArticleContent;
  contentError?: string;
  translation?: ArticleTranslation;
  tags?: ArticleTags;
  manualTags?: string[];
  sourceTags?: string[];
};
export type Feed = {
  url: string;
  title: string;
  fetchedAt: string;
  refreshFailure?: FeedRefreshFailure;
  unsubscribed?: boolean;
  cloudUnsubscribePending?: boolean;
  subscriptionRevision?: number;
};

function plain(value: string, limit: number) {
  // Template contents are inert: never mount these nodes. Read text only.
  // Avoid tag-stripping regexes whose work grows quadratically on unmatched '<'.
  const template = document.createElement("template");
  template.innerHTML = value.replace(
    /<\/(p|div|li|h[1-6]|blockquote)\s*>|<br\s*\/?\s*>/gi,
    "\n\n",
  );
  template.content
    .querySelectorAll("script, style, iframe")
    .forEach((node) => node.remove());
  return (template.content.textContent ?? "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}
export function articleURL(value: string, base: string): string | null {
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
export function parseFeed(
  xml: string,
  feedUrl: string,
  fetchedUrl = feedUrl,
): { feed: Feed; articles: FeedArticle[] } {
  if (xml.length > 2_000_000 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml))
    throw Error("安全に読み込めないXMLです。");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror"))
    throw Error("RSS / Atomの形式を読み取れませんでした。");
  const root = doc.documentElement;
  const atom = root.localName === "feed";
  const channel = atom
    ? root
    : Array.from(root.children).find((e) => e.localName === "channel");
  if (!channel || (!atom && !["rss", "RDF"].includes(root.localName)))
    throw Error("RSS / AtomのURLを指定してください。");
  const children = (node: Element, name: string) =>
    Array.from(node.children).filter((e) => e.localName === name);
  const field = (node: Element, name: string) => {
    const value = children(node, name)[0];
    return value
      ? value.childElementCount
        ? value.innerHTML
        : (value.textContent ?? "")
      : "";
  };
  const fetchedAt = new Date().toISOString();
  const title =
    plain(field(channel, "title"), 200) || new URL(feedUrl).hostname;
  const entries = children(
    root.localName === "RDF" ? root : channel,
    atom ? "entry" : "item",
  );
  const articles = new Map<string, FeedArticle>();
  for (const entry of entries.slice(0, 200)) {
    const link = atom
      ? (children(entry, "link")
          .find(
            (e) =>
              !e.getAttribute("rel") || e.getAttribute("rel") === "alternate",
          )
          ?.getAttribute("href") ?? "")
      : field(entry, "link");
    const feedBase =
      articleURL(root.getAttribute("xml:base") ?? "", fetchedUrl) ?? fetchedUrl;
    const base =
      articleURL(entry.getAttribute("xml:base") ?? "", feedBase) ?? feedBase;
    const url = link.trim() ? articleURL(link.trim(), base) : null;
    const articleTitle = plain(field(entry, "title"), 500) || "無題の記事";
    const date =
      field(entry, atom ? "published" : "pubDate") ||
      field(entry, atom ? "updated" : "date");
    const published =
      date && Number.isFinite(Date.parse(date))
        ? new Date(date).toISOString()
        : null;
    const guid = (
      field(entry, atom ? "id" : "guid").trim() ||
      url ||
      `${articleTitle}:${date}`
    ).slice(0, 2048);
    const body = plain(
      field(entry, "encoded") ||
        field(entry, "content") ||
        field(entry, atom ? "summary" : "description"),
      40000,
    );
    const id = JSON.stringify([feedUrl, guid]);
    articles.set(id, {
      id,
      feedUrl,
      title: articleTitle,
      url: url ?? "",
      published,
      body,
      saved: false,
      read: false,
      fetchedAt,
      sourceTags: normalizeSourceTags(
        children(entry, "category").map((category) =>
          atom
            ? category.getAttribute("label") ||
              category.getAttribute("term") ||
              ""
            : plain(category.textContent ?? "", 61),
        ),
      ),
    });
  }
  if (entries.length && !articles.size)
    throw Error("記事を読み取れませんでした。");
  return {
    feed: { url: feedUrl, title, fetchedAt },
    articles: [...articles.values()],
  };
}
