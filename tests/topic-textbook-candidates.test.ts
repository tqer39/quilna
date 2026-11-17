import { expect, it } from "vitest";
import {
  topicTextbookCandidates,
  type TextbookChoice,
} from "../src/topic-textbook-candidates";

const choice = (
  name: string,
  id = "a",
  version = 1,
  topicId = id,
): TextbookChoice => ({
  target: {
    id: `${id}:${version}`,
    digest: "a".repeat(64),
    title: name + "の教材",
    topicId,
    topicName: name,
  },
  goal: name + "を学ぶ",
});
it("日本語・大小文字・記号を文字通り照合し、別の語の一部分を英単語としない", () => {
  const choices = [
    choice("非同期処理"),
    choice("CAA", "b"),
    choice("C++", "c"),
    choice("AI", "d"),
  ];
  const text =
    "非同期処理を確認し、caaの設定とC++を深掘りする。mailとCAAbやéCAAは別の語。";
  const found = topicTextbookCandidates(text, choices);
  expect(found.map((c) => c.choice.target.topicName)).toEqual([
    "非同期処理",
    "CAA",
    "C++",
  ]);
  for (const c of found) expect(text).toContain(c.quote);
  expect(
    topicTextbookCandidates("mail CAAb éCAA", [
      choice("AI"),
      choice("CAA", "b"),
    ]),
  ).toEqual([]);
});
it("同じ教材では最新の利用可能版を使い、同名の異なるテーマを統合しない", () => {
  const found = topicTextbookCandidates("CAAの運用", [
    choice("CAA", "a", 1),
    choice("CAA", "a", 2),
    choice("CAA", "b", 1),
  ]);
  expect(found.map((c) => c.choice.target.id)).toEqual(["a:2", "b:1"]);
});
it("テーマごとの候補を少数にし、一致する教材がなければ作り出さない", () => {
  const found = topicTextbookCandidates("非同期処理、CAA、C++、Rust", [
    choice("非同期処理"),
    choice("CAA", "b"),
    choice("C++", "c"),
    choice("Rust", "d"),
    choice("CAA", "e", 1, "b"),
  ]);
  expect(found).toHaveLength(3);
  expect(new Set(found.map((c) => c.choice.target.topicId)).size).toBe(3);
  expect(found.map((c) => c.choice.target.id)).toEqual(["a:1", "d:1", "b:1"]);
  expect(
    topicTextbookCandidates("関係する名前はない", [choice("CAA")]),
  ).toEqual([]);
});
it("本文の後半の一致も照合し、抜粋で絵文字を分断しない", () => {
  const text = "資料📚".repeat(10000) + "CAAの運用" + "📚資料".repeat(80);
  const [c] = topicTextbookCandidates(text, [choice("CAA")]);
  expect(c.offset).toBeGreaterThan(20000);
  expect(text).toContain(c.quote);
  expect(/[\uD800-\uDFFF]/u.test(c.quote)).toBe(false);
});
