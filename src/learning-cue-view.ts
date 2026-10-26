import type { ReadingView } from "./article-highlight-view";
import { articleURL } from "./feed-parser";
import { learningCues, type LearningCue } from "./learning-cues";
import { button, el } from "./ui";

export class LearningCueView {
  readonly root = el("section", undefined, "rss-learning-cues");
  private readonly details = el("details");
  private readonly summary = el("summary", "学ぶきっかけ");
  private readonly status = el("p", "", "muted");
  private readonly list = el("ol");
  private readonly restore = button("非表示にした問いを戻す", () => {
    this.hidden.clear();
    this.render();
    this.status.textContent = "候補を再表示しました。";
  });
  private readonly source = el("a", "この記事の出典を開く");
  private view?: ReadingView;
  private controller?: AbortController;
  private cues?: LearningCue[];
  private hidden = new Set<number>();

  constructor(
    private readonly reveal: (view: ReadingView, cue: LearningCue) => string,
    private readonly prepare: (view: ReadingView, cue: LearningCue) => string,
  ) {
    this.root.id = "rss-learning-cues";
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "学ぶきっかけ");
    this.list.setAttribute("aria-label", "本文から見つけた問い");
    this.status.setAttribute("role", "status");
    this.source.target = "_blank";
    this.source.rel = "noopener noreferrer";
    this.details.append(
      this.summary,
      el(
        "p",
        "本文の表現から見つけた、読み返すための問いです。要約や正確性の判定ではありません。答えの入力は不要です。",
        "muted",
      ),
      this.source,
      this.status,
      this.list,
      this.restore,
      el(
        "p",
        "候補の非表示は、この記事の本文・言語を切り替えるまで有効です。引用と問いは、ハイライトで確認して保存できます。",
        "muted",
      ),
    );
    this.root.append(this.details);
    this.details.addEventListener("toggle", () => {
      if (this.details.open) void this.load();
      else this.controller?.abort();
    });
  }
  mount(view: ReadingView) {
    const same =
      this.view?.articleId === view.articleId &&
      this.view.text === view.text &&
      this.view.original === view.original &&
      this.view.view === view.view &&
      this.view.language === view.language &&
      JSON.stringify(this.view.ranges) === JSON.stringify(view.ranges);
    this.view = view;
    if (!same) {
      this.controller?.abort();
      this.cues = undefined;
      this.hidden.clear();
      this.details.open = false;
      this.status.textContent = "";
      this.list.replaceChildren();
      this.restore.hidden = true;
      this.summary.textContent = "学ぶきっかけ";
    }
    const url = articleURL(view.url, view.url);
    this.source.hidden = !url || url !== view.url;
    this.source.href = this.source.hidden ? "#" : (url ?? "#");
    return this.root;
  }
  detach() {
    this.controller?.abort();
    this.view = undefined;
    this.cues = undefined;
    this.hidden.clear();
  }
  private async load() {
    if (!this.view) return;
    if (this.cues) {
      this.render();
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const view = this.view;
    this.status.textContent = "表示中の本文から候補を探しています…";
    try {
      const cues = await learningCues(
        view.text,
        view.ranges,
        controller.signal,
      );
      if (controller.signal.aborted || this.controller !== controller) return;
      this.cues = cues;
      this.status.textContent = cues.length
        ? `${view.view === "translation" ? "訳文" : "原文"}の表現から${cues.length}件の候補を見つけました。学習済みとは記録しません。`
        : "この本文では候補を見つけられませんでした。気になる箇所は自由にハイライトできます。";
      this.render();
    } catch (error) {
      if (!controller.signal.aborted && this.controller === controller)
        this.status.textContent = `${(error as Error).message} パネルを閉じて開くと再試行できます。`;
    }
  }
  private render() {
    this.list.replaceChildren();
    const view = this.view;
    if (!view) return;
    const visible = (this.cues ?? []).filter((c) => !this.hidden.has(c.start));
    this.summary.textContent = `学ぶきっかけ（${visible.length}）`;
    this.restore.hidden = this.hidden.size === 0;
    for (const cue of visible) {
      const item = el("li");
      const title = el("h3", cue.label);
      title.id = `rss-cue-${cue.start}`;
      item.setAttribute("aria-labelledby", title.id);
      item.append(
        title,
        el("blockquote", cue.quote),
        el("p", cue.prompt, "rss-cue-question"),
        button("根拠の本文へ", () => {
          this.status.textContent = this.reveal(view, cue);
        }),
        button("引用と問いを残す", () => {
          this.status.textContent = this.prepare(view, cue);
        }),
        button("この候補を非表示", () => {
          this.hidden.add(cue.start);
          this.render();
          this.status.textContent =
            "この候補を非表示にしました。下のボタンで戻せます。";
          this.restore.focus({ preventScroll: true });
        }),
      );
      this.list.append(item);
    }
  }
}
