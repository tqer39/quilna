import {
  articleReference,
  readConnections,
  type ArticleReference,
} from "./article-connections";
import { readHighlights, type ArticleHighlight } from "./article-highlights";
import {
  readQuoteConnections,
  readArticleQuoteConnections,
} from "./quote-connections";
import { effectiveTags, tagState } from "./article-tags";
import type { FeedArticle } from "./feed-parser";

export type GraphNode =
  | { kind: "article"; ref: ArticleReference }
  | { kind: "quote"; quote: ArticleHighlight }
  | { kind: "tag"; tag: string };
export type GraphEdge = {
  node: GraphNode;
  kind: "linked" | "quote" | "tag";
  reason: string;
  sources: ArticleReference[];
};
export type GraphPage = {
  center: GraphNode;
  edges: GraphEdge[];
  more: boolean;
  notices: string[];
};
export const graphPageSize = 8;
export const graphLabel = (node: GraphNode) =>
  node.kind === "article"
    ? node.ref.title
    : node.kind === "quote"
      ? node.quote.quote
      : node.tag;
export const graphKind = (node: GraphNode) =>
  node.kind === "article"
    ? "記事"
    : node.kind === "quote"
      ? "引用"
      : "話題タグ";
export const graphKey = (node: GraphNode) =>
  JSON.stringify([
    node.kind,
    node.kind === "article"
      ? node.ref.id
      : node.kind === "quote"
        ? node.quote.id
        : node.tag,
  ]);
const quoteRef = (h: ArticleHighlight): ArticleReference => ({
  id: h.articleId,
  title: h.title,
  url: h.url,
});
const topicReason = (a: FeedArticle, tag: string) =>
  `「${tag}」のタグ（${tagState(a)}）。共通の話題を示す手がかりで、内容の一致・支持・反証を確認した関係ではありません。`;

// Only a focused neighborhood is read. Viewing never writes a link or reading state.
export async function graphNeighborhood(
  center: GraphNode,
  offset: number,
  library: readonly FeedArticle[],
  lookup: (id: string) => FeedArticle | undefined,
  signal: AbortSignal,
): Promise<GraphPage> {
  signal.throwIfAborted();
  const edges: GraphEdge[] = [],
    notices: string[] = [];
  if (center.kind === "tag") {
    let skipped = 0;
    for (let i = 0; i < library.length; i++) {
      if (i % 500 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
      const a = library[i];
      if ((!a.read && !a.saved) || !effectiveTags(a).includes(center.tag))
        continue;
      if (skipped++ < offset) continue;
      edges.push({
        node: { kind: "article", ref: articleReference(a) },
        kind: "tag",
        reason: topicReason(a, center.tag),
        sources: [articleReference(a)],
      });
      if (edges.length > graphPageSize) break;
    }
    return {
      center,
      edges: edges.slice(0, graphPageSize),
      more: edges.length > graphPageSize,
      notices: ["この話題の既読・保存記事を表示しています。"],
    };
  }
  if (center.kind === "quote") {
    const quoteId = center.quote.id;
    const quote = (await readHighlights(center.quote.articleId)).find(
      (h) => h.id === quoteId,
    );
    signal.throwIfAborted();
    const connections = await readQuoteConnections(quoteId);
    signal.throwIfAborted();
    if (!quote && !connections.length)
      return {
        center,
        edges: [],
        more: false,
        notices: [
          "この引用は削除されています。元の記事から探索をやり直してください。",
        ],
      };
    if (!quote)
      notices.push(
        "この引用は一覧から削除されています。関連を保存した時点の引用・メモを表示します。",
      );
    const source = quote ?? center.quote;
    center = { kind: "quote", quote: source };
    edges.push({
      node: { kind: "article", ref: quoteRef(source) },
      kind: "quote",
      reason: source.note || "保存した引用と、その出典記事の関係です。",
      sources: [quoteRef(source)],
    });
    for (const c of connections)
      edges.push({
        node: { kind: "quote", quote: c.from.id === quoteId ? c.to : c.from },
        kind: "linked",
        reason: `${c.reason}（関連保存時の引用・メモ）`,
        sources: [quoteRef(c.from), quoteRef(c.to)],
      });
  } else {
    const ref = center.ref;
    const [connections, highlights, quoteConnections] =
      await Promise.allSettled([
        readConnections(ref.id),
        readHighlights(ref.id),
        readArticleQuoteConnections(ref.id),
      ]);
    signal.throwIfAborted();
    if (connections.status === "fulfilled") {
      for (const c of connections.value) {
        if (c.state !== "linked") continue;
        edges.push({
          node: { kind: "article", ref: c.from.id === ref.id ? c.to : c.from },
          kind: "linked",
          reason: c.reason,
          sources: [c.from, c.to],
        });
      }
    } else
      notices.push(
        "記事間のつながりを取得できません。再読み込みしてください。保存した記録は変更していません。",
      );
    if (highlights.status === "fulfilled") {
      for (const h of highlights.value)
        edges.push({
          node: { kind: "quote", quote: h },
          kind: "quote",
          reason: h.note || "保存した引用と、その出典記事の関係です。",
          sources: [quoteRef(h)],
        });
    } else
      notices.push(
        "引用を取得できません。再読み込みしてください。保存した記録は変更していません。",
      );
    if (quoteConnections.status === "fulfilled") {
      const seen = new Set(
        edges
          .filter((e) => e.node.kind === "quote")
          .map((e) => graphKey(e.node)),
      );
      for (const c of quoteConnections.value)
        for (const h of [c.from, c.to]) {
          const node: GraphNode = { kind: "quote", quote: h };
          if (h.articleId !== ref.id || seen.has(graphKey(node))) continue;
          seen.add(graphKey(node));
          edges.push({
            node,
            kind: "quote",
            reason:
              "関連を保存した時点の引用・メモです。ハイライト一覧から削除された引用も残しています。",
            sources: [quoteRef(h)],
          });
        }
    } else
      notices.push(
        "引用のつながりを取得できません。再読み込みしてください。保存した記録は変更していません。",
      );
    const article = lookup(ref.id);
    if (article) {
      for (const tag of effectiveTags(article))
        edges.push({
          node: { kind: "tag", tag },
          kind: "tag",
          reason: topicReason(article, tag),
          sources: [articleReference(article)],
        });
    } else
      notices.push(
        "この記事は現在のライブラリにありません。保存した出典の記録を表示しています。",
      );
  }
  return {
    center,
    edges: edges.slice(offset, offset + graphPageSize),
    more: edges.length > offset + graphPageSize,
    notices,
  };
}
