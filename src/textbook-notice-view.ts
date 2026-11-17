import { button, el } from "./ui";
import type { SharedTextbook } from "./shared-textbook-format";
import {
  listSharedTextbooks,
  readTextbookNotices,
  writeTextbookNotice,
  removeTextbookNotice,
  sharedTextbookDatabase,
  type TextbookNotice,
  type TextbookNoticeState,
} from "./shared-textbook-store";

/** 元の記事や個人記録をURLに入れず、利用者が選んだ版だけを開く。 */
export function textbookNoticeSummary(
  notice?: TextbookNotice,
  replacementState: TextbookNoticeState["replacementState"] = "available",
  separate = false,
) {
  const root = el(separate ? "div" : "section");
  if (!separate) root.setAttribute("aria-label", "この教材版の訂正・撤回");
  if (!notice) {
    root.hidden = true;
    return root;
  }
  root.append(
    el(
      "h3",
      notice.kind === "withdrawn"
        ? "この版は撤回として記録されています"
        : "この版には訂正先の記録があります",
    ),
    el(
      "p",
      "このライブラリの利用者による記録です。作成者や公開元の発表として検証された情報ではありません。教材ファイルには含めません。",
    ),
    el("p", `理由：${notice.reason}`),
    el("p", `判断の根拠：${notice.evidence}`),
  );
  const time = el(
    "time",
    new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(notice.updatedAt)),
  );
  time.dateTime = notice.updatedAt;
  const recorded = el("p", "記録日時：");
  recorded.append(time);
  root.append(recorded);
  if (notice.kind === "withdrawn")
    root.append(
      el(
        "p",
        "継続学習には使わないでください。過去の本文・回答・記事との関連づけは保持しています。",
      ),
    );
  else if (notice.replacement) {
    if (replacementState !== "available") {
      root.append(
        el(
          "p",
          replacementState === "withdrawn"
            ? "訂正先の版も撤回されています。継続学習には使わず、別の版と根拠を確認してください。"
            : "訂正先の版や記録を確認できません。保存済みの教材と記録を確認してください。",
        ),
      );
      return root;
    }
    const link = el(
      "a",
      separate ? "訂正先の版を読む（別タブ）" : "訂正先の版を読む",
    );
    const url = new URL("/", location.origin);
    url.searchParams.set("view", "textbooks");
    url.searchParams.set("book", notice.replacement.id);
    link.href = url.href;
    link.dataset.action = "correction";
    if (separate) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    root.append(
      el(
        "p",
        "旧版の回答と関連づけは移動しません。訂正先の版は自分で確認して開いてください。",
      ),
      link,
    );
  }
  return root;
}

