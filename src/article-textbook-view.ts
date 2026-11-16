import { button, el } from "./ui";
import { highlightVersion } from "./article-highlights";
import {
  listSharedTextbooks,
  readSharedTextbook,
} from "./shared-textbook-store";
import {
  readTextbookLinks,
  writeTextbookLink,
  textbookLinkKey,
  textbookLinkSource,
  textbookLinkTarget,
  textbookLinkDatabase,
  type TextbookLink,
  type TextbookReading,
} from "./article-textbooks";

type Choice = { target: TextbookLink["target"]; goal: string };
type Draft = {
  source: TextbookLink["source"];
  target?: TextbookLink["target"];
  reason: string;
  createdAt: string;
  expected: number | null;
  choices: Choice[];
};
/** 個人の入口情報をURLへ入れず、元の記事を残したまま不変の教材版を開く。 */
function textbookLink(id = "") {
  const url = new URL("/", location.origin);
  url.searchParams.set("view", "textbooks");
  if (id) url.searchParams.set("book", id);
  return url.href;
}
/** 別タブを閉じれば元の記事の位置へ戻れ、参照元のURLも教材側へ渡さない。 */
function separateLink(label: string, id = "") {
  const link = el("a", label, "rss-text-link");
  link.href = textbookLink(id);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
export class ArticleTextbookView {
  readonly root = el("section", undefined, "rss-connections rss-textbooks");
  private readonly details = el("details");
  private readonly summary = el("summary", "深掘りできる教材");
  private readonly status = el("p");
  private readonly list = el("ul");
  private readonly start = button("教材を関連づける", () => void this.begin());
  private readonly reload = button(
    "教材の関連づけを再読み込み",
    () => void this.load(),
  );
  private readonly editor = el("div");
  private readonly source = el("p");
  private readonly select = el("select");
  private readonly scope = el("p");
  private readonly preview = separateLink("教材の範囲と出典を確認（別タブ）");
  private readonly reason = el("textarea");
  private readonly save = button(
    "関連する理由を保存",
    () => void this.commit(),
  );
  private readonly continueDraft = button(
    "最新の理由を確認して下書きの編集を続ける",
    () => {
      const d = this.draft;
      if (!d?.target || this.busy || !this.ready) return;
      const latest = this.records.find((r) => r.target.id === d.target!.id);
      if (
        latest &&
        (JSON.stringify(latest.source) !== JSON.stringify(d.source) ||
          JSON.stringify(latest.target) !== JSON.stringify(d.target))
      ) {
        this.status.textContent =
          "登録時の記事や教材の版を確認できません。下書きは保持しています。";
        return;
      }
      d.expected = latest?.revision ?? null;
      if (latest) d.createdAt = latest.createdAt;
      this.status.textContent = latest
        ? "保存済みの最新の理由と下書きを比較してください。次に保存すると、下書きの理由で更新します。"
        : "関連づけは別の画面で削除されています。次に保存すると、保持した参照元と下書きの理由で作成し直します。";
      this.controls();
    },
  );
  private readonly cancel = button("関連づけの下書きを取り消す", () =>
    this.cancelDraft(),
  );
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(textbookLinkDatabase);
  private view?: TextbookReading;
  private records: TextbookLink[] = [];
  private draft?: Draft;
  private shownDraft?: Draft;
  private drafts = new Map<string, Draft>();
  private context = 0;
  private generation = 0;
  private ready = false;
  private busy = false;
  private rowButtons: HTMLButtonElement[] = [];

  constructor() {
    this.root.setAttribute("aria-label", "深掘りできる教材");
    this.status.setAttribute("role", "status");
    this.list.setAttribute("aria-label", "この記事に関連づけた教材");
    this.select.id = "rss-textbook-choice";
    const choiceLabel = el("label", "保存済みのテーマ教材");
    choiceLabel.htmlFor = this.select.id;
    this.reason.id = "rss-textbook-reason";
    this.reason.rows = 3;
    this.reason.maxLength = 2000;
    const reasonLabel = el("label", "この記事と関連する理由（必須）");
    reasonLabel.htmlFor = this.reason.id;
    this.editor.append(
      this.source,
      choiceLabel,
      this.select,
      this.scope,
      this.preview,
      reasonLabel,
      this.reason,
      this.continueDraft,
      this.save,
      this.cancel,
    );
    this.editor.hidden = true;
    this.select.addEventListener("change", () => {
      if (!this.draft || this.busy) return;
      this.draft.target = this.draft.choices.find(
        (c) => c.target.id === this.select.value,
      )?.target;
      this.showChoice();
      this.controls();
    });
    this.reason.addEventListener("input", () => {
      if (this.draft) this.draft.reason = this.reason.value;
      this.controls();
    });
    this.details.append(
      this.summary,
      el(
        "p",
        "自分で関連する理由を残し、保存済みの教材を複数の記事から開けます。教材は別タブで開くので、この記事の読書位置はそのままです。",
      ),
      this.status,
      this.start,
      separateLink("教材ファイルを取り込む（別タブ）"),
      this.reload,
      this.editor,
      this.list,
    );
    this.root.append(this.details);
    this.details.addEventListener("toggle", () => {
      if (this.details.open) void this.load();
      else {
        this.generation++;
        this.ready = false;
        this.controls();
      }
    });
    this.channel?.addEventListener("message", (event) => {
      if (
        (event.data === this.view?.articleId || event.data === "changed") &&
        this.root.isConnected &&
        this.details.open &&
        !this.busy
      )
        void this.load();
    });
    window.addEventListener("focus", () => {
      if (this.root.isConnected && this.details.open && !this.busy)
        void this.load();
    });
    this.controls();
  }
  mount(view: TextbookReading) {
    if (this.view?.articleId !== view.articleId) this.detach();
    this.view = view;
    this.draft = this.drafts.get(view.articleId);
    this.renderDraft();
    if (this.details.open && !this.busy) void this.load();
    return this.root;
  }
  detach() {
    this.context++;
    this.generation++;
    this.view = undefined;
    this.ready = false;
    this.records = [];
    this.draft = this.shownDraft = undefined;
    this.editor.hidden = true;
    this.list.replaceChildren();
    this.rowButtons = [];
    this.status.textContent = "";
    this.summary.textContent = "深掘りできる教材";
    this.details.open = false;
    this.controls();
  }
  private controls() {
    this.start.disabled = this.busy || !this.ready || !!this.draft;
    this.reload.disabled = this.busy;
    this.select.disabled = this.busy || this.draft?.expected !== null;
    this.reason.disabled = this.busy;
    this.save.disabled =
      this.busy ||
      !this.ready ||
      !this.draft?.target ||
      !this.reason.value.trim();
    this.cancel.disabled = this.busy;
    for (const control of this.rowButtons)
      control.disabled = this.busy || !this.ready || !!this.draft;
    const d = this.draft,
      latest =
        d?.target && this.records.find((r) => r.target.id === d.target!.id);
    this.continueDraft.hidden =
      !d ||
      !d.target ||
      (latest ? latest.revision === d.expected : d.expected === null);
    this.continueDraft.disabled = this.busy || !this.ready;
  }
  private renderDraft() {
    const d = this.draft;
    this.editor.hidden = !d;
    if (d && this.shownDraft !== d) {
      this.shownDraft = d;
      this.source.textContent = `関連づけを始めたときの記事：${d.source.title}（${d.source.view === "translation" ? "訳文" : "原文"}）\n${d.source.excerpt}`;
      this.select.replaceChildren();
      const empty = el("option", "教材を選んでください");
      empty.value = "";
      this.select.append(empty);
      for (const c of d.choices) {
        const option = el(
          "option",
          `${c.target.topicName} — ${c.target.title} · 版 ${c.target.id.split(":")[1]}`,
        );
        option.value = c.target.id;
        this.select.append(option);
      }
      this.select.value = d.target?.id ?? "";
      this.reason.value = d.reason;
    }
    this.showChoice();
    this.controls();
  }
  private showChoice() {
    const d = this.draft,
      target = d?.target;
    this.scope.textContent = target
      ? d!.choices.find((c) => c.target.id === target.id)?.goal ||
        "登録時に選んだ教材版です。範囲と出典は教材の画面で確認できます。"
      : "";
    this.preview.hidden = !target;
    this.preview.href = textbookLink(target?.id);
  }
  private cancelDraft() {
    if (this.busy) return;
    if (this.view) this.drafts.delete(this.view.articleId);
    this.draft = this.shownDraft = undefined;
    this.renderDraft();
    this.status.textContent =
      "下書きを取り消しました。保存済みの関連づけと教材は保持しています。";
  }
  private async begin(record?: TextbookLink) {
    if (!this.view || !this.ready || this.busy) return;
    if (this.draft) {
      this.status.textContent =
        "現在の下書きを保存または取り消してから、別の関連づけを編集してください。";
      return;
    }
    const view = { ...this.view },
      context = this.context;
    this.busy = true;
    this.controls();
    try {
      const choices = record
        ? [{ target: record.target, goal: "" }]
        : (await listSharedTextbooks())
            .filter(
              (b) =>
                b.request.schemaVersion === 2 &&
                !this.records.some((r) => r.target.id === b.id),
            )
            .map((b) => ({
              target: textbookLinkTarget(b),
              goal: b.request.learningGoal,
            }));
      const source = record?.source ?? (await textbookLinkSource(view));
      if (context !== this.context) return;
      if (!choices.length) {
        this.status.textContent =
          "関連づけられるテーマ教材がありません。教材ファイルを取り込むか、保存済みの関連づけを確認してください。";
        return;
      }
      this.draft = {
        source,
        target: record?.target,
        reason: record?.reason ?? "",
        expected: record?.revision ?? null,
        createdAt: record?.createdAt ?? new Date().toISOString(),
        choices,
      };
      this.drafts.set(view.articleId, this.draft);
      this.status.textContent =
        "関連する理由はこの記事用の個人記録です。教材ファイルには含めません。下書きはこの画面を開いている間、記事を切り替えても残ります。";
      this.renderDraft();
    } catch (error) {
      if (context === this.context)
        this.status.textContent = this.message(error);
    } finally {
      this.busy = false;
      this.controls();
      if (
        context === this.context &&
        this.draft &&
        this.root.isConnected &&
        this.details.open
      )
        this.reason.focus();
    }
  }
  private async commit() {
    const draft = this.draft,
      target = draft?.target;
    if (!draft || !target || !this.view || this.busy || !this.ready) return;
    const context = this.context;
    this.busy = true;
    this.controls();
    try {
      await writeTextbookLink(
        {
          id: textbookLinkKey(draft.source.articleId, target.id),
          source: draft.source,
          target,
          reason: draft.reason.trim(),
          createdAt: draft.createdAt,
          revision: (draft.expected ?? 0) + 1,
        },
        draft.expected,
      );
      if (this.drafts.get(draft.source.articleId) === draft)
        this.drafts.delete(draft.source.articleId);
      this.channel?.postMessage(draft.source.articleId);
      if (this.draft === draft) {
        this.draft = this.shownDraft = undefined;
        this.renderDraft();
      }
      if (context === this.context)
        this.status.textContent = "記事と教材の関連づけを保存しました。";
      if (this.view?.articleId === draft.source.articleId) await this.load();
    } catch (error) {
      if (context === this.context)
        this.status.textContent = this.message(error);
    } finally {
      this.busy = false;
      this.controls();
    }
  }
  private async remove(record: TextbookLink) {
    if (this.busy || !this.ready) return;
    const context = this.context;
    this.busy = true;
    this.controls();
    try {
      await writeTextbookLink(record, record.revision, true);
      this.channel?.postMessage(record.source.articleId);
      if (context === this.context)
        this.status.textContent =
          "この記事との関連づけを外しました。教材・回答・他の記事の関連づけは保持しています。";
      if (this.view?.articleId === record.source.articleId) await this.load();
    } catch (error) {
      if (context === this.context)
        this.status.textContent = this.message(error);
    } finally {
      this.busy = false;
      this.controls();
    }
  }
  private async load() {
    if (!this.view || !this.details.open || !this.root.isConnected) return;
    const view = { ...this.view };
    const generation = ++this.generation,
      context = this.context,
      focused = document.activeElement;
    const focusedItem =
      focused instanceof HTMLElement && this.list.contains(focused)
        ? {
            id: focused.closest<HTMLLIElement>("li[data-link]")?.dataset.link,
            action: focused.dataset.action,
          }
        : undefined;
    this.ready = false;
    this.controls();
    try {
      const records = await readTextbookLinks(view.articleId);
      const version = await highlightVersion(
        view.original,
        view.text,
        view.view,
        view.language,
      );
      const available = await Promise.all(
        records.map(async (r) => {
          try {
            const book = await readSharedTextbook(r.target.id);
            return (
              !!book &&
              JSON.stringify(textbookLinkTarget(book)) ===
                JSON.stringify(r.target)
            );
          } catch {
            return false;
          }
        }),
      );
      if (generation !== this.generation || context !== this.context) return;
      this.records = records;
      this.ready = true;
      this.summary.textContent = `深掘りできる教材 · ${records.length}件${this.draft ? " · 下書きあり" : ""}`;
      const keepFocus = focusedItem && document.activeElement === focused;
      const expanded = new Set(
        Array.from(this.list.querySelectorAll<HTMLLIElement>("li[data-link]"))
          .filter((item) => item.querySelector("details")?.open)
          .map((item) => item.dataset.link),
      );
      this.list.replaceChildren();
      this.rowButtons = [];
      if (!records.length)
        this.list.append(
          el("li", "この記事に関連づけた教材はまだありません。"),
        );
      for (const [i, record] of records.entries()) {
        const item = el("li"),
          snapshot = el("details");
        item.dataset.link = record.id;
        const read = separateLink(
          available[i]
            ? "教材を読む（別タブ）"
            : "教材の保存先を確認（別タブ）",
          record.target.id,
        );
        read.dataset.action = "read";
        snapshot.open = expanded.has(record.id);
        snapshot.append(
          el("summary", "関連づけたときの記事（先頭の抜粋）"),
          el("p", record.source.excerpt),
        );
        item.append(
          el("h3", `${record.target.topicName} — ${record.target.title}`),
          el("p", record.reason),
          el(
            "p",
            available[i]
              ? "保存済みの教材版を開けます。"
              : "このライブラリで教材の版を確認できません。教材ファイルと関連づけを確認して再読み込みしてください。",
          ),
          read,
          snapshot,
        );
        if (record.source.version !== version)
          item.append(
            el(
              "p",
              "登録時と表示中の本文・言語・原文／訳文が異なります。関連理由は登録時の表示内容に結び付いています。",
            ),
          );
        const edit = button(
            "関連する理由を編集",
            () => void this.begin(record),
          ),
          unlink = button(
            "この記事との関連づけを外す",
            () => void this.remove(record),
          );
        edit.dataset.action = "edit";
        unlink.dataset.action = "unlink";
        edit.disabled = unlink.disabled = this.busy || !this.ready;
        this.rowButtons.push(edit, unlink);
        item.append(edit, unlink);
        this.list.append(item);
      }
      this.renderDraft();
      if (keepFocus && focusedItem?.id) {
        const item = Array.from(this.list.children).find(
          (n) => (n as HTMLElement).dataset.link === focusedItem.id,
        );
        Array.from(item?.querySelectorAll<HTMLElement>("[data-action]") ?? [])
          .find((n) => n.dataset.action === focusedItem.action)
          ?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (generation === this.generation && context === this.context)
        this.status.textContent = this.message(error);
    } finally {
      if (generation === this.generation && context === this.context)
        this.controls();
    }
  }
  private message(error: unknown) {
    if (
      error instanceof DOMException ||
      (error instanceof Error && error.name === "ZodError")
    )
      return "関連づけを処理できません。保存領域や入力内容を確認して再試行してください。保存済みの記録と下書きは保持しています。";
    return error instanceof Error
      ? error.message
      : "関連づけを処理できませんでした。保存済みの記録と下書きは保持しています。";
  }
}
