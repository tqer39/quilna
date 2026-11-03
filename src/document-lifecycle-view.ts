import { el, button } from "./ui";
import { DocumentPolicyClient, PolicyError } from "./document-policy-client";
import {
  lifecycleCommand,
  type LifecycleCommand,
  type LifecycleAction,
} from "./document-lifecycle.mjs";
import {
  sameLifecycleCommand,
  type LifecycleContext,
  type LifecyclePreview,
  type ReservationSummary,
} from "./document-lifecycle-client";

type Run = (task: (signal: AbortSignal) => Promise<void>) => Promise<void>;
const labels: Record<LifecycleAction, string> = {
  withdraw: "本文の提供を停止",
  restore: "本文の提供を再開",
  retention: "保持期限を変更",
  purge: "保存本文を削除",
};

/** Keep confirmation and retry bound to one exact source, scope and operation. */
export function documentLifecycleView(
  client: DocumentPolicyClient,
  context: LifecycleContext,
  run: Run,
) {
  const root = el("section"),
    summary = el("div"),
    review = el("div"),
    history = el("div"),
    retry = el("div"),
    reservationControls = el("div");
  root.setAttribute("aria-label", "保存本文の管理");
  const markDirty = () => {
    root.dataset.lifecycleDirty = "true";
  };
  const notice = el("p", "保存状態を確認してから操作してください。");
  notice.setAttribute("aria-live", "polite");
  const reasonLabel = el("label", "本文管理の理由"),
    reason = el("textarea");
  reason.maxLength = 200;
  reason.rows = 2;
  reasonLabel.append(reason);
  const expiryLabel = el(
      "label",
      "本文の保持期限（端末の現地時刻・空欄で解除）",
    ),
    expiry = el("input");
  expiry.type = "datetime-local";
  expiryLabel.append(expiry);
  const fields = el("fieldset");
  fields.append(el("legend", "保存本文への操作"), reasonLabel, expiryLabel);
  let preview: LifecyclePreview | null = null,
    pending: LifecycleCommand | null = null,
    pendingRecovery: Pick<ReservationSummary, "token" | "revision"> | null =
      null;
  let recoveryWasDirty = false;
  const blockInputs = () => {
    fields.inert = !!pending || !!pendingRecovery;
  };
  const show = (value: LifecyclePreview) => {
    preview = value;
    const state =
      value.status === "deleted"
        ? "削除済み"
        : value.status === "withdrawn"
          ? "提供停止中"
          : value.expired
            ? "保持期限切れ"
            : "提供可能";
    summary.replaceChildren(
      el("p", context.url),
      el("p", `対象範囲: ${context.scope}`),
      el(
        "p",
        `${state} · ${value.versionCount}版 · ${value.bytes.toLocaleString()}バイト`,
      ),
      el(
        "p",
        `保持期限: ${value.expiresAt ? new Date(value.expiresAt).toLocaleString() : "未設定"}`,
      ),
      el(
        "p",
        value.cleanupPending
          ? "期限を過ぎた本文の削除待ちです。状態を再確認できます。"
          : "期限による削除待ちはありません。",
      ),
    );
    const reservation = value.reservation;
    reservationControls.replaceChildren(
      el(
        "p",
        !reservation.reserved
          ? "この本文取得の予約枠は使用していません。"
          : reservation.legacy
            ? "旧形式の共有予約に確認できない世代が残っています。枠は自動で解放しません。"
            : `本文取得の予約枠を使用中です。記録済みの対象は${reservation.scopeCount}世代です。`,
      ),
    );
    if (value.status === "deleted" && reservation.containsTarget) {
      reservationControls.append(
        button("本文取得枠を回復", () => {
          if (pending || pendingRecovery) return;
          const expected = {
            token: reservation.token,
            revision: reservation.revision,
          };
          review.replaceChildren(
            el("h4", "予約枠の回復を確認"),
            el("p", context.url),
            el(
              "p",
              "この削除済み本文の予約だけを外します。別世代の本文が残る場合は枠を保持し、他の出典には影響しません。",
            ),
            button("確認した予約枠を回復", () => {
              if (pending || pendingRecovery) return;
              recoveryWasDirty = root.dataset.lifecycleDirty === "true";
              pendingRecovery = expected;
              markDirty();
              blockInputs();
              void run(applyRecovery);
            }),
            button("本文操作を取り消す", () => review.replaceChildren()),
          );
        }),
      );
    }
    history.replaceChildren(el("h4", "本文管理の記録"));
    for (const item of value.operations)
      history.append(
        el(
          "p",
          `${new Date(item.at).toLocaleString()} · ${labels[item.command.action]} · ${item.command.reason}`,
        ),
      );
  };
  const applyRecovery = async (signal: AbortSignal) => {
    if (!pendingRecovery) return;
    try {
      const current = await client.reconcileDocument(
        context,
        pendingRecovery,
        signal,
      );
      show(current);
      pendingRecovery = null;
      blockInputs();
      if (!recoveryWasDirty) delete root.dataset.lifecycleDirty;
      retry.replaceChildren();
      review.replaceChildren();
      notice.textContent = current.reservation.reserved
        ? "削除済み本文の予約を外しました。他の世代のために枠を保持しています。"
        : "本文取得の予約枠を回復しました。";
    } catch (error) {
      review.replaceChildren();
      retry.replaceChildren(
        button("同じ予約枠の回復を再確認", () => void run(applyRecovery)),
      );
      notice.textContent =
        "予約枠の回復結果を確認できません。同じ対象を再確認できます。";
      throw error;
    }
  };
  const apply = async (signal: AbortSignal) => {
    if (!pending) return;
    try {
      const result = await client.changeDocument(context, pending, signal);
      show(result.current);
      pending = null;
      blockInputs();
      delete root.dataset.lifecycleDirty;
      retry.replaceChildren();
      review.replaceChildren();
      notice.textContent = result.replayed
        ? "記録済みの操作を確認しました。重複実行していません。"
        : "本文管理の操作を記録しました。";
    } catch (error) {
      review.replaceChildren();
      retry.replaceChildren(
        button("同じ操作を再確認・再試行", () => void run(apply)),
      );
      notice.textContent =
        "結果を確認できません。同じ操作を再確認するか、保存状態を読み直してください。新しい操作はまだ送信しません。";
      throw error;
    }
  };
  const read = button(
    "保存本文の状態を確認",
    () =>
      void run(async (signal) => {
        const value = await client.previewDocument(context, signal);
        show(value);
        review.replaceChildren();
        if (pendingRecovery) {
          pendingRecovery = null;
          blockInputs();
          retry.replaceChildren();
          if (!recoveryWasDirty) delete root.dataset.lifecycleDirty;
          notice.textContent =
            "現在の予約状態を確認しました。必要なら内容を確認してから回復してください。";
        } else if (pending) {
          const recorded = value.operations.find(
            (o) => o.command.operationId === pending!.operationId,
          );
          if (recorded && !sameLifecycleCommand(recorded.command, pending))
            throw new PolicyError(
              "操作の記録が一致しません。再試行を止めて管理者が確認してください。",
            );
          notice.textContent = recorded
            ? "操作は記録済みでした。重複実行していません。"
            : "現在の記録にこの操作はありません。必要なら内容を確認し直してください。";
          pending = null;
          blockInputs();
          if (recorded) delete root.dataset.lifecycleDirty;
          retry.replaceChildren();
        } else notice.textContent = "保存本文の状態と管理記録を確認しました。";
      }),
  );
  const prepare = (action: LifecycleAction) => {
    review.replaceChildren();
    if (!preview || pending || pendingRecovery) {
      notice.textContent = "先に保存本文の状態を確認してください。";
      return;
    }
    try {
      const command = lifecycleCommand.parse({
        operationId: crypto.randomUUID(),
        action,
        expectedRevision: preview.revision,
        reason: reason.value,
        ...(action === "purge"
          ? { expectedCatalogRevision: preview.catalogRevision }
          : {}),
        ...(action === "retention"
          ? {
              expiresAt: expiry.value
                ? new Date(expiry.value).toISOString()
                : null,
            }
          : {}),
      });
      const card = el("section");
      card.append(
        el("h4", "本文管理の確認"),
        el("p", context.url),
        el("p", `対象範囲: ${context.scope}`),
        el(
          "p",
          `${labels[action]} · ${preview.versionCount}版 · ${preview.bytes.toLocaleString()}バイト`,
        ),
        el("p", command.reason),
      );
      if (action === "purge")
        card.append(
          el(
            "p",
            "サーバーの保存本文を削除します。同じ範囲では復元できません。取得済みコピー、個人のメモや引用は残ります。",
          ),
        );
      if (action === "retention")
        card.append(
          el(
            "p",
            command.expiresAt
              ? `保持期限 ${new Date(command.expiresAt).toLocaleString()} 以降にサーバー本文を削除します。`
              : "本文の保持期限を解除します。",
          ),
        );
      card.append(
        button("確認した本文操作を実行", () => {
          if (pending || pendingRecovery) return;
          pending = command;
          markDirty();
          blockInputs();
          void run(apply);
        }),
        button("本文操作を取り消す", () => {
          review.replaceChildren();
        }),
      );
      review.append(card);
    } catch {
      notice.textContent = "理由（1〜200文字）と保持期限を確認してください。";
    }
  };
  for (const action of Object.keys(labels) as LifecycleAction[])
    fields.append(button(labels[action], () => prepare(action)));
  fields.addEventListener("input", () => {
    markDirty();
    review.replaceChildren();
  });
  root.append(
    el("h4", "保存本文の管理"),
    read,
    notice,
    summary,
    reservationControls,
    fields,
    review,
    retry,
    history,
  );
  return root;
}
