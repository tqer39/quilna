import { siteIcon } from "./link-preview";
import { readerIcon, type ReaderIconKind } from "./reader-icons";
import { button, el } from "./ui";

type FeedLine = {
  url: string;
  title: string;
  details: {
    text: string;
    error?: boolean;
    time?: { iso: string; text: string };
  }[];
  retry: boolean;
  updating: boolean;
  unsubscribed: boolean;
  cloudUnsubscribePending: boolean;
  subscriptionBusy: boolean;
  total: number;
  unread: number;
};
type State = {
  counts: { all: number; unread: number; saved: number };
  filter: string;
  input: string;
  ready: boolean;
  connecting: boolean;
  discovering: boolean;
  adding: boolean;
  source: string;
  feeds: FeedLine[];
  updating: ReadonlySet<string>;
  status: string;
};
function text(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}
function attribute(node: HTMLElement, name: string, value: string) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

const filterLabels = [
  ["all", "すべての記事", "stack"],
  ["unread", "未読", "unread"],
  ["saved", "保存した記事", "bookmark"],
] as const satisfies readonly (readonly [string, string, ReaderIconKind])[];

// Keep form controls connected across search, article and collection updates.
export class CollectionNavigation {
  private state?: State;
  private readonly field = el("input");
  private readonly submit = el("button");
  private readonly add;
  private readonly select = el("select");
  private readonly refresh;
  private readonly status = el("p", "", "rss-rail-status");
  private readonly progress = el("p", "", "rss-progress");
  private readonly presets = el("div", undefined, "rss-presets");
  private readonly presetButtons = new Map<string, HTMLButtonElement>();
  private readonly menus = new Map<
    string,
    { button: HTMLButtonElement; count: HTMLElement }
  >();
  private readonly options = new Map<string, HTMLOptionElement>();
  private readonly rows = new Map<
    string,
    {
      root: HTMLDivElement;
      title: HTMLButtonElement;
      mark: HTMLElement;
      label: HTMLElement;
      count: HTMLElement;
      total: HTMLElement;
      management: HTMLDetailsElement;
      summary: HTMLElement;
      stateLabel: HTMLElement;
      details: HTMLDivElement;
      update: HTMLButtonElement;
      subscription: HTMLButtonElement;
      retrySubscription: HTMLButtonElement;
      signature: string;
    }
  >();
  private readonly feedList = el("div", undefined, "rss-feed-list");
  private readonly feedsEmpty = el(
    "p",
    "配信元を追加すると、ここに並びます。",
    "rss-rail-note",
  );
  private readonly importSlot = el("div", undefined, "rss-import-slot");
  private importParts: HTMLElement[] = [];
  /** 購読がある間の追加欄。レールの末尾に置き、読む・配信元より目立たせない。 */
  readonly railImport = el("section", undefined, "rss-rail-add");
  /** 一覧の検索と並べる配信元の選択欄。レールの外に置ける。 */
  readonly sourceField = el("div", undefined, "rss-source-field");

