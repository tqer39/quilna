const voicePreferencesKey = "quilna.reader.voices.v1";
export function voiceKey(voice: SpeechSynthesisVoice): string {
  return voice.voiceURI || `${voice.lang}:${voice.name || "default"}`;
}

export class ArticleSpeech {
  state: "idle" | "speaking" | "paused" = "idle";
  message = "";
  private epoch = 0;
  private utterance: SpeechSynthesisUtterance | null = null;
  private preferences: Record<string, string> = {};
  private preferenceNotice = "";
  constructor(private changed: () => void) {
    try {
      const stored = JSON.parse(
        localStorage.getItem(voicePreferencesKey) ?? "{}",
      );
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [language, key] of Object.entries(stored)) {
          if (
            /^[a-z]{2,3}$/.test(language) &&
            typeof key === "string" &&
            key.length <= 1000
          )
            this.preferences[language] = key;
        }
      }
    } catch {
      /* Voice preferences do not gate reading. */
    }
  }
  voices(language: string): SpeechSynthesisVoice[] {
    return this.supported
      ? speechSynthesis
          .getVoices()
          .filter(
            (voice) =>
              voice.localService &&
              voice.lang.toLowerCase().split("-")[0] ===
                language.toLowerCase().split("-")[0],
          )
      : [];
  }
  selectedVoice(language: string): SpeechSynthesisVoice | undefined {
    const voices = this.voices(language);
    const saved = this.preferences[language.split("-")[0]];
    if (saved) return voices.find((voice) => voiceKey(voice) === saved);
    return (
      voices.find((voice) => voice.default) ||
      (voices.length === 1 ? voices[0] : undefined)
    );
  }
  voiceNotice(language: string): string {
    if (!language) return "原文の言語を選択してから読み上げてください。";
    if (!this.voices(language).length)
      return "この言語の端末内音声が見つかりません。OSの音声設定で追加してから再試行してください。";
    if (!this.selectedVoice(language))
      return "読み上げ音声を選択してください。音声が不明瞭な場合は別の音声を試せます。";
    if (this.preferenceNotice) return this.preferenceNotice;
    return "選んだ端末内音声で読み上げます。音声の選択は言語ごとにこのブラウザへ保存します。";
  }
  selectVoice(language: string, key: string) {
    if (!this.voices(language).some((voice) => voiceKey(voice) === key)) return;
    this.stop(false);
    this.preferences[language.split("-")[0]] = key;
    this.preferenceNotice = "";
    try {
      localStorage.setItem(
        voicePreferencesKey,
        JSON.stringify(this.preferences),
      );
    } catch {
      this.preferenceNotice =
        "音声を変更しましたが、選択を保存できませんでした。この画面では使用できます。";
    }
    this.changed();
  }
  get supported() {
    return (
      typeof speechSynthesis !== "undefined" &&
      typeof SpeechSynthesisUtterance !== "undefined"
    );
  }
  stop(notify = true) {
    this.epoch++;
    if (this.supported) speechSynthesis.cancel();
    this.utterance = null;
    this.state = "idle";
    this.message = "";
    if (notify) this.changed();
  }
  start(text: string, language: string, rate: number) {
    this.stop(false);
    if (!this.supported) {
      this.message = "このブラウザでは読み上げを利用できません。";
      this.changed();
      return;
    }
    if (!language) {
      this.message = "原文の言語を選択してから読み上げてください。";
      this.changed();
      return;
    }
    const voice = this.selectedVoice(language);
    if (!voice) {
      this.message = this.voiceNotice(language);
      this.changed();
      return;
    }
    const ticket = this.epoch;
    const chunks =
      text.match(/[^。！？.!?\n]{1,180}[。！？.!?\n]*|[。！？.!?\n]+/gu) ?? [];
    let index = 0;
    const next = () => {
      if (ticket !== this.epoch) return;
      if (index >= chunks.length) {
        this.state = "idle";
        this.utterance = null;
        this.message = "読み上げが終わりました。";
        this.changed();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      this.utterance = utterance;
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = rate;
      utterance.onend = next;
      utterance.onerror = () => {
        if (ticket !== this.epoch) return;
        this.stop(false);
        this.message =
          "読み上げに失敗しました。音声設定を確認して再試行してください。";
        this.changed();
      };
      // An end event queued before pause may arrive afterward. Keep the user's
      // pause while queuing subsequent chunks; only explicit start clears it.
      const paused = index > 1 && this.state === "paused";
      this.state = paused ? "paused" : "speaking";
      this.message = paused ? "一時停止中" : "読み上げ中";
      try {
        // cancel() removes queued speech but preserves the engine's paused flag.
        // Resume only on explicit start, after the old queue has been cancelled.
        if (index === 1 && speechSynthesis.paused) speechSynthesis.resume();
        speechSynthesis.speak(utterance);
      } catch {
        this.stop(false);
        this.message =
          "読み上げを開始できませんでした。音声設定を確認して再試行してください。";
      }
      this.changed();
    };
    next();
  }
  togglePause() {
    if (!this.supported || this.state === "idle") return;
    if (this.state === "paused") {
      speechSynthesis.resume();
      this.state = "speaking";
      this.message = "読み上げ中";
    } else {
      speechSynthesis.pause();
      this.state = "paused";
      this.message = "一時停止中";
    }
    this.changed();
  }
}
