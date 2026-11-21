import { effectiveTags } from "./article-tags";
import type { FeedArticle } from "./feed-parser";

const normalize = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase();

export function interestWords(input: string) {
  const words = [
    ...new Set(
      input.normalize("NFKC").split(/[,、]/u).map(normalize).filter(Boolean),
    ),
  ];
  if (words.length > 8 || words.some((word) => [...word].length > 40))
    throw Error(
      "関心のある言葉は8個まで、1個につき40文字以内で入力してください。",
    );
  return words;
}

/** 一覧のページ送りから独立して、新しい未読記事から順に選ぶ。 */
export function interestHeadlines(
  library: readonly FeedArticle[],
  words: readonly string[],
) {
  const result: FeedArticle[] = [];
  if (!words.length) return result;
  for (const article of library) {
    if (article.read) continue;
    const title = normalize(article.content?.title || article.title);
    if (
      !words.some((word) => title.includes(word)) &&
      !effectiveTags(article).some((tag) => words.includes(normalize(tag)))
    )
      continue;
    result.push(article);
    if (result.length === 50) break;
  }
  return result;
}
