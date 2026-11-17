import { expect, it } from "vitest";
import { textbookWordLinks } from "../src/textbook-word-links";

it("技術語をそのままリンクし、英単語の部分一致と繰り返しを避ける", () => {
  const text = "mailから非同期処理を調べる。CAAとcaa、C++を読む。";
  const links = textbookWordLinks(text, [
    { label: "AI", href: "/ai" },
    { label: "非同期処理", href: "/async" },
    { label: "CAA", href: "/caa" },
    { label: "C++", href: "/cpp" },
  ]);
  expect(links.map((l) => [text.slice(l.start, l.end), l.href])).toEqual([
    ["非同期処理", "/async"],
    ["CAA", "/caa"],
    ["C++", "/cpp"],
  ]);
});
it("コードと出典リンクの外にある最初の語を使う", () => {
  const text = "CAA https://example.org/CAA 本文のCAAを読む。";
  const links = textbookWordLinks(
    text,
    [{ label: "CAA", href: "/book" }],
    [
      { start: 0, end: 3 },
      { start: 4, end: 27 },
    ],
  );
  expect(links).toEqual([
    {
      start: text.lastIndexOf("CAA"),
      end: text.lastIndexOf("CAA") + 3,
      href: "/book",
    },
  ]);
});
it("名称が重なる場合は長い語を使い、同じ語の異なる行き先を勝手に選ばない", () => {
  const text = "非同期処理の基本とCAA";
  expect(
    textbookWordLinks(text, [
      { label: "非同期", href: "/short" },
      { label: "非同期処理", href: "/long" },
      { label: "CAA", href: "/one" },
      { label: "caa", href: "/two" },
    ]),
  ).toEqual([{ start: 0, end: 5, href: "/long" }]);
});
it("リンクがない本文に教材や生成操作を作り出さない", () => {
  expect(
    textbookWordLinks("教材に一致する語はない", [
      { label: "CAA", href: "/caa" },
    ]),
  ).toEqual([]);
});
it("本文後半も調べ、リンクを本文順の30語までに抑える", () => {
  const labels = Array.from(
    { length: 40 },
    (_, i) => `word${String(i).padStart(2, "0")}`,
  );
  const text = "資料📚".repeat(10000) + labels.join(" ");
  const links = textbookWordLinks(
    text,
    labels.map((label) => ({ label, href: "/" + label })).reverse(),
  );
  expect(links.map((l) => text.slice(l.start, l.end))).toEqual(
    labels.slice(0, 30),
  );
});

it("長い名称に含まれる短い語も、後の独立した出現からリンクする", () => {
  const text = "C++とCを比較する";
  expect(
    textbookWordLinks(text, [
      { label: "C", href: "/c" },
      { label: "C++", href: "/cpp" },
    ]),
  ).toEqual([
    { start: 0, end: 3, href: "/cpp" },
    { start: 4, end: 5, href: "/c" },
  ]);
});

it("カタカナ語の途中と別の一文字言語名にはリンクを付けない", () => {
  const text = "キーボードのキーとC#、C++、Cを読む。";
  expect(
    textbookWordLinks(text, [
      { label: "キー", href: "/key" },
      { label: "C", href: "/c" },
    ]),
  ).toEqual([
    {
      start: text.lastIndexOf("キー"),
      end: text.lastIndexOf("キー") + 2,
      href: "/key",
    },
    {
      start: text.lastIndexOf("C"),
      end: text.lastIndexOf("C") + 1,
      href: "/c",
    },
  ]);
});
it("句読点を自動リンクの語として扱わず、技術用語のC・R・πは残す", () => {
  const text = "CとR、πを読む。";
  const links = textbookWordLinks(text, [
    { label: "。", href: "/punctuation" },
    { label: "C", href: "/c" },
    { label: "R", href: "/r" },
    { label: "π", href: "/pi" },
  ]);
  expect(links.map((l) => text.slice(l.start, l.end))).toEqual(["C", "R", "π"]);
});