/** 不変の教材と回答を編集せず、私的な保守判断だけを競合検査付きで保存する。 */
export function textbookNoticeView(
  book: SharedTextbook,
  initial: TextbookNoticeState,
  changed: (notice: TextbookNotice | undefined, failed: boolean) => void,
) {
  const root = el("div"),
    summary = el("div"),
    editor = el("details");
  editor.className = "textbook-notice-editor";
  const status = el("p");
  status.setAttribute("role", "status");
  editor.append(
    el("summary", "教材の訂正・撤回を記録"),
    el(
      "p",
      "自分のライブラリだけの記録です。理由と判断の根拠を残します。本文や回答を書き換えず、公開元へ送信しません。記事バックアップにも含まれません。",
    ),
  );
  const kind = el("select"),
    target = el("select"),
    reason = el("textarea"),
    evidence = el("textarea");
  const fields = [
    ["記録の種類", kind],
    ["訂正先の保存済み版", target],
    ["訂正・撤回の理由", reason],
    ["判断の根拠", evidence],
  ] as const;
  for (const [i, [name, field]] of fields.entries()) {
    field.id = `textbook-notice-${i}`;
    const label = el("label", name);
    label.htmlFor = field.id;
    editor.append(label, field);
  }
  for (const [value, text] of [
    ["correction", "訂正先を案内する"],
    ["withdrawn", "この版を撤回として扱う"],
  ]) {
    const option = el("option", text);
    option.value = value;
    kind.append(option);
  }
  reason.maxLength = evidence.maxLength = 2000;
  reason.rows = evidence.rows = 3;
  let notice = initial.notice,
    replacementState = initial.replacementState,
    failure = initial.error,
    expected: string | null = initial.notice?.revision ?? null;
  let busy = false,
    prepared = false,
    ready = !initial.error,
    disposed = false,
    generation = 0,
    readEpoch = 0,
    refreshPending = false;
  let choices: SharedTextbook[] = [];
  const active = () => !disposed && root.isConnected;
  const problem = (error: unknown) =>
    error instanceof Error && error.name !== "ZodError"
      ? error.message
      : "訂正・撤回の記録を確認できません。保存済みの記録と入力は保持しています。";
  let shownSummary = "";
  const draw = () => {
    const key = JSON.stringify({
      notice,
      replacementState,
      ready,
      failure: failure?.message,
    });
    if (key === shownSummary) return;
    shownSummary = key;
    summary.replaceChildren(textbookNoticeSummary(notice, replacementState));
    if (!ready)
      summary.append(
        el(
          "p",
          failure?.message ??
            "記録を確認できません。保存済みの内容は保持しています。",
        ),
        el(
          "p",
          "この版の訂正・撤回の記録を確認できないため、新しい回答を止めています。本文と以前の回答は保持しています。",
        ),
        button("記録の読み込みを再試行", () => void refresh()),
      );
    changed(notice, !ready);
  };
  const save = button("この版の記録を保存", () => void commit());
  const remove = button("この版の記録を取り消す", () => void clear());
  const reload = button(
    "入力を取り消して最新記録を読み直す",
    () => void reset(),
  );
  const controls = () => {
    for (const field of [kind, reason, evidence])
      field.disabled = busy || !ready;
    target.disabled = busy || !ready || kind.value !== "correction";
    save.disabled = busy || !ready;
    remove.disabled =
      busy || !ready || !notice || !expected || notice.revision !== expected;
    reload.disabled = busy;
  };
  const fill = () => {
    kind.value = notice?.kind ?? "correction";
    reason.value = notice?.reason ?? "";
    evidence.value = notice?.evidence ?? "";
    expected = notice?.revision ?? null;
  };
  const finish = () => {
    busy = false;
    controls();
    if (refreshPending) {
      refreshPending = false;
      queueMicrotask(() => void refresh());
    }
  };
  async function loadChoices(keepBusy = false) {
    const ticket = ++generation;
    busy = true;
    controls();
    try {
      const books = (await listSharedTextbooks()).filter(
        (b) =>
          b.request.schemaVersion === 2 &&
          book.request.schemaVersion === 2 &&
          b.record.bookID.toLowerCase() === book.record.bookID.toLowerCase() &&
          b.request.topic.id.toLowerCase() ===
            book.request.topic.id.toLowerCase() &&
          b.record.version > book.record.version,
      );
      const notices = await readTextbookNotices(books);
      if (!active() || ticket !== generation) return;
      choices = books.filter(
        (_, i) => !notices[i].error && notices[i].notice?.kind !== "withdrawn",
      );
      target.replaceChildren();
      const empty = el("option", "訂正先を選んでください");
      empty.value = "";
      target.append(empty);
      for (const choice of choices) {
        const option = el(
          "option",
          `${choice.draft.title} · 版 ${choice.record.version}`,
        );
        option.value = choice.id;
        target.append(option);
      }
      target.value = notice?.replacement?.id ?? "";
      if (!choices.length)
        status.textContent =
          "同じテーマ・教材の後の版を先に取り込むと、訂正先に選べます。撤回の記録はこのまま残せます。";
      if (notices.some((n) => n.error))
        status.textContent =
          "記録を確認できない版は訂正先の候補から外しています。他の保存済み版を確認するか、撤回の記録を残せます。";
    } catch (error) {
      if (active()) status.textContent = problem(error);
    } finally {
      if (active() && ticket === generation && !keepBusy) {
        finish();
      }
    }
  }
  async function refresh(exclusive = false) {
    if (!active()) return;
    if (busy && !exclusive) {
      refreshPending = true;
      return;
    }
    const ticket = ++readEpoch;
    try {
      const [latest] = await readTextbookNotices([book]);
      if (!active() || ticket !== readEpoch) return;
      if (busy && !exclusive) {
        refreshPending = true;
        return;
      }
      if (latest.error) throw latest.error;
      notice = latest.notice;
      replacementState = latest.replacementState;
      failure = undefined;
      ready = true;
      if (!prepared) fill();
      draw();
      controls();
      if (prepared && (notice?.revision ?? null) !== expected)
        status.textContent =
          "別の画面で記録が変更されています。入力は保持しています。最新記録を読み直して比較してください。";
    } catch (error) {
      if (active() && ticket === readEpoch) {
        if (busy && !exclusive) {
          refreshPending = true;
          return;
        }
        ready = false;
        failure = error instanceof Error ? error : Error(problem(error));
        status.textContent = problem(error);
        draw();
        controls();
      }
    }
  }
  async function reset() {
    if (!active() || busy) return;
    busy = true;
    controls();
    try {
      await refresh(true);
      if (!active() || !ready) return;
      fill();
      prepared = true;
      status.textContent = "保存済みの最新記録を読み直しました。";
      await loadChoices(true);
    } finally {
      if (active()) finish();
    }
  }
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(sharedTextbookDatabase);
  const signal = () => channel?.postMessage(book.id);
  async function commit() {
    if (busy || !ready) return;
    for (const [label, field] of [
      ["訂正・撤回の理由", reason],
      ["判断の根拠", evidence],
    ] as const) {
      const text = field.value.trim();
      if (!text || text.length > 2000 || text.includes("\0")) {
        status.textContent = `${label}を、空白だけやNULを含まない2,000文字以下で入力してください。`;
        field.focus();
        return;
      }
    }
    readEpoch++;
    busy = true;
    controls();
    try {
      const replacement =
        kind.value === "correction"
          ? choices.find((b) => b.id === target.value)
          : undefined;
      if (kind.value === "correction" && !replacement)
        throw Error("訂正先の保存済み版を選んでください。");
      const saved = await writeTextbookNotice(
        book,
        {
          kind: kind.value as TextbookNotice["kind"],
          reason: reason.value,
          evidence: evidence.value,
          replacement,
        },
        expected,
      );
      signal();
      if (!active()) return;
      notice = saved;
      replacementState = "available";
      expected = saved.revision;
      draw();
      status.textContent =
        "この版の記録を保存しました。本文と回答は保持しています。";
    } catch (error) {
      if (active()) status.textContent = problem(error);
    } finally {
      if (active()) {
        finish();
      }
    }
  }
  async function clear() {
    if (busy || !ready || !notice || !expected) return;
    readEpoch++;
    busy = true;
    controls();
    try {
      await removeTextbookNotice(book, expected);
      signal();
      if (!active()) return;
      notice = undefined;
      expected = null;
      fill();
      draw();
      status.textContent =
        "この版の記録を取り消しました。本文・回答・記事との関連づけは保持しています。";
    } catch (error) {
      if (active()) status.textContent = problem(error);
    } finally {
      if (active()) {
        finish();
      }
    }
  }
  editor.addEventListener("toggle", () => {
    if (editor.open && !prepared && !busy) {
      prepared = true;
      void loadChoices();
    }
  });
  kind.addEventListener("change", controls);
  channel?.addEventListener("message", () => void refresh());
  const focus = () => void refresh();
  window.addEventListener("focus", focus);
  if (initial.error) status.textContent = problem(initial.error);
  fill();
  editor.append(save, remove, reload, status);
  root.append(summary, editor);
  draw();
  controls();
  // 初回の保存領域読み込みと通知購読の間に確定した変更も取り直す。
  queueMicrotask(() => void refresh());
  return {
    root,
    dispose: () => {
      disposed = true;
      generation++;
      channel?.close();
      window.removeEventListener("focus", focus);
    },
  };
}
