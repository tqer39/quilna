import type { ReadingView } from "./article-highlight-view";
import type { ArticleLink } from "./article-structure";
import { plainArticleLinks } from "./article-code";
import {
  listSharedTextbooks,
  readTextbookNotices,
  sharedTextbookDatabase,
} from "./shared-textbook-store";
import { textbookWordLinks, type TextbookWord } from "./textbook-word-links";
import { el } from "./ui";
import { libraryAccount } from "./library-context";

/** 教材の確認は本文表示と独立させ、別の記事へ移った後の結果を混ぜない。 */
export class ArticleTextbookWords {
  readonly status = el("p", undefined, "muted");
  private view?: ReadingView;
  private body?: HTMLElement;
  private generation = 0;
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(sharedTextbookDatabase);
  constructor(
    private readonly publish: (view: ReadingView, links: ArticleLink[]) => void,
  ) {
    this.status.hidden = true;
    this.status.setAttribute("aria-live", "polite");
    this.channel?.addEventListener("message", () => void this.load());
    window.addEventListener("focus", () => void this.load());
  }
  mount(view: ReadingView, body: HTMLElement) {
    this.view = view;
    this.body = body;
    void this.load();
    return this.status;
  }
  detach() {
    this.generation++;
    this.view = undefined;
    this.body = undefined;
    this.status.hidden = true;
  }
  private async load() {
    const view = this.view,
      body = this.body;
    if (!view || !body) return;
    const generation = ++this.generation;
    try {
      const account = libraryAccount();
      const books = await listSharedTextbooks(),
        states = await readTextbookNotices(books);
      const latest = new Map<string, (typeof books)[number]>();
      for (const [i, book] of books.entries()) {
        const state = states[i];
        if (
          book.request.schemaVersion !== 2 ||
          state.error ||
          state.notice?.kind === "withdrawn" ||
          (state.notice?.kind === "correction" &&
            state.replacementState !== "available")
        )
          continue;
        const key = book.record.bookID.toLowerCase(),
          old = latest.get(key);
        if (!old || old.record.version < book.record.version)
          latest.set(key, book);
      }
      const groups = new Map<string, typeof books>();
      for (const book of latest.values()) {
        if (book.request.schemaVersion !== 2) continue;
        const key = book.request.topic.name.trim().toLowerCase();
        const matches = groups.get(key) ?? [];
        matches.push(book);
        groups.set(key, matches);
      }
      const words: TextbookWord[] = [];
      for (const group of groups.values()) {
        const book = group[0];
        if (book.request.schemaVersion !== 2) continue;
        const url = new URL("/", location.origin);
        url.searchParams.set("view", "textbooks");
        if (group.length === 1) url.searchParams.set("book", book.id);
        else url.searchParams.set("term", book.request.topic.name);
        words.push({ label: book.request.topic.name, href: url.href });
      }
      const links = textbookWordLinks(view.text, words, [
        ...(view.ranges ?? []),
        ...(view.structure?.links ?? plainArticleLinks(view.text, view.ranges)),
      ]);
      if (
        generation !== this.generation ||
        view !== this.view ||
        !body.isConnected ||
        libraryAccount() !== account
      )
        return;
      this.publish(view, links);
      const unavailable = states.some((state) => state.error);
      this.status.hidden = !unavailable;
      const message = unavailable
        ? "確認できない教材へのリンクは表示していません。記事は引き続き読めます。"
        : "";
      if (this.status.textContent !== message)
        this.status.textContent = message;
    } catch {
      if (
        generation !== this.generation ||
        view !== this.view ||
        !body.isConnected
      )
        return;
      this.publish(view, []);
      this.status.hidden = false;
      const message =
        "教材のリンクを確認できませんでした。記事と保存済みの記録は保持しています。";
      if (this.status.textContent !== message)
        this.status.textContent = message;
    }
  }
}
