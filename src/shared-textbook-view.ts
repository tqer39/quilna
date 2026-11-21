import { localTextbookView } from "./local-textbook-view";
import { topicGenerationView } from "./topic-generation-view";
import { topicJobView } from "./topic-job-view";
import { topicCreationView } from "./topic-creation-view";
import { applyReaderDesign } from "./reader-design";
import "./reader-design.css";
import "./reader-experience.css";
import { textbookNoticeView } from "./textbook-notice-view";
import { hasAccountLibrary } from "./library-context";
import { button, el } from "./ui";
import {
  pushReaderURL,
  revealReaderAnchor,
  textbookSectionAnchor,
} from "./reader-route";
import {
  parseSharedTextbook,
  sharedTextbookMaximumBytes,
  type SharedTextbook,
  type SharedCitation,
} from "./shared-textbook-format";
import {
  importSharedTextbook,
  listSharedTextbooks,
  readSharedTextbook,
  readSharedAnswers,
  answerSharedTextbook,
  readTextbookNotices,
  eligibleTopicEditions,
  ownTextbookImport,
  sharedTextbookDatabase,
  type TextbookNoticeState,
  type SharedAnswer,
} from "./shared-textbook-store";

/** Display an explicit failure when an operation cannot safely publish its result. */
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "処理できませんでした。保存済みデータは保持しています。";
const reviewLabels: Record<string, string> = {
  factualGrounding: "事実と出典の整合性",
  prerequisites: "前提知識",
  workedExample: "具体例",
  questionUnambiguous: "問題の明確さ",
  correctAnswerSupported: "正答の根拠",
  distractorsExplained: "誤答の解説",
};
/** Preserve the portable reference epoch and explicitly label absent or undisplayable dates. */
const sourceDate = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return "不明";
  const d = new Date((seconds + 978307200) * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "表示できない日時";
};
/** Preview the exact selected edition and included excerpts without loading source URLs. */
function overview(book: SharedTextbook) {
  const content = el("div");
  content.append(
    el("h3", book.draft.title),
    el(
      "p",
      `版 ${book.record.version} · ${book.draft.lessons.length}節 · 作成日時 ${sourceDate(book.record.createdAt)}`,
    ),
    el("p", `学習目標：${book.request.learningGoal}`),
  );
  if (book.request.schemaVersion === 2)
    content.append(
      el("p", `テーマ：${book.request.topic.name}`),
      el("p", `テーマ識別子：${book.request.topic.id}`),
    );
  const sections = el("ol");
  for (const lesson of book.draft.lessons)
    sections.append(el("li", lesson.content.title));
  content.append(
    sections,
    el(
      "p",
      "含まれる出典・引用を確認してください。ファイルを渡すと、次の原文抜粋と学習目標も相手へ渡ります。共有してよい内容かは自分で確認してください。",
    ),
  );
  for (const source of book.request.sources) {
    const detail = el("details"),
      title = el("summary", source.title);
    detail.append(title);
    if (source.url) {
      const link = el("a", source.url);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      detail.append(link);
    } else detail.append(el("p", "元のURL：不明"));
    detail.append(
      el(
        "p",
        `公開日時 ${sourceDate(source.publishedAt)} · 更新日時 ${sourceDate(source.updatedAt)} · 取得日時 ${sourceDate(source.capturedAt)}`,
      ),
    );
    if ("translation" in source && source.translation)
      detail.append(
        el(
          "p",
          `選択された訳文（${source.translation.targetLanguage}）。元の出典との対応をファイルに保持します。`,
        ),
      );
    detail.append(el("blockquote", source.excerpt));
    content.append(detail);
  }
  const reviews = el("details");
  reviews.append(
    el("summary", "作成者が含めた検証記録"),
    el(
      "p",
      "ファイル内の記録です。このブラウザが内容の正しさや作成者を保証するものではありません。",
    ),
  );
  reviews.append(
    el(
      "p",
      `作成時の記録：${book.record.generator.provider} / ${book.record.generator.model}`,
    ),
    el(
      "p",
      `検証時の記録：${book.record.reviewer.provider} / ${book.record.reviewer.model}`,
    ),
  );
  for (const section of book.review.sections) {
    const heading = book.draft.lessons.find(
      (s) => s.content.id === section.sectionID,
    )!.content.title;
    reviews.append(el("h4", heading));
    for (const check of section.checks)
      reviews.append(
        el("p", `${reviewLabels[check.criterion]}：${check.reason}`),
      );
  }
  content.append(reviews);
  return content;
}
/** Display validated verbatim evidence as text; source links require an explicit click. */
function evidence(book: SharedTextbook, title: string, refs: SharedCitation[]) {
  const details = el("details");
  details.append(el("summary", title));
  for (const ref of refs) {
    const source = book.request.sources.find(
      (s) => s.id.toLowerCase() === ref.sourceID.toLowerCase(),
    )!;
    details.append(el("p", source.title), el("blockquote", ref.quote));
    if (source.url) {
      const link = el("a", "元の出典を開く");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      details.append(link);
    }
  }
  return details;
}
/** Download only immutable archive text, with no access to private answer or account stores. */
function download(book: SharedTextbook) {
  // Export the accepted envelope only. This path cannot read the answer store,
  // browser history, account/session settings, annotations or credentials.
  const url = URL.createObjectURL(
      new Blob([book.raw], { type: "application/json" }),
    ),
    link = el("a");
  link.href = url;
  link.download = `quilna-textbook-${book.record.bookID}-v${book.record.version}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Connect local file review, an independent imported library and recipient-only answers. */
export async function sharedTextbookView(root: HTMLElement) {
  applyReaderDesign();
  const term =
    new URL(location.href).searchParams.get("term")?.slice(0, 500).trim() ?? "";
  document.title = "教材 | Quilna";
  root.className = "shared-textbook-page";
  const header = el("header"),
    back = el("a", "記事一覧へ");
  back.href = "/?view=feeds";
  header.append(el("h1", "教材"), back);
  const library = el("div");
  root.append(header, library);
  const importHelp = el("div");
  importHelp.append(
    el(
      "p",
      "教材ファイルを確認して、このブラウザに保存できます。本文・問題・解説・出典と版を保持します。回答履歴は自分のブラウザだけに保存し、書き出しには含めません。教材ファイルの処理はこのブラウザ内で行います。",
    ),
    el(
      "p",
      hasAccountLibrary()
        ? "教材と回答は、このブラウザの現在のログイン専用のライブラリに保存します。別の端末とは同期しません。ブラウザの保存データを消去すると教材と回答が失われます。記事バックアップには含まれないため、教材ファイルを手元にも保管してください。"
        : "この一覧はブラウザのプロフィール内で共通です。別の人は別プロフィールを使ってください。ブラウザの保存データを消去すると教材と回答が失われます。記事バックアップには含まれないため、教材ファイルを手元にも保管してください。",
    ),
  );
  const input = el("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.id = "shared-textbook-file";
  const label = el("label", "教材JSONファイル（540,000バイト以下）");
  label.htmlFor = input.id;
  const notice = el("p");
  notice.setAttribute("role", "status");
  const preview = el("section");
  preview.setAttribute("aria-label", "教材ファイルのプレビュー");
  const list = el("section");
  list.setAttribute("aria-label", "保存した教材");
  const listWarning = el("p");
  listWarning.setAttribute("aria-live", "polite");
  const reader = el("main");
  reader.setAttribute("aria-label", "共有教材の読書");
  reader.hidden = true;
  const importTools = el("details");
  importTools.append(
    el("summary", "教材ファイルを取り込む"),
    importHelp,
    label,
    input,
    preview,
  );
  const legacy = el("section");
  legacy.hidden = true;
  legacy.append(
    el("h3", "以前の試作と処理記録"),
    el(
      "p",
      "以前の試作で保存した依頼や、段階ごとの記録はこちらから確認できます。新しい教科書は上の「教科書を作る」から準備してください。",
    ),
    topicJobView(),
    topicGenerationView(async (id) => {
      await showList(id);
    }),
  );
  const authorTerm = !hasAccountLibrary()
    ? new URLSearchParams(location.hash.slice(1))
        .get("author")
        ?.trim()
        .slice(0, 500)
    : undefined;
  const localAuthor = localTextbookView(
    authorTerm || term,
    download,
    (book, trigger) => {
      if (input.disabled) return;
      fileEpoch++;
      input.value = "";
      importTools.open = true;
      showImportPreview(book, trigger);
    },
  );
  localAuthor.hidden = hasAccountLibrary();
  library.append(
    list,
    listWarning,
    localAuthor,
    topicCreationView(
      term,
      async (id) => {
        await showList(id);
      },
      (allowed) => {
        legacy.hidden = !allowed;
        localAuthor.hidden = hasAccountLibrary() && !allowed;
      },
    ),
    legacy,
    importTools,
    notice,
  );
  root.append(reader);
  let fileEpoch = 0,
    readEpoch = 0,
    listEpoch = 0,
    pending = 0;
  let routeEpoch = 0,
    selectedBook = "",
    routeNotice = "",
    readerTrigger: HTMLElement | undefined;
  let disposeNotice: (() => void) | undefined;
  let foregroundLists = 0,
    backgroundList = false,
    refreshPending = false;
  const editionChannel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(sharedTextbookDatabase);
  const refreshLibrary = () => {
    if (!library.hidden) void showList(undefined, true);
  };
  editionChannel?.addEventListener("message", (event) => {
    if (!ownTextbookImport(event.data)) refreshLibrary();
  });
  window.addEventListener("focus", refreshLibrary);
  // The notice is shared with imports; clear only an error about a URL we left.
  function clearRouteNotice() {
    if (routeNotice && notice.textContent === routeNotice)
      notice.textContent = "";
    routeNotice = "";
  }
  function bookURL(id = "", hash = "") {
    const url = new URL(location.href);
    url.searchParams.set("view", "textbooks");
    if (id) url.searchParams.set("book", id);
    else url.searchParams.delete("book");
    url.hash = hash;
    return url;
  }
  function showLibrary(navigate = true, focus = true, refresh = true) {
    const leavingBook = !!selectedBook;
    disposeNotice?.();
    disposeNotice = undefined;
    routeEpoch++;
    readEpoch++;
    selectedBook = "";
    clearRouteNotice();
    if (navigate) pushReaderURL(bookURL());
    document.title = "教材 | Quilna";
    reader.replaceChildren();
    reader.hidden = true;
    library.hidden = false;
    if (focus)
      (readerTrigger?.isConnected
        ? readerTrigger
        : list.querySelector<HTMLElement>("button")
      )?.focus();
    if (refresh && leavingBook) refreshLibrary();
  }
  /** Resolve only this library's retained edition, never a remote source. */
  async function restoreRoute() {
    const url = location.href,
      id = new URL(url).searchParams.get("book") || "";
    if (id && id === selectedBook) {
      if (!revealReaderAnchor())
        window.scrollTo(0, Number(history.state?.readerScroll) || 0);
      return;
    }
    showLibrary(false, false, !id);
    const ticket = routeEpoch;
    if (!id) {
      window.scrollTo(0, Number(history.state?.readerScroll) || 0);
      return;
    }
    try {
      const book = await readSharedTextbook(id);
      if (ticket !== routeEpoch || url !== location.href) return;
      if (!book) throw Error("このURLの教材は現在のライブラリにありません。");
      await showBook(book, undefined, false);
    } catch (error) {
      if (ticket === routeEpoch && url === location.href)
        notice.textContent = routeNotice = message(error);
    }
  }
  window.addEventListener("popstate", () => void restoreRoute());
  window.addEventListener("beforeunload", (event) => {
    if (pending) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  /** Publish only the latest complete library read and return focus after a confirmed import. */
  async function showList(focusId?: string, background = false) {
    if (background && (foregroundLists > 0 || backgroundList)) {
      refreshPending = true;
      return;
    }
    if (background) backgroundList = true;
    else foregroundLists++;
    const epoch = ++listEpoch;
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && list.contains(focused)
        ? focused.dataset.edition
        : undefined;
    if (!background) {
      listWarning.replaceChildren();
      list.replaceChildren(
        el("h2", "保存した教材"),
        el("p", "教材を確認しています。"),
      );
    }
    try {
      const books = await listSharedTextbooks();
      const states = await readTextbookNotices(books);
      if (epoch !== listEpoch || (background && library.hidden)) return;
      const restoreFocus =
        background && document.activeElement === focused ? focusedId : focusId;
      const restoreWarningFocus =
        background &&
        focused instanceof HTMLElement &&
        listWarning.contains(focused) &&
        document.activeElement === focused;
      listWarning.replaceChildren();
      list.replaceChildren(el("h2", "保存した教材"));
      if (term) {
        const all = el("a", "すべての教材");
        all.href = "/?view=textbooks";
        list.append(el("p", `「${term}」の教材`), all);
      }
      const termEditions = new Set(
        eligibleTopicEditions(books, states)
          .filter(
            (book) =>
              book.request.schemaVersion === 2 &&
              book.request.topic.name.trim().toLowerCase() ===
                term.toLowerCase(),
          )
          .map((book) => book.id),
      );
      const matchesTerm = (book: (typeof books)[number]) =>
        !term || termEditions.has(book.id);
      if (!books.some(matchesTerm))
        list.append(
          el(
            "p",
            term
              ? "この名前で新しく案内できる版はありません。保存済みの版は「すべての教材」から確認できます。"
              : "まだ教材を取り込んでいません。「教材ファイルを取り込む」から追加できます。",
          ),
        );
      for (const [i, book] of books.entries()) {
        if (!matchesTerm(book)) continue;
        const { notice, error } = states[i];
        const row = el("div", undefined, "shared-textbook-row");
        const read = button(
          `${book.draft.title} · 版 ${book.record.version}を読む`,
          () => {
            void showBook(book, read);
          },
        );
        read.dataset.edition = book.id;
        row.append(read);
        if (error)
          row.append(
            el(
              "p",
              "この版の訂正・撤回の記録を確認できません。本文と以前の回答は開いて確認できます。",
            ),
          );
        if (notice)
          row.append(
            el(
              "p",
              notice.kind === "withdrawn"
                ? "撤回の記録あり · 過去の本文と回答を確認できます"
                : "訂正先の記録あり · 開いて確認してください",
            ),
          );
        list.append(row);
        if (book.id === restoreFocus) read.focus();
      }
      if (restoreWarningFocus)
        (
          list.querySelector<HTMLElement>("button") ??
          (importTools.open
            ? input
            : importTools.querySelector<HTMLElement>("summary"))
        )?.focus({
          preventScroll: true,
        });
    } catch (error) {
      if (epoch !== listEpoch) return;
      if (background) {
        listWarning.replaceChildren(
          el(
            "span",
            "教材一覧の再確認に失敗しました。表示中の教材は保持しています。",
          ),
          button("教材一覧の再確認", () => void showList()),
        );
        return;
      }
      list.replaceChildren(
        el("h2", "保存した教材"),
        el("p", message(error)),
        button("教材一覧を再試行", () => {
          void showList();
        }),
      );
    } finally {
      if (background) backgroundList = false;
      else foregroundLists--;
      if (!foregroundLists && !backgroundList && refreshPending) {
        refreshPending = false;
        queueMicrotask(refreshLibrary);
      }
    }
  }

  /** Keep late answer reads from replacing another edition; unreadable answers never block the text. */
  async function showBook(
    book: SharedTextbook,
    trigger?: HTMLElement,
    navigate = true,
  ) {
    disposeNotice?.();
    disposeNotice = undefined;
    routeEpoch++;
    selectedBook = book.id;
    readerTrigger = trigger;
    clearRouteNotice();
    if (navigate) pushReaderURL(bookURL(book.id));
    document.title = `${book.draft.title} · 版 ${book.record.version} | Quilna`;
    const epoch = ++readEpoch;
    library.hidden = true;
    reader.hidden = false;
    /** Invalidate late reader work before restoring the originating library control. */
    const returnToLibrary = () => {
      showLibrary();
    };
    /** Create the persistent library return control for both loading and completed readers. */
    const navigation = () => {
      const actions = el("div", undefined, "shared-textbook-actions");
      actions.append(button("教材一覧へ戻る", returnToLibrary));
      return actions;
    };
    reader.replaceChildren(
      el("h2", book.draft.title),
      navigation(),
      el("p", "自分の回答を確認しています。"),
    );
    let answers: SharedAnswer[] = [];
    let answerError: unknown;
    let editionState: TextbookNoticeState = {};
    const questionControls: Array<() => void> = [];
    try {
      answers = await readSharedAnswers(book);
    } catch (error) {
      answerError = error;
    }
    if (book.request.schemaVersion === 2) {
      [editionState] = await readTextbookNotices([book]);
    }
    if (epoch !== readEpoch) return;
    const heading = el("h2", book.draft.title);
    heading.tabIndex = -1;
    reader.replaceChildren(heading, navigation());
    if (book.request.schemaVersion === 2) {
      const view = textbookNoticeView(book, editionState, (notice, failed) => {
        editionState = {
          notice,
          error: failed ? Error("記録を確認できません") : undefined,
        };
        for (const update of questionControls) update();
      });
      reader.append(view.root);
      disposeNotice = view.dispose;
    }
    if (answerError)
      reader.append(
        el("p", message(answerError)),
        button("回答の読み込みを再試行", () => {
          void showBook(book, trigger, false);
        }),
      );
    const sourceSummary = el("details");
    sourceSummary.append(
      el("summary", "教材の版・出典・検証記録"),
      overview(book),
    );
    reader.append(sourceSummary);
    const exportArea = el("details");
    exportArea.append(el("summary", "教材ファイルを書き出す"), overview(book));
    const confirm = el("input");
    confirm.type = "checkbox";
    const confirmLabel = el("label");
    confirmLabel.append(
      confirm,
      " 出典と引用を確認し、この教材ファイルを書き出す",
    );
    const exportStatus = el("p");
    exportStatus.setAttribute("role", "status");
    const exportButton = button("教材ファイルをダウンロード", () => {
      try {
        download(book);
        exportStatus.textContent =
          "教材ファイルのダウンロードを開始しました。自分の回答は含めていません。";
      } catch {
        exportStatus.textContent =
          "ダウンロードを開始できませんでした。もう一度お試しください。";
      }
    });
    exportButton.disabled = true;
    confirm.addEventListener("change", () => {
      exportButton.disabled = !confirm.checked;
    });
    exportArea.append(
      el(
        "p",
        "自分の回答・成績・メモ・ログイン情報は含めません。実際の相手への送信は、この操作では行いません。",
      ),
      confirmLabel,
      exportButton,
      exportStatus,
    );
    reader.append(exportArea);
    const toc = el("nav");
    toc.setAttribute("aria-label", "教材の目次");
    reader.append(toc);
    for (const lesson of book.draft.lessons) {
      const { content } = lesson,
        q = content.question,
        section = el("section");
      const title = el("h3", content.title);
      title.id = textbookSectionAnchor(content.id);
      title.tabIndex = -1;
      const jump = el("a", content.title);
      jump.href = bookURL(book.id, title.id).href;
      jump.addEventListener("click", (e) => {
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          return;
        e.preventDefault();
        pushReaderURL(new URL(jump.href));
        title.scrollIntoView({ block: "start" });
        title.focus({ preventScroll: true });
      });
      toc.append(jump);
      section.append(title, el("p", `目標：${content.objective}`));
      if (lesson.prerequisiteSectionIDs.length)
        section.append(
          el(
            "p",
            `先に読む節：${lesson.prerequisiteSectionIDs.map((id) => book.draft.lessons.find((s) => s.content.id === id)!.content.title).join("、")}`,
          ),
        );
      if (lesson.assumedKnowledge.length)
        section.append(
          el("p", `前提知識：${lesson.assumedKnowledge.join("、")}`),
        );
      for (const paragraph of content.paragraphs)
        section.append(el("p", paragraph));
      section.append(
        evidence(book, "説明の根拠", lesson.explanationEvidence),
        el("h4", "具体例"),
        el("p", lesson.workedExample),
        evidence(book, "具体例の根拠", lesson.exampleEvidence),
      );
      const question = el("fieldset"),
        legend = el("legend", q.prompt);
      question.append(legend);
      let chosen = "",
        saving = false;
      const updateControls = () => {
        question.disabled =
          saving ||
          !!answerError ||
          !!editionState.error ||
          editionState.notice?.kind === "withdrawn";
      };
      questionControls.push(updateControls);
      updateControls();
      for (const option of q.options) {
        const radio = el("input");
        radio.type = "radio";
        radio.name = `shared-question-${q.id}`;
        radio.value = option.id;
        const optionLabel = el("label");
        optionLabel.append(radio, ` ${option.text}`);
        question.append(optionLabel);
        radio.addEventListener("change", () => {
          chosen = option.id;
          submit.disabled = false;
          result.replaceChildren();
        });
      }
      const result = el("div");
      result.setAttribute("role", "status");
      const ownHistory = el("div");
      let historyPage = 0;
      /** Page private answers without discarding older attempts or mounting an unbounded history. */
      const drawHistory = () => {
        const heading = el("h4", "自分の回答履歴");
        heading.tabIndex = -1;
        ownHistory.replaceChildren(heading);
        if (answerError) {
          ownHistory.append(
            el(
              "p",
              "回答履歴を確認できません。保存済みデータの上書きを止めています。",
            ),
          );
          return;
        }
        const records = answers.filter((a) => a.question === q.id);
        historyPage = Math.min(
          historyPage,
          Math.max(0, Math.ceil(records.length / 20) - 1),
        );
        if (!records.length)
          ownHistory.append(el("p", "まだ回答を保存していません。"));
        else
          ownHistory.append(
            el(
              "p",
              `回答 ${records.length}件 · ${historyPage + 1} / ${Math.ceil(records.length / 20)}ページ（新しい回答から20件ずつ）`,
            ),
          );
        const timeFormat = new Intl.DateTimeFormat("ja-JP", {
          dateStyle: "medium",
          timeStyle: "medium",
        });
        for (const a of records.slice(
          Math.max(0, records.length - (historyPage + 1) * 20),
          records.length - historyPage * 20,
        )) {
          const time = el("time", timeFormat.format(new Date(a.time)));
          time.dateTime = a.time;
          const attempt = el("p");
          attempt.append(
            time,
            ` · ${q.options.find((o) => o.id === a.option)!.text} · ${a.correct ? "正答" : "別の選択肢"}`,
          );
          ownHistory.append(attempt);
        }
        if (records.length > 20) {
          const older = button("古い20件", () => {
            historyPage++;
            drawHistory();
            ownHistory.querySelector("h4")?.focus();
          });
          const newer = button("新しい20件", () => {
            historyPage--;
            drawHistory();
            ownHistory.querySelector("h4")?.focus();
          });
          older.disabled = (historyPage + 1) * 20 >= records.length;
          newer.disabled = historyPage === 0;
          ownHistory.append(older, newer);
        }
      };
      const submit = button("回答して保存", () => {
        if (!chosen || saving) return;
        const option = chosen;
        const keepFocus = question.contains(document.activeElement);
        saving = true;
        pending++;
        question.disabled = true;
        result.replaceChildren(el("p", "回答を保存しています。"));
        void answerSharedTextbook(book, content.id, option)
          .then((answer) => {
            if (epoch !== readEpoch) return;
            answers.push(answer);
            historyPage = 0;
            drawHistory();
            result.replaceChildren(
              el(
                "p",
                answer.correct
                  ? "正答です。回答を保存しました。"
                  : "回答を保存しました。解説を確認してください。",
              ),
            );
            for (const o of q.options)
              result.append(
                el(
                  "p",
                  `${o.text}${o.id === q.correctOptionID ? "（正答）" : ""}：${o.explanation}`,
                ),
                evidence(book, `${o.text}の根拠`, lesson.optionEvidence[o.id]),
              );
            result.append(
              evidence(book, "問題の根拠", lesson.questionEvidence),
            );
          })
          .catch((error) => {
            if (epoch === readEpoch) {
              result.replaceChildren(
                el("p", message(error)),
                el(
                  "p",
                  "選択は保持しています。「回答して保存」で再試行できます。",
                ),
              );
            }
          })
          .finally(() => {
            pending--;
            saving = false;
            updateControls();
            if (
              keepFocus &&
              epoch === readEpoch &&
              submit.isConnected &&
              document.activeElement === document.body
            )
              submit.focus({ preventScroll: true });
          });
      });
      submit.disabled = true;
      question.append(submit);
      drawHistory();
      section.append(question, result, ownHistory);
      reader.append(section);
    }
    heading.focus();
    revealReaderAnchor();
  }

  function showImportPreview(book: SharedTextbook, trigger?: HTMLElement) {
    notice.textContent = "まだ保存していません。教材と出典を確認してください。";
    const cancel = button("取り込みを取り消す", () => {
      fileEpoch++;
      preview.replaceChildren();
      input.value = "";
      notice.textContent =
        "取り込みを取り消しました。保存済みデータは変更していません。";
      (trigger ?? input).focus();
    });
    const save = button("確認してこのブラウザに取り込む", () => {
      input.disabled = true;
      save.disabled = true;
      cancel.disabled = true;
      pending++;
      notice.textContent = "教材を保存しています。";
      void importSharedTextbook(book.raw)
        .then(async () => {
          notice.textContent =
            "教材を取り込みました。自分の回答は別に保存します。";
          preview.replaceChildren();
          input.value = "";
          await showList(book.id);
          if (trigger && root.isConnected && !library.hidden)
            await showBook(book, trigger);
        })
        .catch((error) => {
          notice.textContent = message(error);
        })
        .finally(() => {
          pending--;
          input.disabled = false;
          save.disabled = false;
          cancel.disabled = false;
        });
    });
    preview.replaceChildren(
      overview(book),
      el(
        "p",
        "取り込み前の教材や回答は上書きしません。同じ教材・版で内容が異なる場合は取り込みを拒否します。",
      ),
      save,
      cancel,
    );
    if (trigger) {
      preview.tabIndex = -1;
      preview.focus();
    }
  }

  input.addEventListener("change", () => {
    importTools.open = true;
    const epoch = ++fileEpoch,
      file = input.files?.[0];
    preview.replaceChildren();
    notice.textContent = "";
    if (!file) return;
    notice.textContent = "教材ファイルを確認しています。";
    void (async () => {
      if (file.size > sharedTextbookMaximumBytes)
        throw Error(
          "教材ファイルが大きすぎます。540,000バイト以下を選んでください。",
        );
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw Error(
          "教材ファイルを読めません。UTF-8のJSONファイルを選んで再試行してください。",
        );
      }
      const book = await parseSharedTextbook(raw);
      if (epoch !== fileEpoch) return;
      showImportPreview(book);
    })().catch((error) => {
      if (epoch === fileEpoch) notice.textContent = message(error);
    });
  });
  // A URL names one edition; opening it need not wait for every edition's validation.
  await Promise.all([showList(), restoreRoute()]);
  if (authorTerm && !localAuthor.hidden && !library.hidden) {
    localAuthor.open = true;
    localAuthor.querySelector("input")?.focus();
  }
}
