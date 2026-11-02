import { describe, expect, it } from "vitest";
import { learningCues } from "../src/learning-cues";

const scan = (text: string) =>
  learningCues(text, [], new AbortController().signal);
describe("source-bound learning cues", () => {
  it("keeps exact Japanese/English excerpts and varied prompts, capped at three", async () => {
    const text =
      "見出し\n\n  観察とは、目の前で起きた変化を丁寧に記録して比べることを意味します。\n\nThe soil stays wet because the shaded surface loses water slowly. However, the sunny patch dries before the other patch does.\n\nFor example, compare two pots placed on different sides of a room.";
    const cues = await scan(text);
    expect(cues.map((c) => c.kind)).toEqual([
      "definition",
      "reason",
      "contrast",
    ]);
    for (const c of cues) expect(text.slice(c.start, c.end)).toBe(c.quote);
    expect(cues[0].start).toBe(text.indexOf("観察とは"));
    expect(cues[1].quote).toBe(
      "The soil stays wet because the shaded surface loses water slowly.",
    );
  });
  it("skips marked inline/block code, URLs, short text and oversized sentences", async () => {
    const code =
      "This is defined as executable code, because it appears inside a code block.";
    const prose =
      "For example, compare two pots placed on different sides of a room.";
    const text =
      code +
      "\n\n" +
      "because ".repeat(100) +
      "\n\nFor example https://example.org/read\n\nとは。\n\n" +
      prose;
    const cues = await learningCues(
      text,
      [{ start: 0, end: code.length, block: false }],
      new AbortController().signal,
    );
    expect(cues.map((c) => c.quote)).toEqual([prose]);
    await expect(
      learningCues(
        text,
        [{ start: 0, end: text.length + 1, block: true }],
        new AbortController().signal,
      ),
    ).rejects.toThrow("本文の範囲");
  });
  it("does not fabricate candidates for unsupported text and cooperatively cancels scans", async () => {
    expect(
      await scan("今日は静かな朝でした。窓を開けて日記を読みました。"),
    ).toEqual([]);
    const controller = new AbortController();
    let batches = 0;
    await expect(
      learningCues(
        "Long neutral sentence without a cue.\n".repeat(8000),
        [],
        controller.signal,
        async () => {
          if (++batches === 2) controller.abort();
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(batches).toBe(2);
  });
  it("deduplicates repeated passages, preserves astral characters and never splits long text", async () => {
    const sentence =
      "😀 For example, this contrast exists because the observer changes the conditions.";
    const cues = await scan(sentence + "\n\n" + sentence);
    expect(cues).toHaveLength(1);
    expect(cues[0].quote).toBe(sentence);
    expect(cues[0].start).toBe(0);
  });
});
