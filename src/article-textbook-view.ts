import { button, el } from "./ui";
import { highlightVersion } from "./article-highlights";
import {
  listSharedTextbooks,
  readSharedTextbook,
  readTextbookNotices,
  sharedTextbookDatabase,
} from "./shared-textbook-store";
import { textbookNoticeSummary } from "./textbook-notice-view";
import {
  topicTextbookCandidates,
  type TextbookChoice,
  type TopicTextbookCandidate,
} from "./topic-textbook-candidates";
import {
  readHiddenTextbookTopics,
  setTextbookTopicHidden,
  topicPreferenceDatabase,
  type HiddenTextbookTopic,
} from "./topic-textbook-preferences";
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

type Choice = TextbookChoice;
type Candidate = TopicTextbookCandidate & {
  articleId: string;
  version: string;
  generation: number;
};
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
  private readonly candidateArea = el("section");
  private readonly candidateStatus = el("p");
  private readonly candidateList = el("ul");
  private readonly hiddenDetails = el("details");
  private readonly hiddenSummary = el("summary", "非表示にしたテーマを確認");
  private readonly hiddenList = el("ul");
  private candidateConnects: HTMLButtonElement[] = [];
  private preferenceButtons: HTMLButtonElement[] = [];
  private preferenceError: unknown;
  private preferenceFeedback = "";
  private readonly start = button("教材を関連づける", () => void this.begin());
  private readonly reload = button(
    "教材の関連づけを再読み込み",
    () => void this.load(),
  );
  private readonly editor = el("div");
  private readonly source = el("p");
  private readonly sourceNotice = el("p");
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
      this.renderDraft();
      this.reason.focus();
    },
  );
  private readonly cancel = button("関連づけの下書きを取り消す", () =>
    this.cancelDraft(),
  );
  private readonly channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(textbookLinkDatabase);
  private readonly editionChannel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(sharedTextbookDatabase);
  private readonly preferenceChannel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(topicPreferenceDatabase);
  private view?: TextbookReading;
  private records: TextbookLink[] = [];
  private draft?: Draft;
  private shownDraft?: Draft;
  private shownChoices = "";
  private drafts = new Map<string, Draft>();
  private context = 0;
  private generation = 0;
  private ready = false;
  private currentVersion?: string;
  private busy = false;
  private rowButtons: HTMLButtonElement[] = [];

  constructor() {
    this.root.setAttribute("aria-label", "深掘りできる教材");
    this.status.setAttribute("role", "status");
    this.list.setAttribute("aria-label", "この記事に関連づけた教材");
    this.candidateArea.setAttribute("aria-label", "保存済み教材の候補");
    this.candidateList.setAttribute("aria-label", "本文から見つかった教材候補");
    this.hiddenList.setAttribute("aria-label", "この記事で非表示にしたテーマ");
    this.candidateStatus.setAttribute("aria-live", "polite");
    this.candidateStatus.tabIndex = -1;
    this.hiddenDetails.append(
      this.hiddenSummary,
      el(
        "p",
        "非表示はこのブラウザーのライブラリに保存します。教材ファイルと記事バックアップには含めず、別の端末とは同期しません。",
      ),
      this.hiddenList,
    );
    this.candidateArea.append(
      el("h3", "本文から深掘りできる候補"),
      el(
        "p",
        "本文とテーマ名が一致する保存済み教材を最大3件示します。意味の理解や内容の正しさを検証した結果ではありません。範囲と出典を確認して選んでください。",
      ),
      this.candidateStatus,
      this.candidateList,
      this.hiddenDetails,
    );
    this.select.id = "rss-textbook-choice";
    const choiceLabel = el("label", "保存済みのテーマ教材");
    choiceLabel.htmlFor = this.select.id;
    this.reason.id = "rss-textbook-reason";
    this.reason.rows = 3;
    this.reason.maxLength = 2000;
    this.sourceNotice.id = "rss-textbook-source-notice";
    this.sourceNotice.setAttribute("aria-live", "polite");
    this.sourceNotice.setAttribute("aria-atomic", "true");
    this.reason.setAttribute("aria-describedby", this.sourceNotice.id);
    this.select.setAttribute("aria-describedby", this.sourceNotice.id);
    const reasonLabel = el("label", "この記事と関連する理由（必須）");
    reasonLabel.htmlFor = this.reason.id;
    this.editor.append(
      this.source,
      this.sourceNotice,
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
      this.candidateArea,
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
      if (event.data === this.view?.articleId || event.data === "changed")
        this.refresh();
    });
    this.editionChannel?.addEventListener("message", () => {
      this.refresh();
    });
    this.preferenceChannel?.addEventListener("message", (event) => {
      if (event.data === this.view?.articleId) this.refresh();
    });
    window.addEventListener("focus", () => {
      this.refresh();
    });
    this.controls();
  }
  mount(view: TextbookReading) {
    if (this.view?.articleId !== view.articleId) this.detach();
    const readingChanged =
      this.view &&
      ["original", "text", "view", "language"].some(
        (key) =>
          this.view?.[key as keyof TextbookReading] !==
          view[key as keyof TextbookReading],
      );
    const shouldReload = !!readingChanged || !this.ready;
    if (readingChanged) {
      this.preferenceFeedback = "";
      this.generation++;
      this.ready = false;
      this.currentVersion = undefined;
      this.list.replaceChildren();
      this.candidateList.replaceChildren();
      this.candidateList.hidden = true;
      this.candidateStatus.textContent = "現在の本文で候補を確認しています。";
      this.rowButtons = [];
      this.summary.textContent = "深掘りできる教材";
    }
    this.view = view;
    this.draft = this.drafts.get(view.articleId);
    this.renderDraft();
    this.controls();
    // 記事の再描画ではmount時点で未接続なので、再接続後に現在の表示を照合する。
    queueMicrotask(() => {
      if (shouldReload && this.view === view && this.details.open && !this.busy)
        void this.load();
    });
    return this.root;
  }
  detach() {
    this.context++;
    this.generation++;
    this.view = undefined;
    this.ready = false;
    this.currentVersion = undefined;
    this.records = [];
    this.draft = this.shownDraft = undefined;
    this.editor.hidden = true;
    this.list.replaceChildren();
    this.candidateList.replaceChildren();
    this.hiddenList.replaceChildren();
    this.candidateList.hidden = this.hiddenDetails.hidden = true;
    this.hiddenDetails.open = false;
    this.candidateConnects = [];
    this.preferenceButtons = [];
    this.preferenceError = undefined;
    this.preferenceFeedback = "";
    this.candidateStatus.textContent = "";
    this.rowButtons = [];
    this.status.textContent = "";
    this.summary.textContent = "深掘りできる教材";
    this.details.open = false;
    this.controls();
  }
  private controls() {
    this.start.disabled = this.busy || !this.ready || !!this.draft;
    this.reload.disabled = this.busy;
    this.select.disabled =
      this.busy || !this.ready || this.draft?.expected !== null;
    this.reason.disabled = this.busy;
    this.save.disabled =
      this.busy ||
      !this.ready ||
      !this.choiceAvailable() ||
      !this.reason.value.trim();
    this.cancel.disabled = this.busy;
    for (const control of this.rowButtons)
      control.disabled = this.busy || !this.ready || !!this.draft;
    for (const control of this.candidateConnects)
      control.disabled =
        this.busy || !this.ready || !!this.draft || !!this.preferenceError;
    for (const control of this.preferenceButtons)
      control.disabled = this.busy || !this.ready || !!this.preferenceError;
    const d = this.draft,
      latest =
        d?.target && this.records.find((r) => r.target.id === d.target!.id);
    this.continueDraft.hidden =
      !d ||
      !d.target ||
      (latest ? latest.revision === d.expected : d.expected === null);
    this.continueDraft.disabled = this.busy || !this.ready;
  }
  private refresh() {
    if (!this.root.isConnected || !this.details.open) return;
    if (this.busy) {
      // 待機中の古い照合を無効にし、下書きを残したままfinallyで読み直す。
      this.generation++;
      this.ready = false;
      this.controls();
    } else void this.load();
  }
  private choiceAvailable() {
    const d = this.draft;
    return (
      !!d?.target &&
      (d.expected !== null ||
        d.choices.some(
          (c) => JSON.stringify(c.target) === JSON.stringify(d.target),
        ))
    );
  }
  private async choicePool(records: TextbookLink[], preserveId?: string) {
    const books = await listSharedTextbooks();
    const notices = await readTextbookNotices(books);
    const choices = books
      .map((b, i) => ({ book: b, state: notices[i] }))
      .filter(
        ({ book: b, state }) =>
          b.request.schemaVersion === 2 &&
          !state.error &&
          state.notice?.kind !== "withdrawn" &&
          (b.id === preserveId || !records.some((r) => r.target.id === b.id)),
      )
      .map(({ book: b, state }) => ({
        choice: { target: textbookLinkTarget(b), goal: b.request.learningGoal },
        automatic:
          state.notice?.kind !== "correction" ||
          state.replacementState === "available",
      }));
    return {
      unavailable: notices.some((n) => n.error),
      choices: choices.map((c) => c.choice),
      candidates: choices
        .filter(
          (c) =>
            c.automatic &&
            !records.some((r) => {
              const [bookId, version] = r.target.id.split(":");
              const [candidateBookId, candidateVersion] =
                c.choice.target.id.split(":");
              return (
                bookId === candidateBookId &&
                Number(version) >= Number(candidateVersion)
              );
            }),
        )
        .map((c) => c.choice),
    };
  }
  private renderCandidates(
    candidates: Candidate[],
    hidden: HiddenTextbookTopic[],
    unavailable: boolean,
    candidateError?: unknown,
  ) {
    this.candidateConnects = [];
    this.preferenceButtons = [];
    this.candidateList.replaceChildren();
    this.hiddenList.replaceChildren();
    this.candidateList.hidden = !candidates.length;
    this.hiddenDetails.hidden = !hidden.length;
    this.hiddenSummary.textContent = `非表示にしたテーマを確認 · ${hidden.length}件`;
    let message =
      this.preferenceError || candidateError
        ? this.message(this.preferenceError || candidateError)
        : this.preferenceFeedback ||
          (candidates.length
            ? "候補は未確認です。関連づけは自分で理由を確認して保存します。"
            : "本文のテーマ名と一致する保存済み教材の候補はありません。手動で関連づける教材も選べます。");
    if (!this.preferenceError && !candidateError && unavailable)
      message +=
        " 訂正・撤回の記録を確認できない教材版は候補から外しています。";
    if (this.candidateStatus.textContent !== message)
      this.candidateStatus.textContent = message;
    for (const c of candidates) {
      const item = el("li");
      item.dataset.candidate = c.choice.target.id;
      const preview = separateLink(
        "候補の範囲と出典を確認（別タブ）",
        c.choice.target.id,
      );
      preview.dataset.action = "preview";
      const choose = button(
        "この候補を関連づける",
        () => void this.begin(undefined, c),
      );
      choose.dataset.action = "choose";
      const hide = button(
        "この記事ではこのテーマを候補に出さない",
        () => void this.changeHidden(c.choice.target, true),
      );
      hide.dataset.action = "hide";
      item.append(
        el(
          "h4",
          `${c.choice.target.topicName} — ${c.choice.target.title} · 版 ${c.choice.target.id.split(":")[1]}`,
        ),
        el("p", c.choice.goal),
        el(
          "p",
          `候補の理由：表示中の本文にテーマ名「${c.matched}」があります。`,
        ),
        el("blockquote", c.quote),
        preview,
        choose,
        hide,
      );
      this.candidateList.append(item);
      this.candidateConnects.push(choose);
      this.preferenceButtons.push(hide);
    }
    for (const topic of hidden) {
      const item = el("li");
      item.dataset.hiddenTopic = topic.topicId;
      const restore = button(
        "このテーマの候補を再び確認する",
        () => void this.changeHidden(topic, false),
      );
      restore.dataset.action = "restore";
      item.append(el("span", topic.topicName), restore);
      this.hiddenList.append(item);
      this.preferenceButtons.push(restore);
    }
  }
  private async changeHidden(
    topic: { topicId: string; topicName: string },
    hidden: boolean,
  ) {
    if (!this.view || !this.ready || this.busy || this.preferenceError) return;
    const articleId = this.view.articleId,
      context = this.context;
    const focused = document.activeElement;
    this.busy = true;
    this.controls();
    try {
      await setTextbookTopicHidden(articleId, topic, hidden);
      this.preferenceChannel?.postMessage(articleId);
      if (context === this.context)
        this.preferenceFeedback = hidden
          ? "この記事ではこのテーマの候補を非表示にしました。確定リンク・教材・回答は保持しています。"
          : "このテーマを候補として再び確認できるようにしました。";
    } catch (error) {
      if (context === this.context)
        this.preferenceFeedback = this.message(error);
    } finally {
      this.busy = false;
      if (this.view?.articleId === articleId || !this.ready) await this.load();
      this.controls();
      if (
        context === this.context &&
        this.root.isConnected &&
        this.details.open &&
        focused instanceof HTMLElement &&
        (!focused.isConnected || document.activeElement === document.body)
      )
        this.candidateStatus.focus({ preventScroll: true });
    }
  }
  private renderDraft() {
    const d = this.draft;
    this.editor.hidden = !d;
    const mismatch =
      !!d && !!this.currentVersion && d.source.version !== this.currentVersion;
    this.sourceNotice.hidden = !mismatch;
    const notice = mismatch
      ? "表示中の本文・言語・原文／訳文と、下書きの参照元が異なります。保存しても参照元は移動しません。" +
        (d.expected === null
          ? "現在の表示を使う場合は、下書きを取り消して作成し直してください。"
          : "現在の表示に関連づけ直す場合は、下書きを取り消してから、保存済みの関連づけを外して作成し直してください。")
      : "";
    if (this.sourceNotice.textContent !== notice)
      this.sourceNotice.textContent = notice;
    if (d && this.shownDraft !== d) {
      this.shownDraft = d;
      this.source.textContent = `関連づけを始めたときの記事：${d.source.title}（${d.source.view === "translation" ? "訳文" : "原文"}）\n${d.source.excerpt}`;
      this.reason.value = d.reason;
    }
    if (d) {
      const choices =
        d.expected !== null && d.target
          ? [{ target: d.target, goal: "" }]
          : d.choices;
      const key = JSON.stringify(choices);
      if (key !== this.shownChoices) {
        this.shownChoices = key;
        this.select.replaceChildren();
        const empty = el("option", "教材を選んでください");
        empty.value = "";
        this.select.append(empty);
        for (const c of choices) {
          const option = el(
            "option",
            `${c.target.topicName} — ${c.target.title} · 版 ${c.target.id.split(":")[1]}`,
          );
          option.value = c.target.id;
          this.select.append(option);
        }
      }
      this.select.value = d.target?.id ?? "";
    } else this.shownChoices = "";
    this.showChoice();
    this.controls();
  }
  private showChoice() {
    const d = this.draft,
      target = d?.target;
    this.scope.textContent =
      target && !this.choiceAvailable()
        ? "選んだ教材版は撤回されているか、確認できません。理由と参照元は保持しています。別の版を選ぶか、保存済みの記録を確認してください。"
        : target
          ? d!.choices.find((c) => c.target.id === target.id)?.goal ||
            "登録時に選んだ教材版です。範囲と出典は教材の画面で確認できます。"
          : d && !d.choices.length
            ? "現在、この下書きに選べる教材がありません。保存済みの版と訂正・撤回の記録を確認してください。"
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
  private async begin(record?: TextbookLink, candidate?: Candidate) {
    if (!this.view || !this.ready || this.busy) return;
    if (this.draft) {
      this.status.textContent =
        "現在の下書きを保存または取り消してから、別の関連づけを編集してください。";
      return;
    }
    if (
      candidate &&
      (candidate.generation !== this.generation ||
        candidate.articleId !== this.view.articleId ||
        candidate.version !== this.currentVersion ||
        !this.view.text.includes(candidate.quote))
    ) {
      this.candidateStatus.textContent =
        "本文や候補の状態が変わっています。読み直してから確認してください。";
      return;
    }
    const view = { ...this.view },
      context = this.context;
    this.busy = true;
    this.controls();
    try {
      const pool = record
        ? {
            choices: [{ target: record.target, goal: "" }],
            candidates: [],
            unavailable: false,
          }
        : await this.choicePool(this.records);
      const choices = pool.choices;
      const selected =
        candidate &&
        pool.candidates.find(
          (c) =>
            JSON.stringify(c.target) ===
            JSON.stringify(candidate.choice.target),
        );
      if (candidate && !selected)
        throw Error(
          "この候補の教材版を確認できなくなりました。読み直して確認してください。",
        );
      const source = record?.source ?? (await textbookLinkSource(view));
      if (context !== this.context) return;
      if (!choices.length) {
        this.status.textContent = pool.unavailable
          ? "訂正・撤回の記録を確認できない版は選択肢から外しています。再読み込みして確認してください。不明な保存形式の場合は対応するアプリの版を使ってください。"
          : "関連づけられるテーマ教材がありません。教材ファイルを取り込むか、保存済みの関連づけを確認してください。";
        return;
      }
      this.draft = {
        source,
        target: record?.target ?? (selected ? selected.target : undefined),
        reason:
          record?.reason ??
          (candidate
            ? `本文の「${candidate.quote}」を、テーマ「${candidate.choice.target.topicName}」の教材で深掘りする。`
            : ""),
        expected: record?.revision ?? null,
        createdAt: record?.createdAt ?? new Date().toISOString(),
        choices,
      };
      this.drafts.set(view.articleId, this.draft);
      this.status.textContent =
        "関連する理由はこの記事用の個人記録です。教材ファイルには含めません。下書きはこの画面を開いている間、記事を切り替えても残ります。";
      if (pool.unavailable)
        this.status.textContent +=
          " 訂正・撤回の記録を確認できない版は選択肢から外しています。";
      this.renderDraft();
    } catch (error) {
      if (context === this.context)
        this.status.textContent = this.message(error);
    } finally {
      this.busy = false;
      // 候補待ち中の再描画で無効になった照合を、処理完了時にも回復する。
      if (!this.ready) await this.load();
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
    if (
      !draft ||
      !target ||
      !this.view ||
      this.busy ||
      !this.ready ||
      !this.choiceAvailable()
    )
      return;
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
      if (!this.ready) await this.load();
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
      if (!this.ready) await this.load();
      this.controls();
    }
  }
  private async load() {
    if (!this.view || !this.details.open || !this.root.isConnected) return;
    const view = { ...this.view },
      draft = this.draft;
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
    const candidateFocus =
      focused instanceof HTMLElement &&
      this.candidateArea.contains(focused) &&
      focused.dataset.action
        ? {
            id: focused.closest<HTMLLIElement>("li[data-candidate]")?.dataset
              .candidate,
            topic: focused.closest<HTMLLIElement>("li[data-hidden-topic]")
              ?.dataset.hiddenTopic,
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
            if (
              !book ||
              JSON.stringify(textbookLinkTarget(book)) !==
                JSON.stringify(r.target)
            )
              return undefined;
            return (await readTextbookNotices([book]))[0];
          } catch {
            return undefined;
          }
        }),
      );
      let pool: Awaited<ReturnType<ArticleTextbookView["choicePool"]>> = {
          choices: [],
          candidates: [],
          unavailable: true,
        },
        candidateError: unknown;
      // 候補の障害が、保存済みリンクの確認・編集・解除まで止めないよう分ける。
      try {
        pool = await this.choicePool(
          records,
          draft?.expected === null ? draft.target?.id : undefined,
        );
      } catch {
        candidateError = Error(
          "教材一覧を確認できないため候補を停止しています。保存済みの関連づけ・教材・回答・下書きは保持しています。",
        );
      }
      let hidden: HiddenTextbookTopic[] = [],
        preferenceError: unknown;
      try {
        hidden = await readHiddenTextbookTopics(view.articleId);
      } catch (error) {
        preferenceError = error;
      }
      if (generation !== this.generation || context !== this.context) return;
      if (draft?.expected === null && this.draft === draft)
        draft.choices = pool.choices;
      this.preferenceError = preferenceError;
      const hiddenIds = new Set(hidden.map((r) => r.topicId));
      const candidates = preferenceError
        ? []
        : topicTextbookCandidates(
            view.text,
            pool.candidates.filter((c) => !hiddenIds.has(c.target.topicId)),
          ).map((c) => ({
            ...c,
            version,
            generation,
            articleId: view.articleId,
          }));
      this.currentVersion = version;
      this.records = records;
      this.ready = true;
      this.summary.textContent = `深掘りできる教材 · ${records.length}件${this.draft ? " · 下書きあり" : ""}`;
      const keepFocus = focusedItem && document.activeElement === focused;
      const keepCandidateFocus =
        candidateFocus && document.activeElement === focused;
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
        if (available[i]?.notice)
          item.append(
            textbookNoticeSummary(
              available[i]!.notice,
              available[i]!.replacementState,
              true,
            ),
          );
        if (available[i]?.error)
          item.append(
            el(
              "p",
              "この教材版の訂正・撤回の記録を確認できません。保存済みの教材と記録を確認してください。",
            ),
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
      this.renderCandidates(
        candidates,
        hidden,
        pool.unavailable,
        candidateError,
      );
      if (keepCandidateFocus) {
        const item = [
          ...Array.from(this.candidateList.children),
          ...Array.from(this.hiddenList.children),
        ].find((n) =>
          candidateFocus.id
            ? (n as HTMLElement).dataset.candidate === candidateFocus.id
            : (n as HTMLElement).dataset.hiddenTopic === candidateFocus.topic,
        );
        (
          Array.from(
            item?.querySelectorAll<HTMLElement>("[data-action]") ?? [],
          ).find((n) => n.dataset.action === candidateFocus.action) ??
          this.candidateStatus
        ).focus({ preventScroll: true });
      }
      if (keepFocus && focusedItem?.id) {
        const item = Array.from(this.list.children).find(
          (n) => (n as HTMLElement).dataset.link === focusedItem.id,
        );
        const actions = Array.from(
          item?.querySelectorAll<HTMLElement>("[data-action]") ?? [],
        );
        (
          actions.find((n) => n.dataset.action === focusedItem.action) ??
          actions.find((n) => n.dataset.action === "read")
        )?.focus({ preventScroll: true });
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
