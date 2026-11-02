export type FeedCandidate = { url: string; title: string; format: string };

export function sourceURL(value: string, base?: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) throw Error("url");
  const url = new URL(
    base || /^[a-z][a-z\d+.-]*:/i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`,
    base,
  );
  if (
    url.href.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.includes(".") ||
    url.hostname.includes(":") ||
    /^[\d.]+$/.test(url.hostname) ||
    /\.(localhost|local|internal|test|invalid|example)\.?$/i.test(url.hostname)
  )
    throw Error("url");
  url.hash = "";
  return url.href;
}

export function discoverFeeds(html: string, pageURL: string): FeedCandidate[] {
  if (html.length > 2_000_000) throw Error("ページが大きすぎます。");
  // Never mount these nodes: scripts, images, frames and base must remain inert.
  const template = document.createElement("template");
  template.innerHTML = html;
  const doc = template.content;
  let base = pageURL;
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = sourceURL(baseHref, pageURL);
    } catch {
      /* Ignore unsafe base URLs. */
    }
  }
  const siteTitle = doc
    .querySelector("title")
    ?.textContent?.trim()
    .slice(0, 200);
  const candidates = new Map<string, FeedCandidate>();
  for (const link of Array.from(
    doc.querySelectorAll("link[rel][type][href]"),
  )) {
    const rel = link.getAttribute("rel")!.toLowerCase().split(/\s+/);
    const type = link.getAttribute("type")!.split(";")[0].trim().toLowerCase();
    if (
      !rel.includes("alternate") ||
      !["application/rss+xml", "application/atom+xml"].includes(type)
    )
      continue;
    try {
      const href = link.getAttribute("href")!.trim();
      if (!href) continue;
      const url = sourceURL(href, base);
      if (!candidates.has(url))
        candidates.set(url, {
          url,
          title:
            link.getAttribute("title")?.trim().slice(0, 200) ||
            siteTitle ||
            new URL(url).hostname,
          format: type === "application/atom+xml" ? "Atom" : "RSS",
        });
      if (candidates.size === 20) break;
    } catch {
      /* The server also revalidates every chosen URL and DNS result. */
    }
  }
  return [...candidates.values()];
}
