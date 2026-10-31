import { button, el } from "./ui";
import {
  DocumentAcquisition,
  readDocumentPreference,
  documentPreferenceKey,
} from "./document-acquisition";

export function documentAcquisitionSettings(client: DocumentAcquisition) {
  const root = el("section", undefined, "rss-translation-settings"),
    select = el("select"),
    notice = el("p", "", "muted"),
    label = el("label", "新しく取り込む本文の取得先");
  select.id = "rss-document-acquisition";
  label.htmlFor = select.id;
  for (const [value, name] of [
    ["browser", "このブラウザ用に取得"],
    ["private", "クラウドの自分用本文を再利用"],
    ["shared", "許可された共有本文を再利用"],
  ]) {
    const option = el("option", name);
    option.value = value;
    select.append(option);
  }
  notice.setAttribute("role", "status");
  let busy = false,
    generation = 0;
  function render() {
    try {
      const p = readDocumentPreference();
      select.value = p.mode;
      notice.textContent =
        p.mode === "browser"
          ? "元サイトから取得し、このブラウザに保存します。クラウドの再利用は接続確認後に選べます。"
          : "選択した取得先を保存しています。本文を取り込む際にログインと権限を確認します。";
    } catch {
      select.selectedIndex = -1;
      notice.textContent =
        "取得先の設定を読み込めません。取得先を選び直してください。";
    }
  }
  const check = button("本文のクラウド接続を確認", async () => {
    if (busy) return;
    const current = ++generation;
    busy = true;
    check.disabled = select.disabled = true;
    notice.textContent = "本文のクラウド接続を確認しています…";
    try {
      const status = await client.status();
      if (current !== generation) return;
      notice.textContent = status.enabled
        ? "クラウドに接続できました。取得先を選ぶと、ログイン中のアカウントに設定を結び付けます。共有本文は許可された記事だけが対象です。"
        : "この環境では本文のクラウド再利用はまだ有効になっていません。現在の取得先設定は変更していません。";
    } catch (error) {
      if (current === generation) notice.textContent = (error as Error).message;
    } finally {
      busy = false;
      check.disabled = select.disabled = false;
    }
  });
  select.addEventListener("change", async () => {
    if (busy) return;
    const current = ++generation,
      mode = select.value;
    busy = true;
    check.disabled = select.disabled = true;
    try {
      if (mode === "browser") client.save({ mode });
      else if (mode === "private" || mode === "shared") {
        notice.textContent = "ログイン中のアカウントと接続を確認しています…";
        const status = await client.status();
        if (current !== generation) return;
        if (!status.enabled)
          throw Error(
            "この環境では本文のクラウド再利用はまだ利用できません。設定は変更していません。",
          );
        client.save({ mode, account: status.account });
      }
      render();
      notice.textContent =
        "取得先を保存しました。既存の本文はそのまま残ります。取得先を変えて取り込み直す場合は、記事の「本文の保存履歴」から更新を確認してください。";
    } catch (error) {
      if (current === generation) {
        render();
        notice.textContent = (error as Error).message;
      }
    } finally {
      busy = false;
      check.disabled = select.disabled = false;
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === documentPreferenceKey) {
      generation++;
      render();
    }
  });
  root.append(
    el("h3", "本文の取得・再利用"),
    el(
      "p",
      "同じ本文がクラウドにあれば再取得せずに利用します。送信するのは記事のURLと取得先の選択です。既読・保存・翻訳・引用は送信しません。",
      "muted",
    ),
    label,
    select,
    check,
    notice,
    el(
      "p",
      "許可や接続を確認できない場合、別の取得先へ自動で切り替えません。保存した本文はオフラインでも読めます。このブラウザの保存領域はログインごとに分かれていないため、別の利用者とはブラウザのプロフィールを分けてください。",
      "muted",
    ),
  );
  render();
  return root;
}
