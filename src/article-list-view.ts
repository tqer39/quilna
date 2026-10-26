import { effectiveTags, tagState } from "./article-tags";
import { isLinkOnly } from "./article-content";
import type { FeedArticle } from "./feed-parser";
import { button, el } from "./ui";

function text(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

// Do not detach unchanged children: their layout, focus and DOM objects can
// survive repeated searches and unrelated background updates.
function children(parent: HTMLElement, desired: HTMLElement[]) {
  const focused = document.activeElement;
  const retained = new Set(desired);
  // Remove obsolete siblings first so surviving children do not need to move
  // just because a preceding row or optional control disappeared.
  for (const child of Array.from(parent.children))
    if (!retained.has(child as HTMLElement)) child.remove();
  for (const [index, node] of desired.entries())
    if (parent.children[index] !== node)
      parent.insertBefore(node, parent.children[index] ?? null);
  // insertBefore can blur a moved row during a real reorder. Restore only a
  // surviving focused element, never a deleted row or an outside control.
  if (
    focused instanceof HTMLElement &&
    parent.contains(focused) &&
    document.activeElement !== focused
  )
    focused.focus({ preventScroll: true });
}

export class ArticleListView {
  readonly root = el("div");
  private readonly list = el("ul", undefined, "rss-article-list");
  private readonly status = el("p");
  private readonly progress = el("p");
  private readonly empty = el("div", undefined, "rss-empty");
  private readonly classify;
  private readonly cancel;
  private readonly retry;
  private readonly clear;
  private readonly previous;
  private readonly next;
  private rows = new Map<string, ReturnType<ArticleListView["createRow"]>>();

  constructor(
    private readonly actions: {
      open: (id: string) => void;
      classify: () => void;
      cancel: () => void;
      retry: () => void;
      clear: () => void;
      page: (delta: number) => void;
    },
  ) {
    this.list.setAttribute("aria-label", "記事一覧");
    this.status.id = "rss-search-status";
    this.status.setAttribute("role", "status");
    this.progress.id = "rss-tag-progress";
    this.progress.setAttribute("role", "status");
    this.classify = button("", actions.classify);
    this.cancel = button("タグ判定を中止", actions.cancel);
    this.retry = button("検索準備を再試行", actions.retry);
    this.clear = button("検索を解除", actions.clear);
    this.previous = button("前の50件", () => actions.page(-1));
    this.next = button("次の50件", () => actions.page(1));
  }

  private createRow(id: string) {
    const row = {
      node: el("li"),
      meta: el("p", undefined, "rss-article-meta"),
      title: el("button", undefined, "rss-article-title"),
      excerpt: el("p", undefined, "rss-excerpt"),
      tags: el("p", undefined, "rss-tag-summary"),
    };
    row.title.type = "button";
    // Resolve the current record in the owner on click, not a captured snapshot.
    row.title.addEventListener("click", () => this.actions.open(id));
    row.node.append(row.meta, row.title, row.excerpt, row.tags);
    return row;
  }

  update(state: {
    items: FeedArticle[];
    metadata: (article: FeedArticle) => string;
    status: string;
    classify: string;
    classifying: boolean;
    classifyDisabled: boolean;
    progress: string;
    retry: boolean;
    clear: boolean;
    pagination: boolean;
    previousDisabled: boolean;
    nextDisabled: boolean;
    empty: string;
  }) {
    const rows = new Map<string, ReturnType<ArticleListView["createRow"]>>();
    for (const article of state.items) {
      const row = this.rows.get(article.id) ?? this.createRow(article.id);
      text(row.meta, state.metadata(article));
      text(row.title, article.content?.title || article.title);
      text(
        row.excerpt,
        (
          article.content?.text ||
          (isLinkOnly(article.body) ? "本文なし・リンク情報のみ" : article.body)
        ).slice(0, 160),
      );
      text(
        row.tags,
        `${tagState(article)}：${effectiveTags(article).join("・") || "タグなし"}`,
      );
      rows.set(article.id, row);
    }
    children(
      this.list,
      Array.from(rows.values(), (row) => row.node),
    );
    // Bound retained nodes to the current page, not the whole library.
    this.rows = rows;
    const desired: HTMLElement[] = [];
    text(this.classify, state.classify);
    this.classify.disabled = state.classifyDisabled;
    if (state.classify) desired.push(this.classify);
    if (state.classifying) desired.push(this.cancel);
    text(this.progress, state.progress);
    if (state.progress) desired.push(this.progress);
    text(this.status, state.status);
    desired.push(this.status);
    if (state.retry) desired.push(this.retry);
    if (state.clear) desired.push(this.clear);
    desired.push(this.list);
    this.previous.disabled = state.previousDisabled;
    this.next.disabled = state.nextDisabled;
    if (state.pagination) desired.push(this.previous, this.next);
    text(this.empty, state.empty);
    if (state.empty) desired.push(this.empty);
    children(this.root, desired);
  }
}
