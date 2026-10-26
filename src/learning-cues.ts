import { validCodeRanges, type ArticleCodeRange } from "./article-code";

export type LearningCue = {
  start: number;
  end: number;
  quote: string;
  kind: string;
  label: string;
  prompt: string;
};
const rules = [
  {
    kind: "definition",
    label: "言葉の意味をつかむ",
    pattern:
      /とは|と呼(?:ぶ|ばれ)|を意味|\b(?:means?|refers? to|is defined as)\b/i,
    prompt: "この説明を自分の言葉で言い換えると？具体例を一つ挙げられますか？",
  },
  {
    kind: "reason",
    label: "理由や条件を確かめる",
    pattern: /理由|ため|ので|その結果|\b(?:because|therefore|as a result)\b/i,
    prompt:
      "この理由が成り立つ条件は何でしょう？条件が変わるとどうなりそうですか？",
  },
  {
    kind: "contrast",
    label: "違いから考える",
    pattern:
      /一方|しかし|対して|異な|\b(?:however|whereas|unlike|in contrast)\b/i,
    prompt: "何と何を、どの観点で比べていますか？共通点もあるでしょうか？",
  },
  {
    kind: "example",
    label: "具体例から広げる",
    pattern: /例えば|たとえば|具体例|\b(?:for example|for instance|such as)\b/i,
    prompt:
      "この例から何を説明しようとしていますか？別の例にも当てはまりますか？",
  },
] as const;

// Exact UTF-16 excerpts, not summaries or assertions about truth/understanding.
// Only invoked when the optional panel is opened; never scans the article library.
export async function learningCues(
  text: string,
  ranges: ArticleCodeRange[] | undefined,
  signal: AbortSignal,
  yieldBatch = () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
): Promise<LearningCue[]> {
  if (text.length > 400000 || !validCodeRanges(text, ranges))
    throw Error("本文の範囲を確認できないため、候補を表示できません。");
  const chosen = new Map<string, LearningCue>();
  const seen = new Set<string>();
  let scanned = 0;
  let codeIndex = 0;
  const code = ranges ?? [];
  for (const line of text.matchAll(/[^\n]+/g)) {
    const boundaries = [0];
    for (const end of line[0].matchAll(/[。！？]|[.!?](?=\s|$)/g))
      boundaries.push(end.index + 1);
    if (boundaries.at(-1) !== line[0].length) boundaries.push(line[0].length);
    for (let i = 1; i < boundaries.length; i++) {
      if (scanned++ % 200 === 0) {
        await yieldBatch();
        signal.throwIfAborted();
      }
      const raw = line[0].slice(boundaries[i - 1], boundaries[i]);
      const quote = raw.trim();
      const start =
        line.index + boundaries[i - 1] + raw.length - raw.trimStart().length;
      const end = start + quote.length;
      while (codeIndex < code.length && code[codeIndex].end <= start)
        codeIndex++;
      // Skip whole sentences containing marked code; never splice prose across it.
      if (
        code[codeIndex]?.start < end ||
        quote.length < 24 ||
        quote.length > 600
      )
        continue;
      if (/https?:\/\/|www\.|```/.test(quote)) continue;
      const rule = rules.find(
        (r) => !chosen.has(r.kind) && r.pattern.test(quote),
      );
      const key = quote.replace(/\s+/g, " ").toLocaleLowerCase();
      if (!rule || seen.has(key)) continue;
      seen.add(key);
      chosen.set(rule.kind, {
        start,
        end,
        quote,
        kind: rule.kind,
        label: rule.label,
        prompt: rule.prompt,
      });
      if (chosen.size === 3) return Array.from(chosen.values());
    }
  }
  signal.throwIfAborted();
  return Array.from(chosen.values());
}
