import type { ArticleHighlight } from "./article-highlights";
import {
  learningDatabase,
  readLearning,
  writeLearning,
  type LearningRecord,
} from "./article-learning";
import { articleURL } from "./feed-parser";
import { button, el } from "./ui";

export class ArticleLearningView {
  readonly root = el(
    "section",
    undefined,
    "rss-connections rss-learning-records",
  );
  private readonly details = el("details");
  private readonly summary = el("summary", "自分の学び");
  private readonly status = el("p", "", "muted");
  private readonly list = el("ul");
  private readonly editor = el("div");
  private readonly source = el("div");
  private readonly reflection = el("textarea");
  private readonly save = button("学びを保存", () => void this.commit());
  private readonly cancel = button("学びの編集をやめる", () =>
    this.clearDraft(),
  );
  private readonly reload = button(
    "学びの記録を再読み込み",
    () => void this.load(),
  );
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(learningDatabase);
  private articleId?: string;
  private records: LearningRecord[] = [];
  private draft?: LearningRecord;
  private expected: number | null = null;
  private generation = 0;
  private context = 0;
  private busy = false;
  private ready = false;
  private failure = "";
  private notice = "";
  private revealController?: AbortController;

  constructor(
    private readonly reveal: (
      source: ArticleHighlight,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {
    this.root.id = "rss-learning-records";
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "自分の学び");
    this.status.setAttribute("role", "status");
    this.list.setAttribute("aria-label", "保存した学び");
    this.reflection.id = "rss-learning-reflection";
    this.reflection.rows = 4;
    this.reflection.maxLength = 4000;
    const label = el("label", "学んだこと・自分の説明（必須）");
    label.htmlFor = this.reflection.id;
    this.editor.append(
      this.source,
      label,
      this.reflection,
      this.save,
      this.cancel,
    );
    this.editor.hidden = true;
    this.details.append(
      this.summary,
      el(
        "p",
        "ハイライトの「この引用から学びを記録」から、自分の言葉で残せます。既読・保存・ハイライトとは別の記録で、理解度の自動判定はしません。このブラウザに保存します。",
        "muted",
      ),
      this.status,
      this.editor,
      this.reload,
      this.list,
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
    this.channel?.addEventListener("message", (event) => {
      if (
        (event.data === this.articleId || event.data === "changed") &&
        this.root.isConnected &&
        this.details.open &&
        !this.busy
      )
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
    this.records = [];
    this.ready = false;
    this.failure = this.notice = "";
    this.clearDraft();
    this.list.replaceChildren();
    this.summary.textContent = "自分の学び";
    this.details.open = false;
  }
  begin(source: ArticleHighlight) {
    if (source.articleId !== this.articleId) return;
    this.revealController?.abort();
    if (this.busy || this.draft) {
      this.announce(
        "現在の学びの保存または編集を終えてから、次の引用を選んでください。",
      );
    } else {
      this.failure = this.notice = "";
      this.draft = {
        id: crypto.randomUUID(),
        articleId: source.articleId,
        source: { ...source },
        reflection: "",
        createdAt: new Date().toISOString(),
        revision: 1,
      };
      this.expected = null;
      this.showDraft();
    }
    this.details.open = true;
    void this.load();
    this.root.scrollIntoView({ block: "center" });
    this.root.focus({ preventScroll: true });
  }
  private stop() {
    this.generation++;
    this.revealController?.abort();
  }
  private announce(text: string) {
    this.status.textContent = [this.failure, text].filter(Boolean).join(" ");
  }
  private controls() {
    this.save.disabled = this.busy || !this.ready || !this.draft;
    this.reflection.disabled =
      this.cancel.disabled =
      this.reload.disabled =
        this.busy;
    for (const b of Array.from(this.list.querySelectorAll("button")))
      b.disabled = this.busy || !this.ready || !!this.draft;
  }
  private showDraft() {
    if (!this.draft) return;
    this.source.replaceChildren(this.sourceCard(this.draft.source));
    this.reflection.value = this.draft.reflection;
    this.editor.hidden = false;
    this.controls();
  }
  private clearDraft() {
    this.draft = undefined;
    this.expected = null;
    this.reflection.value = "";
    this.editor.hidden = true;
    this.failure = "";
    this.controls();
  }
  private async load() {
    if (!this.articleId || !this.details.open) return;
    this.revealController?.abort();
    const articleId = this.articleId,
      generation = ++this.generation;
    this.ready = false;
    this.controls();
    this.announce("学びを読み込んでいます…");
    try {
      const records = await readLearning(articleId);
      if (generation !== this.generation) return;
      this.records = records;
      this.ready = true;
      this.renderList();
      this.announce(
        `${this.notice}${records.length}件の学びを記録しています。`,
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.announce(`${(error as Error).message} 再読み込みで再試行できます。`);
    } finally {
      if (generation === this.generation) this.controls();
    }
  }
  private sourceCard(source: ArticleHighlight) {
    const card = el("div", undefined, "rss-quote-card");
    card.append(
      el(
        "p",
        `${source.title} · ${source.view === "original" ? "原文" : "訳文"} ${source.language || "言語未設定"}`,
        "muted",
      ),
      el("blockquote", source.quote),
    );
    if (source.note)
      card.append(
        el("p", `記録時の引用メモ：${source.note}`, "rss-highlight-memo"),
      );
    if (source.url && articleURL(source.url, source.url) === source.url) {
      const link = el("a", "学びの出典を開く");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    return card;
  }
  private renderList() {
    this.list.replaceChildren();
    this.summary.textContent = `自分の学び（${this.records.length}）`;
    for (const record of this.records) {
      const item = el("li");
      item.append(
        el(
          "p",
          `記録日：${new Date(record.createdAt).toLocaleString("ja-JP")}`,
          "muted",
        ),
        el("p", record.reflection, "rss-highlight-memo"),
        this.sourceCard(record.source),
      );
      const jump = button("学びの引用を本文で確認", () => {
        this.revealController?.abort();
        const controller = (this.revealController = new AbortController());
        void this.reveal(record.source, controller.signal)
          .then((message) => {
            if (!controller.signal.aborted) this.announce(message);
          })
          .catch(() => {
            if (!controller.signal.aborted)
              this.announce(
                "引用位置を確認できませんでした。出典と記録は保持しています。",
              );
          });
      });
      const edit = button("学びを編集", () => {
        this.revealController?.abort();
        this.failure = this.notice = "";
        this.draft = { ...record, revision: record.revision + 1 };
        this.expected = record.revision;
        this.showDraft();
        this.reflection.focus();
      });
      const remove = button("学びを削除", () => {
        if (
          window.confirm(
            "この学びの記録を削除しますか？記事・ハイライト・関連は保持します。",
          )
        )
          void this.commit(record);
      });
      item.append(jump, edit, remove);
      this.list.append(item);
    }
    this.controls();
  }
  private async commit(remove?: LearningRecord) {
    if (this.busy || !this.ready || (!remove && !this.draft)) return;
    const record = remove ?? {
      ...this.draft!,
      reflection: this.reflection.value,
    };
    const expected = remove?.revision ?? this.expected,
      context = this.context;
    this.stop();
    this.busy = true;
    this.failure = this.notice = "";
    this.controls();
    this.announce(remove ? "学びを削除しています…" : "学びを保存しています…");
    try {
      await writeLearning(record, expected, !!remove);
      this.channel?.postMessage(record.articleId);
      if (context === this.context) {
        if (!remove) this.clearDraft();
        this.notice = remove
          ? "学びを削除しました。 "
          : "学びを保存しました。 ";
      }
    } catch (error) {
      if (context === this.context) this.failure = (error as Error).message;
    } finally {
      this.busy = false;
      this.controls();
      if (context === this.context) await this.load();
    }
  }
}
