import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArticleSpeech } from "../src/article-speech";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
it("uses the matching local default voice rather than the first installed voice", () => {
  const voices = [
    {
      name: "Novelty",
      voiceURI: "novelty",
      lang: "en-US",
      localService: true,
      default: false,
    },
    {
      name: "Natural",
      voiceURI: "natural",
      lang: "en-US",
      localService: true,
      default: true,
    },
    {
      name: "Remote",
      voiceURI: "remote",
      lang: "en-US",
      localService: false,
      default: true,
    },
  ];
  const speak = vi.fn();
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voices,
    cancel: vi.fn(),
    speak,
    paused: false,
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(public text: string) {}
    },
  );
  const speech = new ArticleSpeech(() => {});
  speech.start("This is a spoken sentence.", "en", 1);
  expect(speak).toHaveBeenCalledOnce();
  expect(speak.mock.calls[0][0].voice).toBe(voices[1]);
});
it("requires a choice for multiple non-default voices and retains that choice across reload", () => {
  const voices = [
    {
      name: "First",
      voiceURI: "first",
      lang: "en-US",
      localService: true,
      default: false,
    },
    {
      name: "Second",
      voiceURI: "second",
      lang: "en-GB",
      localService: true,
      default: false,
    },
  ];
  const speak = vi.fn();
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voices,
    cancel: vi.fn(),
    speak,
    paused: false,
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(public text: string) {}
    },
  );
  const speech = new ArticleSpeech(() => {});
  speech.start("English text.", "en", 1);
  expect(speak).not.toHaveBeenCalled();
  expect(speech.message).toContain("読み上げ音声を選択");
  speech.selectVoice("en", "second");
  const reopened = new ArticleSpeech(() => {});
  reopened.start("English text.", "en", 1);
  expect(speak.mock.calls[0][0].voice).toBe(voices[1]);
  expect(speak.mock.calls[0][0].lang).toBe("en-GB");
  voices.pop();
  reopened.stop();
  speak.mockClear();
  reopened.start("English text.", "en", 1);
  expect(speak).not.toHaveBeenCalled();
  expect(reopened.message).toContain("読み上げ音声を選択");
});
it("rejects network or wrong-language choices, and reports persistence failure without blocking a local choice", () => {
  const voices = [
    {
      name: "Local",
      voiceURI: "local",
      lang: "en-US",
      localService: true,
      default: false,
    },
    {
      name: "Remote",
      voiceURI: "remote",
      lang: "en-US",
      localService: false,
      default: true,
    },
    {
      name: "Japanese",
      voiceURI: "ja",
      lang: "ja-JP",
      localService: true,
      default: true,
    },
  ];
  const speak = vi.fn();
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => voices,
    cancel: vi.fn(),
    speak,
    paused: false,
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(public text: string) {}
    },
  );
  const speech = new ArticleSpeech(() => {});
  speech.selectVoice("en", "remote");
  speech.selectVoice("en", "ja");
  expect(localStorage.getItem("quilna.reader.voices.v1")).toBeNull();
  localStorage.setItem = () => {
    throw Error("quota");
  };
  speech.selectVoice("en", "local");
  expect(speech.voiceNotice("en")).toContain("選択を保存できません");
  speech.start("English text.", "en", 1);
  expect(speak.mock.calls[0][0].voice).toBe(voices[0]);
  speech.stop();
  voices.pop(); // Japanese voice disappears after an unrelated save failure.
  speak.mockClear();
  speech.start("日本語の本文です。", "ja", 1);
  expect(speak).not.toHaveBeenCalled();
  expect(speech.message).toContain("端末内音声が見つかりません");
});
