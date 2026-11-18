import { el, button } from "./ui";
import { libraryAccount, librarySignedOut } from "./library-context";
import {
  TopicGenerationClient,
  TopicClientError,
} from "./topic-generation-client";
import { bestTopicEvidence } from "./topic-evidence";
import type { TopicEvidence } from "./topic-preparation-protocol";

/** テーマから公開資料の候補を準備し、記事の抜粋や関連理由の入力を求めない。 */
export function topicPreparationView(
  initialTopic = "",
  prepared?: (topic: string, sources: TopicEvidence[]) => void,
) {
  const root = el("details", undefined, "topic-preparation"),
    summary = el("summary", "テーマの資料を準備する"),
    notice = el("p"),
    results = el("section"),
    form = el("form"),
    input = el("input"),
    label = el("label", "学びたいテーマ"),
    submit = el("button", "資料を探す"),
    more = button("続きの資料を探す", () => void run(true)),
    stop = button("探索の待機を止める", () => active?.abort());
  root.append(
    summary,
    el(
      "p",
      "保存済みの公開資料から、テーマの語句に合う部分を選びます。資料の準備にLLMは使いません。",
    ),
    notice,
  );
  notice.setAttribute("role", "status");
  results.setAttribute("aria-label", "準備した資料候補");
  const account = libraryAccount();
  if (!account) {
    notice.textContent = "資料の準備にはログインが必要です。";
    return root;
  }
  const client = new TopicGenerationClient(
    account,
    libraryAccount,
    librarySignedOut,
  );
  input.id = "topic-preparation-name";
  input.value = initialTopic;
  input.maxLength = 500;
  input.required = true;
  input.autocomplete = "off";
  const help = el(
    "p",
    "目安は日本語で約160文字です。長文ではなく、学びたい語句を入力してください。",
  );
  help.id = "topic-preparation-help";
  input.setAttribute("aria-describedby", help.id);
  const validate = () =>
    input.setCustomValidity(
      new TextEncoder().encode(input.value.trim()).length > 500
        ? "テーマが長すぎます。短い語句にしてください。"
        : "",
    );
  input.addEventListener("input", validate);
  validate();
  label.htmlFor = input.id;
  submit.type = "submit";
  form.append(label, input, help, submit);
  more.hidden = stop.hidden = true;
  root.append(form, stop, results, more);
  let active: AbortController | undefined,
    topic = "",
    cursor: string | null = null,
    candidates: TopicEvidence[] = [],
    inspected = 0,
    unavailable = 0;
  const cursors = new Set<string>();
  function current() {
    try {
      if (libraryAccount() === account) return;
    } catch {
      /* 失効済みの文脈は候補を保持しない。 */
    }
    results.replaceChildren();
    candidates = [];
    throw new TopicClientError("account-mismatch");
  }
  function render() {
    results.replaceChildren(el("h3", `準備したテーマ：${topic}`));
    if (!candidates.length)
      results.append(
        el(
          "p",
          inspected === 0
            ? "現在、探索できる公開資料がありません。資料が用意された後に、もう一度探してください。"
            : unavailable === inspected
              ? "調べた資料の原文を確認できませんでした。語句を変える必要はありません。時間を置いて確認するか、続きの資料を探してください。"
              : "この範囲には、テーマの語句を含む資料がありません。別の語句で探すか、続きの資料を確認してください。",
        ),
      );
    else
      results.append(
        el(
          "p",
          "語句の一致で選んだ候補です。テーマを学ぶために十分な内容か、出典と原文を確認してください。",
        ),
      );
    for (const candidate of candidates) {
      const row = el("section"),
        title = el("h4"),
        link = el("a", candidate.source.title),
        excerpt = el("details");
      link.href = candidate.source.url!;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      title.append(link);
      excerpt.append(
        el("summary", "選ばれた原文を確認"),
        el("blockquote", candidate.source.excerpt),
      );
      row.append(
        title,
        el("p", `一致した語句：${candidate.matchedTerms.join("、")}`),
        el(
          "p",
          `取得日時 ${new Date((candidate.source.capturedAt + 978307200) * 1000).toLocaleString("ja-JP")}`,
        ),
        excerpt,
      );
      results.append(row);
    }
    if (prepared && candidates.length)
      results.append(
        button("この資料で教科書を準備する", () => {
          if (active) return;
          try {
            current();
            prepared(topic, structuredClone(candidates));
          } catch {
            notice.textContent =
              "ログインを確認してページを開き直してください。";
          }
        }),
      );
    results.append(
      el(
        "p",
        "この画面の準備結果は、画面を閉じると消えます。共有原文の保存先は変更しません。",
      ),
    );
    const moveFocus = cursor === null && document.activeElement === more;
    more.textContent = `「${topic}」の続きの資料を探す`;
    more.hidden = cursor === null;
    if (moveFocus) input.focus();
  }
  async function run(continuing: boolean) {
    if (active || (continuing && !cursor)) return;
    const controller = new AbortController();
    active = controller;
    input.readOnly = true;
    submit.setAttribute("aria-disabled", "true");
    stop.hidden = false;
    root.setAttribute("aria-busy", "true");
    try {
      current();
      const nextTopic = continuing ? topic : input.value.trim();
      let after = continuing ? cursor : null;
      let pageCount = 0;
      notice.textContent = "公開資料を確認しています。";
      do {
        const page = await client.prepare(
          { topic: nextTopic, ...(after ? { after } : {}) },
          controller.signal,
        );
        current();
        if (pageCount === 0 && !continuing) {
          topic = page.topic;
          candidates = [];
          inspected = unavailable = 0;
          cursors.clear();
        }
        if (page.after && cursors.has(page.after))
          throw new TopicClientError("invalid-response");
        if (page.after) cursors.add(page.after);
        candidates = bestTopicEvidence([...candidates, ...page.sources]);
        inspected += page.inspected;
        unavailable += page.unavailable;
        cursor = after = page.after;
        render();
        notice.textContent = `${inspected}件を確認し、資料候補を${candidates.length}件用意しました。${unavailable ? `確認できなかった資料は${unavailable}件です。` : ""}${cursor ? "残りの資料があります。" : "公開資料の一覧を最後まで確認しました。"}`;
      } while (after && ++pageCount < 10);
    } catch (error) {
      const code = error instanceof TopicClientError ? error.code : "held";
      if (["account-mismatch", "unauthenticated"].includes(code)) {
        results.replaceChildren();
        candidates = [];
        cursor = null;
        more.hidden = true;
      }
      notice.textContent = ["account-mismatch", "unauthenticated"].includes(
        code,
      )
        ? "ログインを確認してページを開き直してください。"
        : code === "rate-limit"
          ? "短い時間に資料の確認が集中しました。1分ほど時間を置いてから再開してください。受け取った候補は保持しています。"
          : code === "topic-preparation-unconfigured"
            ? "この接続先では、教材用に参照できる公開資料がまだ利用できません。"
            : code === "topic-preparation-topic"
              ? "学びたい内容を表す語句を入力してください。例：RSS、税、光。"
              : code === "invalid-request"
                ? "テーマを短い語句で入力してください。長い文章は使えません。"
                : code === "cancelled"
                  ? "探索の待機を止めました。受け取った候補は残しています。続きは改めて確認できます。"
                  : "資料を確認できませんでした。受け取った候補は残しています。接続とログイン状態を確認して、もう一度探してください。";
    } finally {
      active = undefined;
      input.readOnly = false;
      submit.removeAttribute("aria-disabled");
      if (document.activeElement === stop) input.focus();
      stop.hidden = true;
      root.removeAttribute("aria-busy");
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(false);
  });
  root.addEventListener("toggle", () => {
    if (!root.open) active?.abort();
  });
  window.addEventListener("pagehide", () => active?.abort());
  return root;
}
