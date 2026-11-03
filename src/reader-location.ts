import { el } from "./ui";

export class ReaderLocation {
  readonly root = el("section", undefined, "rss-location-bar");
  readonly reader = el("nav", undefined, "rss-reader-navigation");
  readonly progress = el("div", undefined, "rss-location-progress");
  private readonly current = el("p", undefined, "rss-location-current");
  private readonly destinations = el("div", undefined, "rss-destinations");
  private readonly links = new Map<string, HTMLAnchorElement>();

  constructor(actions: { list: (filter: string) => void; import: () => void }) {
    this.root.setAttribute("aria-label", "現在地と移動先");
    this.current.setAttribute("aria-current", "page");
    this.reader.setAttribute("aria-label", "記事の移動");
    const links = el("nav", undefined, "rss-destination-links");
    links.setAttribute("aria-label", "主な移動先");
    for (const [key, label, href] of [
      ["all", "記事一覧", "?view=feeds"],
      ["saved", "保存した記事", "?view=feeds&filter=saved"],
      ["import", "サイト・記事の取り込み", "?view=feeds&screen=import"],
    ]) {
      const link = el("a", label);
      link.href = href;
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        if (key === "import") actions.import();
        else actions.list(key);
      });
      this.links.set(key, link);
      links.append(link);
    }
    this.destinations.append(links);
    const controls = el("div", undefined, "rss-location-actions");
    controls.append(this.reader, this.destinations);
    this.root.append(this.current, controls, this.progress);
  }

  update(state: {
    articleId?: string;
    title?: string;
    filter: string;
    source: string;
    importing: boolean;
  }) {
    const list =
      state.filter === "saved"
        ? "保存した記事"
        : state.filter === "unread"
          ? "未読の記事"
          : "記事一覧";
    const context = [list, state.source].filter(Boolean).join(" · ");
    this.current.textContent = state.importing
      ? `${context} › サイト・記事の取り込み`
      : state.articleId
        ? `${context} › 記事詳細 — ${state.title}`
        : context;
    this.current.title = this.current.textContent;
    this.root.dataset.screen = state.articleId ? "article" : "list";
    this.reader.hidden = this.progress.hidden = !state.articleId;
    for (const [key, link] of this.links) {
      const active = state.importing
        ? key === "import"
        : !state.articleId &&
          key === (state.filter === "saved" ? "saved" : "all");
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    document.title = `${state.importing ? "サイト・記事の取り込み" : state.articleId ? state.title : list} | Quilna`;
  }
}
