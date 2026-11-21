import { textbookSectionAnchor } from "./reader-route";
import { button, el } from "./ui";
import { searchWikidata } from "./wikidata-search";
import { libraryAccount } from "./library-context";
import { TrendDiscoveryView } from "./trend-discovery-view";
import {
  captureReaderSelection,
  restoreReaderSelection,
  type ReaderSelection,
} from "./reader-selection";

import {
  dictionaryPhrases,
  findQuickDefinition,
  quickDictionary,
} from "./quick-dictionary-entries";

export function dictionaryLinks(word: string) {
  const query = new URLSearchParams({ search: word.trim() });
  return [
    {
      name: "Wiktionaryで意味・類語・対義語を調べる",
      url: `https://ja.wiktionary.org/w/index.php?${query}`,
    },
    {
      name: "Wikipediaで背景・関連概念を調べる",
      url: `https://ja.wikipedia.org/w/index.php?${query}`,
    },
  ];
}

export function externalReference(name: string, url: string) {
  const link = el("a", name);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

export class QuickDictionary {
  readonly root = el("dialog", undefined, "rss-dictionary");
  private readonly input = el("input");
  private readonly results = el("div", undefined, "rss-dictionary-results");
  private readonly notice = el("p", undefined, "muted");
  private returnTo: HTMLElement | null = null;
  private selection: ReaderSelection | null = null;
  private scroll = { x: 0, y: 0 };
  private location = "";
  private readonly queries: string[] = [];
  private restored = true;
  private wikidataRequest?: AbortController;
  private readonly trends = new TrendDiscoveryView((word) => {
    this.lookup(word);
    this.input.focus();
    this.input.scrollIntoView({ block: "nearest" });
  });

  constructor() {
    const header = el("div", undefined, "rss-settings-header");
    const heading = el("h2", "ことばの辞書");
    heading.id = "rss-dictionary-title";
    this.root.setAttribute("aria-labelledby", heading.id);
    header.append(
      heading,
      button("読書に戻る", () => this.close()),
    );
    const content = el("div", undefined, "rss-settings-body");
    const label = el("label", "調べたい言葉");
    label.htmlFor = this.input.id = "rss-dictionary-query";
    this.input.type = "search";
    this.input.maxLength = 80;
    this.input.placeholder = "気になる言葉を入力";
    const form = el("form");
    const submit = el("button", "調べる");
    submit.type = "submit";
    form.append(label, this.input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.lookup();
    });
    this.notice.setAttribute("role", "status");
    content.append(
      el(
        "p",
        "言葉の意味を短く確認。背景を深く学ぶときは教科書へ。",
        "rss-dictionary-lede",
      ),
      form,
      this.notice,
      this.results,
    );
    content.append(this.trends.root);
    this.root.append(header, content);
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    this.root.addEventListener("close", () => {
      if (!this.root.open) this.restoreReading();
    });
    window.addEventListener("popstate", () => {
      if (this.root.open) this.close();
    });
    window.addEventListener("pagehide", () => this.wikidataRequest?.abort());
  }

  private close() {
    this.root.close();
    // closeイベントは後のタスクになるため、同じ操作内で選択を戻す。
    this.restoreReading();
  }

  private restoreReading() {
    if (this.restored) return;
    this.restored = true;
    this.wikidataRequest?.abort();
    this.trends.root.open = false;
    this.trends.suspend();
    if (this.returnTo?.isConnected)
      this.returnTo.focus({ preventScroll: true });
    restoreReaderSelection(
      this.selection,
      document.querySelector(".rss-source-text"),
    );
    if (location.href === this.location)
      window.scrollTo(this.scroll.x, this.scroll.y);
    this.selection = null;
    this.queries.length = 0;
  }

  open(usePointerCapture = false) {
    if (this.root.open) return;
    this.restored = false;
    this.returnTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.scroll = { x: window.scrollX, y: window.scrollY };
    this.location = location.href;
    // 中断されたポインター操作の選択を、後のキーボード操作へ持ち越さない。
    if (!usePointerCapture || !this.selection) this.captureSelection();
    this.input.value = this.selection
      ? this.selection.text
          .slice(this.selection.start, this.selection.end)
          .trim()
          .slice(0, 80)
          .replace(/[\uD800-\uDBFF]$/u, "")
      : "";
    this.lookup();
    this.root.showModal();
    this.input.focus();
  }

  captureSelection() {
    this.selection = captureReaderSelection(
      document.querySelector(".rss-source-text"),
    );
  }

  private wikidataSearch(query: string) {
    const section = el("section", undefined, "rss-reference-links"),
      notice = el("p", undefined, "muted"),
      items = el("ul");
    section.setAttribute("aria-label", "Wikidataの候補");
    notice.setAttribute("aria-live", "polite");
    notice.hidden = items.hidden = true;
    const search = button(`「${query}」をWikidataへ送って調べる`, async () => {
      if (search.getAttribute("aria-disabled") === "true") return;
      const request = new AbortController();
      this.wikidataRequest = request;
      search.setAttribute("aria-disabled", "true");
      notice.hidden = false;
      items.hidden = true;
      items.replaceChildren();
      notice.textContent = "日本語の説明を探しています。";
      const timer = setTimeout(() => request.abort(), 12000);
      const current = () =>
        this.root.open &&
        section.isConnected &&
        this.wikidataRequest === request;
      try {
        const candidates = await searchWikidata(query, request.signal);
        if (!current()) return;
        for (const candidate of candidates) {
          const row = el("li");
          row.append(
            externalReference(
              candidate.label,
              "https://www.wikidata.org/wiki/" + candidate.id,
            ),
            el("p", candidate.description),
          );
          items.append(row);
        }
        items.hidden = !candidates.length;
        notice.textContent = candidates.length
          ? "Wikidataの候補です。項目名から出典を開けます。"
          : "上位3件に日本語の説明がある候補はありませんでした。";
      } catch {
        if (current())
          notice.textContent =
            "Wikidataの説明を取得できませんでした。時間をおいて再度調べられます。";
      } finally {
        clearTimeout(timer);
        if (this.wikidataRequest === request) this.wikidataRequest = undefined;
        search.removeAttribute("aria-disabled");
      }
    });
    section.append(search, notice, items);
    return section;
  }

  private textbookSearch(query: string) {
    const section = el("section", undefined, "rss-reference-links"),
      status = el("p", undefined, "muted"),
      matches = el("ul"),
      search = button("保存した教科書を探す", () => void load());
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    matches.hidden = true;
    section.setAttribute("aria-label", "この言葉の教科書");
    section.append(search, status, matches);
    const createURL = new URL("/", location.origin);
    createURL.searchParams.set("view", "textbooks");
    createURL.hash = new URLSearchParams({ author: query }).toString();
    const create = externalReference("この言葉で教科書を作る", createURL.href);
    const active = () => this.root.open && section.isConnected;
    const entry = findQuickDefinition(query);
    const normalized = (text: string) => text.normalize("NFKC").toLowerCase();
    function containsTerm(text: string) {
      const title = normalized(text);
      return entry
        ? dictionaryPhrases(title).some(
            (word) => findQuickDefinition(word) === entry,
          )
        : title.includes(normalized(query));
    }
    async function load() {
      if (search.getAttribute("aria-disabled") === "true") return;
      search.setAttribute("aria-disabled", "true");
      create.remove();
      matches.replaceChildren();
      matches.hidden = true;
      status.hidden = false;
      status.textContent = "保存した教科書を確認しています。";
      try {
        const owner = libraryAccount();
        const {
          listSharedTextbooks,
          readTextbookNotices,
          eligibleTopicEditions,
        } = await import("./shared-textbook-store");
        const books = await listSharedTextbooks();
        const states = await readTextbookNotices(books);
        if (!active() || libraryAccount() !== owner) return;
        for (const book of eligibleTopicEditions(books, states)) {
          if (book.request.schemaVersion !== 2) continue;
          const lessons = book.draft.lessons.filter(({ content }) =>
            containsTerm(content.title),
          );
          if (
            !lessons.length &&
            !containsTerm(book.request.topic.name) &&
            !containsTerm(book.draft.title)
          )
            continue;
          const url = new URL("/", location.origin);
          url.searchParams.set("view", "textbooks");
          url.searchParams.set("book", book.id);
          const item = el("li");
          item.append(
            externalReference(
              `${book.draft.title} · 版 ${book.record.version}を読む`,
              url.href,
            ),
          );
          if (lessons.length) {
            const sections = el("ul");
            for (const { content } of lessons) {
              url.hash = textbookSectionAnchor(content.id);
              const section = el("li");
              section.append(externalReference(content.title, url.href));
              sections.append(section);
            }
            item.append(sections);
          }
          matches.append(item);
        }
        const count = matches.childElementCount;
        matches.hidden = !count;
        status.textContent = count
          ? `保存した教科書が${count}件あります。別タブで開きます。`
          : "この言葉に合う教科書は見つかりませんでした。";
        // OSS版の利用者は管理者。保存教材が見つからないときだけ作成へ案内する。
        if (!count && !owner && !states.some((state) => state.error))
          section.append(create);
        if (states.some((state) => state.error))
          status.textContent += "状態を確認できない教材があります。";
      } catch {
        if (active())
          status.textContent =
            "保存した教科書を確認できませんでした。もう一度探せます。";
      } finally {
        search.removeAttribute("aria-disabled");
      }
    }
    return section;
  }

  private lookup(word = this.input.value) {
    const replacingFocusedResult = this.results.contains(
      document.activeElement,
    );
    this.wikidataRequest?.abort();
    this.input.value = word;
    const query = word.trim();
    this.results.replaceChildren();
    if (this.queries.at(-1) !== query) this.queries.push(query);
    if (this.queries.length > 32) this.queries.shift();
    const previous = this.queries.at(-2);
    if (previous !== undefined)
      this.results.append(
        button(previous ? `「${previous}」に戻る` : "収録語一覧に戻る", () => {
          this.queries.pop();
          this.lookup(previous);
        }),
      );
    if (!query) {
      this.notice.textContent =
        "言葉を入力するか、収録済みの言葉を選んでください。";
      if (replacingFocusedResult) this.input.focus();
      for (const entry of quickDictionary)
        this.results.append(button(entry.word, () => this.lookup(entry.word)));
      return;
    }
    const entry = findQuickDefinition(query);
    this.notice.textContent = entry
      ? "Quilnaの簡易辞書に収録された説明です。"
      : "この言葉は簡易辞書に未収録です。外部辞書で調べられます。";
    const heading = el("h3", entry?.word ?? query);
    this.results.append(heading);
    if (replacingFocusedResult) {
      heading.tabIndex = -1;
      heading.focus();
    }
    if (entry) {
      this.results.append(el("p", entry.meaning, "rss-definition"));
      for (const [label, words] of [
        ["類語・言い換え", entry.synonyms],
        ["反語・対比する言葉", entry.contrasts],
        ["関連する言葉", entry.related],
      ] as const) {
        if (!words.length) continue;
        const group = el("section", undefined, "rss-word-relations");
        group.append(el("h4", label));
        for (const related of words)
          group.append(button(related, () => this.lookup(related)));
        this.results.append(group);
      }
      this.results.append(
        externalReference(`説明の出典：${entry.source.name}`, entry.source.url),
      );
    }
    if (!entry) this.results.append(this.wikidataSearch(query));
    const links = el("nav", undefined, "rss-reference-links");
    links.setAttribute("aria-label", "外部辞書");
    for (const link of dictionaryLinks(query))
      links.append(externalReference(link.name, link.url));
    this.results.append(
      this.textbookSearch(query),
      links,
      el(
        "p",
        "外部リンクは別タブで開き、調べる言葉をリンク先へ送ります。",
        "muted",
      ),
    );
  }
}
