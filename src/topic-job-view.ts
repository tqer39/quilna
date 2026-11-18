import { el, button } from "./ui";
import { libraryAccount, librarySignedOut } from "./library-context";
import {
  TopicGenerationClient,
  TopicClientError,
} from "./topic-generation-client";
import type { TopicJob, TopicJobSummary } from "./topic-job-protocol";

const states: Record<TopicJobSummary["state"], string> = {
  queued: "順番待ち",
  running: "処理中",
  complete: "結果あり",
  rejected: "処理を見送り",
  held: "結果の確認待ち",
  cancelled: "予約取消済み",
  unavailable: "記録を確認できません",
};
const date = (at: number) => new Date(at).toLocaleString("ja-JP");
const outcomes: Record<string, string> = {
  unconnected: "生成先に接続されていません。接続設定の確認が必要です。",
  "model-unapproved":
    "選択したモデルを使用できません。モデル設定の確認が必要です。",
  "cost-unconfigured": "費用の設定がないため処理を開始できません。",
  "count-unconfigured": "送信量を確認する設定がないため処理を開始できません。",
  "input-limit": "送信内容が上限を超えているため処理を開始できません。",
  "id-conflict": "同じ識別子に別の依頼があるため処理できません。",
  "cost-policy-changed": "費用設定が変わっています。費用の再確認が必要です。",
  "budget-exhausted": "費用の上限に達しているため処理を開始できません。",
  "provider-budget-exhausted":
    "提供元の費用枠を確保できないため処理を開始できません。",
  "credential-changed":
    "接続用のキーが変更されています。接続設定の確認が必要です。",
  "cost-unapproved": "費用が承認されていないため処理を開始できません。",
  "cost-limit": "承認した費用上限を超えているため処理を開始できません。",
  "quote-changed": "見積りが変わっています。費用の再確認が必要です。",
};
const failures: Record<string, string> = {
  "topic-jobs-unconfigured":
    "この接続先では、作成状況の確認がまだ有効になっていません。",
  unauthenticated: "ログインを確認してから、もう一度開いてください。",
  "account-mismatch": "アカウントが変わりました。ページを開き直してください。",
  "topic-job-owner":
    "このアカウントでは記録を確認できません。ページを開き直してください。",
  "csrf-invalid": "接続を確認し直してください。操作は自動でやり直しません。",
  "topic-job-active":
    "処理が進んだため、この操作はできません。最新の状態を確認してください。",
  "rate-limit": "操作が続いています。少し時間を置いて確認してください。",
  "topic-job-cursor":
    "一覧が変更されました。「一覧を確認」で最初から確認してください。",
  "topic-job-missing":
    "この記録は見つかりません。「一覧を確認」で最新の状態を確認してください。",
  "topic-job-request":
    "記録の指定を確認できません。ページを開き直してください。",
  "not-found":
    "この接続先では作成状況を確認できません。接続先を確認してください。",
};

