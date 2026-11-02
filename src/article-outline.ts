import type { ArticleStructure } from "./article-structure";
import { el } from "./ui";

/** Navigation over retained source headings; never infer translated headings. */
export class ArticleOutline {
  readonly root = el("details", undefined, "rss-article-outline");
  private signature = "";
  private body?: HTMLElement;
  private links: { link: HTMLAnchorElement; id: string }[] = [];
  private current = -1;
  private frame = 0;

  constructor() {
    this.root.id = "rss-article-outline";
    this.root.tabIndex = -1;
    const measure = () => this.schedule();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure, { passive: true });
  }

  mount(
    articleId: string,
    text: string,
    structure: ArticleStructure | undefined,
    translated: boolean,
    body: HTMLElement,
  ) {
    const signature = JSON.stringify([
      articleId,
      text,
      structure?.headings,
      translated,
    ]);
    this.body = body;
    if (signature !== this.signature) {
      this.signature = signature;
      this.current = -1;
      this.links = [];
      this.root.replaceChildren();
      const headings = structure?.headings ?? [];
      this.root.open =
        headings.length > 0 && matchMedia("(min-width: 1100px)").matches;
      this.root.append(
        el(
          "summary",
          `この記事の目次${headings.length ? ` · ${headings.length}` : ""}`,
        ),
      );
      if (headings.length) {
        const nav = el("nav");
        nav.setAttribute("aria-label", "この記事の目次");
        const list = el("ol");
        const stack: {
          level: number;
          item: HTMLLIElement;
          list: HTMLOListElement;
        }[] = [];
        for (const heading of headings) {
          while (stack.length && stack[stack.length - 1].level >= heading.level)
            stack.pop();
          let parent = list;
          const ancestor = stack[stack.length - 1];
          if (ancestor) {
            parent = ancestor.list;
            if (parent === list || parent.parentElement !== ancestor.item) {
              parent = el("ol");
              ancestor.item.append(parent);
              ancestor.list = parent;
            }
          }
          const item = el("li");
          const link = el(
            "a",
            text.slice(heading.start, heading.end),
            "rss-text-link",
          );
          const id = `rss-section-${heading.start}`;
          link.href = `?view=feeds#${id}`;
          link.addEventListener("click", (event) => {
            event.preventDefault();
            const target = this.body?.querySelector<HTMLElement>(`#${id}`);
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({ block: "start" });
            this.schedule();
          });
          item.append(link);
          parent.append(item);
          stack.push({ level: heading.level, item, list: parent });
          this.links.push({ link, id });
        }
        nav.append(list);
        this.root.append(nav);
      } else
        this.root.append(
          el(
            "p",
            translated
              ? "見出しとリンクは原文で確認できます。"
              : "この記事には見出し情報がありません。",
          ),
        );
    }
    this.schedule();
    return this.root;
  }

  show() {
    this.root.open = true;
    this.root.focus({ preventScroll: true });
    this.root.scrollIntoView({ block: "start" });
    this.schedule();
  }

  detach() {
    this.body = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule() {
    if (!this.frame && this.body && this.links.length)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.measure();
      });
  }

  private measure() {
    if (!this.body?.isConnected || !this.links.length) return;
    const toolbar = document.querySelector(".rss-reader-navigation");
    const firstHeading = this.body.querySelector<HTMLElement>(
      `#${this.links[0].id}`,
    );
    const scrollMargin = firstHeading
      ? parseFloat(getComputedStyle(firstHeading).scrollMarginTop) || 0
      : 0;
    const top =
      Math.max(scrollMargin, toolbar?.getBoundingClientRect().bottom ?? 0) + 2;
    // Headings are in document order. Bound layout reads even for 1,000 headings.
    let low = 0,
      high = this.links.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const heading = this.body.querySelector<HTMLElement>(
        `#${this.links[middle].id}`,
      );
      if (heading && heading.getBoundingClientRect().top <= top)
        low = middle + 1;
      else high = middle;
    }
    const current = Math.max(0, low - 1);
    if (current === this.current) return;
    this.current = current;
    this.links.forEach(({ link }, index) => {
      if (index === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }
}
