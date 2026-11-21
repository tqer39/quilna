import { sourceURL } from "./feed-discovery";

export function thumbnailURL(value: unknown, base?: string) {
  if (typeof value !== "string" || (!base && !/^https:\/\//i.test(value)))
    return undefined;
  try {
    return sourceURL(value, base);
  } catch {
    return undefined;
  }
}

export function articleImageURL(img: Element, base: string) {
  for (const attr of ["data-src", "src"]) {
    const url = thumbnailURL(img.getAttribute(attr), base);
    if (url) return url;
  }
  const picture = img.parentElement;
  const sources =
    picture?.tagName.toLowerCase() === "picture"
      ? Array.from(picture.children).filter(
          (node) => node.tagName.toLowerCase() === "source",
        )
      : [];
  for (const node of [...sources, img]) {
    for (const attr of ["data-srcset", "srcset"]) {
      // URL 内のコンマを保ち、候補の末尾に付いた区切りだけを外す。
      const first = node.getAttribute(attr)?.trim().split(/\s+/u, 1)[0];
      const url = thumbnailURL(first?.replace(/,+$/u, ""), base);
      if (url) return url;
    }
  }
}

export function htmlThumbnail(
  root: ParentNode,
  base: string,
  feedMarkup = false,
) {
  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    "article img",
    "main img",
    ...(feedMarkup ? ["img"] : []),
  ]) {
    for (const node of Array.from(root.querySelectorAll(selector))) {
      if (node.hasAttribute("onerror") || node.hasAttribute("onload")) continue;
      if (
        ["width", "height"].some((attr) =>
          /^[01](?:px)?$/.test(node.getAttribute(attr) ?? ""),
        )
      )
        continue;
      const url =
        node.tagName.toLowerCase() === "img"
          ? articleImageURL(node, base)
          : thumbnailURL(node.getAttribute("content"), base);
      if (url) return url;
    }
  }
}
