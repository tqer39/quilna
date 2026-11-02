import type { FeedArticle } from "./feed-parser";

export const tagRules = [
  {
    tag: "技術・開発",
    terms: [
      "react",
      "python",
      "swift",
      "flutter",
      "webassembly",
      "wasm",
      "sre",
      "コード",
      "エンジニア",
      "実装",
      "programming",
      "software",
      "developer",
      "database",
      "sqlite",
      "typescript",
      "javascript",
      "github",
      "api",
      "プログラミング",
      "ソフトウェア",
      "開発",
      "データベース",
    ],
  },
  {
    tag: "AI・機械学習",
    terms: [
      "ai",
      "claude code",
      "codex",
      "chatgpt",
      "qwen",
      "artificial intelligence",
      "machine learning",
      "neural network",
      "llm",
      "generative ai",
      "人工知能",
      "機械学習",
      "生成ai",
      "大規模言語モデル",
    ],
  },
  {
    tag: "科学・研究",
    terms: [
      "research",
      "experiment",
      "scientific",
      "peer reviewed",
      "研究",
      "実験",
      "科学",
      "論文",
      "査読",
    ],
  },
  {
    tag: "ビジネス・経済",
    terms: [
      "economy",
      "revenue",
      "investment",
      "startup",
      "earnings",
      "経済",
      "投資",
      "売上",
      "企業",
      "起業",
      "決算",
    ],
  },
  {
    tag: "暮らし・健康",
    terms: [
      "health",
      "nutrition",
      "exercise",
      "cooking",
      "parenting",
      "健康",
      "栄養",
      "運動",
      "料理",
      "子育て",
      "暮らし",
    ],
  },
  {
    tag: "手順・解説",
    terms: [
      "tutorial",
      "step by step",
      "how to",
      "walkthrough",
      "チュートリアル",
      "手順",
      "入門",
      "解説",
      "使い方",
      "作り方",
    ],
  },
  {
    tag: "レビュー",
    terms: [
      "review",
      "hands on",
      "pros and cons",
      "レビュー",
      "使用感",
      "使ってみた",
      "比較",
      "評価",
    ],
  },
  {
    tag: "ニュース",
    terms: [
      "announced",
      "announcement",
      "breaking news",
      "launched",
      "発表",
      "速報",
      "リリース",
      "報道",
      "ニュース",
    ],
  },
] as const;
export type ArticleTags = {
  version: 1 | 2;
  state: "classified" | "unclassified" | "no-content";
  suggestions: { tag: string; evidence: string[] }[];
};
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
export function normalizeManualTags(values: string[]): string[] {
  const tags = [
    ...new Set(values.map((value) => normalize(value).trim()).filter(Boolean)),
  ];
  if (
    tags.length > 12 ||
    tags.some((tag) => tag.length > 30 || /[\n\r,、]/u.test(tag))
  )
    throw Error(
      "タグは1件30文字以内、最大12件で入力してください。カンマや改行は区切りに使います。",
    );
  // Keep the canonical capitalization of built-in labels.
  return tags.map(
    (tag) => tagRules.find((rule) => normalize(rule.tag) === tag)?.tag ?? tag,
  );
}
export function publisherTags(article: FeedArticle): string[] {
  return [
    ...new Set([
      ...(article.sourceTags ?? []),
      ...(article.content?.sourceTags ?? []),
    ]),
  ];
}
export function effectiveTags(article: FeedArticle): string[] {
  return [
    ...new Set([
      ...publisherTags(article),
      ...(article.tags?.suggestions.map((item) => item.tag) ?? []),
      ...(article.manualTags ?? []),
    ]),
  ];
}
export function needsTagClassification(article: FeedArticle) {
  return !article.tags || article.tags.version !== 2;
}
export function tagSummary(article: FeedArticle): string {
  const source = publisherTags(article);
  const automatic = article.tags?.suggestions.map((item) => item.tag) ?? [];
  return [
    `配信元：${source.join("・") || "タグ情報なし"}`,
    `Quilnaの自動判定：${automatic.join("・") || (!article.tags ? "未処理" : article.tags.state === "no-content" ? "手掛かりとなる本文なし" : "手掛かり不足")}${article.tags?.version === 1 ? "（分類更新待ち）" : ""}`,
    `自分のタグ：${article.manualTags?.join("・") || "未設定"}`,
  ].join("\n");
}
export function tagState(article: FeedArticle): string {
  if (article.manualTags !== undefined) return "手動設定";
  if (!article.tags) return "未処理";
  return {
    classified: "自動判定",
    unclassified: "分類できず",
    "no-content": "本文なし",
  }[article.tags.state];
}
const patterns = tagRules.map((rule) => ({
  tag: rule.tag,
  terms: rule.terms.map((term) => ({
    term,
    // Latin words need boundaries: "api" in "capital" is not evidence.
    pattern: new RegExp(
      `${/^[a-z]/i.test(term) ? "(?<![a-z0-9])" : ""}${term}${/[a-z]$/i.test(term) ? "(?![a-z0-9])" : ""}`,
      "u",
    ),
  })),
}));
export function classifyArticle(article: FeedArticle): ArticleTags {
  const original = article.content?.text || article.body;
  const hasContent =
    !!original.trim() && !/^Article URL:\s*https?:\/\//i.test(original.trim());
  const title = normalize(article.content?.title || article.title);
  const translation =
    article.translation?.sourceText === original
      ? article.translation.text
      : "";
  const body = hasContent ? normalize(`${original}\n${translation}`) : "";
  const source = publisherTags(article).map(normalize);
  const suggestions: ArticleTags["suggestions"] = [];
  for (const rule of patterns) {
    const evidence: string[] = [];
    let score = 0;
    for (const { term, pattern } of rule.terms) {
      const inTitle = pattern.test(title);
      const inSource = source.some((tag) => pattern.test(tag));
      if (inTitle || inSource || pattern.test(body)) {
        if (evidence.length < 20)
          evidence.push(inSource && !inTitle ? `配信元:${term}` : term);
        score += inTitle || inSource ? 2 : 1;
      }
    }
    // A title clue or two distinct body clues; repetition alone does not count.
    if (score >= 2) suggestions.push({ tag: rule.tag, evidence });
  }
  return {
    version: 2,
    state: suggestions.length
      ? "classified"
      : hasContent
        ? "unclassified"
        : "no-content",
    suggestions,
  };
}
export function validManualTags(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every(
      (tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 30,
    )
  );
}
export function validArticleTags(value: unknown): value is ArticleTags {
  if (!value || typeof value !== "object") return false;
  const tags = value as ArticleTags;
  return (
    (tags.version === 1 || tags.version === 2) &&
    ["classified", "unclassified", "no-content"].includes(tags.state) &&
    Array.isArray(tags.suggestions) &&
    tags.suggestions.length <= tagRules.length &&
    tags.suggestions.every(
      (item) =>
        item &&
        tagRules.some((rule) => rule.tag === item.tag) &&
        Array.isArray(item.evidence) &&
        item.evidence.length <= 20 &&
        item.evidence.every(
          (term) => typeof term === "string" && term.length <= 40,
        ),
    )
  );
}
