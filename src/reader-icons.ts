// 線画だけの小さな記号にし、画像の取得や配色に依存せずテーマの文字色で描く。
const paths = {
  imageOff:
    "M3 3l18 18 M9 4h10a1 1 0 0 1 1 1v10 M4 8v11a1 1 0 0 0 1 1h11 M4 16l4-4 6 6 M14 8h1",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  copy: "M9 9h11v11H9z M15 5V3H3v12h2",
  preview:
    "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
  site: "M4 4h16v16H4z M4 9h16 M9 9v11",
  stack: "M4 5h16 M4 10h16 M4 15h10 M4 20h7",
  unread: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10",
  plus: "M12 5v14 M5 12h14",
  book: "M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1z M12 6v14",
  dictionary: "M5 4h11l3 3v13H5z M9 15l3-7 3 7 M10 13h4",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7",
  speaker:
    "M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a7.5 7.5 0 0 1 0 11",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13 M15.5 15.5L20 20",
  filter: "M4 6h16 M7 12h10 M10 18h4",
} as const;

export type ReaderIconKind = keyof typeof paths;

export function readerIcon(kind: ReaderIconKind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("rss-icon");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[kind]);
  svg.append(path);
  return svg;
}
