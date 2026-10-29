import { appendArticleText, type ArticleCodeRange } from "./article-code";
import { articleURL } from "./feed-parser";
import {
  highlightMatches,
  highlightVersion,
  readHighlights,
  writeHighlight,
  type ArticleHighlight,
  type HighlightSource,
} from "./article-highlights";
import { button, el } from "./ui";

export type ReadingView = Omit<HighlightSource, "version"> & {
  text: string;
  original: string;
  ranges?: ArticleCodeRange[];
};
type Span = { node: Text; start: number };
export class ArticleHighlightView {
  readonly root = el("section", undefined, "rss-highlights");
  private readonly status = el("p", "", "muted");
  private readonly details = el("details");
  private readonly summary = el("summary", "ハイライト・メモ");
  private readonly selection = button(
    "選択範囲をハイライト",
    () => this.useSelection(),
    "rss-highlight-capture",
  );
  private readonly query = el("textarea");
  private readonly matches = el("select");
  private readonly find = button("引用の候補を探す", () => this.findQuote());
  private readonly quote = el("blockquote");
  private readonly note = el("textarea");
  private readonly save = button(
    "ハイライトを保存",
    () => void this.saveDraft(),
  );
  private readonly cancel = button("編集をやめる", () => this.clearDraft());
  private readonly reload = button(
    "ハイライト一覧を再読み込み",
    () => void this.load(),
  );
  private readonly list = el("ol");
  private readonly editor = el("div");
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("quilna.highlights.v1");
  private view?: ReadingView;
  private source?: HighlightSource;
  private body?: HTMLElement;
  private spans: Span[] = [];
  private records: ArticleHighlight[] = [];
  private selected?: { start: number; end: number };
  private candidates: number[] = [];
  private draft?: ArticleHighlight;
  private expected: number | null = null;
  private generation = 0;
  private context = 0;
  private refreshPending = false;
  private writeFailure = "";
  private busy = false;
  private ready = false;

