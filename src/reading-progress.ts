import type { FeedArticle } from "./feed-parser";
import {
  readingFingerprint,
  type ReadingPosition,
  type ReadingPositions,
} from "./reading-position";
import { saveReadingPosition, readArticle } from "./feed-store";
import { button, el } from "./ui";

type Session = {
  id: string;
  text: string;
  view: "original" | "translation";
  language: string;
  fingerprint?: string;
  body: HTMLElement;
  positions?: ReadingPositions;
  saved?: ReadingPosition;
  pending?: ReadingPosition;
  armed: boolean;
};

/** Viewport position is a navigation aid, not a claim of comprehension. */
export class ReadingProgress {
  readonly root = el("div", undefined, "rss-reading-progress");
  private label = el("span", "閲覧位置はスクロールすると保存されます");
  private resume = button("続きから読む", () => this.restore());
  private session?: Session;
  private timer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  constructor(
    private database: () => IDBDatabase | null,
    private saved: (id: string, positions: ReadingPositions) => void,
  ) {
    this.root.setAttribute("aria-label", "読書位置");
    this.root.append(this.label, this.resume);
    this.resume.hidden = true;
    const arm = () => {
      if (this.session) this.session.armed = true;
    };
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (
          e.target === document.documentElement ||
          (e.target instanceof Node && this.session?.body.contains(e.target))
        )
          arm();
      },
      { passive: true },
    );
    window.addEventListener("wheel", arm, { passive: true });
    window.addEventListener("touchstart", arm, { passive: true });
    window.addEventListener("keydown", (e) => {
      if (
        [
          "PageDown",
          "PageUp",
          "ArrowDown",
          "ArrowUp",
          " ",
          "End",
          "Home",
        ].includes(e.key) &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          e.target instanceof HTMLSelectElement
        )
      )
        arm();
    });
    window.addEventListener(
      "scroll",
      () => {
        if (!this.frame)
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.measure();
          });
      },
      { passive: true },
    );
    window.addEventListener("pagehide", () => this.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.flush();
    });
  }
  mount(
    article: FeedArticle,
    text: string,
    view: "original" | "translation",
    language: string,
    body: HTMLElement,
  ) {
    const old = this.session;
    if (
      old?.id === article.id &&
      old.text === text &&
      old.view === view &&
      old.language === language
    ) {
      old.body = body;
      return this.root;
    }
    this.detach();
    const session: Session = {
      id: article.id,
      text,
      view,
      language,
      body,
      positions: article.readingPositions,
      armed: false,
    };
    this.session = session;
    this.label.textContent = "閲覧位置を確認中…";
    this.resume.hidden = true;
    const db = this.database();
    void Promise.all([
      readingFingerprint(text, language),
      db ? readArticle(db, article.id) : Promise.resolve(article),
    ])
      .then(([fingerprint, latest]) => {
        if (this.session !== session) return;
        session.fingerprint = fingerprint;
        const saved = latest.readingPositions?.[view];
        if (saved?.fingerprint === fingerprint && saved.furthest <= text.length)
          session.saved = saved;
        this.paint(session);
      })
      .catch(() => {
        if (this.session === session)
          this.label.textContent =
            "読書位置を読み込めませんでした。記事は引き続き読めます。";
      });
    return this.root;
  }
  detach() {
    this.flush();
    this.session = undefined;
    this.root.remove();
  }
  private paint(s: Session) {
    const p = s.pending ?? s.saved;
    this.label.textContent = p
      ? `閲覧位置 ${Math.round((p.offset / Math.max(1, s.text.length)) * 100)}% · 到達 ${Math.round((p.furthest / Math.max(1, s.text.length)) * 100)}%`
      : "閲覧位置はスクロールすると保存されます";
    this.resume.hidden = !s.saved || s.saved.offset === 0;
  }
  private blocks(s: Session) {
    return Array.from(
      s.body.querySelectorAll<HTMLElement>("[data-reading-start]"),
    );
  }
  private measure() {
    const s = this.session;
    if (!s?.armed || !s.fingerprint || !s.body.isConnected || document.hidden)
      return;
    const rect = s.body.getBoundingClientRect();
    if (rect.top > innerHeight) return;
    const blocks = this.blocks(s);
    if (!blocks.length) return;
    const at = (y: number) => {
      let offset = 0;
      for (let i = 0; i < blocks.length; i++) {
        const box = blocks[i].getBoundingClientRect(),
          start = Number(blocks[i].dataset.readingStart);
        const end =
          i + 1 < blocks.length
            ? Number(blocks[i + 1].dataset.readingStart)
            : s.text.length;
        if (box.top > y) break;
        offset = Math.min(
          end,
          start +
            Math.floor(
              Math.max(
                0,
                Math.min(1, (y - box.top) / Math.max(1, box.height)),
              ) *
                (end - start),
            ),
        );
      }
      return offset;
    };
    const top =
      document.querySelector(".rss-reader-navigation")?.getBoundingClientRect()
        .bottom ?? 80;
    const offset = at(Math.max(0, top) + 12),
      furthest = Math.max(offset, at(innerHeight));
    s.pending = {
      fingerprint: s.fingerprint,
      offset,
      furthest: Math.max(
        furthest,
        s.pending?.furthest ?? s.saved?.furthest ?? 0,
      ),
      updatedAt: Date.now(),
    };
    this.paint(s);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  flush() {
    clearTimeout(this.timer);
    const s = this.session,
      db = this.database();
    if (!s?.pending || !db) return;
    const pending = s.pending;
    s.pending = undefined;
    void saveReadingPosition(db, s.id, s.view, s.text, pending)
      .then((positions) => {
        s.saved = positions[s.view];
        this.saved(s.id, positions);
        if (this.session === s) this.paint(s);
      })
      .catch(() => {
        if (this.session === s) {
          s.pending ??= pending;
          this.label.textContent =
            "読書位置を保存できませんでした。本文は保持しています。";
        }
      });
  }
  private restore() {
    const s = this.session,
      p = s?.saved;
    if (!s || !p) return;
    const blocks = this.blocks(s);
    const index = Math.max(
      0,
      blocks.reduce(
        (last, b, i) => (Number(b.dataset.readingStart) <= p.offset ? i : last),
        0,
      ),
    );
    const target = blocks[index];
    if (!target) return;
    const start = Number(target.dataset.readingStart),
      end =
        index + 1 < blocks.length
          ? Number(blocks[index + 1].dataset.readingStart)
          : s.text.length;
    const box = target.getBoundingClientRect();
    const header =
      document.querySelector(".rss-reader-navigation")?.getBoundingClientRect()
        .height ?? 80;
    s.armed = true;
    window.scrollTo({
      top:
        scrollY +
        box.top +
        (box.height * (p.offset - start)) / Math.max(1, end - start) -
        header -
        12,
    });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
}
