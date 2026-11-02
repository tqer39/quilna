import { PaperClient } from "./paper-client";
import { paperQuery, type PaperSearchResults } from "./paper-search";
import { button, el } from "./ui";

/** Keep unsaved list summaries separate from DOI observations and invalidate late transport completions. */
export function paperSearchView(
  client: Pick<PaperClient, "search">,
  choose: (doi: string) => void,
  start: () => void,
) {
  const root = el("section"),
    form = el("form"),
    label = el("label", "書誌キーワード"),
    input = el("input"),
    submit = el("button", "キーワードをCrossrefへ送って検索"),
    notice = el("p"),
    results = el("section");
  root.setAttribute("aria-label", "書誌キーワード検索");
  results.setAttribute("aria-label", "書誌キーワードの検索結果");
  input.id = "paper-query";
  input.type = "text";
  input.maxLength = 200;
  input.autocomplete = "off";
  label.htmlFor = input.id;
  submit.type = "submit";
  notice.setAttribute("aria-live", "polite");
  let revision = 0,
    controller = new AbortController(),
    busy = false;
  /** Cancellation is local invalidation too, even if the underlying transport ignores the signal. */
  function cancelPending() {
    revision++;
    controller.abort();
    controller = new AbortController();
    const wasBusy = busy;
    busy = false;
    submit.disabled = false;
    cancel.hidden = true;
    if (wasBusy)
      notice.textContent =
        "検索を中止しました。前の結果と保存済みの記録は保持しています。";
  }
  const cancel = button("検索を中止", cancelPending);
  cancel.hidden = true;
  form.append(
    el("h2", "書誌キーワードから探す"),
    el(
      "p",
      "このボタンを押すと、入力したキーワードをCrossref（api.crossref.org）へ送ります。IPと要求内容が提供元に記録されます。アカウント・メール・記事・学習履歴は送りません。題名・著者などの書誌情報の検索で、本文検索ではありません。登録やAPIキーは不要です。",
    ),
    label,
    input,
    submit,
    cancel,
  );
  root.append(form, notice, results);
  /** Render provider strings as text; selecting a DOI starts the separate explicit detail check. */
  function render(query: string, value: PaperSearchResults) {
    const heading = el("h3", `「${query}」の検索結果`);
    heading.tabIndex = -1;
    results.replaceChildren(
      heading,
      el(
        "p",
        `提供元の該当件数: ${value.total}件。最初の最大20件から${value.items.length}件を表示しています（同じ書誌情報の重複${value.duplicates}件を除外）。続きの自動取得はしません。キーワードを絞って再検索できます。検索結果とキーワードは保存しません。`,
      ),
    );
    if (!value.items.length)
      results.append(
        el(
          "p",
          "該当する書誌情報がありません。キーワードを変えて検索できます。",
        ),
      );
    for (const item of value.items) {
      const row = el("article", undefined, "paper-row"),
        select = button("このDOIをCrossrefへ送って詳細を確認", () => {
          if (!select.isConnected) return;
          cancelPending();
          choose(item.doi);
        });
      row.append(
        el("h4", item.titles.join(" / ") || "題名不明"),
        el("p", `DOI: ${item.doi}`),
        el(
          "p",
          `著者: ${item.authors.map((a) => a.name || [a.given, a.family].filter(Boolean).join(" ") || "氏名不明").join(" / ") || "不明"}`,
        ),
        el(
          "p",
          `公開日: ${[item.published.parts?.join("-"), item.published.timestamp].filter(Boolean).join(" / ") || "不明"}`,
        ),
        el(
          "p",
          `種類: ${item.type || "不明"} · 掲載誌・収録先: ${item.container.join(" / ") || "不明"} · 出版社: ${item.publisher || "不明"}`,
        ),
        select,
      );
      results.append(row);
    }
    results.append(
      el(
        "p",
        "検索結果は書誌情報の要約です。保存するには、選んだDOIの詳細を改めて確認してください。本文・実際の論文の版・査読・訂正・撤回の網羅性を確認したものではありません。",
      ),
    );
    heading.focus();
  }
  input.addEventListener("input", cancelPending);
  window.addEventListener("pagehide", cancelPending);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    cancelPending();
    start();
    const current = revision;
    try {
      const query = paperQuery(input.value);
      busy = true;
      submit.disabled = true;
      cancel.hidden = false;
      notice.textContent =
        "Crossrefの書誌情報を検索しています…前の結果は引き続き選べます。";
      const value = await client.search(query, controller.signal);
      if (current !== revision) return;
      render(query, value);
      notice.textContent =
        "検索結果を確認しました。保存する前にDOIの詳細を確認してください。";
    } catch (error) {
      if (current === revision) notice.textContent = (error as Error).message;
    } finally {
      if (current === revision) {
        busy = false;
        submit.disabled = false;
        cancel.hidden = true;
      }
    }
  });
  return { root, cancel: cancelPending };
}
