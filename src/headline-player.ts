import { libraryName } from "./library-context";
import { interestWords, interestHeadlines } from "./headline-interests";
import { ArticleSpeech, voiceKey } from "./article-speech";
import { browserLocale, readerLocales } from "./reader-preferences";
import type { FeedArticle } from "./feed-parser";
import { readerIcon } from "./reader-icons";
import { button, el } from "./ui";

export class HeadlinePlayer {
  readonly root = el("details", undefined, "rss-headline-player");
  private readonly speech = new ArticleSpeech(() => this.render());
  private readonly language = el("select");
  private readonly voice = el("select");
  private readonly rate = el("select");
  private readonly status = el("p", undefined, "rss-headline-status");
  private readonly interest = el(
    "details",
    undefined,
    "rss-headline-interests",
  );
  private readonly wordsInput = el("input");
  private readonly interestNote = el("p", undefined, "muted");
  private readonly voiceHelp = el("p", undefined, "muted");
  private readonly previewPanel = el("details");
  private readonly preview = el("ol");
  private readonly nowPlaying = el("p", undefined, "rss-headline-current");
  private readonly personalStart = button("関心のある未読を聞く", () =>
    this.playTitles(true),
  );
  private readonly preferenceKey = libraryName("quilna.headlines.interests.v1");
  private words: string[] = [];
  private library: readonly FeedArticle[] = [];
  private revision = -1;
  private preparedRevision = -1;
  private personalSignature = "";
  private personalItems: FeedArticle[] = [];
  private playingPersonal = false;
  private readonly start = button("この一覧の見出しを聞く", () =>
    this.playTitles(false),
  );
  private readonly pause = button("一時停止", () => this.speech.togglePause());
  private readonly cancel = button("停止", () => this.stop());
  private items: FeedArticle[] = [];
  private currentIndex = -1;
  private readonly saveCurrent = button("あとで読むに保存", () => {
    const article = this.currentArticle();
    if (article && !article.saved) this.saveArticle(article.id);
  });
  private signature = "";
  private notice = "";

