import { afterEach, expect, it, vi } from "vitest";
import {
  readReaderPreferences,
  targetLanguageFor,
  speechLocaleFor,
} from "../src/reader-preferences";

afterEach(() => vi.unstubAllGlobals());
it("uses the first browser locale by default and follows language changes", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("navigator", {
    languages: ["en-GB", "ja-JP"],
    language: "en-GB",
  });
  const settings = readReaderPreferences();
  expect(settings).toEqual({ targetLanguage: "browser", automatic: false });
  expect(targetLanguageFor(settings)).toBe("en");
  expect(speechLocaleFor(settings, "en")).toBe("en-GB");
  expect(speechLocaleFor(settings, "ja")).toBe("ja");
  vi.stubGlobal("navigator", { languages: ["xx-ZZ", "ja-JP"] });
  expect(targetLanguageFor(settings)).toBe("");
  expect(speechLocaleFor(settings, "")).toBe("");
});
it("retains explicit legacy and regional settings and safely handles unavailable storage", () => {
  for (const locale of ["ja", "fr", "en-US", "en-GB"]) {
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({ targetLanguage: locale, automatic: true }),
    });
    expect(readReaderPreferences()).toEqual({
      targetLanguage: locale,
      automatic: true,
    });
  }
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error("denied");
    },
  });
  expect(readReaderPreferences().targetLanguage).toBe("browser");
});
