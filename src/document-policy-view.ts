import { button, el } from "./ui";
import { sourceURL } from "./feed-discovery";
import {
  DocumentPolicyClient,
  PolicyError,
  validatePolicyInput,
  type DocumentPolicy,
  type PolicyInput,
  type PolicyAlias,
} from "./document-policy-client";

const localDate = (time: number) => {
  const date = new Date(time);
  return Number.isFinite(date.getTime())
    ? new Date(time - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
};
const dateValue = (value: string) => (value ? new Date(value).getTime() : NaN);

export function documentPolicySettings(client = new DocumentPolicyClient()) {
  const root = el("details", undefined, "rss-policy-settings");
  root.append(el("summary", "共有する本文の管理（管理者用）"));
  const notice = el(
    "p",
    "管理者として接続を確認すると、共有する出典と利用者を編集できます。",
  );
  notice.setAttribute("role", "status");
  const workspace = el("div"),
    list = el("div"),
    editor = el("div"),
    recovery = el("div");
  workspace.hidden = true;
  let busy = false,
    dirty = false,
    uncertain = false,
    bound: string | null = null;
  let previous: DocumentPolicy | null = null,
    next: string | null = null;
  let controller = new AbortController();
  const connect = button(
    "管理者として接続を確認",
    () =>
      void run(async (signal) => {
        const account = await client.connect(signal);
        bound = account;
        workspace.hidden = false;
        identity.value = account;
        if (!dirty && !previous) await loadList(null, signal);
        notice.textContent =
          "管理者の接続を確認しました。現在の編集内容は、この画面を離れるまで保持します。";
      }),
  );
  const reset = button("編集を破棄して接続し直す", () => {
    if (busy || !discard()) return;
    client.account = bound = null;
    previous = null;
    dirty = uncertain = false;
    workspace.hidden = true;
    editor.replaceChildren();
    recovery.replaceChildren();
    list.replaceChildren();
    notice.textContent =
      "編集を破棄しました。接続するアカウントを確認してください。";
  });
  const identity = el("input");
  identity.readOnly = true;
  const identityLabel = el("label", "自分の利用者ID");
  identityLabel.append(identity);
  const refresh = button(
    "一覧の先頭を確認",
    () => void run((s) => loadList(null, s)),
  );
  const more = button("次の20件", () => {
    if (next) void run((s) => loadList(next, s));
  });
  const create = button("共有する出典を登録", () => {
    if (busy || !discard()) return;
    renderEditor(null);
    notice.textContent =
      "本文を提供できる根拠を確認した出典だけ登録してください。初期状態は無効です。";
  });
  workspace.append(
    identityLabel,
    el(
      "p",
      "利用者IDは本人のログインから決まります。ここで共有相手を追加しても、新しいログイン利用者は追加されません。",
      "muted",
    ),
    refresh,
    more,
    create,
    list,
    recovery,
    editor,
  );
  root.append(
    el(
      "p",
      "登録した出典の本文を、指定した利用者だけが再利用できます。既読・保存・翻訳・メモは共有しません。",
      "muted",
    ),
    connect,
    reset,
    notice,
    workspace,
  );
  function discard() {
    return (
      !dirty ||
      window.confirm(
        "編集中の内容を破棄しますか？ 保存済みの共有設定は変更しません。",
      )
    );
  }
  function controls() {
    for (const b of Array.from(
      root.querySelectorAll<HTMLButtonElement>("button"),
    ))
      b.disabled = busy;
    more.disabled = busy || !next;
    for (const f of Array.from(
      editor.querySelectorAll<HTMLFieldSetElement>("fieldset"),
    ))
      f.disabled = busy || !!editor.querySelector(".rss-policy-review");
    const review = editor.querySelector<HTMLButtonElement>("[data-review]");
    if (review) review.disabled = busy || uncertain;
  }
  async function run(
    task: (signal: AbortSignal) => Promise<void>,
    mutating = false,
  ) {
    if (busy) return;
    busy = true;
    controls();
    const current = controller;
    try {
      await task(current.signal);
    } catch (error) {
      if (mutating) {
        uncertain = true;
        editor.querySelector(".rss-policy-review")?.remove();
      }
      if (error instanceof PolicyError && error.locked) workspace.hidden = true;
      notice.textContent = (error as Error).message;
      if (mutating)
        notice.textContent +=
          " 自動で保存し直しません。下書きを保持したまま、一覧または最新の設定を確認してください。";
    } finally {
      busy = false;
      controls();
    }
  }
  async function loadList(after: string | null, signal: AbortSignal) {
    const page = await client.list(after, signal);
    next = page.after;
    list.replaceChildren(el("h4", "登録済みの共有出典"));
    if (!page.policies.length)
      list.append(el("p", "このページに共有出典はありません。"));
    for (const policy of page.policies) {
      const row = button(
        `${policy.enabled ? "有効" : "無効"} · ${policy.url}`,
        () => {
          if (busy || !discard()) return;
          void run(async (s) => {
            const p = await client.read(policy.id, s);
            renderEditor(p);
            notice.textContent = "最新の共有設定を読み込みました。";
          });
        },
      );
      list.append(row);
    }
    controls();
  }
  function renderEditor(saved: DocumentPolicy | null) {
    previous = saved;
    dirty = false;
    uncertain = false;
    recovery.replaceChildren();
    editor.replaceChildren();
    const data: PolicyInput = saved ?? {
      url: "",
      enabled: false,
      expires: Math.floor((Date.now() + 30 * 86400000) / 60000) * 60000,
      evidence: "",
      members: bound ? [bound] : [],
      aliases: [],
    };
    const form = el("form"),
      fields = el("fieldset"),
      aliases = el("div"),
      preview = el("div");
    fields.append(el("legend", saved ? "共有設定を編集" : "新しい共有出典"));
    const field = (
      parent: HTMLElement,
      label: string,
      value: string,
      type = "text",
      multiline = false,
    ) => {
      const wrap = el("label", label),
        input = multiline ? el("textarea") : el("input");
      if (input instanceof HTMLInputElement) input.type = type;
      input.value = value;
      wrap.append(input);
      parent.append(wrap);
      return input;
    };
    const check = (parent: HTMLElement, label: string, value: boolean) => {
      const wrap = el("label", label),
        input = el("input");
      input.type = "checkbox";
      input.checked = value;
      wrap.prepend(input);
      parent.append(wrap);
      return input;
    };
    const address = field(
      fields,
      "出典の記事URL",
      data.url,
    ) as HTMLInputElement;
    address.readOnly = !!saved;
    address.maxLength = 2048;
    const enabled = check(
      fields,
      "指定した利用者への本文共有を有効にする",
      data.enabled,
    );
    const expires = field(
      fields,
      "共有の期限（端末の現地時刻）",
      localDate(data.expires),
      "datetime-local",
    ) as HTMLInputElement;
    expires.step = "60";
    const readExpiry = () =>
      expires.value === localDate(data.expires)
        ? data.expires
        : dateValue(expires.value);
    const reason = field(
      fields,
      "本文を共有できる根拠",
      data.evidence,
      "text",
      true,
    ) as HTMLTextAreaElement;
    reason.maxLength = 2000;
    reason.rows = 3;
    const members = field(
      fields,
      "共有する利用者ID（1行に1人）",
      data.members.join("\n"),
      "text",
      true,
    ) as HTMLTextAreaElement;
    members.maxLength = 6500;
    members.rows = 3;
    members.spellcheck = false;
    const self = button("自分の利用者IDを追加", () => {
      const values = members.value.split(/\s+/).filter(Boolean);
      if (bound && !values.includes(bound)) values.push(bound);
      members.value = values.join("\n");
      dirty = true;
    });
    fields.append(
      self,
      el(
        "p",
        "利用者を外すと次の権限確認から本文を取得できなくなります。すでに保存したコピーは削除しません。",
        "muted",
      ),
      el("h4", "同じ記事を指す別名URL"),
      el(
        "p",
        "RSSなどの別URLを、この出典と同じ記事として扱います。確認したURLだけを追加してください。",
        "muted",
      ),
      aliases,
    );
    const rows: {
      read: () => PolicyAlias;
      approve: HTMLInputElement;
      node: HTMLElement;
    }[] = [];
    const revision = () =>
      (saved?.policyRevision ?? 1) +
      Number(!!saved && reason.value !== saved.evidence);
    function addAlias(a?: PolicyAlias) {
      if (rows.length >= 50) {
        notice.textContent = "別名は50件までです。";
        return;
      }
      const node = el("fieldset");
      node.append(el("legend", "別名URLの設定"));
      const u = field(node, "別名URL", a?.url ?? "") as HTMLInputElement;
      u.maxLength = 2048;
      const on = check(node, "この別名を有効にする", a?.enabled ?? false);
      const exp = field(
        node,
        "別名の期限（端末の現地時刻）",
        localDate(a?.expires ?? readExpiry()),
        "datetime-local",
      ) as HTMLInputElement;
      exp.step = "60";
      const initialExpiry = a?.expires ?? readExpiry();
      const why = field(
        node,
        "同じ記事と判断した根拠",
        a?.evidence ?? "",
        "text",
        true,
      ) as HTMLTextAreaElement;
      why.maxLength = 2000;
      why.rows = 2;
      const approve = check(
        node,
        "現在の共有条件で、同じ記事を指すことを確認しました",
        !!a && a.policyRevision === revision(),
      );
      const row = {
        node,
        approve,
        read: () => ({
          url: sourceURL(u.value),
          enabled: on.checked,
          expires:
            exp.value === localDate(initialExpiry)
              ? initialExpiry
              : dateValue(exp.value),
          evidence: why.value,
          policyRevision: approve.checked
            ? revision()
            : (a?.policyRevision ?? 1),
        }),
      };
      // Editing evidence or identity invalidates the visible approval. Saving an
      // active alias then requires another explicit checkbox selection.
      u.addEventListener("input", () => {
        approve.checked = false;
      });
      why.addEventListener("input", () => {
        approve.checked = false;
      });
      node.append(
        button("この別名を外す", () => {
          rows.splice(rows.indexOf(row), 1);
          node.remove();
          dirty = true;
        }),
      );
      rows.push(row);
      aliases.append(node);
    }
    for (const a of data.aliases) addAlias(a);
    reason.addEventListener("input", () =>
      rows.forEach((r) => {
        r.approve.checked = false;
      }),
    );
    fields.append(
      button("別名URLを追加", () => {
        addAlias();
        dirty = true;
      }),
    );
    const review = button("変更内容を確認", () => {
      if (busy || uncertain) return;
      try {
        const input: PolicyInput = {
          url: sourceURL(address.value),
          enabled: enabled.checked,
          expires: readExpiry(),
          evidence: reason.value,
          members: members.value.split(/\s+/).filter(Boolean),
          aliases: rows.map((r) => r.read()),
        };
        if (rows.some((r, i) => input.aliases[i].enabled && !r.approve.checked))
          throw new PolicyError(
            "有効な別名が現在の共有条件で同じ記事を指すことを確認してください。",
          );
        validatePolicyInput(input, revision());
        const card = el("section", undefined, "rss-policy-review");
        card.append(
          el("h4", "保存する共有範囲"),
          el("p", input.url),
          el(
            "p",
            input.enabled
              ? `共有を有効にします。対象は${input.members.length}人です。`
              : "共有を無効にします。新しい本文の提供を停止します。",
          ),
          el("p", `期限: ${new Date(input.expires).toLocaleString()}`),
          el("p", input.evidence),
        );
        const people = el("ul");
        for (const member of input.members) people.append(el("li", member));
        card.append(people);
        for (const a of input.aliases)
          card.append(
            el("p", `${a.enabled ? "有効" : "無効"}な別名: ${a.url}`),
          );
        card.append(
          button(
            "この内容を保存",
            () =>
              void run(async (signal) => {
                const result = await client.save(input, saved, signal);
                renderEditor(result);
                next = null;
                list.replaceChildren(
                  el("h4", "保存した共有出典"),
                  el(
                    "p",
                    `${result.enabled ? "有効" : "無効"} · ${result.url}`,
                  ),
                );
                notice.textContent =
                  "共有設定を保存しました。記事や個人の読書記録は変更していません。";
              }, true),
          ),
          button("入力に戻る", () => {
            preview.replaceChildren();
            controls();
          }),
        );
        preview.replaceChildren(card);
        controls();
      } catch (error) {
        notice.textContent =
          error instanceof PolicyError
            ? error.message
            : "出典と別名には公開HTTPSの記事URLを入力してください。";
      }
    });
    review.dataset.review = "true";
    const reread = button(
      "最新の保存内容を確認",
      () =>
        void run(async (signal) => {
          if (!previous) {
            await loadList(null, signal);
            notice.textContent =
              "一覧から同じ出典を確認してください。下書きは保持しています。";
            return;
          }
          const latest = await client.read(previous.id, signal);
          recovery.replaceChildren(
            el("h4", "現在サーバーに保存されている内容"),
            el(
              "p",
              `${latest.url} · ${latest.enabled ? "有効" : "無効"} · 対象${latest.members.length}人`,
            ),
            el("p", latest.evidence),
            el("p", "編集中の内容はまだ置き換えていません。"),
            button("この保存内容で編集し直す", () => {
              if (!busy && discard()) {
                renderEditor(latest);
                notice.textContent = "保存されている内容から編集し直せます。";
              }
            }),
          );
          notice.textContent =
            "最新の設定を確認しました。編集中の内容は保持しています。";
        }),
    );
    form.addEventListener("submit", (e) => e.preventDefault());
    fields.addEventListener("input", () => {
      dirty = true;
    });
    form.append(fields, review, reread, preview);
    editor.append(form);
    controls();
  }
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("pagehide", () => {
    controller.abort();
    controller = new AbortController();
  });
  return root;
}
