import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { serializeArticle } from "../src/article-serialization";
import {
  safeArticleLink,
  validArticleStructure,
  validArticleInfo,
} from "../src/article-structure";
import { readingMinutes, articleReadingTime } from "../src/reading-time";
import {
  readingFingerprint,
  validReadingPositions,
} from "../src/reading-position";
import { faviconData } from "../src/favicon-data.mjs";
import type { FeedArticle } from "../src/feed-parser";

describe("retained article structure", () => {
  it("maps normalized whitespace and inline code without changing literal code or text", () => {
    const { document } = parseHTML(
      '<article>  <h2> A  😀 <code>x()</code> heading </h2><p>Go <a href="../guide">  to   the 😀 guide </a> now.</p><pre>  a\n    b\n</pre></article>',
    );
    const s = serializeArticle(
      document.querySelector("article") as unknown as Node,
      "https://example.org/posts/one",
    );
    expect(s.text).toBe(
      "A 😀 x() heading \n\nGo to the 😀 guide now.\n\n  a\n    b\n",
    );
    expect(s.codeRanges.map((r) => s.text.slice(r.start, r.end))).toEqual([
      "x()",
      "  a\n    b\n",
    ]);
    expect(
      s.structure.headings.map((h) => s.text.slice(h.start, h.end)),
    ).toEqual(["A 😀 x() heading "]);
    expect(
      s.structure.links.map((h) => [s.text.slice(h.start, h.end), h.href]),
    ).toEqual([["to the 😀 guide ", "https://example.org/guide"]]);
    expect(validArticleStructure(s.text, s.structure)).toBe(true);
  });
  it("refuses executable URLs, sparse, overlapping, split surrogate and out-of-range annotations", () => {
    expect(safeArticleLink("javascript:alert(1)")).toBeNull();
    expect(safeArticleLink("https://user:pass@example.org")).toBeNull();
    expect(safeArticleLink("/docs", "https://example.org/a")).toBe(
      "https://example.org/docs",
    );
    for (const links of [
      new Array(1),
      [{ start: 2, end: 3, href: "https://example.org/" }],
      [{ start: 0, end: 9, href: "https://example.org/" }],
      [{ start: 0, end: 1, href: "javascript:alert(1)" }],
      [
        { start: 0, end: 3, href: "https://example.org/" },
        { start: 1, end: 3, href: "https://example.org/" },
      ],
    ]) {
      expect(
        validArticleStructure("a😀b", { version: 1, links, headings: [] }),
      ).toBe(false);
    }
    expect(validArticleStructure("old", undefined)).toBe(true);
    expect(validArticleInfo({ published: "nonsense" })).toBe(false);
  });
});
it("estimates mixed languages and distinguishes a summary from the full article", () => {
  expect(readingMinutes("学".repeat(1000))).toBe(2);
  expect(readingMinutes("word ".repeat(440))).toBe(2);
  expect(readingMinutes("学".repeat(500) + " word".repeat(220))).toBe(2);
  const article = { body: "summary" } as FeedArticle;
  expect(articleReadingTime(article)).toBe("配信された概要の目安 1分");
  article.content = { text: "summary" } as FeedArticle["content"];
  expect(articleReadingTime(article)).toBe("読了目安 1分");
  expect(
    articleReadingTime({
      body: "Article URL: https://example.org",
    } as FeedArticle),
  ).toContain("本文取得後");
});
it("binds positions to text and language; refuses corrupt ranges", async () => {
  const fingerprint = await readingFingerprint("article", "en");
  expect(await readingFingerprint("article", "ja")).not.toBe(fingerprint);
  expect(await readingFingerprint("new article", "en")).not.toBe(fingerprint);
  expect(
    validReadingPositions({
      original: { fingerprint, offset: 2, furthest: 7, updatedAt: 1 },
    }),
  ).toBe(true);
  expect(
    validReadingPositions({
      original: { fingerprint, offset: 8, furthest: 7, updatedAt: 1 },
    }),
  ).toBe(false);
});
it("allows bounded raster icons but rejects SVG, HTML and oversized content", () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(faviconData(png)).toMatch(/^data:image\/png;base64,/);
  for (const data of [
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    new TextEncoder().encode("<!doctype html>"),
    new Uint8Array(65537),
    new Uint8Array(),
  ])
    expect(() => faviconData(data)).toThrow();
});
