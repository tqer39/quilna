import { readerIcon } from "./reader-icons";
import { el } from "./ui";

export class ReaderLocation {
  readonly reader = el("nav", undefined, "rss-reader-navigation");
  readonly progress = el("div", undefined, "rss-location-progress");
  readonly destinations = el("div", undefined, "rss-destinations");
  private readonly links = new Map<string, HTMLAnchorElement>();

  constructor(actions: { list: (filter: string) => void; import: () => void }) {
    this.reader.setAttribute("aria-label", "記事の移動");
    const links = el("nav", undefined, "rss-destination-links");
    links.setAttribute("aria-label", "主な移動先");
    for (const [key, label, href, icon, name] of [
      ["all", "記事一覧", "?view=feeds", "stack", ""],
      ["saved", "保存した記事", "?view=feeds&filter=saved", "bookmark", ""],
      // 狭い画面でも読み上げ名は保ち、見える文字は「取り込み」に縮める。
      [
        "import",
        "取り込み",
        "?view=feeds&screen=import",
        "plus",
        "サイト・記事の取り込み",
      ],
    ] as const) {
      const link = el("a");
      link.dataset.destination = key;
      link.append(readerIcon(icon), el("span", label));
      if (name) link.setAttribute("aria-label", name);
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
  }

  update(state: {
    articleId?: string;
    title?: string;
    filter: string;
    importing: boolean;
  }) {
    const list =
      state.filter === "saved"
        ? "保存した記事"
        : state.filter === "unread"
          ? "未読の記事"
          : "記事一覧";
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
