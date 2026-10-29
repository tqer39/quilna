import { articleReference, type ArticleReference } from "./article-connections";
import type { ArticleHighlight } from "./article-highlights";
import { articleURL, type FeedArticle } from "./feed-parser";
import {
  graphNeighborhood,
  graphKey,
  graphKind,
  graphLabel,
  graphPageSize,
  type GraphNode,
  type GraphEdge,
  type GraphPage,
} from "./article-graph";
import { button, el } from "./ui";

const edgeLabel = (edge: GraphEdge) =>
  edge.kind === "linked"
    ? "自分で保存した関連"
    : edge.kind === "quote"
      ? "引用と出典"
      : "同じ話題の手がかり";
export class ArticleGraphView {
  readonly root = el("section", undefined, "rss-graph");
  private readonly details = el("details");
  private readonly status = el("p", "", "muted");
  private readonly canvas = el("div", undefined, "rss-graph-canvas");
  private readonly list = el("ul", undefined, "rss-graph-list");
  private readonly evidence = el("section", undefined, "rss-graph-evidence");
  private readonly back = button("前の起点へ", () => {
    const old = this.history.pop();
    if (old) {
      this.center = old.node;
      this.offset = old.offset;
      void this.load(true);
    }
  });
  private readonly home = button("読んでいる記事を起点にする", () => {
    if (this.article)
      this.focus({ kind: "article", ref: articleReference(this.article) });
  });
  private readonly retry = button("関係図を再読み込み", () => void this.load());
  private readonly previous = button("前の8件", () => {
    this.offset = Math.max(0, this.offset - graphPageSize);
    void this.load(true);
  });
  private readonly next = button("次の8件", () => {
    this.offset += graphPageSize;
    void this.load(true);
  });
  private article?: FeedArticle;
  private revision = -1;
  private center?: GraphNode;
  private history: { node: GraphNode; offset: number }[] = [];
  private offset = 0;
  private controller?: AbortController;
  private revealController?: AbortController;
  private generation = 0;
  private page?: GraphPage;
  private selected?: string;
  private readonly channels: BroadcastChannel[] = [];
  constructor(
    private readonly library: () => readonly FeedArticle[],
    private readonly lookup: (id: string) => FeedArticle | undefined,
    private readonly open: (id: string) => void,
    private readonly reveal: (
      quote: ArticleHighlight,
      signal: AbortSignal,
    ) => Promise<string>,
    private readonly connect?: (quote: ArticleHighlight) => void,
  ) {
    this.root.id = "rss-graph";
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "情報の関係図");
    this.status.setAttribute("role", "status");
    this.canvas.setAttribute("role", "group");
    this.canvas.setAttribute("aria-label", "周辺の関係図");
    this.canvas.tabIndex = -1;
    this.list.setAttribute("aria-label", "関係図と同じ情報の一覧");
    this.evidence.setAttribute("aria-label", "選択した関係の理由と出典");
    this.evidence.tabIndex = -1;
    const listDetails = el("details");
    listDetails.append(el("summary", "同じ情報を一覧で見る"), this.list);
    const controls = el("div", undefined, "rss-graph-controls");
    controls.append(this.back, this.home, this.retry);
    const pages = el("div", undefined, "rss-graph-controls");
    pages.append(this.previous, this.next);
    this.details.append(
      el("summary", "情報の関係図"),
      el(
        "p",
        "記事・引用・話題から、気になるつながりを辿れます。線かカードを選ぶと理由と出典が開きます。",
        "muted",
      ),
      controls,
      this.status,
      this.canvas,
      pages,
      listDetails,
      this.evidence,
    );
    this.root.append(this.details);
    this.details.addEventListener("toggle", () => {
      if (this.details.open) void this.load();
      else this.stop();
    });
    if (typeof BroadcastChannel !== "undefined")
      for (const name of [
        "quilna.connections.v1",
        "quilna.highlights.v1",
        "quilna.quote-connections.v1",
      ]) {
        const channel = new BroadcastChannel(name);
        channel.addEventListener("message", () => {
          if (this.details.open && this.root.isConnected) void this.load();
        });
        this.channels.push(channel);
      }
    window.addEventListener("focus", () => {
      if (this.details.open && this.root.isConnected) void this.load();
    });
  }
  mount(article: FeedArticle, revision: number) {
    const different = this.article?.id !== article.id;
    const changed = this.revision !== revision || this.article !== article;
    this.article = article;
    this.revision = revision;
    if (different) {
      this.stop();
      this.center = { kind: "article", ref: articleReference(article) };
      this.history = [];
      this.offset = 0;
      this.details.open = false;
      this.clear();
    } else if (changed && this.details.open) void this.load();
    return this.root;
  }
  detach() {
    this.stop();
    this.article = undefined;
  }
  showQuote(quote: ArticleHighlight) {
    this.details.open = true;
    this.focus({ kind: "quote", quote });
    this.root.scrollIntoView({ block: "center" });
    this.root.focus({ preventScroll: true });
  }
  private stop() {
    this.generation++;
    this.controller?.abort();
    this.revealController?.abort();
  }
  private clear() {
    this.page = undefined;
    this.selected = undefined;
    this.canvas.replaceChildren();
    this.list.replaceChildren();
    this.evidence.replaceChildren();
  }
  private focus(node: GraphNode) {
    if (this.center && graphKey(node) !== graphKey(this.center)) {
      this.history.push({ node: this.center, offset: this.offset });
      if (this.history.length > 20) this.history.shift();
    }
    this.center = node;
    this.offset = 0;
    void this.load(true);
  }
  private async load(moveFocus = false) {
    if (!this.center || !this.article || !this.details.open) return;
    this.stop();
    const generation = this.generation;
    const controller = (this.controller = new AbortController());
    this.clear();
    this.previous.disabled = this.next.disabled = true;
    this.back.disabled = !this.history.length;
    this.status.textContent = "周辺の関係を読み込んでいます…";
    try {
      const page = await graphNeighborhood(
        this.center,
        this.offset,
        this.library(),
        this.lookup,
        controller.signal,
      );
      if (generation !== this.generation) return;
      this.page = page;
      this.center = page.center;
      this.status.textContent = [
        page.edges.length
          ? `${this.offset + 1}〜${this.offset + page.edges.length}件を表示。各カードを次の起点にできます。`
          : "表示できる関係はありません。記事にハイライトや関連を保存すると、ここから辿れます。",
        ...page.notices,
      ].join(" ");
      this.previous.disabled = this.offset === 0;
      this.next.disabled = !page.more;
      this.render(page);
      if (moveFocus) {
        this.canvas.focus({ preventScroll: true });
        this.canvas.scrollIntoView({ block: "nearest" });
      }
    } catch {
      if (generation === this.generation)
        this.status.textContent =
          "関係図を読み込めませんでした。再読み込みしてください。保存した記事・引用・関連は変更していません。";
    }
  }
  private render(page: GraphPage) {
    const rows = Math.ceil(page.edges.length / 2),
      height = Math.max(220, 145 + rows * 125);
    this.canvas.style.height = `${height}px`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 1000 ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    // Every line has an equivalent native button in the adjacent list.
    svg.setAttribute("aria-hidden", "true");
    this.canvas.append(svg);
    const center = el("div", undefined, "rss-graph-center");
    center.append(
      el("small", `${graphKind(page.center)} · 起点`),
      el("strong", graphLabel(page.center)),
    );
    center.title = graphLabel(page.center);
    this.canvas.append(center);
    page.edges.forEach((edge, index) => {
      const left = index % 2 === 0,
        y = 145 + Math.floor(index / 2) * 125;
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute(
        "d",
        `M 500 90 C ${left ? 470 : 530} ${y - 50}, ${left ? 470 : 530} ${y}, ${left ? 430 : 570} ${y}`,
      );
      path.setAttribute("class", `rss-graph-edge rss-graph-edge-${edge.kind}`);
      path.setAttribute("data-graph-key", graphKey(edge.node));
      path.addEventListener("click", () => this.select(edge));
      svg.append(path);
      const node = button(
        "",
        () => this.select(edge),
        `rss-graph-node rss-graph-node-${edge.kind}`,
      );
      node.style.top = `${y - 40}px`;
      node.style.left = left ? "0" : "57%";
      node.setAttribute(
        "aria-label",
        `${graphKind(edge.node)}：${graphLabel(edge.node)}。${edgeLabel(edge)}の理由と出典を表示`,
      );
      node.append(
        el("small", graphKind(edge.node)),
        el("span", graphLabel(edge.node)),
        el("small", edgeLabel(edge)),
      );
      node.title = graphLabel(edge.node);
      node.dataset.graphKey = graphKey(edge.node);
      node.setAttribute("aria-pressed", "false");
      this.canvas.append(node);
      const item = el("li");
      item.append(
        button(
          `${graphKind(edge.node)}：${graphLabel(edge.node)} — ${edgeLabel(edge)}`,
          () => this.select(edge),
        ),
      );
      this.list.append(item);
    });
  }
  private source(ref: ArticleReference) {
    const item = el("div");
    item.append(el("p", ref.title));
    const open = button("この記事を読む", () => {
      if (this.lookup(ref.id)) this.open(ref.id);
      else
        this.status.textContent =
          "この記事は現在のライブラリにありません。出典は保持しています。";
    });
    open.disabled = !this.lookup(ref.id);
    item.append(open);
    if (!this.lookup(ref.id))
      item.append(el("p", "現在のライブラリにはありません。", "muted"));
    if (ref.url && articleURL(ref.url, ref.url) === ref.url) {
      const link = el("a", "保存した出典を開く");
      link.href = ref.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    }
    return item;
  }
  private select(edge: GraphEdge) {
    if (!this.page) return;
    this.revealController?.abort();
    const generation = this.generation,
      key = (this.selected = graphKey(edge.node));
    for (const item of Array.from(
      this.canvas.querySelectorAll("[data-graph-key]"),
    )) {
      const active = item.getAttribute("data-graph-key") === key;
      item.classList.toggle("rss-graph-selected", active);
      if (item.tagName === "BUTTON")
        item.setAttribute("aria-pressed", String(active));
    }
    this.evidence.replaceChildren(
      el("h3", edgeLabel(edge)),
      el("p", graphLabel(edge.node)),
      el("p", edge.reason, "rss-connection-reason"),
    );
    const quote =
      edge.node.kind === "quote"
        ? edge.node.quote
        : this.page.center.kind === "quote"
          ? this.page.center.quote
          : undefined;
    if (quote) {
      this.evidence.append(
        el("blockquote", quote.quote),
        el(
          "p",
          `${quote.view === "original" ? "原文" : "訳文"} · ${quote.language || "言語未設定"} · 保存時の引用`,
          "muted",
        ),
      );
      if (quote.note)
        this.evidence.append(el("p", quote.note, "rss-highlight-memo"));
      const notice = el(
        "p",
        "表示中の本文と版・言語・引用が一致する場合だけ、その位置へ移動します。",
        "muted",
      );
      notice.setAttribute("role", "status");
      const reveal = button("表示中の本文の引用へ", () => {
        this.revealController?.abort();
        const controller = (this.revealController = new AbortController());
        void this.reveal(quote, controller.signal)
          .then((message) => {
            if (
              !controller.signal.aborted &&
              generation === this.generation &&
              key === this.selected
            )
              notice.textContent = message;
          })
          .catch(() => {
            if (
              !controller.signal.aborted &&
              generation === this.generation &&
              key === this.selected
            )
              notice.textContent =
                "引用の位置を確認できませんでした。もう一度試してください。";
          });
      });
      this.evidence.append(reveal, notice);
      if (this.connect)
        this.evidence.append(
          button("この引用のつながりを編集", () => this.connect?.(quote)),
        );
    }
    for (const ref of edge.sources) this.evidence.append(this.source(ref));
    this.evidence.append(
      button("ここを起点に周辺を見る", () => this.focus(edge.node)),
    );
    this.evidence.focus({ preventScroll: true });
    this.evidence.scrollIntoView({ block: "nearest" });
  }
}
