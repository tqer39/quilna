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

// Keep form controls connected across search, article and collection updates.
export class CollectionNavigation {
  private state?: State;
  private readonly field = el("input");
  private readonly submit = el("button");
  private readonly add;
  private readonly select = el("select");
  private readonly refresh;
  private readonly status = el("p", "", "muted");
  private readonly progress = el("p", "", "rss-progress");
  private readonly presets = el("div", undefined, "rss-presets");
  private readonly presetButtons = new Map<string, HTMLButtonElement>();
  private readonly menus = new Map<string, HTMLButtonElement>();
  private readonly options = new Map<string, HTMLOptionElement>();
  private readonly rows = new Map<
    string,
    {
      root: HTMLDivElement;
      title: HTMLElement;
      details: HTMLDivElement;
      update: HTMLButtonElement;
      subscription: HTMLButtonElement;
      retrySubscription: HTMLButtonElement;
      signature: string;
    }
  >();
  private readonly feedList = el("div");

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
    for (const value of ["all", "unread", "saved"]) {
      const menu = button("", () => actions.filter(value));
      menus.append(menu);
      this.menus.set(value, menu);
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
    this.refresh = button("すべて更新", actions.refreshAll);
    this.status.id = "rss-auto-refresh-status";
    this.status.setAttribute("role", "status");
    this.progress.setAttribute("role", "status");
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
    root.append(
      el("p", "COLLECT → READ → LEARN", "eyebrow"),
      el("h2", "情報収集"),
      menus,
      form,
      this.presets,
      sourceLabel,
      this.select,
      this.refresh,
      this.status,
      this.progress,
      this.feedList,
    );
  }
  private readonly createRefresh: (url: string) => HTMLButtonElement;
  private readonly createSubscription: (url: string) => {
    subscription: HTMLButtonElement;
    retrySubscription: HTMLButtonElement;
  };

  update(state: State) {
    this.state = state;
    for (const [value, label] of [
      ["all", "すべての記事"],
      ["unread", "未読"],
      ["saved", "保存した記事"],
    ] as const) {
      const menu = this.menus.get(value)!;
      text(menu, `${label} · ${state.counts[value]}`);
      if (state.filter === value) menu.setAttribute("aria-current", "page");
      else menu.removeAttribute("aria-current");
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
    text(this.status, state.status);
    text(
      this.progress,
      state.updating.size
        ? `更新中：${state.updating.size}件。取得済みの記事は読めます。`
        : "",
    );
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
          title: el("strong"),
          details: el("div"),
          update: this.createRefresh(feed.url),
          ...this.createSubscription(feed.url),
          signature: "",
        };
        row.root.append(
          row.title,
          row.details,
          row.update,
          row.subscription,
          row.retrySubscription,
        );
        this.rows.set(feed.url, row);
      }
      text(row.title, feed.title);
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
