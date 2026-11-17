import { el, button } from "./ui";
import { libraryAccount, librarySignedOut } from "./library-context";
import {
  TopicGenerationClient,
  TopicClientError,
} from "./topic-generation-client";
import type {
  TopicCapabilities,
  TopicQuote,
  TopicTextbookEnvelope,
  TopicGenerationReply,
} from "./topic-generation-protocol";
import {
  parseTextbookRequest,
  parseTextbookCandidate,
  parseReviewedTextbookCandidate,
} from "./shared-textbook-format";
import {
  listSharedTextbooks,
  importSharedTextbook,
} from "./shared-textbook-store";
import {
  listTopicOperations,
  retainTopicOperation,
  newTopicOperation,
  renewTopicApproval,
  generatedTopicBook,
  removeTopicOperations,
  type TopicOperation,
} from "./topic-generation-store";

const yen = (n: number) =>
  `${(n / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 3 })}円`;
const labels: Record<string, string> = {
  unconnected: "教材生成は未接続です。接続と費用の設定が必要です。",
  "credentials-unconfigured":
    "教材生成は未接続です。接続と費用の設定が必要です。",
  "model-unapproved":
    "このモデルは現在利用できません。設定を確認してください。",
  "quote-changed":
    "確認後に見積りが変わりました。送信していません。内容と費用を改めて確認してください。",
  "cost-limit": "承認した費用上限を超えています。送信していません。",
  "cost-unapproved": "内容と費用の確認が必要です。",
  "input-limit":
    "この内容は入力の上限を超えています。短い公開資料の抜粋で作り直してください。",
  "budget-exhausted": "今月の予算枠が足りません。新しい送信はしていません。",
  "provider-budget-exhausted":
    "接続先の予算枠が足りません。新しい送信はしていません。",
  "id-conflict":
    "保存した依頼と一致しません。新しい送信はせず、控えを保持しました。",
  "credential-changed":
    "接続先のキーが変更されました。保存した控えから結果を確認してください。",
  "not-found":
    "保存結果が見つかりません。まだ送信していない場合もあります。自動では再送しません。",
  reserved:
    "処理中です。控えから結果を確認できます。新しい依頼は送信しません。",
  unknown:
    "結果が確定していません。予算の保留を維持しています。控えから結果を確認してください。",
  busy: "別の処理が進行中か結果不明です。控えから確認してください。",
  rejected:
    "教材として採用できる結果がありません。使用量が発生した可能性があります。自動では再送しません。",
  "csrf-invalid":
    "確認の有効期限が切れました。控えを保持しています。結果を照会し、必要なら費用を再確認してください。",
  cancelled:
    "応答の待機を止めました。外部の処理や費用は取り消していません。控えから結果を確認できます。",
  "account-mismatch":
    "ログインしたライブラリが変わりました。再読み込みしてください。",
  unauthenticated: "ログインを確認できません。再読み込みしてください。",
  "invalid-response":
    "応答を確認できません。控えを保持しています。結果を確認してください。",
};
function errorMessage(error: unknown) {
  if (error instanceof TopicClientError)
    return (
      labels[error.code] ??
      "接続を確認できません。控えを保持しています。結果の確認は新しい生成を行いません。"
    );
  return error instanceof Error
    ? error.message
    : "処理できませんでした。控えは保持しています。";
}
function field(label: string, multiline = false) {
  const wrap = el("label", label),
    input = multiline ? el("textarea") : el("input");
  input.required = true;
  wrap.append(input);
  return { wrap, input };
}
function consent(text: string) {
  const label = el("label"),
    input = el("input");
  input.type = "checkbox";
  label.append(input, ` ${text}`);
  return { label, input };
}
/** 候補を採用する前に、説明だけでなく前提・問題・正誤の根拠も確認できるようにする。 */
function candidatePreview(
  content: Pick<
    Awaited<ReturnType<typeof parseTextbookCandidate>>,
    "request" | "draft"
  >,
) {
  const area = el("div");
  area.append(
    el("h4", content.draft.title),
    el("p", `学習目標：${content.request.learningGoal}`),
  );
  for (const source of content.request.sources) {
    const detail = el("details");
    detail.append(
      el("summary", `出典：${source.title}`),
      el("p", source.url ?? "URLなし"),
      el("blockquote", source.excerpt),
    );
    area.append(detail);
  }
  for (const lesson of content.draft.lessons) {
    const question = lesson.content.question;
    area.append(
      el("h4", lesson.content.title),
      el("p", `目標：${lesson.content.objective}`),
      el("p", `前提節：${lesson.prerequisiteSectionIDs.join("、") || "なし"}`),
      el("p", `必要な知識：${lesson.assumedKnowledge.join("、") || "なし"}`),
      ...lesson.content.paragraphs.map((p) => el("p", p)),
      el("p", `具体例：${lesson.workedExample}`),
      el("h5", question.prompt),
    );
    for (const option of question.options)
      area.append(
        el(
          "p",
          `${option.id === question.correctOptionID ? "正答" : "誤答"}：${option.text} — ${option.explanation}`,
        ),
      );
    const evidence = el("details");
    evidence.append(el("summary", "説明・例・問題・選択肢の根拠"));
    for (const [label, citations] of [
      ["説明", lesson.explanationEvidence],
      ["具体例", lesson.exampleEvidence],
      ["問題", lesson.questionEvidence],
      ...Object.entries(lesson.optionEvidence).map(
        ([id, citations]) => [`選択肢 ${id}`, citations] as const,
      ),
    ] as const)
      for (const citation of citations)
        evidence.append(
          el(
            "p",
            `${label}：${content.request.sources.find((s) => s.id === citation.sourceID)?.title ?? citation.sourceID}`,
          ),
          el("blockquote", citation.quote),
        );
    area.append(evidence);
  }
  return area;
}
/** 読書から独立した明示操作にし、課金する処理を読書・画面復元から始めない。 */
export function topicGenerationView(saved: (id: string) => Promise<void>) {
  const root = el("details", undefined, "topic-creator"),
    summary = el("summary", "テーマの教材を作る");
  const notice = el("p"),
    body = el("div"),
    output = el("section"),
    retained = el("section");
  notice.setAttribute("role", "status");
  output.setAttribute("aria-label", "教材作成の確認");
  retained.setAttribute("aria-label", "作成の控え");
  root.append(summary, notice, body, output, retained);
  const account = libraryAccount();
  if (!account) {
    body.append(
      el(
        "p",
        "教材の作成にはログインしたライブラリが必要です。受け取った教材の読書・取り込みは引き続き使えます。",
      ),
    );
    return root;
  }
  const client = new TopicGenerationClient(
    account,
    libraryAccount,
    librarySignedOut,
  );
  let active: AbortController | undefined,
    initialized = false,
    capabilities: TopicCapabilities | undefined;
  let selectedRoot: TopicOperation | undefined;
  function check() {
    if (libraryAccount() !== account)
      throw new TopicClientError("account-mismatch");
  }
  const stop = button("応答の待機を止める", () => active?.abort());
  stop.hidden = true;
  root.append(stop);
  window.addEventListener("pagehide", () => active?.abort());
  async function work(task: (signal: AbortSignal) => Promise<void>) {
    if (active) return;
    const controller = new AbortController();
    active = controller;
    root.setAttribute("aria-busy", "true");
    body.inert = output.inert = retained.inert = true;
    stop.hidden = false;
    try {
      check();
      await task(controller.signal);
      check();
    } catch (error) {
      notice.textContent = errorMessage(error);
    } finally {
      active = undefined;
      root.removeAttribute("aria-busy");
      body.inert = output.inert = retained.inert = false;
      stop.hidden = true;
    }
  }
  function showReply(result: TopicGenerationReply) {
    if (result.status !== "complete") {
      notice.textContent =
        labels[result.status] ??
        "設定を確認できません。控えを保持しました。自動では再送しません。";
      return false;
    }
    return true;
  }
  function quotePicker(purpose: TopicQuote["purpose"], modelId?: string) {
    const select = el("select"),
      wrap = el(
        "label",
        purpose === "book-addition"
          ? "生成モデルと費用上限"
          : "検証モデルと費用上限",
      );
    const quotes =
      capabilities?.quotes.filter(
        (q) => q.purpose === purpose && (!modelId || q.modelId === modelId),
      ) ?? [];
    for (const [i, q] of quotes.entries()) {
      const option = el(
        "option",
        `OpenAI / ${q.model} · 最大${yen(q.maxMilliYen)}`,
      );
      option.value = String(i);
      select.append(option);
    }
    wrap.append(select);
    return { wrap, selected: () => quotes[Number(select.value)] };
  }
  function quoteDetails(q: TopicQuote) {
    return el(
      "p",
      `送信先：OpenAI / ${q.model}。1回の予約上限 ${yen(q.maxMilliYen)}。入力上限 ${q.inputTokens} tokens・出力上限 ${q.outputTokens} tokens。データの扱い：${q.dataConditions}。料金確認 ${q.priceCheckedAt}、費用確認 ${q.costCheckedAt}。`,
    );
  }
  async function refreshRetained() {
    const ops = await listTopicOperations();
    check();
    retained.replaceChildren(
      el("h3", "作成の控え"),
      el(
        "p",
        "依頼と識別子はこのブラウザ・ログイン専用に保存します。記事バックアップには含まれません。結果の確認は新しい生成・検証を送りません。",
      ),
    );
    for (const op of ops.filter((x) => x.input.purpose === "book-addition")) {
      const row = el("div", undefined, "topic-operation");
      row.append(
        el("p", `${op.title} · ${op.createdAt}`),
        button(
          "保存した結果を確認",
          () =>
            void work(async (signal) => {
              output.replaceChildren();
              selectedRoot = undefined;

              const result = await client.operate(
                "operations",
                op.input,
                op.quote,
                signal,
              );
              if (!showReply(result) || result.status !== "complete") {
                if (
                  result.status === "not-found" ||
                  (result.status === "rejected" && result.retryable === true)
                )
                  await reconfirmGeneration(op, result.status === "rejected");
                return;
              }
              const review = ops.find(
                (x) =>
                  x.input.purpose === "evidence-check" && x.rootId === op.id,
              );
              await showDraft(op, result.draft);
              if (review) {
                const checked = await client.operate(
                  "operations",
                  review.input,
                  review.quote,
                  signal,
                );
                if (showReply(checked) && checked.status === "complete")
                  await showReview(op, review, result.draft, checked.draft);
                else if (
                  checked.status === "not-found" ||
                  (checked.status === "rejected" && checked.retryable === true)
                )
                  await showDraft(
                    op,
                    result.draft,
                    review,
                    checked.status === "rejected",
                  );
              }
            }),
        ),
        button("この控えを整理する", () => {
          const warning = el("div"),
            remove = button(
              "外部の処理は取り消さず、控えを削除する",
              () =>
                void work(async () => {
                  await removeTopicOperations(op.id);
                  check();
                  if (selectedRoot?.id === op.id) {
                    output.replaceChildren();
                    selectedRoot = undefined;
                  }
                  await refreshRetained();
                  notice.textContent =
                    "控えを削除しました。外部の処理・費用・保存した教材は変更していません。";
                }),
            );
          warning.append(
            el(
              "p",
              "この控えと検証の控えを削除すると、未回収の結果を確認できなくなります。進行中の処理や課金は取り消しません。",
            ),
            remove,
            button("控えを残す", () => warning.remove()),
          );
          row.append(warning);
        }),
      );
      retained.append(row);
    }
  }
  async function showReview(
    op: TopicOperation,
    review: TopicOperation,
    candidate: TopicTextbookEnvelope,
    checked: TopicTextbookEnvelope,
  ) {
    check();
    const parsed = await parseReviewedTextbookCandidate(
      op.input.requestRaw,
      candidate.json,
      checked.json,
    );
    check();
    output.replaceChildren(el("h3", "検証結果"));
    for (const section of parsed.review.sections)
      for (const result of section.checks)
        output.append(
          el("p", `${result.passed ? "確認済み" : "要修正"}：${result.reason}`),
        );
    if (checked.kind !== "topic-textbook-review" || !checked.allChecksPassed) {
      notice.textContent =
        "検証で修正が必要になりました。この候補は教材として保存できません。自動では再検証しません。";
      return;
    }
    notice.textContent =
      "検証済みの候補です。内容を確認して保存してください。モデルの検証記録は正確性の保証ではありません。";
    const book = await generatedTopicBook(op, review, candidate, checked);
    check();
    output.append(candidatePreview(book));
    output.append(
      button(
        "確認して教材を保存する",
        () =>
          void work(async () => {
            check();
            await importSharedTextbook(book.raw);
            check();
            await saved(book.id);
            check();
            notice.textContent =
              "教材を保存しました。回答は別に保持します。教材ファイルも手元に保管してください。";
          }),
      ),
    );
  }
  async function showDraft(
    op: TopicOperation,
    candidate: TopicTextbookEnvelope,
    retry?: TopicOperation,
    retryUnsent = false,
  ) {
    const content = await parseTextbookCandidate(
      op.input.requestRaw,
      candidate.json,
    );
    check();
    selectedRoot = op;

    output.replaceChildren(
      el("h3", "生成した候補"),
      el(
        "p",
        "まだ教材として保存できません。出典と内容を確認し、別の検証処理を承認してください。",
      ),
      el("h4", content.draft.title),
    );
    output.append(candidatePreview(content));
    const existing = (await listTopicOperations()).some(
      (x) => x.rootId === op.id && x.input.purpose === "evidence-check",
    );
    check();
    if (existing && !retry) {
      output.append(
        el(
          "p",
          "検証の控えがあります。「保存した結果を確認」で結果を確認してください。",
        ),
      );
      return;
    }
    const picker = quotePicker("evidence-check", retry?.input.modelId),
      preview = el("div"),
      confirm = consent(
        "この候補・学習目標・公開資料の抜粋をOpenAIへ送り、表示した上限内で検証することを確認しました。",
      );
    const render = () => {
      preview.replaceChildren();
      const q = picker.selected();
      if (q) preview.append(quoteDetails(q));
      confirm.input.checked = false;
    };
    picker.wrap.addEventListener("change", render);
    render();
    const send = button(
      "確認した費用で検証する",
      () =>
        void work(async (signal) => {
          const q = picker.selected();
          if (!q || !confirm.input.checked)
            throw new TopicClientError("cost-unapproved");
          const review = retry
            ? await renewTopicApproval(retry, q, retryUnsent)
            : await newTopicOperation(
                {
                  requestId: crypto.randomUUID(),
                  purpose: "evidence-check",
                  modelId: q.modelId,
                  requestRaw: op.input.requestRaw,
                  generationRequestId: op.id,
                  generatorInvocation: candidate.invocation.id.toLowerCase(),
                  draftRaw: candidate.json,
                  approvedPublicText: true,
                  approvedMaxMilliYen: q.maxMilliYen,
                  approvedQuoteDigest: q.quoteDigest,
                },
                q,
                op,
              );
          if (!retry) await retainTopicOperation(review);
          check();
          // 保存後の待機中止でも再送せず、この識別子から照会する。
          confirm.input.checked = false;
          send.disabled = true;
          await refreshRetained();
          const result = await client.operate(
            "proposals",
            review.input,
            review.quote,
            signal,
          );
          if (showReply(result) && result.status === "complete")
            await showReview(op, review, candidate, result.draft);
        }),
    );
    send.disabled = !picker.selected();
    output.append(picker.wrap, preview, confirm.label, send);
    notice.textContent = retryUnsent
      ? "サーバーが未送信・使用量0を確認した検証です。同じIDのまま費用を再確認してやり直せます。"
      : retry
        ? "検証の保存結果がありません。同じ操作IDのまま費用を再確認できます。既に処理が進んでいても、新しい検証IDは作りません。"
        : "候補を生成しました。検証はまだ送っていません。";
  }
  async function reconfirmGeneration(op: TopicOperation, retryUnsent: boolean) {
    const request = await parseTextbookRequest(op.input.requestRaw);
    check();
    output.replaceChildren(
      el("h3", "保存した生成依頼を再確認"),
      el("p", `テーマ：${op.title}`),
      el("p", `学習目標：${request.learningGoal}`),
    );
    for (const source of request.sources)
      output.append(
        el("h4", source.title),
        el("p", source.url ?? "URLなし"),
        el("blockquote", source.excerpt),
      );
    const picker = quotePicker("book-addition", op.input.modelId),
      detail = el("div"),
      confirmation = consent(
        "表示した保存済みの依頼を同じIDのままOpenAIへ送り、表示した費用上限で生成することを確認しました。",
      );
    const render = () => {
      detail.replaceChildren();
      const q = picker.selected();
      if (q) detail.append(quoteDetails(q));
      confirmation.input.checked = false;
    };
    picker.wrap.addEventListener("change", render);
    render();
    const send = button(
      "同じ依頼で生成を確認する",
      () =>
        void work(async (signal) => {
          const q = picker.selected();
          if (!q || !confirmation.input.checked)
            throw new TopicClientError("cost-unapproved");
          const renewed = await renewTopicApproval(op, q, retryUnsent);
          check();
          send.disabled = true;
          confirmation.input.checked = false;
          await refreshRetained();
          const result = await client.operate(
            "proposals",
            renewed.input,
            renewed.quote,
            signal,
          );
          if (showReply(result) && result.status === "complete")
            await showDraft(renewed, result.draft);
        }),
    );
    send.disabled = !picker.selected();
    output.append(picker.wrap, detail, confirmation.label, send);
    notice.textContent = retryUnsent
      ? "サーバーが未送信・使用量0を確認した依頼です。同じ操作IDのまま費用を確認して再実行できます。"
      : "保存結果がありません。同じ操作IDのまま費用を確認できます。自動では送信しません。";
  }
  async function initialize(signal: AbortSignal) {
    capabilities = await client.status(signal);
    check();
    body.replaceChildren(
      el(
        "p",
        "記事はテーマへの入口です。繰り返し使える教材のテーマと学習目標を指定してください。記事本文・個人のメモ・回答履歴を自動では取り込みません。",
      ),
    );
    const b = capabilities.budget;
    body.append(
      el(
        "p",
        `今月の上限 ${yen(b.limitMilliYen)} · 使用済み ${yen(b.spentMilliYen)} · 保留 ${yen(b.heldMilliYen)} · 固定費 ${b.fixedMilliYen === null ? "未設定" : yen(b.fixedMilliYen)} · 安全枠 ${b.safetyMilliYen === null ? "未設定" : yen(b.safetyMilliYen)}`,
      ),
    );
    await refreshRetained();
    if (
      capabilities.mode !== "test-only" ||
      !capabilities.quotes.some((q) => q.purpose === "book-addition")
    ) {
      body.append(el("p", labels.unconnected));
      return;
    }
    body.append(
      el(
        "p",
        "検証用の接続です。実モデルの品質評価は未完了です。生成と検証は別々に費用が発生します。",
      ),
    );
    const form = el("form"),
      topic = field("教材のテーマ"),
      goal = field("学習目標", true);
    topic.input.maxLength = 500;
    goal.input.maxLength = 1000;
    const reuse = el("select"),
      reuseLabel = el("label", "テーマの識別子");
    const option = el("option", "新しいテーマ");
    option.value = "";
    reuse.append(option);
    const books = await listSharedTextbooks();
    check();
    const seen = new Set<string>();
    for (const book of books)
      if (
        book.request.schemaVersion === 2 &&
        !seen.has(book.request.topic.id)
      ) {
        seen.add(book.request.topic.id);
        const option = el("option", book.request.topic.name);
        option.value = book.request.topic.id;
        reuse.append(option);
      }
    reuseLabel.append(reuse);
    reuse.addEventListener("change", () => {
      const book = books.find(
        (b) =>
          b.request.schemaVersion === 2 && b.request.topic.id === reuse.value,
      );
      if (book?.request.schemaVersion === 2)
        topic.input.value = book.request.topic.name;
      topic.input.readOnly = Boolean(reuse.value);
    });
    form.append(
      topic.wrap,
      reuseLabel,
      goal.wrap,
      el(
        "p",
        "共有してよい公開資料だけを選び、抜粋を貼り付けてください（1〜3件、各6,000バイト以下）。URLを取得したり、記事全体を送ったりはしません。",
      ),
    );
    const sources = el("div"),
      entries: ReturnType<typeof addSource>[] = [];
    function addSource() {
      const group = el("fieldset"),
        title = field("出典の題名"),
        url = field("公開資料のURL（任意）"),
        excerpt = field("送ってよい原文抜粋", true);
      url.input.required = false;
      title.input.maxLength = 1000;
      url.input.maxLength = 4096;
      excerpt.input.maxLength = 6000;
      group.append(
        el("legend", `出典 ${entries.length + 1}`),
        title.wrap,
        url.wrap,
        excerpt.wrap,
      );
      const remove = button("この出典を外す", () => {
        const index = entries.findIndex((entry) => entry.group === group);
        if (index < 1) return;
        entries.splice(index, 1);
        group.remove();
        add.disabled = false;
        entries.forEach((entry, i) => {
          entry.group.querySelector("legend")!.textContent = `出典 ${i + 1}`;
        });
      });
      remove.disabled = entries.length === 0;
      group.append(remove);
      sources.append(group);
      return { title, url, excerpt, group };
    }
    entries.push(addSource());
    const add = button("出典を追加", () => {
      if (entries.length < 3) entries.push(addSource());
      add.disabled = entries.length === 3;
    });
    const picker = quotePicker("book-addition"),
      submit = el("button", "送信内容と費用を確認");
    submit.type = "submit";
    form.append(sources, add, picker.wrap, submit);
    body.append(form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void work(async () => {
        const q = picker.selected();
        if (!q) throw new TopicClientError("unconnected");
        const id = crypto.randomUUID(),
          request = {
            schemaVersion: 2,
            id,
            topic: {
              id: reuse.value || crypto.randomUUID(),
              name: topic.input.value,
            },
            learningGoal: goal.input.value,
            sources: await Promise.all(
              entries.map(async (entry) => {
                const excerpt = entry.excerpt.input.value;
                const hash = await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(excerpt),
                );
                return {
                  id: crypto.randomUUID(),
                  title: entry.title.input.value,
                  url: entry.url.input.value || null,
                  capturedAt: Date.now() / 1000 - 978307200,
                  sourceFingerprint: Array.from(new Uint8Array(hash), (n) =>
                    n.toString(16).padStart(2, "0"),
                  ).join(""),
                  excerpt,
                };
              }),
            ),
          };
        const requestRaw = JSON.stringify(request);
        try {
          await parseTextbookRequest(requestRaw);
        } catch {
          throw Error(
            "テーマ・学習目標・公開資料の形式と容量を確認してください。まだ送信していません。",
          );
        }
        check();
        output.replaceChildren(
          el("h3", "送信する内容"),
          el("p", `テーマ：${request.topic.name}`),
          el("p", `学習目標：${request.learningGoal}`),
        );
        for (const source of request.sources)
          output.append(
            el("h4", source.title),
            el("p", source.url ?? "URLなし"),
            el("blockquote", source.excerpt),
          );
        output.append(quoteDetails(q));
        const confirmation = consent(
          "表示したテーマ・学習目標・公開資料の抜粋だけをOpenAIへ送り、この上限内で生成することを確認しました。",
        );
        const send = button(
          "確認した費用で生成する",
          () =>
            void work(async (signal) => {
              if (!confirmation.input.checked)
                throw new TopicClientError("cost-unapproved");
              const op = await newTopicOperation(
                {
                  requestId: id,
                  purpose: "book-addition",
                  modelId: q.modelId,
                  requestRaw,
                  approvedPublicText: true,
                  approvedMaxMilliYen: q.maxMilliYen,
                  approvedQuoteDigest: q.quoteDigest,
                },
                q,
              );
              await retainTopicOperation(op);
              check();
              confirmation.input.checked = false;
              send.disabled = true;
              await refreshRetained();
              const result = await client.operate(
                "proposals",
                op.input,
                op.quote,
                signal,
              );
              if (showReply(result) && result.status === "complete")
                await showDraft(op, result.draft);
            }),
        );
        output.append(confirmation.label, send);
        notice.textContent =
          "まだ送信していません。表示内容を確認してください。フォームの変更はこの確認内容には反映されません。";
      });
    });
  }
  const retry = button("接続と控えを確認", () => void work(initialize));
  root.append(retry);
  root.addEventListener("toggle", () => {
    if (root.open && !initialized) {
      initialized = true;
      void work(initialize);
    }
  });
  return root;
}
