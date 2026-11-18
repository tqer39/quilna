import { button, el } from "./ui";
import {
  DocumentPolicyClient,
  type DocumentPolicy,
  type PublicationState,
  type PublicationRecord,
} from "./document-policy-client";

const localDate = (at: number) => {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
type Run = (task: (signal: AbortSignal) => Promise<void>) => Promise<void>;

/** 公開前の確認と、結果不明時の再照会を分け、下書きを自動送信しない。 */
export function documentPublicationView(
  client: DocumentPolicyClient,
  policy: DocumentPolicy,
  run: Run,
) {
  const root = el("details"),
    summary = el("div"),
    recovery = el("div"),
    review = el("div"),
    history = el("div");
  root.setAttribute("aria-label", "一般公開の許可");
  root.append(el("summary", "一般公開の許可"));
  const notice = el(
    "p",
    "公開設定を確認してから、ログインなしでの配信を設定できます。",
  );
  notice.setAttribute("aria-live", "polite");
  const fields = el("fieldset"),
    legend = el("legend", "ログインなしで読める範囲");
  const enabled = el("input"),
    expires = el("input"),
    reason = el("textarea"),
    approve = el("input");
  enabled.type = approve.type = "checkbox";
  expires.type = "datetime-local";
  expires.required = true;
  expires.step = "60";
  reason.maxLength = 2000;
  reason.required = true;
  reason.rows = 3;
  const wrap = (text: string, input: HTMLElement) => {
    const label = el("label", text);
    label.append(input);
    return label;
  };
  fields.append(
    legend,
    wrap("この出典の記事を誰でも読めるようにする", enabled),
    wrap("一般公開の期限（端末の現地時刻）", expires),
    wrap("一般公開してよい根拠", reason),
    wrap("この出典の原文を一般公開できることを確認しました", approve),
  );
  let baseline: PublicationState | null = null,
    uncertain = false,
    reviewing = false;
  const block = () => {
    fields.inert = !baseline || uncertain || reviewing;
  };
  const show = (state: PublicationState) => {
    const p = state.publication;
    const active =
      !!p &&
      p.enabled &&
      p.policyRevision === state.policyRevision &&
      state.policyEnabled &&
      Math.min(p.expires, state.policyExpires) > Date.now();
    summary.replaceChildren(
      el("p", policy.url),
      el(
        "p",
        p
          ? `${active ? "公開許可は有効です" : "現在の公開許可は無効です"}。変更 #${p.revision}`
          : "一般公開の許可は登録されていません。",
      ),
    );
    if (p) {
      summary.append(
        el("p", `公開期限：${new Date(p.expires).toLocaleString()}`),
        el("p", p.evidence),
      );
      const actor = el("details");
      actor.append(
        el("summary", "変更者と日時"),
        el(
          "p",
          p.actor
            ? `変更者：${p.actor} / ${new Date(p.updated).toLocaleString()}`
            : "この許可の元の変更者・日時は不明です。",
        ),
      );
      summary.append(actor);
    }
    if (active) {
      const link = el("a", "公開ページを開く");
      const target = new URL("/public/documents", location.href);
      target.searchParams.set("url", policy.url);
      link.href = target.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      summary.append(link);
      summary.append(
        el(
          "p",
          "保存済みの共有版がない場合や、本文の提供が停止された場合は表示されません。",
          "muted",
        ),
      );
    }
    if (
      state.policyRevision !== policy.policyRevision ||
      state.managementRevision !== policy.managementRevision
    )
      summary.append(
        el(
          "p",
          "共有条件が変わっています。最新の共有設定を読み直してから公開を設定してください。",
        ),
      );
  };
  const apply = (state: PublicationState) => {
    baseline = state;
    enabled.checked =
      !!state.publication?.enabled &&
      state.publication.policyRevision === state.policyRevision;
    expires.value = localDate(
      state.publication?.expires ?? state.policyExpires,
    );
    reason.value = state.publication?.evidence ?? "";
    approve.checked = false;
    uncertain = reviewing = false;
    root.dataset.publicationDirty = root.dataset.publicationPending = "false";
    review.replaceChildren();
    recovery.replaceChildren();
    show(state);
    block();
  };
  const load = button(
    "公開設定を確認",
    () =>
      void run(async (signal) => {
        const state = await client.readPublication(policy.id, signal);
        show(state);
        root.dataset.publicationPending = "false";
        if (!baseline) apply(state);
        else
          recovery.replaceChildren(
            el(
              "p",
              "最新の公開設定を確認しました。入力中の内容は保持しています。",
            ),
            button("この公開設定で編集し直す", () => {
              apply(state);
              notice.textContent = "保存済みの公開設定から編集し直せます。";
            }),
          );
        notice.textContent =
          "公開設定を読み込みました。変更はまだ保存していません。";
      }).then(() => {
        if (load.isConnected) load.focus();
      }),
  );
  const confirm = button("公開の変更内容を確認", () => {
    if (!baseline || uncertain || reviewing) return;
    const initial = baseline.publication?.expires ?? baseline.policyExpires;
    const input: Pick<PublicationRecord, "enabled" | "expires" | "evidence"> = {
      enabled: enabled.checked,
      expires:
        expires.value === localDate(initial)
          ? initial
          : new Date(expires.value).getTime(),
      evidence: reason.value,
    };
    if (
      input.evidence.trim().length < 5 ||
      input.evidence.length > 2000 ||
      !Number.isFinite(input.expires) ||
      (input.enabled &&
        (!approve.checked ||
          !baseline.policyEnabled ||
          input.expires <= Date.now() ||
          input.expires > baseline.policyExpires))
    ) {
      notice.textContent =
        "一般公開の根拠（5〜2,000文字）と期限を確認してください。有効にするときは公開可能であることの確認も必要です。";
      return;
    }
    if (
      baseline.policyRevision !== policy.policyRevision ||
      baseline.managementRevision !== policy.managementRevision
    ) {
      notice.textContent =
        "共有条件が変わっています。最新の共有設定を確認してください。";
      return;
    }
    reviewing = true;
    block();
    review.replaceChildren(
      el("h5", "保存する公開範囲"),
      el("p", policy.url),
      el(
        "p",
        input.enabled
          ? "この出典の保存済み共有記事を、ログインしていない人も読めるようにします。"
          : "一般公開の許可を無効にします。指定した利用者の共有設定は変えません。",
      ),
      el("p", `公開期限：${new Date(input.expires).toLocaleString()}`),
      el("p", input.evidence),
      button(
        "この公開設定を保存",
        () =>
          void run(async (signal) => {
            if (!baseline || uncertain) return;
            root.dataset.publicationDirty = "true";
            root.dataset.publicationPending = "true";
            try {
              const next = await client.savePublication(
                policy,
                baseline,
                input,
                signal,
              );
              apply(next);
              notice.textContent =
                "公開設定を保存しました。個人の読書記録は変更していません。";
            } catch (error) {
              uncertain = true;
              reviewing = false;
              review.replaceChildren();
              block();
              notice.textContent =
                "保存結果を確認できません。自動では再送しません。公開設定を確認し、必要なら保存済みの内容から編集し直してください。";
              throw error;
            }
          }).then(() => {
            if (load.isConnected) load.focus();
          }),
      ),
      button("公開の入力に戻る", () => {
        reviewing = false;
        review.replaceChildren();
        block();
      }),
    );
    notice.textContent = "公開する範囲・期限・根拠を確認して保存してください。";
  });
  fields.addEventListener("input", (event) => {
    root.dataset.publicationDirty = "true";
    if (event.target !== approve) approve.checked = false;
  });
  const historyPage = async (before: number | null, signal: AbortSignal) => {
    const result = await client.publicationHistory(policy.id, before, signal);
    history.replaceChildren(el("h5", "一般公開の変更履歴"));
    if (!result.entries.length)
      history.append(el("p", "公開許可の変更履歴はありません。"));
    for (const entry of result.entries)
      history.append(
        el(
          "p",
          `変更 #${entry.revision} / ${entry.enabled ? "有効" : "無効"} / ${new Date(entry.recorded).toLocaleString()}`,
        ),
        el(
          "p",
          entry.actor
            ? `変更者：${entry.actor}`
            : "履歴導入前の設定：元の変更者・日時は不明です。",
        ),
        el(
          "p",
          `共有条件の世代：${entry.policyRevision} / 期限：${new Date(entry.expires).toLocaleString()}`,
        ),
        el("p", entry.evidence),
      );
    if (result.before)
      history.append(
        button(
          "さらに前の公開履歴20件",
          () => void run((s) => historyPage(result.before, s)),
        ),
      );
  };
  root.append(
    el(
      "p",
      "一般公開では、指定した利用者以外にも原文を配信します。既に配信したコピーは回収できません。個人の既読・保存・メモは含まれません。",
      "muted",
    ),
    load,
    notice,
    summary,
    recovery,
    fields,
    confirm,
    review,
    button("一般公開の履歴を確認", () => void run((s) => historyPage(null, s))),
    history,
  );
  block();
  return root;
}
