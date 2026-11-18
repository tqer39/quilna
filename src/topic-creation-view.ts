import { el, button } from "./ui";
import { libraryAccount, librarySignedOut } from "./library-context";
import {
  TopicGenerationClient,
  TopicClientError,
} from "./topic-generation-client";
import { topicPreparationView } from "./topic-preparation-view";
import {
  parseTextbookRequest,
  parseSharedTextbook,
} from "./shared-textbook-format";
import { importSharedTextbook } from "./shared-textbook-store";
import {
  topicCreationPayloads,
  type TopicCreation,
} from "./topic-creation-protocol";
import type { TopicEvidence } from "./topic-preparation-protocol";
import type {
  TopicQuote,
  TopicCapabilities,
} from "./topic-generation-protocol";

const yen = (n: number) =>
  `${(n / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 3 })}円`;
type PendingMarker = {
  kind: "save" | "approve" | "retry" | "review-again" | "resume";
  command?: unknown;
};
const states = {
  draft: "作成前",
  generation: "教科書を生成中",
  review: "内容を検証中",
  ready: "完成・取り込み可能",
  held: "確認が必要",
  rejected: "作成を見送り",
  unavailable: "記録を確認できません",
};
const failures: Record<string, string> = {
  "topic-author-forbidden":
    "現在の管理者権限を確認できないため、作成を開始しませんでした。保存した記録は確認できます。",
  "topic-creations-unconfigured":
    "この接続先では教科書の作成受付がまだ有効になっていません。",
  "credentials-unconfigured":
    "この接続先では生成用のキー設定がまだ有効になっていません。",
  "quote-changed":
    "モデルや費用が変わりました。最新のモデルと費用を確認してください。",
  "topic-creation-conflict":
    "依頼の状態が変わりました。同じ依頼の最新の状態を確認してください。",
  "topic-creation-active":
    "処理が進んだため、この操作はできません。最新の状態を確認してください。",
  "topic-job-active":
    "処理中か結果不明のため、この操作はできません。結果を確認してください。",
  "topic-job-retry-unavailable":
    "未送信を確認できないため、同じ処理を送り直せません。結果を確認してください。",
  "topic-materials-invalid":
    "準備した資料と公開中の原文が一致しません。資料を準備し直してください。",
  "document-unavailable":
    "資料の公開許可や保存原文を確認できません。資料を準備し直してください。",
  "topic-materials-unconfigured":
    "この接続先では公開資料を確認する設定がまだありません。",
  "topic-creation-capacity":
    "作成依頼の保存枠または進行枠がいっぱいです。不要な終了済みの控えを整理してください。",
  "topic-job-capacity":
    "処理の控えがいっぱいです。終了済みの控えを整理して続きを再開してください。",
  "rate-limit":
    "操作が集中しました。1分ほど待ってから確認してください。自動でやり直しません。",
  "topic-creation-cursor":
    "一覧が変わりました。「一覧を確認」で最初から確認してください。",
  "csrf-invalid": "接続を確認し直してください。操作は自動でやり直しません。",
  "storage-unavailable":
    "受付番号をこのブラウザに保存できないため、送信を始めませんでした。保存設定を確認してください。",
  "topic-creation-unavailable":
    "接続先の記録を読めません。記録は保持しています。時間を置いて確認し、続く場合は接続先の管理者に確認してください。",
  "topic-creation-invalid":
    "保存記録を読み取れません。未確認の処理や費用を失わないよう保持しています。接続先の管理者による確認が必要です。",
};
/** 手動引用を求めず、保存・費用承認・結果確認を分けた独立した作成入口。 */
export function topicCreationView(
  initialTopic: string,
  saved: (id: string) => Promise<void>,
  permission?: (allowed: boolean) => void,
) {
  const root = el("section", undefined, "topic-creation"),
    notice = el("p", undefined, "topic-creation-notice"),
    editor = el("section"),
    detail = el("section"),
    history = el("details"),
    rows = el("ol"),
    historyControls = el("div"),
    more = button("以前の依頼を表示", () => void run(() => loadList(true)));
  notice.setAttribute("aria-live", "polite");
  notice.setAttribute("aria-atomic", "true");
  editor.setAttribute("aria-label", "教科書の作成準備");
  detail.setAttribute("aria-label", "教科書の作成依頼");
  rows.setAttribute("aria-label", "保存した教科書の作成依頼");
  history.append(el("summary", "保存した作成依頼"), historyControls, rows);
  historyControls.append(
    button("一覧を確認", () => void run(() => loadList(false))),
    more,
  );
  more.hidden = true;
  const creationHeading = el("h2", "教科書を作る"),
    creationIntro = el(
      "p",
      "学びたいテーマの公開資料から、説明・具体例・確認問題をまとめます。作成を承認した後は画面を閉じても処理が続きます。",
    );
  root.append(creationHeading, creationIntro, notice);
  const account = libraryAccount();
  root.hidden = true;
  if (!account) {
    permission?.(false);
    return root;
  }
  const client = new TopicGenerationClient(
    account,
    libraryAccount,
    librarySignedOut,
  );
  const permissionCheck = new AbortController();
  let canAuthor = false;
  function applyPermission(allowed: boolean) {
    canAuthor = allowed;
    root.hidden = false;
    creationHeading.textContent = allowed ? "教科書を作る" : "保存した作成記録";
    creationIntro.hidden = !allowed;
    preparation.hidden = !allowed;
    editor.hidden = !allowed;
    permission?.(allowed);
  }
  void client
    .status(permissionCheck.signal)
    .then((status) => {
      const allowed = status.creations?.canAuthor === true;
      applyPermission(allowed);
    })
    .catch(() => {
      applyPermission(false);
    });
  window.addEventListener("pagehide", () => permissionCheck.abort());
  const markerPrefix = `quilna.topic-creation.pending.${account}.`;
  let active: AbortController | undefined,
    selected: TopicCreation | null = null,
    pendingRaw: string | null = null,
    next: string | null = null,
    initialized = false;
  let pageRows: { id: string; title?: string; state: keyof typeof states }[] =
    [];
  let pendingId: string | null = null;
  let sendingId: string | null = null;
  function marker(id: string): PendingMarker | null {
    try {
      const raw = localStorage.getItem(markerPrefix + id);
      if (!raw || raw.length > 65536) return null;
      const m = JSON.parse(raw);
      if (
        !m ||
        !["save", "approve", "retry", "review-again", "resume"].includes(m.kind)
      )
        return null;
      if (m.kind === "save") return { kind: "save" };
      const parsed = topicCreationPayloads[
        m.kind as Exclude<PendingMarker["kind"], "save">
      ].safeParse(m.command);
      return parsed.success && parsed.data.id === id
        ? { kind: m.kind, command: parsed.data }
        : null;
    } catch {
      return null;
    }
  }
  function nextPending() {
    try {
      for (let n = 0; n < localStorage.length; n++) {
        const key = localStorage.key(n);
        if (!key?.startsWith(markerPrefix)) continue;
        const id = key.slice(markerPrefix.length);
        if (
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) &&
          marker(id)
        )
          return id;
      }
    } catch {
      /* 送信時には保存の成功を必須にする。 */
    }
    return null;
  }
  pendingId = nextPending();
  const recover = button("未確認の受付を確認", () => {
    if (pendingId) void run(() => read(pendingId!));
  });
  const pendingChoices = el("details"),
    pendingRows = el("div");
  pendingChoices.append(el("summary", "未確認の受付を選ぶ"), pendingRows);
  function drawPending() {
    pendingRows.replaceChildren();
    try {
      for (let n = 0; n < localStorage.length; n++) {
        const key = localStorage.key(n);
        if (!key?.startsWith(markerPrefix)) continue;
        const id = key.slice(markerPrefix.length);
        if (!marker(id)) continue;
        pendingRows.append(
          button(`受付 ${id} を確認`, () => {
            pendingId = id;
            void run(() => read(id));
          }),
        );
      }
    } catch {
      /* 照会できない印を削除しない。 */
    }
    pendingChoices.hidden = pendingRows.childElementCount < 2;
  }
  drawPending();
  recover.hidden = !pendingId;
  if (pendingId)
    notice.textContent =
      "前の操作の受付が未確認です。同じ受付番号の状態を確認できます。";
  const preparation = topicPreparationView(initialTopic, prepare);
  root.append(recover, pendingChoices, preparation, editor, history, detail);
  function current() {
    try {
      if (libraryAccount() === account && root.isConnected) return;
    } catch {
      /* 失効済み。 */
    }
    editor.replaceChildren();
    detail.replaceChildren();
    rows.replaceChildren();
    pendingRaw = null;
    selected = null;
    throw new TopicClientError("account-mismatch");
  }
  function mark(id: string, value: PendingMarker) {
    const previouslyPending = marker(id) !== null;
    try {
      const raw = JSON.stringify(value);
      localStorage.setItem(markerPrefix + id, raw);
      if (localStorage.getItem(markerPrefix + id) !== raw) throw Error();
    } catch {
      throw new TopicClientError("storage-unavailable");
    }
    pendingId = id;
    sendingId = previouslyPending ? null : id;
    recover.hidden = false;
  }
  function clearMark(id: string) {
    try {
      localStorage.removeItem(markerPrefix + id);
    } catch {
      /* 同じ受付番号の読取だけが残る。 */
    }
    pendingId = nextPending();
    recover.hidden = !pendingId;
  }
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (active) return;
    const controller = new AbortController();
    active = controller;
    sendingId = null;
    const disabled = Array.from(
      root.querySelectorAll("button"),
      (b) => [b, b.disabled] as const,
    );
    disabled.forEach(([b]) => (b.disabled = true));
    root.setAttribute("aria-busy", "true");
    try {
      current();
      await work(controller.signal);
      current();
    } catch (error) {
      const code = error instanceof TopicClientError ? error.code : "held";
      if (
        [
          "topic-creations-unconfigured",
          "credentials-unconfigured",
          "quote-changed",
          "topic-materials-invalid",
          "topic-materials-request",
          "document-unavailable",
          "invalid-request",
          "rate-limit",
          "topic-creation-capacity",
        ].includes(code) &&
        pendingId &&
        pendingId === sendingId
      ) {
        clearMark(pendingId);
        pendingRaw = null;
        const goal = editor.querySelector("textarea");
        if (goal) goal.readOnly = false;
      }
      notice.textContent = [
        "account-mismatch",
        "unauthenticated",
        "topic-creation-owner",
      ].includes(code)
        ? "ログインを確認してページを開き直してください。"
        : (failures[code] ??
          "結果を確認できませんでした。自動では送信し直しません。「未確認の受付を確認」または同じ依頼の「最新の状態を確認」を使ってください。");
      if (
        [
          "account-mismatch",
          "unauthenticated",
          "topic-creation-owner",
        ].includes(code)
      ) {
        editor.replaceChildren();
        detail.replaceChildren();
        rows.replaceChildren();
      }
    } finally {
      active = undefined;
      root.removeAttribute("aria-busy");
      disabled.forEach(([b, value]) => {
        if (b.isConnected) b.disabled = value;
      });
      drawPending();
    }
  }
  function prepare(topic: string, candidates: TopicEvidence[]) {
    if (active) return;
    if (pendingId) {
      notice.textContent =
        "未確認の別の依頼は保持しています。今回は新しい依頼として準備します。同じ依頼のやり直しには受付の確認を使ってください。";
    }
    pendingRaw = null;
    selected = null;
    detail.replaceChildren();
    const goal = el("textarea"),
      label = el("label", "学習目的"),
      form = el("form"),
      submit = el("button", "依頼を保存して費用を確認");
    goal.id = "topic-creation-goal";
    goal.required = true;
    goal.maxLength = 1000;
    goal.rows = 3;
    goal.placeholder =
      "例：RSSの仕組みを理解し、毎日の情報収集に使えるようになる";
    label.htmlFor = goal.id;
    const goalHelp = el(
      "p",
      "日本語で約330文字まで。何を理解し、使えるようになりたいかを入力してください。",
    );
    goalHelp.id = "topic-creation-goal-help";
    goal.setAttribute("aria-describedby", goalHelp.id);
    const validateGoal = () =>
      goal.setCustomValidity(
        !goal.value.trim()
          ? "理解したいことを入力してください。"
          : new TextEncoder().encode(goal.value.trim()).length > 1000
            ? "学習目的が長すぎます。日本語で約330文字以内にまとめてください。"
            : /[\uD800-\uDFFF\0]/u.test(goal.value)
              ? "入力できない文字が含まれています。学習目的を入力し直してください。"
              : "",
      );
    goal.addEventListener("input", validateGoal);
    validateGoal();
    submit.type = "submit";
    const sources = candidates.map((c) => structuredClone(c.source));
    editor.replaceChildren(
      el("h3", topic),
      el(
        "p",
        `公開資料${sources.length}件を使用します。資料は下の原文確認から読めます。`,
      ),
      form,
    );
    form.append(
      label,
      goal,
      goalHelp,
      el(
        "p",
        "資料と学習目的をサーバーに保存します。この操作ではLLMへ送信せず、費用は発生しません。",
      ),
      submit,
    );
    const requestId = crypto.randomUUID(),
      topicId = crypto.randomUUID();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (active) return;
      void run(async (signal) => {
        if (!pendingRaw) {
          goal.readOnly = true;
          const raw = JSON.stringify({
            schemaVersion: 2,
            id: requestId,
            topic: { id: topicId, name: topic },
            learningGoal: goal.value.trim(),
            sources,
          });
          try {
            await parseTextbookRequest(raw);
          } catch {
            goal.readOnly = false;
            notice.textContent =
              "資料と学習目的を保存できる大きさに収まりません。テーマを絞って資料を準備し直してください。";
            return;
          }
          current();
          pendingRaw = raw;
        }
        mark(requestId, { kind: "save" });
        const response = await client.creations(
          "save",
          { requestRaw: pendingRaw },
          signal,
        );
        current();
        if (!response.creation) throw new TopicClientError("invalid-response");
        clearMark(requestId);
        preparation.open = false;
        pendingRaw = null;
        editor.replaceChildren();
        await show(response.creation);
        notice.textContent =
          "作成依頼を保存しました。まだ生成していません。モデルと費用を確認してください。";
      });
    });
    goal.focus();
  }
  function drawRows() {
    rows.replaceChildren();
    for (const r of pageRows) {
      const row = el("li"),
        title = el("h3", r.title ?? "読めない作成記録");
      row.append(
        title,
        el("p", states[r.state]),
        button("依頼を確認", () => void run(() => read(r.id))),
      );
      rows.append(row);
    }
    if (!pageRows.length)
      rows.append(
        el(
          "li",
          canAuthor
            ? "保存した作成依頼はありません。上の「テーマの資料を準備する」から始めてください。"
            : "このアカウントに保存した作成記録はありません。教科書の作成は管理者が行います。",
        ),
      );
    more.hidden = !next;
  }
  async function loadList(continuing: boolean) {
    const after = continuing ? next : null;
    if (continuing && !after) return;
    const response = await client.creations(
      "list",
      after ? { after } : {},
      active!.signal,
    );
    current();
    if (
      continuing &&
      response.creations.some((r) => pageRows.some((old) => old.id === r.id))
    )
      throw new TopicClientError("invalid-response");
    pageRows = continuing
      ? [...pageRows, ...response.creations]
      : response.creations;
    next = response.next;
    initialized = true;
    drawRows();
    notice.textContent =
      "保存した依頼を確認しました。新しい生成は始めていません。";
  }
  async function read(id: string) {
    const response = await client.creations("read", { id }, active!.signal);
    current();
    if (!response.creation) {
      detail.replaceChildren();
      notice.textContent =
        "この受付番号の依頼は見つかりませんでした。未確認の受付は時間を置いて再確認してください。";
      if (pendingId === id && marker(id)?.kind === "save")
        detail.append(
          button("作成せず準備に戻る", () => {
            if (active) return;
            if (marker(id)?.kind !== "save") return;
            clearMark(id);
            pendingRaw = null;
            editor.replaceChildren();
            detail.replaceChildren();
            notice.textContent =
              "未承認の受付の確認を終了しました。保存が遅れて届いても生成は始まりません。資料から改めて準備できます。";
          }),
        );
      else if (marker(id))
        detail.append(
          el(
            "p",
            "この操作の依頼を見つけられません。サーバーへの取消ではなく、このブラウザの確認だけを終了できます。遅れて処理や費用が確定する可能性があり、すでに発生した費用は変わりません。",
          ),
          button("この受付の確認を終了", () => {
            if (active) return;
            clearMark(id);
            detail.replaceChildren();
            notice.textContent =
              "このブラウザの確認を終了しました。サーバーの処理・費用は変更していません。";
          }),
        );
      return;
    }
    const savedMarker = marker(id),
      c = response.creation;
    const confirmed =
      !savedMarker ||
      savedMarker.kind === "save" ||
      (["resume", "retry"].includes(savedMarker.kind) && c.state === "ready") ||
      (savedMarker.kind === "resume" &&
        (c.state === "rejected" ||
          (c.state === "held" && c.reason !== "capacity"))) ||
      (savedMarker.kind === "approve" && c.quotes !== null) ||
      (savedMarker.kind === "review-again" &&
        c.reviewRequestId ===
          topicCreationPayloads["review-again"].parse(savedMarker.command)
            .reviewRequestId) ||
      (savedMarker.kind === "retry" &&
        c.operation &&
        ["queued", "running", "complete"].includes(c.operation.state));
    if (confirmed) clearMark(id);
    if (pendingRaw && JSON.parse(pendingRaw).id === id) {
      pendingRaw = null;
      editor.replaceChildren();
      preparation.open = false;
    }
    await show(response.creation);
    notice.textContent = confirmed
      ? "保存した依頼の現在の状態です。"
      : "送信した操作の受付はまだ未確認です。遅れて処理が始まる場合があります。同じ依頼を再確認してください。別の有料操作は始めません。";
  }
  async function show(c: TopicCreation) {
    current();
    selected = c;
    pageRows = pageRows.map((r) =>
      r.id === c.id ? { id: c.id, title: c.title, state: c.state } : r,
    );
    drawRows();
    const heading = el("h3", c.title),
      actions = el("div", undefined, "topic-creation-actions"),
      costs = el("section");
    heading.tabIndex = -1;
    detail.replaceChildren(
      heading,
      el("p", states[c.state]),
      el("p", `学習目的：${c.learningGoal}`),
      el("p", `受付 ${new Date(c.createdAt).toLocaleString("ja-JP")}`),
    );
    const identity = el("details");
    identity.append(el("summary", "受付番号と資料を確認"), el("p", c.id));
    const request = await parseTextbookRequest(c.requestRaw);
    current();
    for (const s of request.sources) {
      const source = el("details"),
        link = el("a", s.title);
      if (s.url) link.href = s.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      source.append(el("summary", s.title), link, el("blockquote", s.excerpt));
      identity.append(source);
    }
    detail.append(identity, actions, costs);
    const pending = marker(c.id);
    if (canAuthor && pending && pending.kind !== "save") {
      const retryArea = el("div", undefined, "topic-creation-confirm");
      const q =
        pending.kind === "approve"
          ? Object.values(
              topicCreationPayloads.approve.parse(pending.command),
            ).filter(
              (v): v is TopicQuote =>
                typeof v === "object" && v !== null && "maxMilliYen" in v,
            )
          : pending.kind === "resume"
            ? Object.values(c.quotes ?? {})
            : [
                topicCreationPayloads[pending.kind].parse(pending.command)
                  .quote,
              ];
      retryArea.append(
        el(
          "p",
          "前の操作の受付は未確認です。同じ受付内容を明示して再送できます。受付済みなら新しい依頼を作らず、未受付なら同じ承認内容で処理を始めます。",
        ),
      );
      for (const quote of q)
        retryArea.append(
          el(
            "p",
            `OpenAI / ${quote.model}・上限${yen(quote.maxMilliYen)}・${quote.dataConditions}`,
          ),
        );
      retryArea.append(
        button("同じ受付内容の再送を確認", () => {
          if (active) return;
          const controls = el("div");
          controls.append(
            el(
              "p",
              "同じモデル・費用上限・操作IDで再送します。新しい検証IDは作りません。",
            ),
            button(
              "確認して同じ受付内容を再送",
              () =>
                void run(async (signal) => {
                  mark(c.id, pending);
                  const r = await sendPending(pending, signal);
                  current();
                  clearMark(c.id);
                  if (r.creation) await show(r.creation);
                  notice.textContent = "同じ受付内容を確認しました。";
                }),
            ),
            button("取り消す", () => controls.remove()),
          );
          retryArea.append(controls);
          controls.querySelector("button")?.focus();
        }),
      );
      detail.append(retryArea);
    }
    actions.append(
      button("最新の状態を確認", () => void run(() => read(c.id))),
    );
    if (["held", "generation", "review"].includes(c.state))
      actions.append(
        button(
          "処理結果を照会",
          () =>
            void run(async (signal) => {
              const r = await client.creations("refresh", { id: c.id }, signal);
              if (r.creation) await show(r.creation);
              else await read(c.id);
            }),
        ),
      );
    if (c.reason === "capacity")
      detail.append(
        el(
          "p",
          "処理の控えがいっぱいです。終了した控えを整理してから再開するか、この依頼を取り下げてください。",
        ),
      );
    else if (c.state === "held")
      detail.append(
        el(
          "p",
          "結果がまだ確定していません。まず処理結果を照会してください。自動では送り直しません。",
        ),
      );
    else if (c.state === "rejected")
      detail.append(
        el(
          "p",
          c.operation &&
            "reviewPassed" in c.operation &&
            c.operation.reviewPassed === false
            ? "内容の検証で不合格になりました。教材には取り込めません。追加の検証には別途費用がかかります。"
            : "処理を見送りました。未送信が確認できた場合だけ同じ内容を再予約できます。送信済みの生成は自動でやり直しません。",
        ),
      );
    if (canAuthor && c.state === "draft")
      actions.append(
        button(
          "モデルと費用を確認",
          () =>
            void run(async (signal) =>
              renderCosts(c, costs, await client.status(signal), "approve"),
            ),
        ),
      );
    const operation =
      c.operation && "status" in c.operation ? c.operation : null;
    const statusMessages: Record<string, string> = {
      "materials-unavailable":
        "公開資料を送信前に確認できなかったため保留しました。資料を確認できるようになった後、未送信を照合して再予約できます。",
      "input-limit":
        "資料と学習目的がモデルの入力上限を超えています。テーマを絞り、資料を準備し直してください。",
      "budget-exhausted":
        "月の費用枠を確保できませんでした。費用枠を確認してください。",
      "provider-budget-exhausted":
        "提供元の費用枠を確保できませんでした。接続先の費用設定を確認してください。",
      "quote-changed":
        "承認後にモデルや費用が変わりました。最新の費用を確認してください。",
      unconnected: "モデルの接続が未設定です。接続設定の確認が必要です。",
      "account-forbidden":
        "現在のアカウントでは生成を利用できません。利用資格を確認してください。",
    };
    if (operation?.status && statusMessages[operation.status])
      detail.append(el("p", statusMessages[operation.status]));
    const canRetry =
      operation &&
      operation.status !== "input-limit" &&
      (operation.confirmedUnsent ||
        operation.status === "not-found" ||
        (c.state === "rejected" &&
          operation.status &&
          !["rejected", "complete", "reserved", "unknown"].includes(
            operation.status,
          )));
    if (
      ["held", "rejected"].includes(c.state) &&
      canAuthor &&
      c.reason !== "capacity" &&
      canRetry
    )
      actions.append(
        button(
          "再予約の費用を確認",
          () =>
            void run(async (signal) =>
              renderCosts(c, costs, await client.status(signal), "retry"),
            ),
        ),
      );
    if (
      canAuthor &&
      c.state === "rejected" &&
      c.stage === "review" &&
      operation &&
      (operation.status === "rejected" ||
        operation.reviewPassed === false ||
        (operation.state === "rejected" &&
          operation.status &&
          ![
            "complete",
            "reserved",
            "unknown",
            "credential-changed",
            "materials-unavailable",
          ].includes(operation.status)))
    )
      actions.append(
        button(
          "追加検証の費用を確認",
          () =>
            void run(async (signal) =>
              renderCosts(
                c,
                costs,
                await client.status(signal),
                "review-again",
              ),
            ),
        ),
      );
    if (
      canAuthor &&
      (["generation", "review"].includes(c.state) || c.reason === "capacity")
    )
      actions.append(
        button("続きを再開", () =>
          confirmation(
            actions,
            "承認済みのモデルと費用上限で続きを再開します。結果が不明な処理は再送しません。",
            "確認して再開",
            async (signal) => {
              mark(c.id, {
                kind: "resume",
                command: { id: c.id, confirm: true },
              });
              const r = await client.creations(
                "resume",
                { id: c.id, confirm: true },
                signal,
              );
              clearMark(c.id);
              if (r.creation) await show(r.creation);
            },
          ),
        ),
      );
    const canDiscard =
      c.state === "held" &&
      (c.reason === "capacity" ||
        (c.operation &&
          "confirmedUnsent" in c.operation &&
          c.operation.confirmedUnsent));
    if (["draft", "ready", "rejected"].includes(c.state) || canDiscard)
      actions.append(
        button(canDiscard ? "この依頼を取り下げる" : "この作成控えを削除", () =>
          confirmation(
            actions,
            "サーバーの依頼・結果・未取り込みの教材を削除します。取り込んだ教材と回答、すでに発生した費用は変わりません。削除した結果は復元できません。",
            "確認して削除",
            async (signal) => {
              await client.creations(
                "remove",
                {
                  id: c.id,
                  confirm: true,
                  ...(canDiscard
                    ? { discardGeneratedResult: true as const }
                    : {}),
                },
                signal,
              );
              clearMark(c.id);
              selected = null;
              detail.replaceChildren();
              await loadList(false);
              notice.textContent = "作成控えを削除しました。";
            },
          ),
        ),
      );
    if (c.book) {
      const book = await parseSharedTextbook(c.book);
      current();
      detail.append(
        el("h4", book.draft.title),
        el(
          "p",
          `${book.draft.lessons.length}節。別の呼び出しによる検証に合格しました。内容の正しさを保証するものではありません。`,
        ),
      );
      const lessons = el("ul");
      for (const lesson of book.draft.lessons)
        lessons.append(el("li", lesson.content.title));
      detail.append(lessons);
      detail.append(
        button(
          "完成版をこのブラウザに取り込む",
          () =>
            void run(async () => {
              current();
              await importSharedTextbook(book.raw);
              current();
              await saved(book.id);
              current();
              notice.textContent =
                "完成版をこのブラウザに取り込みました。保存した教材の一覧から読めます。";
            }),
        ),
      );
    }
    heading.focus();
  }
  function confirmation(
    area: HTMLElement,
    text: string,
    label: string,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (active) return;
    if (selected && marker(selected.id)) {
      notice.textContent =
        "前の操作が未確認です。先に同じ依頼の最新の状態を確認してください。";
      recover.focus();
      return;
    }
    const box = el("div", undefined, "topic-creation-confirm");
    box.append(
      el("p", text),
      button(label, () => void run(work)),
      button("取り消す", () => box.remove()),
    );
    area.append(box);
    box.querySelector("button")?.focus();
  }
  async function sendPending(value: PendingMarker, signal: AbortSignal) {
    switch (value.kind) {
      case "approve":
        return client.creations(
          "approve",
          topicCreationPayloads.approve.parse(value.command),
          signal,
        );
      case "retry":
        return client.creations(
          "retry",
          topicCreationPayloads.retry.parse(value.command),
          signal,
        );
      case "review-again":
        return client.creations(
          "review-again",
          topicCreationPayloads["review-again"].parse(value.command),
          signal,
        );
      case "resume":
        return client.creations(
          "resume",
          topicCreationPayloads.resume.parse(value.command),
          signal,
        );
      default:
        throw new TopicClientError("invalid-request");
    }
  }
  function renderCosts(
    c: TopicCreation,
    area: HTMLElement,
    status: TopicCapabilities,
    action: "approve" | "retry" | "review-again",
  ) {
    current();
    if (selected?.id !== c.id) return;
    const pendingAtRender = marker(c.id);
    if (pendingAtRender && pendingAtRender.kind !== action) {
      notice.textContent =
        "前の操作が未確認です。先に同じ依頼の最新の状態を確認してください。";
      recover.focus();
      return;
    }
    area.replaceChildren(
      el(
        "h4",
        action === "review-again" ? "追加検証のモデルと費用" : "送信前の確認",
      ),
    );
    if (pendingAtRender)
      area.append(
        el(
          "p",
          "前の操作は未確認です。以前の費用上限で遅れて処理が始まる場合があります。今回も同じ受付番号・検証IDを使い、新しい依頼は作りません。",
        ),
      );
    applyPermission(status.creations?.canAuthor === true);
    if (!status.creations?.enabled) {
      area.append(
        el(
          "p",
          "この接続先では新しい生成・検証を開始できません。保存した結果の確認はできます。",
        ),
      );
      return;
    }
    const form = el("form"),
      chosen: Record<string, TopicQuote> = {};
    const purposes =
      action === "approve" ? ["generation", "review"] : [c.stage];
    for (const phase of purposes) {
      const purpose =
        phase === "generation" ? "book-addition" : "evidence-check";
      const options = status.quotes.filter(
        (q) =>
          q.purpose === purpose &&
          (action !== "retry" ||
            (q.modelId === c.quotes?.[c.stage].modelId &&
              q.model === c.quotes[c.stage].model)),
      );
      if (!options.length) {
        area.append(
          el(
            "p",
            "現在使えるモデルと費用を確認できません。接続設定を確認してください。",
          ),
        );
        return;
      }
      const label = el(
          "label",
          phase === "generation" ? "生成モデル" : "検証モデル",
        ),
        select = el("select"),
        explanation = el("p");
      select.id = `topic-creation-${phase}`;
      label.htmlFor = select.id;
      for (const [i, q] of options.entries()) {
        const option = el(
          "option",
          `OpenAI / ${q.model}・最大${yen(q.maxMilliYen)}`,
        );
        option.value = String(i);
        select.append(option);
      }
      const update = () => {
        const q = options[Number(select.value)];
        chosen[phase] = q;
        explanation.textContent = `送信条件：${q.dataConditions}。料金確認 ${q.priceCheckedAt}。上限確認 ${q.costCheckedAt}。`;
        updateTotal();
      };
      select.addEventListener("change", update);
      chosen[phase] = options[0];
      explanation.textContent = `送信条件：${options[0].dataConditions}。料金確認 ${options[0].priceCheckedAt}。上限確認 ${options[0].costCheckedAt}。`;
      form.append(label, select, explanation);
    }
    const total = el("p", undefined, "topic-creation-cost"),
      consent = el("input"),
      consentLabel = el("label"),
      submit = el(
        "button",
        action === "approve"
          ? "この費用上限で作成を始める"
          : action === "retry"
            ? "未送信を確認して再予約する"
            : "この費用上限で追加検証する",
      );
    consent.type = "checkbox";
    consent.required = true;
    consentLabel.append(
      consent,
      document.createTextNode(
        "表示した公開資料の抜粋・テーマ・学習目的をOpenAIへ送り、この費用上限で処理することを確認しました。",
      ),
    );
    submit.type = "submit";
    function updateTotal() {
      const sum = Object.values(chosen).reduce((n, q) => n + q.maxMilliYen, 0);
      total.textContent = `今回の上限 合計${yen(sum)}。${action === "approve" ? "生成と検証の2段階です。" : "すでに発生した費用とは別の上限です。"}月の残り目安 ${yen(Math.max(0, status.budget.limitMilliYen - status.budget.spentMilliYen - status.budget.heldMilliYen))}。`;
      submit.disabled =
        sum > status.budget.limitMilliYen ||
        status.budget.spentMilliYen + status.budget.heldMilliYen >=
          status.budget.limitMilliYen;
    }
    updateTotal();
    form.append(
      total,
      el(
        "p",
        "送信する内容は、依頼に保存した資料・テーマ・学習目的と、検証時の生成候補です。記事の閲覧履歴・ハイライト・回答は送りません。",
      ),
      consentLabel,
      submit,
    );
    area.append(form);
    const reviewRequestId =
      pendingAtRender?.kind === "review-again"
        ? topicCreationPayloads["review-again"].parse(pendingAtRender.command)
            .reviewRequestId
        : crypto.randomUUID();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (active || !consent.checked || submit.disabled) return;
      if (marker(c.id) && !pendingAtRender) {
        notice.textContent =
          "前の操作が未確認です。先に同じ依頼の最新の状態を確認してください。";
        recover.focus();
        return;
      }
      void run(async (signal) => {
        const common = {
          id: c.id,
          expectedRevision: c.revision,
          confirm: true as const,
          approvedPublicText: true as const,
        };
        const pending: PendingMarker = {
          kind: action,
          command:
            action === "approve"
              ? {
                  ...common,
                  generation: chosen.generation,
                  review: chosen.review,
                }
              : action === "retry"
                ? { ...common, quote: chosen[c.stage] }
                : { ...common, quote: chosen.review, reviewRequestId },
        };
        mark(c.id, pending);
        const r = await sendPending(pending, signal);
        current();
        clearMark(c.id);
        if (r.creation) await show(r.creation);
        notice.textContent =
          "依頼を受け付けました。画面を閉じた後も処理を続けます。自動では追加の有料処理を送りません。";
      });
    });
  }
  history.addEventListener("toggle", () => {
    if (history.open && !initialized && !active)
      void run(() => loadList(false));
  });
  window.addEventListener("pagehide", () => active?.abort());
  return root;
}