  constructor(
    private readonly connect?: (quote: ArticleHighlight) => void,
    private readonly learn?: (quote: ArticleHighlight) => void,
  ) {
    this.root.id = "rss-highlights";
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "ハイライトとメモ");
    this.status.setAttribute("role", "status");
    this.query.id = "rss-quote-query";
    this.query.maxLength = 4000;
    this.query.rows = 2;
    const queryLabel = el("label", "本文から探す引用（完全一致）");
    queryLabel.htmlFor = this.query.id;
    this.matches.setAttribute("aria-label", "引用の候補位置");
    this.matches.hidden = true;
    this.matches.addEventListener("change", () => {
      const start = this.candidates[Number(this.matches.value)];
      if (this.matches.value !== "" && start !== undefined)
        this.begin(start, start + this.query.value.length);
    });
    this.query.addEventListener("input", () => {
      this.matches.hidden = true;
      this.candidates = [];
    });
    this.note.id = "rss-highlight-note";
    this.note.maxLength = 2000;
    this.note.rows = 3;
    const noteLabel = el("label", "気づいたこと・メモ（任意）");
    noteLabel.htmlFor = this.note.id;
    this.editor.append(
      this.quote,
      noteLabel,
      this.note,
      this.save,
      this.cancel,
    );
    this.editor.hidden = true;
    this.list.setAttribute("aria-label", "保存したハイライト");
    this.details.append(
      this.summary,
      el(
        "p",
        "本文を選択して保存するか、引用文を入力して該当箇所を探せます。記録はこのブラウザに保存します。",
        "muted",
      ),
      queryLabel,
      this.query,
      this.find,
      this.matches,
      this.editor,
      this.reload,
      this.list,
    );
    this.root.append(this.selection, this.status, this.details);
    document.addEventListener("selectionchange", () => this.captureSelection());
    this.channel?.addEventListener("message", (event) => {
      if (event.data === this.view?.articleId && this.root.isConnected) {
        if (this.busy) this.refreshPending = true;
        else void this.load();
      }
    });
    window.addEventListener("focus", () => {
      if (this.root.isConnected && !this.busy) void this.load();
    });
    this.controls();
  }
  mount(view: ReadingView, body: HTMLElement) {
    const same =
      this.view?.articleId === view.articleId &&
      this.view.text === view.text &&
      this.view.original === view.original &&
      this.view.view === view.view &&
      this.view.language === view.language;
    this.view = view;
    this.body = body;
    if (!same) {
      this.context++;
      this.generation++;
      this.writeFailure = "";
      this.source = undefined;
      this.records = [];
      this.ready = false;
      this.selected = undefined;
      this.clearDraft();
      this.query.value = "";
      this.matches.hidden = true;
      this.candidates = [];
      this.details.open = false;
      this.renderList();
    }
    this.paint();
    if (!same) void this.load();
    return this.root;
  }
  detach() {
    this.context++;
    this.generation++;
    this.view = undefined;
    this.source = undefined;
    this.body = undefined;
    this.spans = [];
    this.selected = undefined;
    this.ready = false;
  }
  private checkExcerpt(view: ReadingView, start: number, end: number) {
    if (
      !this.view ||
      this.view.articleId !== view.articleId ||
      this.view.text !== view.text ||
      this.view.original !== view.original ||
      this.view.view !== view.view ||
      this.view.language !== view.language ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > view.text.length
    )
      return "本文が切り替わりました。現在の本文で候補を開き直してください。";
    return "";
  }
  prepareExcerpt(view: ReadingView, start: number, end: number, note: string) {
    const error = this.checkExcerpt(view, start, end);
    if (error) return error;
    if (this.busy)
      return "ハイライトを保存中です。完了後にもう一度操作してください。";
    if (!this.ready)
      return "ハイライトをまだ読み込めていません。状態を確認し、「ハイライト一覧を再読み込み」を試してください。";
    if (this.draft)
      return "ハイライトの編集内容を保持しています。先に保存するか「編集をやめる」を選んでください。";
    if (note.length > 2000 || !this.begin(start, end))
      return "引用または問いの範囲を確認できませんでした。";
    this.note.value = note;
    return "引用と問いをハイライトの下書きに入れました。内容を確認して保存してください。";
  }
  revealExcerpt(view: ReadingView, start: number, end: number) {
    const error = this.checkExcerpt(view, start, end);
    if (error) return error;
    const first = this.spans.find(
      (s) => s.start <= start && s.start + s.node.length > start,
    );
    const last = this.spans.find(
      (s) => s.start < end && s.start + s.node.length >= end,
    );
    if (!first || !last) return "根拠の本文の位置を確認できませんでした。";
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const target = first.node.parentElement!;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
    return "根拠の本文を選択しました。";
  }
  async revealSaved(quote: ArticleHighlight, signal: AbortSignal) {
    if (signal.aborted) return "";
    const view = this.view,
      context = this.context;
    if (!view || quote.articleId !== view.articleId)
      return "先に引用元の記事を開いてください。現在の本文の位置は変更していません。";
    const version = await highlightVersion(
      view.original,
      view.text,
      view.view,
      view.language,
    );
    if (signal.aborted) return "";
    if (context !== this.context)
      return "本文が切り替わりました。引用を開き直してください。";
    if (!highlightMatches(quote, { ...view, version }, view.text))
      return "別の本文の版・言語の引用です。位置を移さず保持しています。";
    return this.revealExcerpt(view, quote.start, quote.end);
  }
  private controls() {
    this.selection.disabled = this.busy || !this.ready || !this.selected;
    this.selection.hidden = this.selection.disabled;
    this.save.disabled = this.busy || !this.ready || !this.draft;
    this.find.disabled = this.busy || !this.ready;
    this.matches.disabled = this.busy || !this.ready;
    this.cancel.disabled = this.busy;
    this.reload.disabled = this.busy;
    this.note.disabled = this.busy;
  }
  private announce(message: string) {
    this.status.textContent = [this.writeFailure, message]
      .filter(Boolean)
      .join(" ");
  }
  private async load() {
    const view = this.view;
    if (!view) return;
    const generation = ++this.generation;
    this.announce("ハイライトを読み込んでいます…");
    this.ready = false;
    this.controls();
    this.renderList();
    try {
      const [version, records] = await Promise.all([
        highlightVersion(view.original, view.text, view.view, view.language),
        readHighlights(view.articleId),
      ]);
      if (generation !== this.generation) return;
      this.source = {
        articleId: view.articleId,
        title: view.title,
        url: view.url,
        view: view.view,
        language: view.language,
        version,
      };
      this.records = records;
      this.ready = true;
      this.announce(
        records.length
          ? `${records.length}件の引用を保存しています。`
          : "気になる言葉を残して、あとで読み返せます。",
      );
      this.paint();
      this.renderList();
    } catch (error) {
      if (generation !== this.generation) return;
      this.announce(
        `${(error as Error).message} 一覧の再読み込みを試してください。`,
      );
    } finally {
      if (generation === this.generation) this.controls();
    }
  }
  private paint() {
    if (!this.body || !this.view) return;
    this.selected = undefined;
    this.controls();
    const active = this.source
      ? this.records.filter((h) =>
          highlightMatches(h, this.source!, this.view!.text),
        )
      : [];
    this.body.replaceChildren();
    this.spans = [];
    appendArticleText(
      this.body,
      this.view.text,
      this.view.ranges,
      (text, start) => {
        const fragment = document.createDocumentFragment();
        const end = start + text.length;
        const ranges = active.filter((h) => h.end > start && h.start < end);
        const cuts = Array.from(
          new Set([
            start,
            end,
            ...ranges.flatMap((h) => [
              Math.max(start, h.start),
              Math.min(end, h.end),
            ]),
          ]),
        ).sort((a, b) => a - b);
        for (let i = 0; i < cuts.length - 1; i++) {
          const node = document.createTextNode(
            text.slice(cuts[i] - start, cuts[i + 1] - start),
          );
          this.spans.push({ node, start: cuts[i] });
          const ids = ranges
            .filter((h) => h.start < cuts[i + 1] && h.end > cuts[i])
            .map((h) => h.id);
          if (ids.length) {
            const mark = el("mark");
            mark.dataset.highlightIds = ids.join(" ");
            mark.tabIndex = -1;
            mark.append(node);
            fragment.append(mark);
          } else fragment.append(node);
        }
        return fragment;
      },
    );
  }
  private captureSelection() {
    if (!this.body?.isConnected || !this.ready || this.busy) return;
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      this.selected = undefined;
      this.controls();
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !this.body.contains(range.startContainer) ||
      !this.body.contains(range.endContainer)
    ) {
      this.selected = undefined;
      this.controls();
      return;
    }
    const pieces = this.spans
      .filter((s) => range.intersectsNode(s.node))
      .map((s) => ({
        start:
          s.start + (range.startContainer === s.node ? range.startOffset : 0),
        end:
          s.start +
          (range.endContainer === s.node ? range.endOffset : s.node.length),
      }))
      .filter((s) => s.end > s.start);
    this.selected = pieces.length
      ? { start: pieces[0].start, end: pieces[pieces.length - 1].end }
      : undefined;
    this.controls();
  }
  private useSelection() {
    if (this.selected) this.begin(this.selected.start, this.selected.end);
  }
  private begin(start: number, end: number) {
    if (!this.source || !this.view || !this.ready || this.busy) return false;
    const quote = this.view.text.slice(start, end);
    if (!quote.trim() || quote.length > 4000) {
      this.announce("引用は1〜4000文字の本文を選択してください。");
      return false;
    }
    for (const offset of [start, end]) {
      if (
        /[\uD800-\uDBFF]/.test(this.view.text[offset - 1] ?? "") &&
        /[\uDC00-\uDFFF]/.test(this.view.text[offset] ?? "")
      ) {
        this.announce("文字の途中を選択しています。選択し直してください。");
        return false;
      }
    }
    this.selected = undefined;
    this.draft = {
      ...this.source,
      title: this.view.title,
      url: this.view.url,
      id: crypto.randomUUID(),
      start,
      end,
      quote,
      note: "",
      createdAt: new Date().toISOString(),
      revision: 1,
    };
    this.expected = null;
    this.note.value = "";
    this.showDraft();
    return true;
  }
  private showDraft() {
    this.quote.textContent = this.draft?.quote ?? "";
    this.editor.hidden = !this.draft;
    this.save.textContent =
      this.expected === null ? "ハイライトを保存" : "メモを更新";
    this.details.open = true;
    this.controls();
    this.note.focus({ preventScroll: true });
    this.editor.scrollIntoView({ block: "nearest" });
  }
  private clearDraft() {
    this.draft = undefined;
    this.expected = null;
    this.note.value = "";
    this.editor.hidden = true;
    this.controls();
  }
  private findQuote() {
    const text = this.view?.text,
      quote = this.query.value;
    this.candidates = [];
    this.matches.hidden = true;
    if (!text || !quote.trim()) {
      this.announce("探したい引用文を入力してください。");
      return;
    }
    for (let from = 0; from < text.length;) {
      const start = text.indexOf(quote, from);
      if (start < 0) break;
      this.candidates.push(start);
      if (this.candidates.length > 100) {
        this.announce("候補が多いため、引用文を長くして探してください。");
        this.candidates = [];
        return;
      }
      from = start + 1;
    }
    if (!this.candidates.length) {
      this.announce("表示中の本文に一致する引用はありません。");
      return;
    }
    if (this.candidates.length === 1)
      this.begin(this.candidates[0], this.candidates[0] + quote.length);
    else {
      this.matches.replaceChildren();
      const placeholder = el("option", "引用する箇所を選択してください");
      placeholder.value = "";
      this.matches.append(placeholder);
      this.candidates.forEach((start, index) => {
        const option = el(
          "option",
          `${index + 1}：${text
            .slice(Math.max(0, start - 20), start + quote.length + 20)
            .replace(/\s+/g, " ")
            .slice(0, 120)}`,
        );
        option.value = String(index);
        this.matches.append(option);
      });
      this.matches.hidden = false;
      this.matches.focus();
    }
    this.announce(
      `${this.candidates.length}箇所が一致しました。引用を確認して保存してください。`,
    );
  }
  private async saveDraft() {
    if (!this.draft || this.busy || !this.ready) return;
    const record = { ...this.draft, note: this.note.value };
    await this.commit(record, this.expected, false);
  }
  private async commit(
    record: ArticleHighlight,
    expected: number | null,
    remove: boolean,
  ) {
    if (this.busy) return;
    const context = this.context;
    this.busy = true;
    this.writeFailure = "";
    this.controls();
    this.renderList();
    this.announce(remove ? "削除しています…" : "保存しています…");
    try {
      await writeHighlight(record, expected, remove);
      this.channel?.postMessage(record.articleId);
      if (this.context === context) {
        if (!remove || this.draft?.id === record.id) this.clearDraft();
        await this.load();
      }
    } catch (error) {
      if (this.context === context) {
        this.writeFailure = (error as Error).message;
        this.announce("");
      }
    } finally {
      this.busy = false;
      this.controls();
      this.renderList();
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.load();
      }
    }
  }
  private renderList() {
    this.list.replaceChildren();
    this.summary.textContent = `ハイライト・メモ（${this.records.length}）`;
    for (const h of this.records) {
      const item = el("li");
      const matches =
        !!this.source &&
        !!this.view &&
        highlightMatches(h, this.source, this.view.text);
      item.append(
        el(
          "p",
          `${h.view === "original" ? "原文" : "訳文"} ${h.language || "言語未設定"} · ${new Date(h.createdAt).toLocaleString("ja-JP")}`,
          "muted",
        ),
        el("blockquote", h.quote),
      );
      if (h.note) item.append(el("p", h.note, "rss-highlight-memo"));
      item.append(
        el(
          "p",
          matches
            ? "表示中の本文の引用"
            : "別の本文の版・言語の引用です。位置を移さず保持しています。",
          "muted",
        ),
      );
      const jump = button("本文の引用へ", () => {
        const mark = Array.from(
          this.body?.querySelectorAll<HTMLElement>(
            "mark[data-highlight-ids]",
          ) ?? [],
        ).find((m) => m.dataset.highlightIds?.split(" ").includes(h.id));
        mark?.focus({ preventScroll: true });
        mark?.scrollIntoView({ block: "center" });
      });
      jump.disabled = !matches;
      const edit = button("メモを編集", () => {
        if (this.busy || !this.ready) return;
        this.draft = { ...h, revision: h.revision + 1 };
        this.expected = h.revision;
        this.note.value = h.note;
        this.showDraft();
      });
      const remove = button("ハイライトを削除", () => {
        if (this.busy || !this.ready) return;
        if (
          window.confirm("この引用とメモを削除しますか？記事本文は保持します。")
        )
          void this.commit(h, h.revision, true);
      });
      edit.disabled = remove.disabled = this.busy || !this.ready;
      item.append(jump, edit, remove);
      if (this.connect) {
        const connect = button("この引用をつなぐ", () => this.connect?.(h));
        connect.disabled = this.busy || !this.ready;
        item.append(connect);
      }
      if (this.learn) {
        const learn = button("この引用から学びを記録", () => this.learn?.(h));
        learn.disabled = this.busy || !this.ready;
        item.append(learn);
      }
      if (h.url && articleURL(h.url, h.url) === h.url) {
        const link = el("a", "引用元の記事を開く");
        link.href = h.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(link);
      }
      this.list.append(item);
    }
  }
}
