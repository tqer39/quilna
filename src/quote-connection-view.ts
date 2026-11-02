import { connectionKey } from "./article-connections";
import { readHighlights, type ArticleHighlight } from "./article-highlights";
import type { FeedArticle } from "./feed-parser";
import { findConnectionTargets } from "./related-articles";
import {
  readQuoteConnections,
  writeQuoteConnection,
  quoteConnectionDatabase,
  type QuoteConnection,
} from "./quote-connections";
import { button, el } from "./ui";

export class QuoteConnectionView {
  readonly root = el(
    "section",
    undefined,
    "rss-connections rss-quote-connections",
  );
  private readonly details = el("details");
  private readonly status = el("p", "", "muted");
  private readonly source = el("div");
  private readonly list = el("ul");
  private readonly query = el("input");
  private readonly results = el("ul");
  private readonly choices = el("ul");
  private readonly editor = el("div");
  private readonly target = el("div");
  private readonly reason = el("textarea");
  private readonly search = button(
    "引用のある記事を探す",
    () => void this.find(),
  );
  private readonly sameArticle = button("同じ記事の引用を選ぶ", () => {
    if (this.quote) void this.chooseArticle(this.quote.articleId);
  });
  private readonly save = button(
    "引用のつながりを保存",
    () => void this.commit(),
  );
  private readonly cancel = button("引用の関連編集をやめる", () =>
    this.clearDraft(),
  );
  private readonly reload = button(
    "引用のつながりを再読み込み",
    () => void this.load(),
  );
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(quoteConnectionDatabase);
  private quote?: ArticleHighlight;
  private articleId?: string;
  private records: QuoteConnection[] = [];
  private draft?: QuoteConnection;
  private expected: number | null = null;
  private controller?: AbortController;
  private generation = 0;
  private context = 0;
  private busy = false;
  private ready = false;
  private writeFailure = "";
  private savedNotice = "";

