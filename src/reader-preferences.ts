export const readerLanguages = [
  ["ja", "日本語"],
  ["en", "英語"],
  ["zh", "中国語"],
  ["ko", "韓国語"],
  ["fr", "フランス語"],
  ["de", "ドイツ語"],
  ["es", "スペイン語"],
  ["pt", "ポルトガル語"],
] as const;
export const readerLocales = [
  ["ja-JP", "日本語（日本）"],
  ["en-US", "英語（米国）"],
  ["en-GB", "英語（英国）"],
  ["zh-CN", "中国語（中国）"],
  ["zh-TW", "中国語（台湾）"],
  ["ko-KR", "韓国語（韓国）"],
  ["fr-FR", "フランス語（フランス）"],
  ["de-DE", "ドイツ語（ドイツ）"],
  ["es-ES", "スペイン語（スペイン）"],
  ["pt-BR", "ポルトガル語（ブラジル）"],
  ["pt-PT", "ポルトガル語（ポルトガル）"],
] as const;
export const readerPreferencesKey = "quilna.reader.preferences.v1";
export type ReaderPreferences = { targetLanguage: string; automatic: boolean };
export function languageName(code: string): string {
  return readerLanguages.find(([value]) => value === code)?.[1] ?? code;
}
export function articleLanguage(language: string | undefined): string {
  const base = language?.toLowerCase().split("-")[0];
  return readerLanguages.some(([code]) => code === base) ? base! : "";
}
export function readReaderPreferences(): ReaderPreferences {
  const fallback = { targetLanguage: "browser", automatic: false };
  try {
    const saved = JSON.parse(
      localStorage.getItem(readerPreferencesKey) ?? "null",
    );
    if (
      !saved ||
      (saved.targetLanguage !== "browser" &&
        !readerLanguages.some(([code]) => code === saved.targetLanguage) &&
        !readerLocales.some(([code]) => code === saved.targetLanguage)) ||
      typeof saved.automatic !== "boolean"
    )
      return fallback;
    return { targetLanguage: saved.targetLanguage, automatic: saved.automatic };
  } catch {
    return fallback;
  }
}

export function browserTargetLanguage(): string {
  // Respect the first browser preference; do not silently use a different language.
  return articleLanguage(browserLocale());
}
export function browserLocale(): string {
  return navigator.languages?.[0] || navigator.language || "";
}
export function localeFor(preferences: ReaderPreferences): string {
  return preferences.targetLanguage === "browser"
    ? browserLocale()
    : preferences.targetLanguage;
}
export function targetLanguageFor(preferences: ReaderPreferences): string {
  return articleLanguage(localeFor(preferences));
}
export function speechLocaleFor(
  preferences: ReaderPreferences,
  displayedLanguage: string,
): string {
  if (!displayedLanguage) return "";
  const locale = localeFor(preferences);
  return articleLanguage(locale) === displayedLanguage
    ? locale
    : displayedLanguage;
}