  constructor(private readonly saveArticle: (id: string) => void) {
    const summary = el("summary");
    summary.append(readerIcon("speaker"), el("span", "見出しを聞く"));
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
    const form = el("form");
    const wordsLabel = el("label", "関心のある言葉");
    wordsLabel.htmlFor = this.wordsInput.id = "rss-headline-interests";
    this.wordsInput.maxLength = 648;
    this.wordsInput.placeholder = "例：宇宙、技術";
    const help = el(
      "p",
      "読点で区切って8個まで。見出しに含まれる言葉か、一致するタグで、全配信元の未読から新しい順に50件まで選びます。空欄で保存すると解除します。",
      "muted",
    );
    help.id = "rss-interest-help";
    this.wordsInput.setAttribute("aria-describedby", help.id);
    this.wordsInput.addEventListener("input", () => {
      if (this.playingPersonal && this.speech.state !== "idle") this.stop();
      this.interestNote.textContent = "";
      this.render();
    });
    const save = el("button", "関心を保存");
    save.type = "submit";
    form.append(wordsLabel, this.wordsInput, save, help);
    this.interestNote.setAttribute("aria-live", "polite");
    const loadPreference = () => {
      try {
        this.words = interestWords(
          localStorage.getItem(this.preferenceKey) ?? "",
        );
        this.wordsInput.value = this.words.join("、");
        this.interestNote.textContent = "";
      } catch {
        this.words = [];
        this.interestNote.textContent = "保存した関心を読み込めませんでした。";
      }
      this.preparedRevision = -1;
      this.prepareInterests();
    };
    loadPreference();
    window.addEventListener("storage", (event) => {
      if (event.key !== this.preferenceKey && event.key !== null) return;
      const draft = this.wordsInput.value;
      const editing = draft !== this.words.join("、");
      loadPreference();
      if (editing) {
        this.wordsInput.value = draft;
        this.render();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      let words: string[];
      try {
        words = interestWords(this.wordsInput.value);
      } catch (error) {
        this.interestNote.textContent = (error as Error).message;
        return;
      }
      try {
        if (words.length)
          localStorage.setItem(this.preferenceKey, words.join("、"));
        else localStorage.removeItem(this.preferenceKey);
      } catch {
        this.interestNote.textContent =
          "関心を保存できませんでした。入力を残しています。";
        return;
      }
      this.words = words;
      this.wordsInput.value = words.join("、");
      this.preparedRevision = -1;
      this.prepareInterests();
      this.interestNote.textContent = words.length
        ? "このブラウザに関心を保存しました。"
        : "保存した関心を解除しました。";
    });
    this.previewPanel.append(
      el("summary", "読み上げる見出しを確認"),
      this.preview,
    );
    this.interest.append(
      el("summary", "関心のある未読記事"),
      form,
      this.interestNote,
      this.personalStart,
      this.voiceHelp,
      this.previewPanel,
    );
    this.interest.addEventListener("toggle", () => this.prepareInterests());
    this.root.addEventListener("toggle", () => this.prepareInterests());
    body.append(
      fields,
      actions,
      this.status,
      this.nowPlaying,
      this.saveCurrent,
      this.interest,
    );
    this.root.append(summary, body);
    if (this.speech.supported)
      speechSynthesis.addEventListener?.("voiceschanged", () => this.render());
    window.addEventListener("pagehide", () => this.stop());
    this.render();
  }

  private prepareInterests() {
    if (
      !(this.interest.open && this.root.open) &&
      !(this.playingPersonal && this.speech.state !== "idle")
    )
      return;
    if (this.preparedRevision === this.revision) return;
    this.preparedRevision = this.revision;
    const matches = interestHeadlines(this.library, this.words);
    this.personalItems = matches;
    const signature = JSON.stringify(
      matches.map((item) => [item.id, item.content?.title || item.title]),
    );
    if (signature !== this.personalSignature) {
      if (this.playingPersonal && this.speech.state !== "idle") {
        this.speech.stop(false);
        this.notice = "関心に合う未読記事が変わったため停止しました。";
      }
      this.personalSignature = signature;
      const titles = matches.map((item) => item.content?.title || item.title);
      this.preview.replaceChildren(...titles.map((title) => el("li", title)));
    }
    this.render();
  }

  update(
    items: FeedArticle[],
    library: readonly FeedArticle[],
    revision: number,
  ) {
    this.items = items;
    this.library = library;
    this.revision = revision;
    this.prepareInterests();
    const signature = JSON.stringify(
      items.map((item) => [item.id, item.content?.title || item.title]),
    );
    if (signature !== this.signature) {
      if (!this.playingPersonal && this.speech.state !== "idle") {
        this.speech.stop(false);
        this.notice =
          "表示する記事が変わったため停止しました。新しい一覧から再生できます。";
      }
      this.signature = signature;
    }
    this.render();
  }

  private currentArticle() {
    return this.speech.state === "idle"
      ? undefined
      : (this.playingPersonal ? this.personalItems : this.items)[
          this.currentIndex
        ];
  }

  private playTitles(personal: boolean) {
    const titles = (personal ? this.personalItems : this.items).map(
      (article) => article.content?.title || article.title,
    );
    this.currentIndex = -1;
    this.playingPersonal = personal;
    this.notice = "";
    this.nowPlaying.textContent = "";
    this.speech.start(
      titles.map((title, i) => `${i + 1}件目。${title}`),
      this.language.value,
      Number(this.rate.value),
      (i) => {
        const current = `${i + 1} / ${titles.length} · ${titles[i]}`;
        if (this.nowPlaying.textContent !== current)
          this.nowPlaying.textContent = current;
        this.currentIndex = i;
        this.render();
      },
    );
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
    const dirty = this.wordsInput.value !== this.words.join("、");
    const count = this.preview.childElementCount;
    this.previewPanel.hidden = !count || dirty;
    this.personalStart.textContent = dirty
      ? "関心を保存してから再生"
      : count
        ? `関心のある未読${count}件を聞く`
        : this.words.length
          ? "関心に合う未読記事はありません"
          : "関心のある未読を聞く";
    this.personalStart.disabled =
      dirty || !count || !this.speech.supported || !this.voice.value;
    this.voiceHelp.hidden = dirty || !count || !!this.voice.value;
    if (!this.voiceHelp.hidden)
      this.voiceHelp.textContent = this.speech.voiceNotice(this.language.value);
    this.start.disabled =
      !this.items.length || !this.speech.supported || !this.voice.value;
    this.nowPlaying.hidden =
      this.speech.state === "idle" || !this.nowPlaying.textContent;
    const current = this.currentArticle();
    this.saveCurrent.hidden = !current;
    this.saveCurrent.disabled = !current || current.saved;
    this.saveCurrent.textContent = current?.saved
      ? "あとで読むに保存済み"
      : "あとで読むに保存";
    this.pause.hidden = this.cancel.hidden = this.speech.state === "idle";
    this.pause.textContent =
      this.speech.state === "paused" ? "再開" : "一時停止";
    this.status.textContent =
      this.notice ||
      this.speech.message ||
      (!this.items.length
        ? "表示中の記事はありません。"
        : !this.speech.supported
          ? "このブラウザでは読み上げを利用できません。"
          : `${this.items.length}件の見出し。${this.speech.voiceNotice(this.language.value)}`);
  }
}