  constructor(
    private readonly library: () => readonly FeedArticle[],
    private readonly graph: (quote: ArticleHighlight) => void,
  ) {
    this.root.id = "rss-quote-connections";
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "引用のつながり");
    this.status.setAttribute("role", "status");
    this.list.setAttribute("aria-label", "保存した引用のつながり");
    this.results.setAttribute("aria-label", "引用を探す記事の候補");
    this.choices.setAttribute("aria-label", "関連付ける引用の候補");
    this.query.id = "rss-quote-connection-query";
    this.query.type = "search";
    this.query.maxLength = 300;
    const queryLabel = el("label", "引用を探す記事の題名");
    queryLabel.htmlFor = this.query.id;
    this.reason.id = "rss-quote-connection-reason";
    this.reason.rows = 3;
    this.reason.maxLength = 2000;
    const reasonLabel = el("label", "引用をつなぐ理由（必須）");
    reasonLabel.htmlFor = this.reason.id;
    this.editor.append(
      this.target,
      reasonLabel,
      this.reason,
      this.save,
      this.cancel,
    );
    this.editor.hidden = true;
    this.details.append(
      el("summary", "引用のつながり"),
      el(
        "p",
        "ハイライト一覧の「この引用をつなぐ」から、別の引用と理由付きで結べます。引用・メモは関連を保存した時点の内容を残し、このブラウザに保存します。",
        "muted",
      ),
      this.status,
      this.source,
      this.reload,
      this.list,
      this.sameArticle,
      queryLabel,
      this.query,
      this.search,
      this.results,
      this.choices,
      this.editor,
    );
    this.root.append(this.details);
    this.details.addEventListener("toggle", () => {
      if (this.details.open) void this.load();
      else {
        this.stop();
        this.ready = false;
        this.controls();
      }
    });
    this.query.addEventListener("input", () => {
      this.controller?.abort();
      this.results.replaceChildren();
      this.choices.replaceChildren();
    });
    this.query.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void this.find();
      }
    });
    this.channel?.addEventListener("message", () => {
      if (this.root.isConnected && this.details.open && !this.busy)
        void this.load();
    });
    window.addEventListener("focus", () => {
      if (this.root.isConnected && this.details.open && !this.busy)
        void this.load();
    });
    this.controls();
  }
  mount(articleId: string) {
    if (this.articleId !== articleId) this.detach();
    this.articleId = articleId;
    return this.root;
  }
  detach() {
    this.stop();
    this.context++;
    this.articleId = undefined;
    this.quote = undefined;
    this.records = [];
    this.ready = false;
    this.writeFailure = "";
    this.clearDraft();
    this.savedNotice = "";
    this.source.replaceChildren();
    this.list.replaceChildren();
    this.results.replaceChildren();
    this.choices.replaceChildren();
    this.query.value = "";
    this.details.open = false;
  }
  begin(quote: ArticleHighlight) {
    if (this.busy || this.draft) {
      this.details.open = true;
      this.status.textContent =
        "現在の関連の保存または編集を終えてから、次の引用を選んでください。";
    } else {
      this.stop();
      this.context++;
      this.quote = quote;
      this.ready = false;
      this.records = [];
      this.list.replaceChildren();
      this.results.replaceChildren();
      this.choices.replaceChildren();
      this.writeFailure = "";
      this.savedNotice = "";
      this.source.replaceChildren(this.quoteCard(quote));
      this.details.open = true;
      void this.load();
    }
    this.root.scrollIntoView({ block: "center" });
    this.root.focus({ preventScroll: true });
  }
  private stop() {
    this.generation++;
    this.controller?.abort();
  }
  private controls() {
    this.save.disabled = this.busy || !this.ready || !this.draft;
    this.cancel.disabled = this.busy;
    this.search.disabled = this.sameArticle.disabled =
      this.busy || !this.ready || !this.quote || !!this.draft;
    this.query.disabled = this.busy || !!this.draft;
    this.reason.disabled = this.busy;
    this.reload.disabled = this.busy || !this.quote;
    for (const b of Array.from(this.list.querySelectorAll("button")))
      b.disabled = this.busy || !this.ready || !!this.draft;
    for (const b of Array.from(this.choices.querySelectorAll("button")))
      b.disabled = this.busy || !this.ready || !!this.draft;
  }
  private quoteCard(h: ArticleHighlight) {
    const card = el("div", undefined, "rss-quote-card");
    card.append(
      el("strong", h.title),
      el(
        "p",
        `${h.view === "original" ? "原文" : "訳文"} · ${h.language || "言語未設定"}`,
        "muted",
      ),
      el("blockquote", h.quote),
    );
    if (h.note) card.append(el("p", h.note));
    return card;
  }
  private clearDraft() {
    this.draft = undefined;
    this.expected = null;
    this.editor.hidden = true;
    this.reason.value = "";
    this.writeFailure = "";
    this.controls();
  }
  private edit(c: QuoteConnection, expected: number | null) {
    if (this.busy || !this.ready || this.draft || !this.quote) return;
    this.savedNotice = "";
    this.draft = c;
    this.expected = expected;
    this.target.replaceChildren(
      this.quoteCard(c.from.id === this.quote.id ? c.to : c.from),
    );
    this.reason.value = c.reason;
    this.editor.hidden = false;
    this.controls();
    this.reason.focus();
  }
  private async load() {
    if (!this.quote || !this.details.open || this.busy) return;
    this.stop();
    const generation = this.generation;
    this.ready = false;
    this.status.textContent =
      this.writeFailure || "引用のつながりを読み込んでいます…";
    this.controls();
    try {
      const records = await readQuoteConnections(this.quote.id);
      if (generation !== this.generation) return;
      this.records = records;
      this.ready = true;
      this.render();
      this.status.textContent =
        this.writeFailure ||
        `${this.savedNotice}${records.length}件のつながり。保存した時点の引用・メモを表示します。`;
    } catch (error) {
      if (generation === this.generation)
        this.status.textContent = this.writeFailure || (error as Error).message;
    } finally {
      if (generation === this.generation) this.controls();
    }
  }
  private async find() {
    if (!this.quote || this.busy || !this.ready) return;
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const context = this.context;
    this.results.replaceChildren();
    this.choices.replaceChildren();
    this.status.textContent = "記事を探しています…";
    try {
      const articles = await findConnectionTargets(
        "",
        this.library(),
        this.query.value,
        controller.signal,
      );
      if (controller.signal.aborted || context !== this.context) return;
      this.status.textContent =
        "最大20件の記事候補です。記事を選んで保存した引用を確認してください。";
      for (const article of articles) {
        const item = el("li");
        item.append(
          button(
            article.content?.title || article.title,
            () => void this.chooseArticle(article.id),
          ),
        );
        this.results.append(item);
      }
    } catch {
      if (!controller.signal.aborted && context === this.context)
        this.status.textContent =
          "記事を探せませんでした。再試行してください。";
    }
  }
  private async chooseArticle(articleId: string) {
    if (!this.quote || this.busy || !this.ready || this.draft) return;
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const context = this.context;
    this.choices.replaceChildren();
    this.status.textContent = "保存した引用を読み込んでいます…";
    try {
      const quotes = await readHighlights(articleId);
      if (controller.signal.aborted || context !== this.context) return;
      const available = quotes.filter((h) => h.id !== this.quote!.id);
      this.status.textContent = available.length
        ? "つなぐ引用を選んでください。"
        : "この候補に、つなげられる保存済みの引用はありません。先に本文でハイライトを保存してください。";
      for (const h of available) {
        const item = el("li");
        item.append(this.quoteCard(h));
        item.append(
          button("この引用を相手にする", () => {
            if (!this.quote || context !== this.context) return;
            const id = connectionKey(this.quote.id, h.id);
            const old = this.records.find((c) => c.id === id);
            this.edit(
              old
                ? { ...old, revision: old.revision + 1 }
                : {
                    id,
                    members: [this.quote.id, h.id].sort() as [string, string],
                    articles: [
                      ...new Set([this.quote.articleId, h.articleId]),
                    ].sort(),
                    from: this.quote,
                    to: h,
                    reason: "",
                    createdAt: new Date().toISOString(),
                    revision: 1,
                  },
              old?.revision ?? null,
            );
          }),
        );
        this.choices.append(item);
      }
      this.controls();
    } catch (error) {
      if (!controller.signal.aborted && context === this.context)
        this.status.textContent = (error as Error).message;
    }
  }
  private render() {
    this.list.replaceChildren();
    for (const c of this.records) {
      const other = c.from.id === this.quote?.id ? c.to : c.from;
      const item = el("li");
      item.append(this.quoteCard(other), el("p", c.reason));
      item.append(
        button("関係図でこの引用を辿る", () => this.graph(other)),
        button("引用の関連理由を編集", () =>
          this.edit({ ...c, revision: c.revision + 1 }, c.revision),
        ),
        button("引用のつながりを解除", () => {
          if (
            !this.busy &&
            this.ready &&
            !this.draft &&
            confirm(
              "この引用のつながりを解除しますか？引用とメモは保持します。",
            )
          )
            void this.commit(c);
        }),
      );
      this.list.append(item);
    }
  }
  private async commit(remove?: QuoteConnection) {
    if (this.busy || !this.ready || (!remove && !this.draft)) return;
    const c = remove || { ...this.draft!, reason: this.reason.value };
    const expected = remove?.revision ?? this.expected;
    const context = this.context;
    this.busy = true;
    this.writeFailure = "";
    this.controls();
    try {
      await writeQuoteConnection(c, expected, !!remove);
      this.channel?.postMessage(c.members);
      if (context !== this.context) return;
      this.clearDraft();
      this.savedNotice = remove
        ? "引用のつながりを解除しました。 "
        : "引用のつながりを保存しました。 ";
      this.status.textContent = this.savedNotice;
    } catch (error) {
      if (context === this.context) {
        this.writeFailure = (error as Error).message;
        this.status.textContent = this.writeFailure;
      }
    } finally {
      this.busy = false;
      this.controls();
      if (context === this.context) {
        await this.load();
      }
    }
  }
}