  constructor(
    root: HTMLElement,
    actions: {
      filter: (value: string) => void;
      input: (value: string) => void;
      discover: (value: string) => void;
      add: (value: string) => void;
      source: (value: string) => void;
      refresh: (url: string, insert?: boolean) => void;
      refreshAll: () => void;
      subscription: (url: string, subscribed: boolean) => void;
    },
  ) {
    const menus = el("nav", undefined, "rss-filters");
    menus.setAttribute("aria-label", "記事の絞り込み");
    for (const [value, label, icon] of filterLabels) {
      const menu = button("", () => actions.filter(value));
      const count = el("span", "", "rss-filter-count");
      menu.append(
        readerIcon(icon),
        el("span", label, "rss-filter-label"),
        count,
      );
      menus.append(menu);
      this.menus.set(value, { button: menu, count });
    }
    const form = el("form", undefined, "rss-add");
    const label = el("label", "サイト・RSSのURL");
    label.htmlFor = this.field.id = "feed-url";
    Object.assign(this.field, {
      type: "text",
      inputMode: "url",
      maxLength: 2048,
      autocapitalize: "off",
      spellcheck: false,
      required: true,
      placeholder: "example.com や記事のURL",
    });
    this.field.addEventListener("input", () => {
      actions.input(this.field.value);
      this.submit.disabled = !this.state?.ready || !!this.state.connecting;
      text(this.submit, "フィードを探す");
    });
    this.submit.id = "rss-find-feeds";
    this.submit.type = "submit";
    const hint = el(
      "p",
      "サイトから配信元を探すか、記事URLから本文を取り込んで保存できます。",
      "rss-add-hint",
    );
    hint.id = "rss-url-hint";
    this.field.setAttribute("aria-describedby", hint.id);
    this.add = button("", () => actions.add(this.field.value));
    this.add.classList.add("rss-add-article");
    form.append(
      el("h3", "サイトを追加"),
      label,
      this.field,
      hint,
      this.submit,
      this.add,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      actions.discover(this.field.value);
    });
    this.presets.append(el("p", "公開フィードから試す", "muted"));
    for (const [name, url] of [
      ["Zenn", "https://zenn.dev/feed"],
      ["Cloudflare Blog", "https://blog.cloudflare.com/rss/"],
    ]) {
      const add = button(`${name}を追加`, () => actions.refresh(url, true));
      this.presets.append(add);
      this.presetButtons.set(url, add);
    }
    const sourceLabel = el("label", "配信元");
    sourceLabel.htmlFor = this.select.id = "feed-source";
    const all = el("option", "すべての配信元");
    all.value = "";
    this.select.append(all);
    this.select.addEventListener("change", () =>
      actions.source(this.select.value),
    );
    this.sourceField.append(sourceLabel, this.select);
    this.refresh = button("", actions.refreshAll, "rss-refresh-all");
    this.refresh.append(readerIcon("refresh"), el("span", "すべて更新"));
    this.status.id = "rss-auto-refresh-status";
    this.status.setAttribute("role", "status");
    this.progress.setAttribute("role", "status");
    this.createSource = (url) => button("", () => actions.source(url));
    this.createRefresh = (url) => button("", () => actions.refresh(url));
    this.createSubscription = (url) => ({
      subscription: button("", () =>
        actions.subscription(
          url,
          !!this.state?.feeds.find((f) => f.url === url)?.unsubscribed,
        ),
      ),
      retrySubscription: button("", () => actions.subscription(url, false)),
    });
    this.importParts = [form, this.presets];
    this.restoreImport();
    this.railImport.setAttribute("aria-label", "配信元の追加");
    this.railImport.append(this.importSlot);
    const sources = el("div", undefined, "rss-sources-header");
    sources.append(el("h3", "配信元"), this.refresh);
    root.append(
      el("h2", "情報収集"),
      menus,
      sources,
      this.progress,
      this.feedsEmpty,
      this.feedList,
      this.status,
      this.railImport,
    );
  }
  private readonly createSource: (url: string) => HTMLButtonElement;
  private readonly createRefresh: (url: string) => HTMLButtonElement;
  private readonly createSubscription: (url: string) => {
    subscription: HTMLButtonElement;
    retrySubscription: HTMLButtonElement;
  };

  presentImport(host: HTMLElement) {
    host.append(...this.importParts);
    this.field.focus();
  }
  restoreImport() {
    this.importSlot.append(...this.importParts);
  }
  /**
   * 空のライブラリでは紙面の中央、購読後はレールの末尾へ追加欄を移す。
   * 入力途中の値・フォーカス・選択範囲は移動後も保つ。
   */
  placeImport(host: HTMLElement) {
    if (this.importSlot.parentElement === host) return;
    const focused = document.activeElement;
    const keep =
      focused instanceof HTMLElement && this.importSlot.contains(focused)
        ? focused
        : null;
    const range =
      keep instanceof HTMLInputElement
        ? ([
            keep.selectionStart,
            keep.selectionEnd,
            keep.selectionDirection ?? undefined,
          ] as const)
        : null;
    host.append(this.importSlot);
    if (!keep) return;
    keep.focus({ preventScroll: true });
    if (range && keep instanceof HTMLInputElement)
      keep.setSelectionRange(range[0], range[1], range[2]);
  }

  update(state: State) {
    this.state = state;
    for (const [value, label] of filterLabels) {
      const menu = this.menus.get(value)!;
      // 表示は名前と件数を分けて揃え、読み上げ名は従来の「名前 · 件数」を保つ。
      attribute(menu.button, "aria-label", `${label} · ${state.counts[value]}`);
      text(menu.count, String(state.counts[value]));
      if (state.filter === value)
        menu.button.setAttribute("aria-current", "page");
      else menu.button.removeAttribute("aria-current");
    }
    if (this.field.value !== state.input) this.field.value = state.input;
    text(this.submit, state.discovering ? "探しています…" : "フィードを探す");
    this.submit.disabled =
      !state.ready || state.connecting || state.discovering;
    text(this.add, state.adding ? "記事を取り込み中…" : "記事として取り込む");
    this.add.disabled = !state.ready || state.adding;
    this.presets.hidden = !!state.feeds.length;
    for (const [url, add] of this.presetButtons)
      add.disabled = !state.ready || state.updating.has(url);
    this.refresh.disabled =
      !state.feeds.some((f) => !f.unsubscribed) || !!state.updating.size;
    this.feedsEmpty.hidden = !!state.feeds.length || state.connecting;
    text(this.status, state.status);
    text(
      this.progress,
      state.updating.size
        ? `更新中：${state.updating.size}件。取得済みの記事は読めます。`
        : "",
    );
    this.progress.hidden = !state.updating.size;
    const retained = new Set(state.feeds.map((f) => f.url));
    for (const [url, option] of this.options)
      if (!retained.has(url)) {
        option.remove();
        this.options.delete(url);
      }
    for (const [url, row] of this.rows)
      if (!retained.has(url)) {
        row.root.remove();
        this.rows.delete(url);
      }
    const focused = document.activeElement;
    for (const [index, feed] of state.feeds.entries()) {
      let option = this.options.get(feed.url);
      if (!option) {
        option = el("option");
        option.value = feed.url;
        this.options.set(feed.url, option);
      }
      text(option, feed.title);
      if (this.select.options[index + 1] !== option)
        this.select.insertBefore(
          option,
          this.select.options[index + 1] ?? null,
        );
      let row = this.rows.get(feed.url);
      if (!row) {
        row = {
          root: el("div", undefined, "rss-feed-state"),
          title: this.createSource(feed.url),
          mark: el("span", "", "rss-feed-mark"),
          label: el("span", "", "rss-feed-label"),
          count: el("span", "", "rss-feed-count"),
          total: el("span", "", "rss-feed-total"),
          management: el("details", undefined, "rss-feed-management"),
          summary: el("summary"),
          stateLabel: el("p", undefined, "rss-feed-status"),
          details: el("div"),
          update: this.createRefresh(feed.url),
          ...this.createSubscription(feed.url),
          signature: "",
        };
        row.title.className = "rss-feed-title";
        row.title.append(siteIcon(feed.url, row.mark), row.label);
        row.management.append(
          row.summary,
          row.details,
          row.update,
          row.subscription,
          row.retrySubscription,
        );
        const counts = el("span", "", "rss-feed-counts");
        row.total.title = "取り込んだ記事の総数";
        counts.append(row.total, row.count);
        row.root.append(row.title, counts, row.stateLabel, row.management);
        this.rows.set(feed.url, row);
      }
      text(row.label, feed.title);
      text(row.mark, Array.from(feed.title.trim())[0] ?? "?");
      text(row.total, `全${feed.total}件`);
      text(row.count, feed.unread ? `未読${feed.unread}件` : "");
      row.title.setAttribute("aria-pressed", String(feed.url === state.source));
      text(row.summary, "管理");
      row.summary.setAttribute("aria-label", `${feed.title}の管理`);
      const stateKey = feed.updating
        ? "updating"
        : feed.cloudUnsubscribePending
          ? "cloud-pending"
          : feed.unsubscribed
            ? "unsubscribed"
            : feed.retry || feed.details.some((detail) => detail.error)
              ? "failed"
              : "active";
      row.root.dataset.state = stateKey;
      row.stateLabel.dataset.state = stateKey;
      text(
        row.stateLabel,
        {
          updating: "更新中",
          "cloud-pending": "クラウド解除の確認待ち",
          unsubscribed: "購読停止中",
          failed: "取得に失敗・再試行できます",
          active: "購読中",
        }[stateKey],
      );
      const signature = JSON.stringify(feed.details);
      if (row.signature !== signature) {
        const nodes = feed.details.map((detail) => {
          const node = el(
            detail.error ? "p" : "span",
            detail.text,
            detail.error ? "rss-feed-error" : "muted",
          );
          if (detail.error) node.setAttribute("role", "alert");
          if (detail.time) {
            const time = el("time", detail.time.text);
            time.dateTime = detail.time.iso;
            node.append(time);
          }
          return node;
        });
        row.details.replaceChildren(...nodes);
        row.signature = signature;
      }
      text(row.update, `${feed.title}を${feed.retry ? "再試行" : "更新"}`);
      row.update.disabled = feed.updating || feed.unsubscribed;
      text(
        row.subscription,
        `${feed.title}の購読を${feed.unsubscribed ? "再開" : "解除"}`,
      );
      row.subscription.disabled = feed.subscriptionBusy || feed.updating;
      text(row.retrySubscription, `${feed.title}のクラウド解除を再確認`);
      row.retrySubscription.hidden =
        !feed.unsubscribed || !feed.cloudUnsubscribePending;
      row.retrySubscription.disabled = feed.subscriptionBusy || feed.updating;
      if (this.feedList.children[index] !== row.root)
        this.feedList.insertBefore(
          row.root,
          this.feedList.children[index] ?? null,
        );
    }
    if (this.select.value !== state.source) this.select.value = state.source;
    if (
      focused instanceof HTMLElement &&
      this.feedList.contains(focused) &&
      document.activeElement !== focused
    )
      focused.focus({ preventScroll: true });
  }
}
