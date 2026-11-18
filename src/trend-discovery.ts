export const trendSources = [
  {
    id: "google",
    name: "Google Trends",
    url: "https://trends.google.com/trending?geo=JP",
    endpoint: "https://trends.google.com/trending/rss?geo=JP",
    scope: "日本の検索キーワード / RSSの掲載順。集計期間はRSSに未記載。",
  },
  {
    id: "hackernews",
    name: "Hacker News",
    url: "https://news.ycombinator.com/",
    endpoint: "https://news.ycombinator.com/rss",
    scope: "Hacker Newsの配信見出し / 地域・集計期間はRSSに未記載。",
  },
  {
    id: "github",
    name: "GitHub Trending",
    url: "https://github.com/trending?since=daily",
    endpoint: "https://github.com/trending?since=daily",
    scope:
      "日次の注目リポジトリ / 全言語。世界全体の人気順位を示すものではありません。",
  },
] as const;
export type TrendSource = (typeof trendSources)[number]["id"];
export type TrendItem = {
  title: string;
  url: string;
  published: string | null;
  terms: string[];
};
export type TrendSnapshot = {
  version: 1;
  source: TrendSource;
  fetchedAt: string;
  items: TrendItem[];
};
export const trendFreshMs = 15 * 60 * 1000;
const bad = () =>
  Error("話題のデータ形式を確認できません。前回の記録は保持しています。");
const clean = (value: string, maximum = 160) =>
  value
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum)
    .replace(/[\uD800-\uDBFF]$/u, "");

function safeURL(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 2048
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

// 見出し中に実際に現れる語だけを候補にする。定義や意味上の関連は推測しない。
export function headlineTerms(title: string): string[] {
  const stop = new Set([
    "the",
    "with",
    "from",
    "this",
    "that",
    "for",
    "and",
    "are",
    "how",
    "why",
    "new",
    "show",
    "ask",
    "する",
    "した",
    "ため",
    "から",
    "について",
  ]);
  const words =
    title.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,30}|[a-zA-Z][a-zA-Z0-9+#.-]{1,29}/gu,
    ) ?? [];
  return [...new Set(words)]
    .filter((word) => !stop.has(word.toLowerCase()))
    .slice(0, 6);
}

function published(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseTrendResponse(
  source: TrendSource,
  result: { url: string; xml?: string; html?: string },
  fetchedAt = new Date().toISOString(),
): TrendSnapshot {
  const config = trendSources.find((candidate) => candidate.id === source);
  if (!config || !result || typeof result.url !== "string") throw bad();
  const responseURL = safeURL(result.url);
  if (!responseURL) throw bad();
  const final = new URL(responseURL);
  const expected = new URL(config.endpoint);
  if (
    final.origin !== expected.origin ||
    final.username ||
    final.password ||
    final.pathname !== expected.pathname ||
    (source === "google" && final.searchParams.get("geo") !== "JP") ||
    (source === "github" && final.searchParams.get("since") !== "daily")
  )
    throw bad();
  const items: TrendItem[] = [];
  if (source === "github") {
    if (typeof result.html !== "string" || result.html.length > 2_000_000)
      throw bad();
    const template = document.createElement("template");
    template.innerHTML = result.html;
    for (const row of Array.from(
      template.content.querySelectorAll("article.Box-row"),
    )) {
      const link = row.querySelector<HTMLAnchorElement>("h2 a[href]");
      const url = safeURL(link?.getAttribute("href") ?? "", config.url);
      if (!url) continue;
      const parsed = new URL(url);
      if (
        parsed.origin !== "https://github.com" ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(parsed.pathname)
      )
        continue;
      const title = parsed.pathname.slice(1).replace(/\/$/, "");
      items.push({
        title,
        url,
        published: null,
        terms: headlineTerms(title.split("/").at(-1)!),
      });
      if (items.length === 20) break;
    }
  } else {
    if (
      typeof result.xml !== "string" ||
      result.xml.length > 2_000_000 ||
      /<!\s*(DOCTYPE|ENTITY)/iu.test(result.xml)
    )
      throw bad();
    const document = new DOMParser().parseFromString(
      result.xml,
      "application/xml",
    );
    if (
      document.querySelector("parsererror") ||
      document.documentElement.localName !== "rss"
    )
      throw bad();
    for (const row of Array.from(document.querySelectorAll("channel > item"))) {
      const title = clean(row.querySelector("title")?.textContent ?? "");
      const url = safeURL(
        row.querySelector("link")?.textContent ?? "",
        config.url,
      );
      if (!title || !url) continue;
      items.push({
        title,
        url,
        published: published(row.querySelector("pubDate")?.textContent ?? ""),
        terms: source === "google" ? [clean(title, 80)] : headlineTerms(title),
      });
      if (items.length === 20) break;
    }
  }
  if (!items.length) throw bad();
  return validateTrendSnapshot({ version: 1, source, fetchedAt, items });
}

export function validateTrendSnapshot(value: unknown): TrendSnapshot {
  const snapshot = value as TrendSnapshot;
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !trendSources.some((source) => source.id === snapshot.source) ||
    typeof snapshot.fetchedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(snapshot.fetchedAt) ||
    !Number.isFinite(Date.parse(snapshot.fetchedAt)) ||
    !Array.isArray(snapshot.items) ||
    !snapshot.items.length ||
    snapshot.items.length > 20
  )
    throw bad();
  for (const item of snapshot.items) {
    if (
      !item ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 160 ||
      typeof item.url !== "string" ||
      !safeURL(item.url) ||
      (item.published !== null &&
        (typeof item.published !== "string" ||
          !Number.isFinite(Date.parse(item.published)))) ||
      !Array.isArray(item.terms) ||
      item.terms.length > 6 ||
      item.terms.some(
        (term) =>
          typeof term !== "string" ||
          !term.trim() ||
          term.length > 80 ||
          !item.title.includes(term),
      )
    )
      throw bad();
  }
  return snapshot;
}

export async function fetchTrendSnapshot(
  source: TrendSource,
  signal: AbortSignal,
) {
  const config = trendSources.find((candidate) => candidate.id === source);
  if (!config) throw bad();
  const response = await fetch("/api/feeds/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: config.endpoint, discover: true }),
    signal,
  });
  if (!response.ok)
    throw Error(
      "話題を取得できませんでした。前回の記録を確認するか、接続後に更新してください。",
    );
  let data;
  try {
    data = await response.json();
  } catch {
    throw bad();
  }
  return parseTrendResponse(source, data);
}
