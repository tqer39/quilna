import type { TextbookLink } from "./article-textbooks";

export type TextbookChoice = { target: TextbookLink["target"]; goal: string };
export type TopicTextbookCandidate = {
  choice: TextbookChoice;
  matched: string;
  quote: string;
  offset: number;
};
export const topicCandidateLimit = 3;

/** 単なるテーマ名の一致として原文を示し、意味理解や事実の裏付けとは扱わない。 */
export function topicTextbookCandidates(
  text: string,
  choices: readonly TextbookChoice[],
): TopicTextbookCandidate[] {
  const latest = new Map<string, TextbookChoice>();
  for (const choice of choices) {
    const [id, version] = choice.target.id.split(":");
    const old = latest.get(id);
    if (!old || Number(version) > Number(old.target.id.split(":")[1]))
      latest.set(id, choice);
  }
  const candidates: TopicTextbookCandidate[] = [];
  const latin = /[\p{Script=Latin}\p{Number}\p{Mark}_]/u;
  for (const choice of latest.values()) {
    const name = choice.target.topicName.trim();
    if (!name) continue;
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = latin.test(Array.from(name)[0])
      ? "(?<![\\p{Script=Latin}\\p{Number}\\p{Mark}_])"
      : "";
    const after = latin.test(Array.from(name).at(-1)!)
      ? "(?![\\p{Script=Latin}\\p{Number}\\p{Mark}_])"
      : "";
    const match = new RegExp(before + literal + after, "iu").exec(text);
    if (!match) continue;
    let start = Math.max(0, match.index - 80),
      end = Math.min(text.length, match.index + match[0].length + 80);
    // 抜粋の境界で補助平面文字を切断しない。
    if (
      start &&
      /[\uDC00-\uDFFF]/.test(text[start]) &&
      /[\uD800-\uDBFF]/.test(text[start - 1])
    )
      start--;
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/.test(text[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[end])
    )
      end++;
    candidates.push({
      choice,
      matched: match[0],
      quote: text.slice(start, end),
      offset: match.index,
    });
  }
  candidates.sort(
    (a, b) =>
      b.matched.length - a.matched.length ||
      a.offset - b.offset ||
      a.choice.target.id.localeCompare(b.choice.target.id),
  );
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (seen.has(c.choice.target.topicId)) return false;
      seen.add(c.choice.target.topicId);
      return true;
    })
    .slice(0, topicCandidateLimit);
}
