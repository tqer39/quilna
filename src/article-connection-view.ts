import type { FeedArticle } from "./feed-parser";
import { articleURL } from "./feed-parser";
import {
  articleReference,
  connectionKey,
  readConnections,
  writeConnection,
  type ArticleConnection,
  type ArticleReference,
} from "./article-connections";
import {
  relatedArticles,
  findConnectionTargets,
  type RelatedArticle,
} from "./related-articles";
import { button, el } from "./ui";

export class ArticleConnectionView {
  readonly root = el("section", undefined, "rss-connections");
  private readonly details = el("details");
  private readonly summary = el("summary", "情報のつながり");
  private readonly status = el("p", "", "muted");
  private readonly linked = el("ul");
  private readonly suggested = el("ul");
  private readonly hidden = el("ul");
  private readonly query = el("input");
  private readonly search = button("つなぐ記事を探す", () => void this.find());
  private readonly results = el("ul");
  private readonly editor = el("div");
  private readonly selectedTitle = el("p");
  private readonly reason = el("textarea");
  private readonly save = button("つながりを保存", () => {
    if (this.draft && this.ready && !this.busy)
      void this.commit(
        { ...this.draft, reason: this.reason.value },
        this.expected,
      );
  });
  private readonly cancel = button("関連の編集をやめる", () =>
    this.clearDraft(),
  );
  private readonly reload = button(
    "つながりを再読み込み",
    () => void this.load(),
  );
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("quilna.connections.v1");
  private article?: FeedArticle;
  private libraryRevision = -1;
  private context = 0;
  private generation = 0;
  private controller?: AbortController;
  private finder?: AbortController;
  private records: ArticleConnection[] = [];
  private candidates: RelatedArticle[] = [];
  private targets: FeedArticle[] = [];
  private draft?: ArticleConnection;
  private expected: number | null = null;
  private ready = false;
  private busy = false;
  private finding = false;
  private refreshPending = false;
  private writeFailure = "";
  constructor(
    private readonly library: () => readonly FeedArticle[],
    private readonly lookup: (id: string) => FeedArticle | undefined,
    private readonly open: (id: string) => void,
  ) {
    this.root.id = "rss-connections";
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "情報のつながり");
    this.status.setAttribute("role", "status");
    this.query.id = "rss-connection-query";
    this.query.type = "search";
    this.query.maxLength = 300;
    const label = el("label", "ライブラリの記事を題名で探す");
    label.htmlFor = this.query.id;
    this.reason.id = "rss-connection-reason";
    this.reason.rows = 3;
    this.reason.maxLength = 2000;
    const reasonLabel = el("label", "つながりの理由（必須）");
    reasonLabel.htmlFor = this.reason.id;
    this.editor.append(
      this.selectedTitle,
      reasonLabel,
      this.reason,
      this.save,
      this.cancel,
    );
    this.editor.hidden = true;
    this.linked.setAttribute("aria-label", "自分で保存したつながり");
    this.suggested.setAttribute("aria-label", "共通タグからの候補");
    this.results.setAttribute("aria-label", "つなぐ記事の検索結果");
    this.hidden.setAttribute("aria-label", "非表示にした組み合わせ");
    const hiddenDetails = el("details");
    hiddenDetails.append(el("summary", "非表示にした候補を管理"), this.hidden);
    this.details.append(
      this.summary,
      el(
        "p",
        "気になる記事を、理由を添えてつなぎます。記録はこのブラウザに保存します。",
        "muted",
      ),
      this.status,
      this.reload,
      el("h3", "自分で保存したつながり"),
      this.linked,
      el("h3", "共通タグからの候補"),
      el(
        "p",
        "既読・保存した記事から最大3件。共通の話題を探す候補で、内容の一致や支持・反証は確認していません。",
        "muted",
      ),
      this.suggested,
      el("h3", "自分でつなぐ記事を選ぶ"),
      label,
      this.query,
      this.search,
      this.results,
      this.editor,
      hiddenDetails,
    );
    this.root.append(this.details);
    this.details.addEventListener("toggle", () => {
      if (this.details.open) void this.load();
      else {
        this.stopReads();
        this.ready = false;
        this.controls();
      }
    });
    this.query.addEventListener("input", () => {
      this.finder?.abort();
      this.finder = undefined;
      this.finding = false;
      this.targets = [];
      this.renderTargets();
      this.controls();
    });
    this.query.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void this.find();
      }
    });
    this.channel?.addEventListener("message", (event) => {
      if (
        this.article &&
        this.details.open &&
        this.root.isConnected &&
        Array.isArray(event.data) &&
        event.data.includes(this.article.id)
      ) {
        if (this.busy) this.refreshPending = true;
        else void this.load();
      }
    });
    window.addEventListener("focus", () => {
      if (this.root.isConnected && this.details.open && !this.busy)
        void this.load();
    });
    this.controls();
  }
  mount(article: FeedArticle, revision: number) {
    const same = article.id === this.article?.id;
    const changed =
      revision !== this.libraryRevision || article !== this.article;
    this.article = article;
    this.libraryRevision = revision;
    if (!same) {
      this.context++;
      this.stopReads();
      this.writeFailure = "";
      this.ready = false;
      this.records = [];
      this.candidates = [];
      this.targets = [];
      this.query.value = "";
      this.clearDraft();
      this.details.open = false;
      this.renderLists();
      this.renderTargets();
      this.announce("");
    } else if (changed && this.details.open) {
      if (this.busy) this.refreshPending = true;
      else void this.load();
    }
    return this.root;
  }
  detach() {
    this.context++;
    this.article = undefined;
    this.ready = false;
    this.stopReads();
  }
  private stopReads() {
    this.generation++;
    this.controller?.abort();
    this.finder?.abort();
    this.finder = undefined;
    this.finding = false;
  }
  private announce(text: string) {
    this.status.textContent = [this.writeFailure, text]
      .filter(Boolean)
      .join(" ");
  }
  private controls() {
    this.search.disabled = !this.ready || this.busy || this.finding;
    this.save.disabled = !this.ready || this.busy || !this.draft;
    this.query.disabled =
      this.reason.disabled =
      this.cancel.disabled =
        this.busy;
    this.reload.disabled = this.busy;
  }
  private async load() {
    if (!this.article || !this.details.open) return;
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const generation = ++this.generation,
      article = this.article;
    this.ready = false;
    this.controls();
    this.renderLists();
    this.renderTargets();
    this.announce("つながりを読み込んでいます…");
    try {
      const records = await readConnections(article.id);
      if (generation !== this.generation) return;
      const excluded = new Set(
        records.map((c) => this.other(c, article.id).id),
      );
      const candidates = await relatedArticles(
        article,
        this.library(),
        excluded,
        controller.signal,
      );
      if (generation !== this.generation) return;
      this.records = records;
      this.candidates = candidates;
      this.ready = true;
      this.announce("保存した関連と、自動の候補を分けて表示しています。");
      this.renderLists();
      this.renderTargets();
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted)
        this.announce(
          `${(error as Error).message} 再読み込みを試してください。`,
        );
    } finally {
      if (generation === this.generation) this.controls();
    }
  }
  private async find() {
    if (!this.article || !this.ready || this.busy || this.finding) return;
    this.finder?.abort();
    const controller = (this.finder = new AbortController()),
      context = this.context;
    this.finding = true;
    this.controls();
    this.announce("記事を探しています…");
    try {
      const targets = await findConnectionTargets(
        this.article.id,
        this.library(),
        this.query.value,
        controller.signal,
      );
      if (this.finder !== controller || this.context !== context) return;
      this.targets = targets;
      this.renderTargets();
      this.announce(
        targets.length
          ? `${targets.length}件を表示しています（最大20件）。題名を絞り込めます。`
          : "題名が一致する記事はありません。",
      );
    } catch (error) {
      if (!controller.signal.aborted && this.context === context)
        this.announce((error as Error).message);
    } finally {
      if (this.finder === controller) {
        this.finding = false;
        this.controls();
      }
    }
  }
  private other(c: ArticleConnection, id = this.article?.id) {
    return c.from.id === id ? c.to : c.from;
  }
  private fresh(
    target: FeedArticle,
    state: ArticleConnection["state"],
  ): ArticleConnection {
    const from = articleReference(this.article!),
      to = articleReference(target);
    return {
      id: connectionKey(from.id, to.id),
      members: [from.id, to.id].sort() as [string, string],
      from,
      to,
      state,
      reason: "",
      createdAt: new Date().toISOString(),
      revision: 1,
    };
  }
  private choose(id: string) {
    if (!this.article || !this.ready || this.busy) return;
    const target = this.lookup(id);
    if (!target) {
      this.announce("この記事はライブラリにありません。記録は保持しています。");
      return;
    }
    const old = this.records.find(
      (c) => c.id === connectionKey(this.article!.id, id),
    );
    this.edit(old ?? this.fresh(target, "linked"), old?.revision ?? null);
  }
  private edit(c: ArticleConnection, expected: number | null) {
    if (!this.ready || this.busy) return;
    this.draft = { ...c, state: "linked", revision: (expected ?? 0) + 1 };
    this.expected = expected;
    this.reason.value = c.reason;
    this.selectedTitle.textContent = `${c.from.title} ↔ ${c.to.title}`;
    this.editor.hidden = false;
    this.controls();
    this.reason.focus({ preventScroll: true });
    this.editor.scrollIntoView({ block: "nearest" });
  }
  private clearDraft() {
    this.draft = undefined;
    this.expected = null;
    this.reason.value = "";
    this.editor.hidden = true;
    this.controls();
  }
  private async commit(
    c: ArticleConnection,
    expected: number | null,
    remove = false,
  ) {
    if (this.busy || !this.ready) return;
    const context = this.context;
    this.busy = true;
    this.writeFailure = "";
    this.controls();
    this.renderLists();
    this.renderTargets();
    this.announce(
      remove ? "関連を解除しています…" : "つながりを保存しています…",
    );
    try {
      await writeConnection(c, expected, remove);
      this.channel?.postMessage(c.members);
      if (context === this.context) {
        if (this.draft?.id === c.id) this.clearDraft();
        await this.load();
      }
    } catch (error) {
      if (context === this.context) {
        this.writeFailure = (error as Error).message;
        this.announce("");
      }
    } finally {
      this.busy = false;
      this.controls();
      this.renderLists();
      this.renderTargets();
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.load();
      }
    }
  }
  private articleLink(item: HTMLElement, ref: ArticleReference) {
    const open = button("この記事を読む", () => {
      if (this.lookup(ref.id)) this.open(ref.id);
      else
        this.announce(
          "この記事はライブラリにありません。出典の記録は保持しています。",
        );
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
  }
  private renderLists() {
    this.linked.replaceChildren();
    this.hidden.replaceChildren();
    this.suggested.replaceChildren();
    const linked = this.records.filter((c) => c.state === "linked");
    this.summary.textContent = `情報のつながり（${linked.length}）`;
    for (const c of this.records) {
      const ref = this.other(c),
        item = el("li");
      item.append(el("h4", ref.title));
      if (c.state === "linked") {
        item.append(
          el("p", "自分で保存した関連", "muted"),
          el("p", c.reason, "rss-connection-reason"),
        );
        this.articleLink(item, ref);
        const edit = button("関連の理由を編集", () => this.edit(c, c.revision));
        edit.disabled = this.busy || !this.ready;
        item.append(edit);
      } else
        item.append(
          el(
            "p",
            "この2記事の組み合わせを候補から非表示にしています。",
            "muted",
          ),
        );
      const remove = button(
        c.state === "linked" ? "関連を解除" : "候補の非表示を解除",
        () => {
          if (this.busy || !this.ready) return;
          if (
            window.confirm(
              "このつながり・非表示の記録を解除しますか？記事とハイライトは保持します。",
            )
          )
            void this.commit(c, c.revision, true);
        },
      );
      remove.disabled = this.busy || !this.ready;
      item.append(remove);
      (c.state === "linked" ? this.linked : this.hidden).append(item);
    }
    if (!linked.length)
      this.linked.append(el("li", "保存したつながりはまだありません。"));
    if (!this.hidden.children.length)
      this.hidden.append(el("li", "非表示の候補はありません。"));
    for (const candidate of this.candidates) {
      const ref = articleReference(candidate.article),
        item = el("li");
      item.append(
        el("h4", ref.title),
        el(
          "p",
          `候補の理由：共通タグ「${candidate.tags.join("」「")}」`,
          "muted",
        ),
      );
      this.articleLink(item, ref);
      const choose = button("理由を添えてつなぐ", () => this.choose(ref.id));
      const hide = button("この候補を非表示", () => {
        if (!this.ready || this.busy || !this.article) return;
        const target = this.lookup(ref.id);
        if (target) void this.commit(this.fresh(target, "hidden"), null);
      });
      choose.disabled = hide.disabled = !this.ready || this.busy;
      item.append(choose, hide);
      this.suggested.append(item);
    }
    if (!this.candidates.length)
      this.suggested.append(
        el(
          "li",
          "共通タグのある既読・保存記事は見つかりません。題名から自分で選べます。",
        ),
      );
  }
  private renderTargets() {
    this.results.replaceChildren();
    for (const target of this.targets) {
      const item = el("li");
      item.append(el("p", articleReference(target).title));
      const choose = button("この記事を選ぶ", () => this.choose(target.id));
      choose.disabled = !this.ready || this.busy;
      item.append(choose);
      this.results.append(item);
    }
  }
}
