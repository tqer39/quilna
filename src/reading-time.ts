import { isLinkOnly } from "./article-content";
import type { FeedArticle } from "./feed-parser";
// An explicit estimate, not a measured personal reading speed.
export function readingMinutes(text: string): number {
  const cjk = (
    text.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ) ?? []
  ).length;
  const words = (
    text
      .replace(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        " ",
      )
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  ).length;
  return Math.max(1, Math.ceil(cjk / 500 + words / 220));
}
const estimates = new WeakMap<
  FeedArticle,
  { text: string; full: boolean; label: string }
>();
export function articleReadingTime(article: FeedArticle): string {
  const text = article.content?.text || article.body;
  if (!text.trim() || (!article.content && isLinkOnly(text)))
    return "読了時間：本文取得後に表示";
  const old = estimates.get(article);
  if (old?.text === text && old.full === !!article.content) return old.label;
  const label = `${article.content ? "読了目安" : "配信された概要の目安"} ${readingMinutes(text)}分`;
  estimates.set(article, { text, full: !!article.content, label });
  return label;
}
