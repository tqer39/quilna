import { listPaperExcerpts } from "./paper-excerpt-store";
import { type PaperExcerpt } from "./paper-text-format";
import { button, el } from "./ui";
/** Keep stored-citation paging independent of the selected source, including during delayed save completions. */
export function paperExcerptLibrary(open: (record: PaperExcerpt) => void) {
  const root = el("section");
  root.setAttribute("aria-label", "保存した論文引用");
  let revision = 0,
    after: string | undefined;
  /** Preserve the focus present at publication time without stealing it from source/quote controls. */
  function render(children: HTMLElement[]) {
    const active = document.activeElement as HTMLElement | null,
      key =
        active && root.contains(active)
          ? active.dataset.excerptFocusKey
          : undefined,
      heading = children[0];
    heading.tabIndex = -1;
    heading.dataset.excerptFocusKey = "heading";
    root.replaceChildren(...children);
    if (key)
      (
        Array.from(
          root.querySelectorAll<HTMLElement>("[data-excerpt-focus-key]"),
        ).find((n) => n.dataset.excerptFocusKey === key) ?? heading
      ).focus({ preventScroll: true });
  }
  /** Stable identities survive a new page render; disconnected old buttons cannot select a stale row. */
  function control(key: string, label: string, action: () => void) {
    const node = button(label, () => {
      if (node.isConnected) action();
    });
    node.dataset.excerptFocusKey = key;
    return node;
  }
  /** Refuse stale page completions and show failures without clearing stored records. */
  async function read(cursor?: string) {
    const current = ++revision;
    after = cursor;
    try {
      const page = await listPaperExcerpts(cursor);
      if (current !== revision) return;
      const children: HTMLElement[] = [el("h2", "保存した論文引用")];
      if (!page.records.length)
        children.push(el("p", "保存した論文引用はありません。"));
      for (const record of page.records) {
        const row = el("div", undefined, "paper-row"),
          text = Array.from(record.text);
        row.append(
          el(
            "p",
            `${record.source.facts.title || "題名不明"} · ${record.source.facts.pmcid}`,
          ),
          el(
            "p",
            `${text.slice(0, 100).join("")}${text.length > 100 ? "…" : ""}`,
          ),
          control(record.digest, "論文引用を開く", () => open(record)),
        );
        children.push(row);
      }
      if (cursor)
        children.push(
          control("first", "論文引用の先頭20件", () => {
            void read();
          }),
        );
      if (page.next)
        children.push(
          control("next", "論文引用の次の20件", () => {
            void read(page.next);
          }),
        );
      render(children);
    } catch (error) {
      if (current === revision)
        render([
          el("h2", "保存した論文引用"),
          el("p", (error as Error).message),
          control("retry", "論文引用一覧を再試行", () => {
            void read(cursor);
          }),
        ]);
    }
  }
  window.addEventListener("pagehide", () => {
    revision++;
  });
  return { root, refresh: () => read(after) };
}
