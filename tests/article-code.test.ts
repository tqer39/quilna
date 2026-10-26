import { afterEach, describe, expect, it, vi } from "vitest";
import { validCodeRanges } from "../src/article-code";
import { translateArticle } from "../src/article-content";

afterEach(() => vi.unstubAllGlobals());
describe("saved code boundaries", () => {
  it("keeps legacy records valid but refuses overlapping, out-of-bounds and split Unicode ranges", () => {
    expect(validCodeRanges("a😀b", undefined)).toBe(true);
    expect(validCodeRanges("a😀b", [{ start: 1, end: 3, block: false }])).toBe(
      true,
    );
    for (const ranges of [
      new Array(1),
      null,
      {},
      [{ start: 0, end: 5, block: true }],
      [{ start: 2, end: 3, block: false }],
      [{ start: 0, end: 2, block: false }],
      [{ start: 1, end: 1, block: false }],
      [
        { start: 0, end: 3, block: true },
        { start: 2, end: 4, block: false },
      ],
    ]) {
      expect(validCodeRanges("a😀b", ranges)).toBe(false);
    }
  });
});
it("preserves long code exactly and translates only surrounding prose with valid output offsets", async () => {
  const translate = vi.fn(async (value: string) => `日本語:${value}`);
  const destroy = vi.fn();
  vi.stubGlobal("Translator", { create: async () => ({ translate, destroy }) });
  const code = '  const exact = "😀 <tag>";\n'.repeat(160);
  const text = `Before.\n\n${code}\n\nAfter.`;
  const result = await translateArticle(
    text,
    "en",
    "ja",
    new AbortController().signal,
    () => {},
    false,
    [{ start: 9, end: 9 + code.length, block: true }],
  );
  expect(translate.mock.calls.map(([value]) => value)).toEqual([
    "Before.",
    "After.",
  ]);
  expect(result.sourceText).toBe(text);
  expect(result.text).toBe(`日本語:Before.\n\n${code}\n\n日本語:After.`);
  expect(validCodeRanges(result.text, result.codeRanges)).toBe(true);
  const range = result.codeRanges![0];
  expect(result.text.slice(range.start, range.end)).toBe(code);
  expect(destroy).toHaveBeenCalledOnce();
});
it("does not return a partial translation or code ranges after cancellation", async () => {
  const controller = new AbortController();
  const destroy = vi.fn();
  vi.stubGlobal("Translator", {
    create: async () => ({
      translate: async () => {
        controller.abort();
        return "遅い結果";
      },
      destroy,
    }),
  });
  await expect(
    translateArticle(
      "Some text. code()",
      "en",
      "ja",
      controller.signal,
      () => {},
      false,
      [{ start: 11, end: 17, block: false }],
    ),
  ).rejects.toThrow();
  expect(destroy).toHaveBeenCalled();
});