/** 再照会だけを行い、ページの再表示や通信失敗から生成を再送しない。 */
export function topicJobView() {
  const root = el("details", undefined, "topic-job-status"),
    summary = el("summary", "作成状況"),
    notice = el("p"),
    rows = el("ol", undefined, "topic-job-list"),
    detail = el("section"),
    controls = el("div", undefined, "topic-job-controls");
  notice.setAttribute("role", "status");
  rows.setAttribute("aria-label", "サーバーに保存した作成状況");
  detail.setAttribute("aria-label", "作成結果の状態");
  root.append(
    summary,
    el(
      "p",
      "画面を閉じた後の処理も、ここで確認できます。候補の生成と内容の検証は別の段階です。",
    ),
    notice,
    controls,
    rows,
    detail,
  );
  const account = libraryAccount();
  if (!account) {
    notice.textContent = "作成状況の確認にはログインが必要です。";
    return root;
  }
  const client = new TopicGenerationClient(
    account,
    libraryAccount,
    librarySignedOut,
  );
  let active: AbortController | undefined;
  let initialized = false;
  let reloadRequested = false,
    leaving = false;
  let cursor: string | null = null;
  const seen = new Set<string>();
  const refresh = button("一覧を確認", () => void load(false));
  const more = button("続きを表示", () => void load(true));
  more.hidden = true;
  controls.append(refresh, more);
  function current() {
    try {
      if (libraryAccount() === account) return;
    } catch {
      // 失効済みの文脈も、別アカウントと同じように表示を破棄する。
    }
    rows.replaceChildren();
    detail.replaceChildren();
    throw new TopicClientError("account-mismatch");
  }
  async function work(
    task: (signal: AbortSignal) => Promise<void>,
    mutation = false,
  ) {
    if (active) return;
    const controller = new AbortController();
    active = controller;
    root.setAttribute("aria-busy", "true");
    // ボタンはフォーカスを維持し、操作の再入はactiveで止める。
    try {
      current();
      notice.textContent = "確認しています。";
      await task(controller.signal);
      current();
    } catch (error) {
      const code = error instanceof TopicClientError ? error.code : "held";
      if (
        ["account-mismatch", "unauthenticated", "topic-job-owner"].includes(
          code,
        )
      ) {
        rows.replaceChildren();
        detail.replaceChildren();
      }
      if (code === "topic-job-cursor") {
        cursor = null;
        more.hidden = true;
        initialized = false;
        refresh.focus();
      }
      if (code === "cancelled") {
        initialized = false;
        notice.textContent =
          "待機を止めました。操作が反映されたかは「一覧を確認」で確認してください。自動では操作をやり直しません。";
      } else
        notice.textContent =
          failures[code] ??
          (mutation
            ? "操作の結果を確認できませんでした。既に反映された可能性があります。「一覧を確認」で確認してください。自動では操作をやり直しません。"
            : "確認できませんでした。表示中の記録を残しています。もう一度確認してください。操作は自動でやり直しません。");
    } finally {
      active = undefined;
      root.removeAttribute("aria-busy");
      const reload = reloadRequested && root.open && !leaving;
      reloadRequested = false;
      if (reload) {
        queueMicrotask(() => void load(false));
      }
    }
  }
  function show(job: TopicJob | null) {
    detail.replaceChildren();
    if (!job) {
      detail.append(
        el("p", "この記録は見つかりません。一覧を確認し直してください。"),
      );
      return;
    }
    detail.append(
      el("h3", states[job.state]),
      el("p", `受付日時 ${date(job.createdAt)}`),
    );
    if (job.result?.status === "complete") {
      detail.append(
        el(
          "p",
          job.result.draft.kind === "topic-textbook-draft"
            ? "生成候補を受け取りました。内容の検証と教材としての保存は、まだ完了していません。"
            : job.result.draft.allChecksPassed
              ? "検証結果を受け取りました。教材としての保存は、まだ完了していません。"
              : "検証で修正が必要になりました。教材としての保存は行っていません。",
        ),
      );
    } else if (job.reason === "access-unavailable") {
      detail.append(
        el("p", "送信前に利用権限を確認できなかったため、処理を見送りました。"),
      );
    } else if (job.result && outcomes[job.result.status]) {
      detail.append(
        el(
          "p",
          `${outcomes[job.result.status]}この画面から生成をやり直すことはありません。`,
        ),
      );
    } else if (job.state === "held" || job.state === "running") {
      detail.append(
        el(
          "p",
          "処理結果をまだ確定できません。「結果を確認」は保存先を照会し、生成を送り直しません。",
        ),
      );
    } else if (job.state === "rejected") {
      detail.append(
        el(
          "p",
          "処理は完了していません。接続・費用・検証結果の確認が必要です。自動では再送しません。",
        ),
      );
    }
    notice.textContent = "保存先の状態を確認しました。";
  }
  function reveal(job: TopicJob | null, row: HTMLElement) {
    let target = row;
    if (job) {
      target = render(job);
      row.replaceWith(target);
    }
    show(job);
    target.append(detail);
    detail.tabIndex = -1;
    detail.focus();
  }
  function render(job: TopicJobSummary | TopicJob) {
    const row = el("li", undefined, "topic-job-row"),
      heading = el(
        "h3",
        job.state === "unavailable"
          ? states[job.state]
          : `受付 ${date(job.createdAt)}`,
      );
    row.append(heading);
    const reference = el("details");
    reference.append(el("summary", "記録の識別子"), el("p", job.id));
    row.append(reference);
    if (job.state === "unavailable") {
      row.append(
        el("p", "記録は変更していません。接続先の管理者に確認してください。"),
      );
    } else {
      row.append(
        el("p", states[job.state]),
        button(
          "結果を確認",
          () =>
            void work(async (signal) => {
              const reply = await client.jobs(
                job.state === "running" ||
                  (job.state === "held" &&
                    !(
                      "result" in job &&
                      job.result &&
                      outcomes[job.result.status]
                    ))
                  ? "refresh"
                  : "read",
                { id: job.id },
                signal,
              );
              current();
              reveal(reply.job, row);
            }),
        ),
      );
      const action =
        job.state === "queued"
          ? "cancel"
          : ["complete", "rejected", "cancelled"].includes(job.state)
            ? "remove"
            : null;
      if (action)
        row.append(
          button(
            action === "cancel" ? "予約を取り消す" : "控えを整理する",
            () => {
              if (active) return;
              row.querySelector(".topic-job-confirm")?.remove();
              const confirmation = el("div", undefined, "topic-job-confirm");
              confirmation.append(
                el(
                  "p",
                  action === "cancel"
                    ? "未実行の予約だけを取り消します。既に処理が始まっていれば取り消せません。"
                    : "この控えと結果を削除します。この画面から復元できず、教材として保存していない内容も失われます。費用や保存済み教材は変更しません。",
                ),
                button(
                  action === "cancel"
                    ? "確認して予約を取り消す"
                    : "確認して控えを削除する",
                  () =>
                    void work(async (signal) => {
                      if (action === "remove") {
                        await client.jobs(
                          "remove",
                          { id: job.id, confirm: true },
                          signal,
                        );
                        current();
                        row.remove();
                        seen.delete(job.id);
                        const reset = cursor === job.id;
                        if (reset) {
                          cursor = null;
                          more.hidden = true;
                          initialized = false;
                        }
                        detail.replaceChildren();
                        refresh.focus();
                        notice.textContent = reset
                          ? "控えを削除しました。続きは「一覧を確認」で確認してください。"
                          : "控えを削除しました。";
                      } else {
                        const reply = await client.jobs(
                          "cancel",
                          { id: job.id, confirm: true },
                          signal,
                        );
                        current();
                        if (!reply.job)
                          throw new TopicClientError("invalid-response");
                        reveal(reply.job, row);
                        notice.textContent = "予約を取り消しました。";
                      }
                    }, true),
                ),
                button("変更せず戻る", () => confirmation.remove()),
              );
              row.append(confirmation);
            },
          ),
        );
    }
    return row;
  }
  async function load(append: boolean) {
    await work(async (signal) => {
      const page = await client.jobs(
        "list",
        append && cursor ? { after: cursor } : {},
        signal,
      );
      current();
      if (append && page.after && seen.has(page.after))
        throw new TopicClientError("invalid-response");
      if (!append) {
        rows.replaceChildren();
        seen.clear();
      }
      for (const job of page.jobs)
        if (!seen.has(job.id)) {
          rows.append(render(job));
          seen.add(job.id);
        }
      cursor = page.after;
      const moveFocus = cursor === null && document.activeElement === more;
      more.hidden = cursor === null;
      if (moveFocus) refresh.focus();
      notice.textContent = seen.size
        ? `${seen.size}件の記録を表示しています。`
        : "保存先に作成の記録はありません。";
      initialized = true;
    });
  }
  root.addEventListener("toggle", () => {
    if (root.open && active?.signal.aborted) reloadRequested = true;
    else if (root.open && !initialized) void load(false);
    else if (!root.open) active?.abort();
  });
  window.addEventListener("pagehide", () => {
    leaving = true;
    active?.abort();
  });
  return root;
}
