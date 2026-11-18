import { button, el } from "./ui";
import { TrendDiscoveryView } from "./trend-discovery-view";
import {
  captureReaderSelection,
  restoreReaderSelection,
  type ReaderSelection,
} from "./reader-selection";

type Entry = {
  word: string;
  aliases: string[];
  meaning: string;
  synonyms: string[];
  contrasts: string[];
  related: string[];
  source: { name: string; url: string };
};

// 定義は短い編集済みの説明。検索しただけで生成や外部への送信を始めない。
export const quickDictionary: readonly Entry[] = [
  {
    word: "RSS",
    aliases: ["Really Simple Syndication"],
    meaning:
      "サイトの更新を、記事の題名・リンク・概要などを含む一定の形式で受け取る仕組みです。Atomは別の配信形式です。",
    synonyms: ["フィード配信"],
    contrasts: [],
    related: ["Atom", "非同期", "キャッシュ"],
    source: {
      name: "RSS 2.0 Specification",
      url: "https://www.rssboard.org/rss-specification",
    },
  },
  {
    word: "Atom",
    aliases: ["Atomフィード"],
    meaning:
      "記事などの更新情報を配信するためのXML形式です。RSSとは別の仕様で、題名・識別子・更新日時などを扱います。",
    synonyms: [],
    contrasts: [],
    related: ["RSS"],
    source: {
      name: "RFC 4287: The Atom Syndication Format",
      url: "https://www.rfc-editor.org/rfc/rfc4287.html",
    },
  },
  {
    word: "キャッシュ",
    aliases: ["cache", "caching"],
    meaning:
      "一度取得した情報のコピーを保存し、次の要求で再利用する仕組みです。古くなった情報の更新確認も必要です。",
    synonyms: ["一時保存"],
    contrasts: [],
    related: ["RSS", "非同期"],
    source: {
      name: "MDN: HTTP caching",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching",
    },
  },
  {
    word: "非同期",
    aliases: ["asynchronous", "async", "非同期処理"],
    meaning:
      "時間のかかる処理の完了を待つ間に、別の処理を進められる方式です。複数の処理を同時に実行することと必ずしも同じではありません。",
    synonyms: ["非同期処理"],
    contrasts: ["同期"],
    related: ["キャッシュ", "RSS"],
    source: {
      name: "MDN: Asynchronous",
      url: "https://developer.mozilla.org/en-US/docs/Glossary/Asynchronous",
    },
  },
  {
    word: "同期",
    aliases: ["synchronous", "同期処理"],
    meaning:
      "一つの処理が終わってから次の処理へ進む方式です。データのコピー同士を揃える「同期」とは文脈を分けて使います。",
    synonyms: ["同期処理"],
    contrasts: ["非同期"],
    related: ["キャッシュ"],
    source: {
      name: "MDN: Synchronous",
      url: "https://developer.mozilla.org/en-US/docs/Glossary/Synchronous",
    },
  },
];

const normalize = (word: string) =>
  word.normalize("NFKC").trim().toLocaleLowerCase();
export function findQuickDefinition(word: string) {
  const value = normalize(word);
  return quickDictionary.find((entry) =>
    [entry.word, ...entry.aliases].some((alias) => normalize(alias) === value),
  );
}

export function dictionaryLinks(word: string) {
  const query = encodeURIComponent(word.trim());
  return [
    {
      name: "Wiktionaryで意味・類語・対義語を調べる",
      url: `https://ja.wiktionary.org/w/index.php?search=${query}`,
    },
    {
      name: "Wikipediaで背景・関連概念を調べる",
      url: `https://ja.wikipedia.org/w/index.php?search=${query}`,
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
  private restored = true;
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
  }

  private close() {
    this.root.close();
    // closeイベントは後のタスクになるため、同じ操作内で選択を戻す。
    this.restoreReading();
  }

  private restoreReading() {
    if (this.restored) return;
    this.restored = true;
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

  private lookup(word = this.input.value) {
    this.input.value = word;
    const query = word.trim();
    this.results.replaceChildren();
    if (!query) {
      this.notice.textContent =
        "言葉を入力するか、収録済みの言葉を選んでください。";
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
    if (entry) {
      this.results.append(el("p", entry.meaning, "rss-definition"));
      for (const [label, words] of [
        ["類語・言い換え", entry.synonyms],
        ["反語・対比する言葉", entry.contrasts],
        ["関連する言葉", entry.related],
      ] as const) {
        const group = el("section", undefined, "rss-word-relations");
        group.append(el("h4", label));
        if (words.length)
          for (const related of words)
            group.append(button(related, () => this.lookup(related)));
        else group.append(el("p", "この項目の収録はありません。", "muted"));
        this.results.append(group);
      }
      this.results.append(
        externalReference(`説明の出典：${entry.source.name}`, entry.source.url),
      );
    }
    const links = el("nav", undefined, "rss-reference-links");
    links.setAttribute("aria-label", "外部辞書");
    for (const link of dictionaryLinks(query))
      links.append(externalReference(link.name, link.url));
    this.results.append(
      links,
      el(
        "p",
        "外部リンクは別タブで開き、調べる言葉をリンク先へ送ります。",
        "muted",
      ),
    );
  }
}
