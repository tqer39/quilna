export type ReaderRoute = {
  article: string | null;
  filter: string;
  source: string;
  query: string;
  tag: string;
  page: number;
  screen: string;
};

/** Read navigable state from a URL, including an entry without history.state. */
export function readReaderRoute(url = new URL(location.href)): ReaderRoute {
  const p = url.searchParams;
  const page = Number(p.get("page"));
  return {
    article: p.get("article") || null,
    filter: ["saved", "unread"].includes(p.get("filter") ?? "")
      ? p.get("filter")!
      : "all",
    source: p.get("source") ?? "",
    query: (p.get("q") ?? "").slice(0, 300),
    tag: p.get("tag") ?? "",
    page: Number.isSafeInteger(page) && page > 0 ? page - 1 : 0,
    screen: ["import", "settings"].includes(p.get("screen") ?? "")
      ? p.get("screen")!
      : "",
  };
}

export function readerRouteURL(route: ReaderRoute, hash = ""): URL {
  const url = new URL(location.href);
  for (const key of [
    "article",
    "filter",
    "source",
    "q",
    "tag",
    "page",
    "screen",
  ])
    url.searchParams.delete(key);
  url.searchParams.set("view", "feeds");
  for (const [key, value] of Object.entries({
    article: route.article,
    filter: route.filter === "all" ? "" : route.filter,
    source: route.source,
    q: route.query,
    tag: route.tag,
    page: route.page ? String(route.page + 1) : "",
    screen: route.screen,
  }))
    if (value) url.searchParams.set(key, value);
  url.hash = hash;
  return url;
}

/** Preserve the departing viewport; the URL remains the source of screen state. */
export function pushReaderURL(url: URL, replace = false) {
  if (url.href === location.href) return;
  history.replaceState({ ...history.state, readerScroll: scrollY }, "");
  const state = { ...history.state, readerScroll: 0 };
  if (replace) history.replaceState(state, "", url);
  else history.pushState(state, "", url);
}

export function revealReaderAnchor(hash = location.hash): boolean {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = document.getElementById(id);
  if (!target) return false;
  for (let node: HTMLElement | null = target; node; node = node.parentElement)
    if (node instanceof HTMLDetailsElement) node.open = true;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
  return true;
}
