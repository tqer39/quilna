import { ArticleSpeech, voiceKey } from "./article-speech";
import { browserLocale, readerLocales } from "./reader-preferences";
import type { FeedArticle } from "./feed-parser";
import { button, el } from "./ui";

export class HeadlinePlayer {
  readonly root = el("details", undefined, "rss-headline-player");
  private readonly speech = new ArticleSpeech(() => this.render());
  private readonly language = el("select");
  private readonly voice = el("select");
  private readonly rate = el("select");
  private readonly status = el("p", undefined, "rss-headline-status");
  private readonly start = button("この一覧の見出しを聞く", () => {
    this.notice = "";
    this.speech.start(this.text, this.language.value, Number(this.rate.value));
  });
  private readonly pause = button("一時停止", () => this.speech.togglePause());
  private readonly cancel = button("停止", () => this.stop());
  private text = "";
  private signature = "";
  private count = 0;
  private notice = "";

  constructor() {
    const summary = el("summary", "見出しを聞く");
    const body = el("div", undefined, "rss-headline-controls");
    body.append(
      el(
        "p",
        "興味のあるタグや配信元で絞ると、このページの見出しだけを続けて聞けます。本文や既読状態は変わりません。",
        "muted",
      ),
    );
    const fields = el("div", undefined, "rss-headline-fields");
    const languageLabel = el("label", "見出しの読み上げ言語");
    languageLabel.htmlFor = this.language.id = "rss-headline-language";
    for (const [value, name] of readerLocales) {
      const option = el("option", name);
      option.value = value;
      this.language.append(option);
    }
    this.language.value = readerLocales.some(
      ([code]) => code === browserLocale(),
    )
      ? browserLocale()
      : "ja-JP";
    this.language.addEventListener("change", () => this.stop());
    const voiceLabel = el("label", "見出しの音声");
    voiceLabel.htmlFor = this.voice.id = "rss-headline-voice";
    this.voice.addEventListener("change", () =>
      this.speech.selectVoice(this.language.value, this.voice.value),
    );
    const rateLabel = el("label", "見出しの速度");
    rateLabel.htmlFor = this.rate.id = "rss-headline-rate";
    for (const value of [0.8, 1, 1.2, 1.5, 2]) {
      const option = el("option", `${value}倍`);
      option.value = String(value);
      this.rate.append(option);
    }
    this.rate.value = "1";
    this.rate.addEventListener("change", () => this.stop());
    for (const [label, field] of [
      [languageLabel, this.language],
      [voiceLabel, this.voice],
      [rateLabel, this.rate],
    ]) {
      const group = el("div");
      group.append(label, field);
      fields.append(group);
    }
    const actions = el("div", undefined, "rss-headline-actions");
    actions.append(this.start, this.pause, this.cancel);
    this.status.setAttribute("role", "status");
    body.append(fields, actions, this.status);
    this.root.append(summary, body);
    if (this.speech.supported)
      speechSynthesis.addEventListener?.("voiceschanged", () => this.render());
    window.addEventListener("pagehide", () => this.stop());
    this.render();
  }

  update(items: FeedArticle[]) {
    const signature = JSON.stringify(
      items.map((item) => [item.id, item.content?.title || item.title]),
    );
    if (signature !== this.signature) {
      if (this.speech.state !== "idle") {
        this.speech.stop(false);
        this.notice =
          "表示する記事が変わったため停止しました。新しい一覧から再生できます。";
      }
      this.signature = signature;
      this.count = items.length;
      this.text = items
        .map(
          (item, index) =>
            `${index + 1}件目。${item.content?.title || item.title}`,
        )
        .join("\n");
    }
    this.render();
  }

  stop() {
    // 読書へ移った後の再描画で、本文側の音声まで停止させない。
    if (this.speech.state !== "idle") this.speech.stop(false);
    this.speech.message = "";
    this.notice = "";
    this.render();
  }

  private render() {
    const voices = this.speech.voices(this.language.value);
    const signature = JSON.stringify(
      voices.map((voice) => [voiceKey(voice), voice.name]),
    );
    if (signature !== this.voice.dataset.voices) {
      this.voice.dataset.voices = signature;
      this.voice.replaceChildren();
      const placeholder = el(
        "option",
        voices.length ? "音声を選択" : "利用できる端末内音声なし",
      );
      placeholder.value = "";
      this.voice.append(placeholder);
      for (const voice of voices) {
        const option = el("option", `${voice.name}（${voice.lang}）`);
        option.value = voiceKey(voice);
        this.voice.append(option);
      }
    }
    this.voice.value = this.speech.selectedVoice(this.language.value)
      ? voiceKey(this.speech.selectedVoice(this.language.value)!)
      : "";
    this.start.disabled =
      !this.count || !this.speech.supported || !this.voice.value;
    this.pause.hidden = this.cancel.hidden = this.speech.state === "idle";
    this.pause.textContent =
      this.speech.state === "paused" ? "再開" : "一時停止";
    this.status.textContent =
      this.notice ||
      this.speech.message ||
      (!this.count
        ? "表示中の記事はありません。"
        : !this.speech.supported
          ? "このブラウザでは読み上げを利用できません。"
          : `${this.count}件の見出し。${this.speech.voiceNotice(this.language.value)}`);
  }
}
