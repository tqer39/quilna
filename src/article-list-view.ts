import { libraryName } from "./library-context";
import { thumbnailURL } from "./article-thumbnail";
import { siteIcon } from "./link-preview";
import { readerIcon } from "./reader-icons";
import { articleReadingTime } from "./reading-time";
import { effectiveTags, tagSummary } from "./article-tags";
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

export type ArticleListPosition = { id: string; index: number; top: number };

export class ArticleListView {
  readonly root = el("div");
  private readonly list = el("ul", undefined, "rss-article-list");
  private readonly status = el("p");
  private readonly listTools = el("div", undefined, "rss-list-display");
  private readonly headlinesLabel = el(
    "label",
    undefined,
    "rss-headlines-label",
  );
  private readonly progress = el("p");
  private readonly empty = el("div", undefined, "rss-empty");
  private readonly pager = el("div", undefined, "rss-pagination");
  private readonly upkeep = el("div", undefined, "rss-list-upkeep");
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
      save: (id: string) => void;
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
    const headlines = el("input");
    headlines.type = "checkbox";
    const preference = libraryName("quilna.reader.headlinesOnly.v1");
    try {
      headlines.checked = localStorage.getItem(preference) === "true";
    } catch {
      // 保存領域が使えないときも、開いている一覧で切り替えられる。
    }
    this.list.classList.toggle("rss-headlines-only", headlines.checked);
    headlines.addEventListener("change", () => {
      this.list.classList.toggle("rss-headlines-only", headlines.checked);
      try {
        localStorage.setItem(preference, String(headlines.checked));
      } catch {
        // 現在の表示はチェックボックスが保持する。
      }
    });
    this.headlinesLabel.append(headlines, "見出し中心");
    this.listTools.append(this.status, this.headlinesLabel);
    this.progress.id = "rss-tag-progress";
    this.progress.setAttribute("role", "status");
    this.classify = button("", actions.classify);
    this.cancel = button("タグ判定を中止", actions.cancel);
    this.retry = button("検索準備を再試行", actions.retry);
    this.clear = button("検索を解除", actions.clear);
    this.previous = button("前の50件", () => actions.page(-1));
    this.next = button("次の50件", () => actions.page(1));
    this.pager.append(this.previous, this.next);
    // 見出しの間はポインタなしでも矢印キーで流し読みできるようにする。
    this.list.addEventListener("keydown", (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof HTMLElement) ||
        !event.target.classList.contains("rss-article-title")
      )
        return;
      const titles = this.titles();
      const index = titles.indexOf(event.target as HTMLButtonElement);
      const next =
        event.key === "ArrowDown"
          ? titles[index + 1]
          : event.key === "ArrowUp"
            ? titles[index - 1]
            : event.key === "Home"
              ? titles[0]
              : event.key === "End"
                ? titles[titles.length - 1]
                : undefined;
      if (!next) return;
      event.preventDefault();
      next.focus();
    });
  }

  private titles() {
    return Array.from(this.rows.values(), (row) => row.title);
  }

  /** n/p キーなど一覧外からの移動。表示中の見出しがなければ false。 */
  moveFocus(direction: -1 | 1) {
    const titles = this.titles();
    if (!titles.length || !this.list.isConnected) return false;
    const focused = document.activeElement;
    const index = titles.findIndex(
      (title) => !!focused && title.closest("li")!.contains(focused),
    );
    const next =
      index < 0
        ? titles[direction > 0 ? 0 : titles.length - 1]
        : titles[index + direction];
    if (!next) return false;
    next.focus();
    return true;
  }

  private createRow(id: string) {
    const row = {
      node: el("li"),
      thumbnail: el("span", undefined, "rss-story-thumbnail"),
      imageUrl: undefined as string | undefined,
      meta: el("p", undefined, "rss-article-meta"),
      publisherIcon: el("span"),
      iconURL: null as string | null,
      facts: el("span"),
      duration: el("span", undefined, "rss-reading-duration"),
      durationText: el("span"),
      title: el("button", undefined, "rss-article-title"),
      excerpt: el("p", undefined, "rss-excerpt"),
      tags: el("details", undefined, "rss-tag-summary"),
      tagLabel: el("summary"),
      tagDetails: el("p"),
      save: el("button", undefined, "rss-quick-save"),
    };
    row.duration.append(readerIcon("clock"), row.durationText);
    row.meta.append(
      row.publisherIcon,
      row.facts,
      document.createTextNode(" · "),
      row.duration,
    );
    row.title.type = "button";
    row.save.type = "button";
    row.save.append(readerIcon("bookmark"));
    row.tags.append(row.tagLabel, row.tagDetails);
    row.save.addEventListener("click", () => {
      if (row.save.getAttribute("aria-disabled") !== "true")
        this.actions.save(id);
    });
    // Resolve the current record in the owner on click, not a captured snapshot.
    row.title.addEventListener("click", () => this.actions.open(id));
    row.node.append(
      row.thumbnail,
      row.title,
      row.meta,
      row.excerpt,
      row.tags,
      row.save,
    );
    return row;
  }

  position(id: string): ArticleListPosition | null {
    const row = this.rows.get(id);
    return row
      ? {
          id,
          index: Array.from(this.rows.keys()).indexOf(id),
          top: row.title.getBoundingClientRect().top,
        }
      : null;
  }

  restorePosition(position: ArticleListPosition): boolean {
    const rows = Array.from(this.rows.values());
    const row =
      this.rows.get(position.id) ??
      rows[Math.min(position.index, rows.length - 1)];
    if (!row) return false;
    row.title.focus({ preventScroll: true });
    window.scrollBy(0, row.title.getBoundingClientRect().top - position.top);
    return true;
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
    saving: ReadonlySet<string>;
  }) {
    const focused = document.activeElement;
    const previousIndex = Array.from(this.rows.values()).findIndex(
      (row) => !!focused && row.node.contains(focused),
    );
    const rows = new Map<string, ReturnType<ArticleListView["createRow"]>>();
    for (const article of state.items) {
      const row = this.rows.get(article.id) ?? this.createRow(article.id);
      const url =
        article.content?.images?.[0]?.data ??
        thumbnailURL(article.thumbnailUrl) ??
        thumbnailURL(article.content?.thumbnailUrl);
      if (row.imageUrl !== url) {
        row.imageUrl = url;
        row.thumbnail.replaceChildren();
        if (url) {
          const img = el("img");
          img.alt = "";
          img.loading = "lazy";
          img.decoding = "async";
          img.referrerPolicy = "no-referrer";
          img.addEventListener(
            "error",
            () => {
              const fallback = el(
                "span",
                undefined,
                "rss-thumbnail-unavailable",
              );
              fallback.setAttribute("role", "img");
              fallback.setAttribute("aria-label", "画像を表示できません");
              fallback.title = "画像を表示できません";
              fallback.append(readerIcon("imageOff"));
              img.replaceWith(fallback);
            },
            { once: true },
          );
          img.src = url;
          row.thumbnail.append(img);
        }
      }
      text(row.facts, state.metadata(article));
      text(row.durationText, articleReadingTime(article));
      const iconURL = article.feedUrl || article.url;
      if (row.iconURL !== iconURL) {
        row.iconURL = iconURL;
        row.publisherIcon.replaceChildren(siteIcon(iconURL));
      }
      text(row.title, article.content?.title || article.title);
      // 未読・既読は文字の濃さで見分け、行ごとの印は増やさない。
      row.node.dataset.read = String(!!article.read);
      row.node.dataset.saved = String(!!article.saved);
      text(
        row.excerpt,
        (
          article.content?.text ||
          (isLinkOnly(article.body) ? "本文なし・リンク情報のみ" : article.body)
        ).slice(0, 160),
      );
      const tags = effectiveTags(article);
      text(
        row.tagLabel,
        tags.length
          ? `タグ：${tags.slice(0, 3).join("・")}${tags.length > 3 ? ` ほか${tags.length - 3}件` : ""}`
          : "タグを確認",
      );
      text(row.tagDetails, tagSummary(article));
      row.save.title = article.saved
        ? "あとで読むから外す"
        : "あとで読むに保存";
      row.save.setAttribute("aria-pressed", String(article.saved));
      row.save.setAttribute(
        "aria-label",
        `${article.saved ? "あとで読むから外す" : "あとで読むに保存"}：${article.content?.title || article.title}`,
      );
      // 書き込み中もフォーカスを保ち、同じ操作の重複だけを防ぐ。
      row.save.setAttribute(
        "aria-disabled",
        String(state.saving.has(article.id)),
      );
      row.save.setAttribute("aria-busy", String(state.saving.has(article.id)));
      rows.set(article.id, row);
    }
    children(
      this.list,
      Array.from(rows.values(), (row) => row.node),
    );
    // Bound retained nodes to the current page, not the whole library.
    this.rows = rows;
    // 件数の一行だけを見出しの前に置き、タグ判定などの整理作業は一覧の後ろへ回す。
    const desired: HTMLElement[] = [];
    text(this.status, state.status);
    this.headlinesLabel.hidden = !rows.size;
    desired.push(this.listTools);
    if (state.retry) desired.push(this.retry);
    if (state.clear) desired.push(this.clear);
    desired.push(this.list);
    this.previous.disabled = state.previousDisabled;
    this.next.disabled = state.nextDisabled;
    if (state.pagination) desired.push(this.pager);
    text(this.empty, state.empty);
    if (state.empty) desired.push(this.empty);
    text(this.classify, state.classify);
    this.classify.disabled = state.classifyDisabled;
    const upkeep: HTMLElement[] = [];
    if (state.classify) upkeep.push(this.classify);
    if (state.classifying) upkeep.push(this.cancel);
    text(this.progress, state.progress);
    if (state.progress) upkeep.push(this.progress);
    children(this.upkeep, upkeep);
    if (upkeep.length) desired.push(this.upkeep);
    children(this.root, desired);
    // An asynchronous read/save update can remove the returned-to row.
    if (
      previousIndex >= 0 &&
      focused instanceof HTMLElement &&
      !focused.isConnected
    ) {
      const next = Array.from(rows.values())[
        Math.min(previousIndex, rows.size - 1)
      ];
      this.status.tabIndex = -1;
      (next?.title ?? this.status).focus({ preventScroll: true });
    }
  }
}
