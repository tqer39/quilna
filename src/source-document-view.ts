import { button, el } from "./ui";
import { documentHistory, documentDatabase } from "./source-document-store";
import type { ArticleContent } from "./article-content";
import type { DocumentVersion } from "./source-document";

export class SourceDocumentView {
  readonly root = el("details", undefined, "rss-document-history");
  private readonly status = el("p", "", "muted");
  private readonly list = el("div");
  private readonly previous = button(
    "以前の本文を見る",
    () => void this.load(true),
  );
  private readonly refresh = button(
    "元サイトの更新を確認",
    () => void this.refreshSource(),
  );
  private generation = 0;
  private active?: ArticleContent;
  private busy = false;
  private articleId?: string;
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(documentDatabase);
  private cursor?: [string, string];
  constructor(
    private readonly update: () => Promise<void>,
    private readonly choose: (version: DocumentVersion) => Promise<void>,
    private readonly prepare: () => Promise<void>,
  ) {
    this.root.append(
      el("summary", "本文の保存履歴"),
      el(
        "p",
        "このブラウザに保存した本文の版です。更新を確認しても過去の本文は保持します。既読・保存・引用は記事ごとに残ります。",
        "muted",
      ),
      this.refresh,
      this.status,
      this.list,
      this.previous,
      button("保存履歴を再読み込み", () => void this.load()),
    );
    this.status.setAttribute("role", "status");
    this.previous.hidden = true;
    this.root.addEventListener("toggle", () => {
      this.generation++;
      if (this.root.open) void this.load();
    });
    this.channel?.addEventListener("message", () => {
      if (this.root.open && this.root.isConnected && !this.busy)
        void this.load();
    });
  }
  show(content: ArticleContent | undefined, busy = false, articleId?: string) {
    const moved = this.articleId !== articleId;
    this.articleId = articleId;
    const changed =
      moved ||
      this.active?.document?.versionId !== content?.document?.versionId;
    this.active = content;
    this.busy = busy;
    this.root.hidden = !content;
    this.refresh.disabled = busy;
    for (const button of Array.from(this.list.querySelectorAll("button")))
      button.disabled =
        busy || button.dataset.version === content?.document?.versionId;
    if (moved) {
      this.root.open = false;
      this.status.textContent = "";
      this.cursor = undefined;
    }
    if (changed) {
      this.generation++;
      this.list.replaceChildren();
      this.previous.hidden = true;
      if (this.root.open) void this.load();
    }
  }
  private async refreshSource() {
    if (this.busy) return;
    await this.update();
    if (this.root.open) await this.load();
  }
  private async load(older = false) {
    const generation = ++this.generation;
    if (!this.active?.document) {
      try {
        await this.prepare();
      } catch (error) {
        if (generation === this.generation && this.root.open)
          this.status.textContent = (error as Error).message;
      }
      return;
    }
    const ref = this.active?.document;
    if (!ref) return;
    this.previous.disabled = true;
    this.status.textContent = "本文の保存履歴を読み込んでいます…";
    try {
      const result = await documentHistory(
        ref.documentId,
        ref.scope,
        older ? this.cursor : undefined,
      );
      if (generation !== this.generation || !this.root.open) return;
      if (!older) this.list.replaceChildren();
      for (const version of result.versions) {
        const row = el("div", undefined, "rss-document-version"),
          current = version.id === ref.versionId;
        row.append(
          el(
            "p",
            `${new Date(version.createdAt).toLocaleString("ja-JP")}${current ? " · 表示中" : ""}`,
          ),
          el("p", version.content.text.slice(0, 160), "muted"),
        );
        const use = button("この本文を表示", async () => {
          if (this.busy) return;
          use.disabled = true;
          try {
            await this.choose(version);
          } catch (error) {
            if (generation === this.generation)
              this.status.textContent = (error as Error).message;
          } finally {
            use.disabled = current || this.busy;
          }
        });
        use.disabled = current || this.busy;
        use.dataset.version = version.id;
        row.append(use);
        this.list.append(row);
      }
      const last = result.versions.at(-1);
      this.cursor = last ? [last.createdAt, last.id] : undefined;
      this.previous.hidden = !result.more;
      this.previous.disabled = false;
      this.status.textContent = result.versions.length
        ? "選んだ版をこの記事の本文として表示できます。共有サービスへの公開はしていません。"
        : "保存された本文がありません。";
    } catch (error) {
      if (generation !== this.generation) return;
      this.status.textContent = (error as Error).message;
      this.previous.hidden = false;
      this.previous.disabled = false;
    }
  }
}
