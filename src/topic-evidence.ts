import type { TopicEvidence } from "./topic-preparation-protocol";
const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
const generic = new Set([
  "について",
  "とは",
  "仕組み",
  "基本",
  "理解",
  "学ぶ",
  "知りたい",
  "教科書",
  "する",
  "こと",
  "ため",
]);
/** 空白のない日本語も語に分ける。関連性の判定は単語一致であり、内容検証ではない。 */
export function topicTerms(topic: string) {
  const words = [
    ...new Intl.Segmenter("ja", { granularity: "word" }).segment(
      normalize(topic),
    ),
  ]
    .filter(
      (s) =>
        s.isWordLike &&
        (Array.from(s.segment).length >= 2 ||
          /^[a-z]$/.test(s.segment) ||
          /^\p{Script=Han}$/u.test(s.segment)) &&
        !generic.has(s.segment),
    )
    .map((s) => s.segment);
  return [...new Set(words)].slice(0, 8);
}
function includes(text: string, term: string) {
  if (/^[a-z0-9]+$/.test(term)) {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_])${safe}($|[^a-z0-9_])`, "u").test(text);
  }
  return text.includes(term);
}
const bytes = (s: string) => {
  const n = s.codePointAt(0)!;
  return n <= 127 ? 1 : n <= 2047 ? 2 : n <= 65535 ? 3 : 4;
};
/** 境界で語が欠けないよう重なりを持たせ、原文の連続した範囲だけを候補にする。 */
export function evidenceExcerpt(text: string, title: string, terms: string[]) {
  const chars = Array.from(text);
  const sizes = chars.map(bytes);
  let start = 0,
    best: { excerpt: string; score: number; matchedTerms: string[] } | null =
      null;
  const titleScore =
    terms.filter((t) => includes(normalize(title), t)).length * 5;
  while (start < chars.length) {
    let end = start,
      size = 0;
    while (end < chars.length && size + sizes[end] <= 6000)
      size += sizes[end++];
    const excerpt = chars.slice(start, end).join("").trim();
    const normalized = normalize(excerpt);
    const matchedTerms = terms.filter((t) => includes(normalized, t));
    const score = matchedTerms.length * 10 + titleScore;
    if (matchedTerms.length && (!best || score > best.score))
      best = { excerpt, score, matchedTerms };
    if (end === chars.length) break;
    let overlap = 0,
      next = end;
    while (next > start && overlap + sizes[next - 1] <= 1024)
      overlap += sizes[--next];
    start = Math.max(start + 1, next);
  }
  return best;
}
/** 同じ文書の再取得は重複採用せず、候補を最大3件に絞る。 */
export function bestTopicEvidence(values: TopicEvidence[]) {
  const unique = new Map<string, TopicEvidence>();
  for (const value of values) {
    const old = unique.get(value.documentId);
    if (!old || value.score > old.score) unique.set(value.documentId, value);
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.source.url! < b.source.url!
          ? -1
          : a.source.url! > b.source.url!
            ? 1
            : 0),
    )
    .slice(0, 3);
}
