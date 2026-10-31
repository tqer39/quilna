import { articleLanguage } from "./reader-preferences";

interface LanguageSession {
  detect(
    text: string,
  ): Promise<{ detectedLanguage: string; confidence: number }[]>;
  destroy(): void;
}
interface LanguageFactory {
  availability(): Promise<string>;
  create(options: {
    signal: AbortSignal;
    monitor: (monitor: EventTarget) => void;
  }): Promise<LanguageSession>;
}
export function browserLanguageDetector(): LanguageFactory | undefined {
  return (
    globalThis as typeof globalThis & { LanguageDetector?: LanguageFactory }
  ).LanguageDetector;
}
export async function detectArticleLanguage(
  text: string,
  signal: AbortSignal,
  progress: (message: string) => void,
  automatic: boolean,
): Promise<string> {
  const factory = browserLanguageDetector();
  if (!factory)
    throw Error(
      "原文の言語を判定できません。このブラウザは端末内の言語判定に対応していないため、言語を選択してください。",
    );
  if (text.trim().length < 80)
    throw Error(
      "本文が短いため言語を確実に判定できません。原文の言語を選択してください。",
    );
  if (automatic && !navigator.userActivation?.isActive) {
    const availability = await factory.availability();
    signal.throwIfAborted();
    if (availability !== "available")
      throw Error(
        "言語判定データの準備が必要です。「原文の言語を判定」を押すか、言語を選択してください。",
      );
  }
  // Preserve the click activation for a first model download.
  const detector = await factory.create({
    signal,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        progress(
          `言語判定データを準備中… ${Math.round((event as Event & { loaded: number }).loaded * 100)}%`,
        );
      });
    },
  });
  const abort = () => detector.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    // Require agreement across the beginning, middle and end. Mixed/uncertain
    // content remains unknown rather than being silently treated as English.
    const starts = [
      ...new Set([
        0,
        Math.max(0, Math.floor(text.length / 2) - 1000),
        Math.max(0, text.length - 2000),
      ]),
    ];
    let language = "";
    for (const start of starts) {
      const [result] = await detector.detect(text.slice(start, start + 2000));
      signal.throwIfAborted();
      const candidate = articleLanguage(result?.detectedLanguage);
      if (
        !candidate ||
        !Number.isFinite(result?.confidence) ||
        result.confidence < 0.8 ||
        (language && language !== candidate)
      )
        throw Error(
          "原文の言語を確実に判定できません。複数言語が混在する場合も、読みたい原文の言語を選択してください。",
        );
      language = candidate;
    }
    return language;
  } finally {
    signal.removeEventListener("abort", abort);
    detector.destroy();
  }
}
