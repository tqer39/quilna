import { button, el } from "./ui";
import {
  fetchTrendSnapshot,
  trendFreshMs,
  trendSources,
  type TrendSnapshot,
  type TrendSource,
} from "./trend-discovery";
import { readTrendSnapshot, saveTrendSnapshot } from "./trend-store";

function reference(title: string, url: string) {
  const link = el("a", title);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

export class TrendDiscoveryView {
  readonly root = el("details", undefined, "rss-trend-sources");
  private readonly source = el("select");
  private readonly status = el("p", undefined, "muted");
  private readonly metadata = el("p", undefined, "muted");
  private readonly list = el("ol", undefined, "rss-trend-list");
  private readonly refresh = button("話題を更新", () => void this.load(true));
  private snapshot?: TrendSnapshot;
  private controller?: AbortController;
  private epoch = 0;
  private busy = false;
  private message = "情報源を選ぶと、取得した話題から言葉を調べられます。";
  private rendered?: TrendSnapshot;

  constructor(private readonly lookup: (word: string) => void) {
    this.root.append(el("summary", "話題の言葉を探す"));
    const body = el("div", undefined, "rss-trend-body");
    const label = el("label", "話題の情報源");
    label.htmlFor = this.source.id = "rss-trend-source";
    for (const source of trendSources) {
      const option = el("option", source.name);
      option.value = source.id;
      this.source.append(option);
    }
    this.source.addEventListener("change", () => {
      this.snapshot = undefined;
      void this.load();
    });
    this.status.setAttribute("role", "status");
    this.list.setAttribute("aria-label", "取得した話題");
    const references = el("nav", undefined, "rss-reference-links");
    references.setAttribute("aria-label", "トレンドの参考元");
    for (const source of trendSources)
      references.append(reference(source.name, source.url));
    references.append(
      reference(
        "Reddit — 人気の投稿（外部で確認）",
        "https://www.reddit.com/r/popular/",
      ),
    );
    body.append(
      el(
        "p",
        "開くと情報源へ接続します。語句を選ぶと辞書で調べられます。配信元の違う数字や掲載順は合算しません。",
        "muted",
      ),
      label,
      this.source,
      this.refresh,
      this.status,
      this.metadata,
      this.list,
      el(
        "p",
        "RedditはRSS提供を終了しているため未接続です。参考元のページは別タブで確認できます。",
        "muted",
      ),
      references,
    );
    this.root.append(body);
    this.root.addEventListener("toggle", () => {
      if (this.root.open) void this.load();
      else this.suspend();
    });
    window.addEventListener("pagehide", () => this.suspend());
    this.render();
  }

  suspend() {
    this.epoch++;
    this.controller?.abort();
    this.controller = undefined;
    if (this.busy)
      this.message = "取得を中止しました。保存済みの話題は保持しています。";
    this.busy = false;
    this.render();
  }

  private async load(force = false) {
    if (force && this.busy) return;
    this.controller?.abort();
    const ticket = ++this.epoch;
    const source = this.source.value as TrendSource;
    const controller = (this.controller = new AbortController());
    const current = () =>
      ticket === this.epoch && !controller.signal.aborted && this.root.open;
    this.busy = true;
    this.message = "保存済みの話題を確認しています…";
    this.render();
    let storageProblem = false;
    let saving = false;
    const timer = setTimeout(() => {
      if (!saving) controller.abort();
      if (ticket === this.epoch) {
        this.busy = false;
        this.message = saving
          ? "保存の完了を確認できていません。もう少し待つか、あとで確認してください。"
          : "時間内に取得できませんでした。接続後に更新してください。";
        this.render();
      }
    }, 16000);
    try {
      try {
        const saved = await readTrendSnapshot(source);
        if (!current()) return;
        this.snapshot = saved;
      } catch {
        storageProblem = true;
      }
      if (!current()) return;
      const age = this.snapshot
        ? Date.now() - Date.parse(this.snapshot.fetchedAt)
        : Infinity;
      if (!force && !storageProblem && age >= 0 && age < trendFreshMs) {
        this.message = "15分以内に取得した保存済みの話題を表示しています。";
        return;
      }
      this.message = this.snapshot
        ? "前回の話題を表示したまま更新しています…"
        : "話題を取得しています…";
      this.render();
      const snapshot = await fetchTrendSnapshot(source, controller.signal);
      if (!current()) return;
      try {
        saving = true;
        const retained = await saveTrendSnapshot(snapshot);
        if (!current()) return;
        this.snapshot = retained;
        this.message = "話題を取得し、このブラウザに保存しました。";
      } catch {
        if (!current()) return;
        this.snapshot = snapshot;
        this.message = storageProblem
          ? "話題を取得しましたが、保存領域を確認できません。今回は表示のみです。"
          : "話題を取得しましたが保存できませんでした。今回は表示のみです。";
      }
    } catch (error) {
      if (ticket !== this.epoch) return;
      this.message = controller.signal.aborted
        ? "時間内に取得できませんでした。接続後に更新してください。"
        : error instanceof Error
          ? error.message
          : "話題を取得できませんでした。";
      if (this.snapshot) this.message += " 前回の取得分を表示しています。";
    } finally {
      clearTimeout(timer);
      if (ticket === this.epoch) {
        this.busy = false;
        this.controller = undefined;
        this.render();
      }
    }
  }

  private render() {
    const config = trendSources.find(
      (source) => source.id === this.source.value,
    )!;
    // 更新中もキーボードの操作位置を保持し、重複取得は入口で防ぐ。
    this.refresh.setAttribute("aria-disabled", String(this.busy));
    this.refresh.setAttribute("aria-busy", String(this.busy));
    this.status.textContent = this.message;
    this.list.setAttribute("aria-busy", String(this.busy));
    this.metadata.textContent = this.snapshot
      ? `${config.scope} 取得日時：${new Date(this.snapshot.fetchedAt).toLocaleString("ja-JP")}`
      : config.scope;
    if (this.rendered === this.snapshot) return;
    this.rendered = this.snapshot;
    this.list.replaceChildren();
    for (const item of this.snapshot?.items ?? []) {
      const row = el("li");
      row.append(reference(item.title, item.url));
      if (item.published)
        row.append(
          el(
            "p",
            `配信元の日時：${new Date(item.published).toLocaleString("ja-JP")}`,
            "muted",
          ),
        );
      const words = el("div", undefined, "rss-trend-words");
      if (item.terms.length) {
        words.append(
          el(
            "span",
            config.id === "google" ? "検索キーワード：" : "見出し中の語句：",
            "muted",
          ),
        );
        for (const term of item.terms) {
          const word = button(term, () => this.lookup(term));
          word.setAttribute("aria-label", `辞書で調べる：${term}`);
          words.append(word);
        }
        row.append(words);
      }
      this.list.append(row);
    }
  }
}
