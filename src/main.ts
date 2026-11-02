import { byokSettings } from "./byok-settings";
import { accountSettings } from "./account-settings";
import { feedbackMessage } from "./feedback";
import { installNavigationShortcuts } from "./navigation-shortcuts";
import { openReaderDialog } from "./reader-dialog";
import "./style.css";
import { book as baseBook } from "./book";
import {
  activeLocalBook,
  applyProposal,
  questionSchema,
  type Proposal,
} from "./improvements";
import { resumeReview } from "./resume-review";
import { questionWorkbench } from "./question-workbench";
import { setTermQuestionHandler } from "./terms";
import {
  historySchema,
  mergeHistoryRecords,
  readHistory,
  writeHistory,
} from "./history";
import { button, el } from "./ui";
import { learningPlan, blockMinutes } from "./learning-plan";
import { renderBlock } from "./renderer";
const storage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) =>
    window.localStorage.setItem(key, value),
};
const loaded = readHistory(storage);
const history = loaded.history;
const previousResume = history.resume ? { ...history.resume } : null;
let book = activeLocalBook(baseBook, history.bookRevisions);
let reviewOpen = false;
let reviewNode: HTMLElement | null = null;
let proposalApplying = false;
let deferredPopstate: string | null = null;
const shortcutKey = "fieldnotes.navigation-shortcuts.v1";
let shortcutsEnabled = true;
let shortcutNotice = "";
try {
  shortcutsEnabled = storage.getItem(shortcutKey) !== "off";
} catch {
  shortcutNotice =
    "設定を読み込めませんでした。このタブではキー移動が有効です。";
}
setTermQuestionHandler((context, termId, text, excerpt) => {
  if (
    history.questions.some(
      (q) =>
        q.version === context.version &&
        q.blockId === context.blockId &&
        q.termId === termId &&
        q.text === text,
    )
  )
    return "同じ質問は保存済みです。";
  history.questions.push(
    questionSchema.parse({
      ...context,
      termId,
      text,
      context: excerpt,
      userId: history.userId,
      time: new Date().toISOString(),
      questionId: crypto.randomUUID(),
    }),
  );
  save();
  return "このタブに質問を記録しました。保存状態を確認し、節の改善欄で一覧を読み直してください。";
});
let blocked = loaded.error;
let resume =
  history.resume?.bookId === book.bookId &&
  history.resume.version === book.version
    ? history.resume
    : null;
let minutes: 5 | 10 | 15 | 30 = resume?.minutes ?? 10;
let index = Math.max(
  0,
  book.blocks.findIndex((b) => b.id === location.hash.slice(1)),
);
let planStart = resume?.planStart ?? index;
const root = document.querySelector<HTMLDivElement>("#app")!;
const header = el("header");
header.className = "lesson-header";
header.append(
  el("a", "Quilna", "brand"),
  el("span", "SRE のための、小さな教科書", "muted"),
);
const byok = byokSettings();
const collectionLink = el("a", "情報収集へ", "rss-text-link");
collectionLink.href = "/?view=feeds";
header.append(collectionLink);
const readingSettings = button("読書設定", () => {
  const content = el("div", undefined, "reading-settings");
  content.append(
    el("h3", "履歴の保存先"),
    el(
      "p",
      "教材の回答・再開位置などの履歴は、このブラウザ内に自動保存します。別の端末やブラウザとは同期しません。ブラウザのデータを消去すると失われます。",
    ),
    el(
      "p",
      "保存中や保存できなかった場合は、読書画面に状態と再試行を表示します。",
    ),
    el("h3", "キーボード操作"),
  );
  const shortcutLabel = el("label");
  const shortcutToggle = el("input");
  shortcutToggle.type = "checkbox";
  shortcutToggle.checked = shortcutsEnabled;
  const shortcutStatus = el("span", undefined, "muted");
  shortcutStatus.setAttribute("role", "status");
  shortcutStatus.textContent = shortcutNotice;
  shortcutToggle.addEventListener("change", () => {
    shortcutsEnabled = shortcutToggle.checked;
    try {
      storage.setItem(shortcutKey, shortcutsEnabled ? "on" : "off");
      shortcutNotice = "";
    } catch {
      shortcutNotice = "設定はこのタブのみ。保存できませんでした。";
    }
    shortcutStatus.textContent = shortcutNotice;
  });
  shortcutLabel.append(
    shortcutToggle,
    " N：次へ / P：前へ（キー移動を有効にする）",
  );
  content.append(shortcutLabel, shortcutStatus);
  openReaderDialog("reading-settings", "読書設定", content, readingSettings);
});
header.append(readingSettings);
header.append(button("自分のAPIキー設定", byok.open));
root.append(header, byok.dialog);
root.append(accountSettings());
const shell = el("div", undefined, "shell");
const sidebar = el("aside");
const toc = el("details");
toc.open = window.matchMedia("(min-width:801px)").matches;
toc.append(el("summary", "このセクションの目次"));
const nav = el("nav");
nav.setAttribute("aria-label", "目次");
toc.append(nav);
const edition = el("p", undefined, "muted");
sidebar.append(el("p", "NETWORK / 001", "eyebrow"), toc, edition);
const main = el("main");
shell.append(sidebar, main);
root.append(shell);
const status = el("div", undefined, "save-status");
status.setAttribute("role", "status");
root.append(status);
let pendingSaves = 0;
window.addEventListener("beforeunload", (event) => {
  if (pendingSaves) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function save() {
  pendingSaves++;
  status.dataset.saving = "true";
  status.replaceChildren(
    feedbackMessage(
      "neutral",
      "保存中",
      "記録の保存が終わるまで、このタブでお待ちください。",
    ),
  );
  history.resume = {
    bookId: book.bookId,
    version: book.version,
    blockId: book.blocks[index].id,
    userId: history.userId,
    time: new Date().toISOString(),
    minutes,
    planStart,
  };
  const persist = () => {
    const fresh = blocked ? null : readHistory(storage);
    const conflict =
      fresh &&
      !fresh.error &&
      activeLocalBook(baseBook, fresh.history.bookRevisions).version !==
        book.version;
    if (fresh && !fresh.error && !conflict) {
      mergeHistoryRecords(history, fresh.history);
    }
    const ok =
      !blocked && !conflict && !fresh?.error && writeHistory(storage, history);
    pendingSaves--;
    if (!pendingSaves) delete status.dataset.saving;
    status.replaceChildren();
    if (!ok) {
      status.append(
        feedbackMessage(
          "error",
          "保存エラー",
          conflict
            ? "別タブで教材版が変わりました。保存を保留しています。再読み込みして現版を確認してください。"
            : blocked
              ? "履歴を読み込めませんでした。既存データの上書きを止めています。"
              : "保存できません。このタブ内の回答・予想・ふりかえりは保持しています。",
        ),
        button("保存を再試行", () => {
          if (blocked) {
            const retry = readHistory(storage);
            if (retry.error) return;
            mergeHistoryRecords(history, retry.history);
            blocked = false;
          }
          save();
        }),
      );
    } else if (pendingSaves)
      status.append(
        feedbackMessage(
          "neutral",
          "保存中",
          "記録の保存が終わるまで、このタブでお待ちください。",
        ),
      );
  };
  if (navigator.locks)
    void navigator.locks.request("fieldnotes.history.v1", persist).catch(() => {
      pendingSaves--;
      if (!pendingSaves) delete status.dataset.saving;
      status.replaceChildren(
        feedbackMessage(
          "error",
          "保存エラー",
          "排他制御中に保存できませんでした。このタブ内の記録は保持しています。",
        ),
        button("保存を再試行", save),
      );
    });
  else persist();
}
async function acceptProposal(proposal: Proposal): Promise<string | null> {
  if (!navigator.locks)
    return "このブラウザでは安全な排他制御を利用できません。反映は保留します。";
  proposalApplying = true;
  try {
    return await navigator.locks.request("fieldnotes.history.v1", async () => {
      const latest = readHistory(storage);
      if (latest.error)
        return "保存領域を読み込めません。既存データの保護のため反映を止めました。";
      if (
        activeLocalBook(baseBook, latest.history.bookRevisions).version !==
        book.version
      )
        return "別タブで教材版が変わりました。再読み込みして現版を確認してください。";
      try {
        const revisionId = crypto.randomUUID();
        const nextBook = applyProposal(
          book,
          proposal,
          [...history.proposalEvents, ...latest.history.proposalEvents],
          revisionId,
        );
        const time = new Date().toISOString();
        const identity = {
          bookId: book.bookId,
          version: book.version,
          blockId: proposal.blockId,
          userId: history.userId,
          time,
        };
        const staged = historySchema.parse(history);
        mergeHistoryRecords(staged, latest.history);
        staged.bookRevisions.push({
          ...identity,
          version: nextBook.version,
          revisionId,
          proposalId: proposal.proposalId,
          baseVersion: book.version,
          book: nextBook,
        });
        staged.proposalEvents.push({
          ...identity,
          eventId: crypto.randomUUID(),
          proposalId: proposal.proposalId,
          action: "apply",
        });
        staged.questionEvents.push({
          ...identity,
          eventId: crypto.randomUUID(),
          questionId: proposal.questionId,
          action: "resolved",
        });
        if (!writeHistory(storage, staged))
          return "新しい版を保存できませんでした。元の教材のままです。保存を再試行してから、もう一度本人選択で反映してください。";
        const readingId = book.blocks[index]?.id;
        Object.assign(history, staged);
        book = nextBook;
        index = Math.max(
          0,
          book.blocks.findIndex((b) => b.id === readingId),
        );
        planStart = Math.min(planStart, book.blocks.length - 1);
        resume = null;
        reviewOpen = false;
        reviewNode = null;
        render();
        save();
        main.querySelector("h2")?.focus();
        return null;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : "追加案の検証に失敗しました。";
      }
    });
  } finally {
    proposalApplying = false;
    if (deferredPopstate !== null) {
      const target = book.blocks.findIndex((b) => b.id === deferredPopstate);
      deferredPopstate = null;
      go(target < 0 ? 0 : target, false);
    }
  }
}
function go(i: number, push = true) {
  if (proposalApplying || i < 0 || i >= book.blocks.length) return;
  reviewOpen = false;
  reviewNode = null;
  index = i;
  if (push) window.history.pushState(null, "", `#${book.blocks[i].id}`);
  if (window.matchMedia("(max-width:800px)").matches) toc.open = false;
  render();
  save();
  main.querySelector("h2")?.focus();
}
function render() {
  edition.textContent = `固定教材 · v${book.version}\n全 1 セクション`;
  nav.replaceChildren();
  book.blocks.forEach((b, i) => {
    const a = el("a", b.title);
    a.href = `#${b.id}`;
    if (i === index) a.setAttribute("aria-current", "step");
    a.addEventListener("click", (e) => {
      e.preventDefault();
      go(i);
    });
    nav.append(a);
  });
  main.replaceChildren();
  main.append(el("h1", book.title, "compact-title"));
  main.append(
    el(
      "p",
      `CAA の固定教材${book.version.includes("+local.") ? "＋本人のローカル追加" : ""} · 生成は未実装・実認証と同期は未接続`,
      "prototype-note",
    ),
  );
  const introduction = el("details", undefined, "introduction");
  introduction.append(
    el("summary", "はじめに：教材・保存範囲・用語"),
    el(
      "p",
      `CAA の適用範囲と、運用で役立つ場面を学ぶ全1セクション、${book.blocks.length}ブロックです。時間設定は区切りの目安です。基本教材約25–35分、本人の追加・説明練習は別。所要時間は保証しません。`,
    ),
    el(
      "p",
      "固定教材の試作、生成機能は未実装。Google 認証の実環境設定・クラウド同期は未接続です。履歴はこのブラウザのみ。実習費・AI API 呼び出し・外部 DNS 操作はありません。",
    ),
    el(
      "p",
      "保存するのはブロックの位置・時間設定・回答履歴・図の予想とふりかえり・復習・質問・手動提案・ローカル教材版です。再読み込みや次回再開では、スクロール位置、図の設定、探索ステップ、回答の表示は復元しません。同じタブ内で問題から図を開く場合は、回答表示を保持します。保存済みの図の予想・比較・ふりかえりは再読み込み後も確認できます。入力途中の未保存文は戻りません。読了の表示はこのタブ内だけです。",
    ),
    el(
      "p",
      "IN はインターネット用の DNS クラス。flags は CAA のフラグ欄で、今回の 0 は特別なフラグなし。SAN は証明書に含める対象名の一覧。CP/CPS は認証局の証明書ポリシー・運用規程です。",
    ),
  );
  if (
    history.resume?.bookId === book.bookId &&
    history.resume.version !== book.version
  )
    main.append(
      feedbackMessage(
        "warning",
        "教材更新：再開位置を確認",
        `教材を v${book.version} に更新しました。旧版の回答は保存したまま、旧版の再開位置は自動適用しません。`,
      ),
    );
  if (resume) {
    main.append(
      button(
        `前回のブロックへ：${book.blocks.find((b) => b.id === resume?.blockId)?.title ?? "01"}`,
        () =>
          go(
            book.blocks.findIndex((b) => b.id === resume?.blockId) >= 0
              ? book.blocks.findIndex((b) => b.id === resume?.blockId)
              : 0,
          ),
        "resume",
      ),
    );
  }
  if (history.resume) {
    main.append(
      button(
        resume ? "復習してから再開（任意）" : "新版の導入を1問確認（任意）",
        () => {
          reviewOpen = !reviewOpen;
          if (!reviewOpen) reviewNode = null;
          render();
          main.querySelector<HTMLElement>(".resume-review")?.focus();
        },
        "review-toggle",
      ),
    );
    if (reviewOpen) {
      reviewNode ??= resumeReview(
        book,
        { history, save },
        () => {
          reviewOpen = false;
          reviewNode = null;
          const target = book.blocks.findIndex((b) => b.id === resume?.blockId);
          go(target >= 0 ? target : index);
        },
        previousResume,
      );
      main.append(reviewNode);
    }
  }
  const settings = el("div", undefined, "settings");
  const timeLabel = el("label", "今日の時間（目安）");
  const times = el("select");
  times.id = "minutes";
  timeLabel.htmlFor = times.id;
  for (const t of [5, 10, 15, 30]) {
    const o = el("option", `${t} 分`);
    o.value = String(t);
    times.append(o);
  }
  times.value = String(minutes);
  times.addEventListener("change", () => {
    minutes = Number(times.value) as typeof minutes;
    planStart = index;
    render();
    save();
    main.querySelector<HTMLSelectElement>("#minutes")?.focus();
  });
  settings.append(timeLabel, times);
  main.append(settings);
  const plan = learningPlan(
    planStart,
    minutes,
    book.blocks.map(
      (b) =>
        blockMinutes[
          baseBook.blocks.findIndex((original) => original.id === b.id)
        ] ?? 2,
    ),
  );
  const range = `${String(plan.start + 1).padStart(2, "0")}–${String(plan.end + 1).padStart(2, "0")}`;
  main.append(
    el(
      "p",
      `今回 ${range} · 終点：${book.blocks[plan.end].title.split(" / ")[1]}（目安約${plan.estimate}分）`,
      "plan",
    ),
  );
  for (const [i, link] of Array.from(nav.querySelectorAll("a")).entries()) {
    if (i >= plan.start && i <= plan.end) link.dataset.inPlan = "true";
    if (i === plan.end) link.append(el("span", "今回の終点", "plan-end-label"));
  }
  const article = el("article");
  article.append(
    renderBlock(
      book.blocks[index],
      (answer, correct) => {
        history.attempts.push({
          bookId: book.bookId,
          version: book.version,
          blockId: book.blocks[index].id,
          userId: history.userId,
          attemptId: crypto.randomUUID(),
          time: new Date().toISOString(),
          answer,
          correct,
        });
        save();
      },
      { bookId: book.bookId, version: book.version },
      { history, save },
    ),
  );
  article.hidden = reviewOpen;
  article.querySelector("h2")!.tabIndex = -1;
  main.append(
    article,
    questionWorkbench(
      book,
      book.blocks[index].id,
      { history, save },
      acceptProposal,
    ),
  );
  main.querySelector<HTMLElement>(".question-workbench")!.hidden = reviewOpen;
  const controls = el("div", undefined, "page-controls");
  controls.hidden = reviewOpen;
  const back = button("← 前へ", () => go(index - 1));
  back.disabled = index === 0;
  const next = button(
    index === book.blocks.length - 1 ? "セクションを読み終えた" : "次へ →",
    () => {
      if (index < book.blocks.length - 1) go(index + 1);
      else {
        completion.textContent =
          "読了。説明練習と模擬図を必要に応じて繰り返してください。";
        save();
      }
    },
  );
  const completion = el("p");
  completion.setAttribute("role", "status");
  controls.append(
    back,
    el("span", `${index + 1} / ${book.blocks.length}`),
    next,
  );
  main.append(controls, completion);
  if (index === plan.end) {
    const checkpoint = el("div", undefined, "checkpoint");
    checkpoint.append(
      el("strong", "今回の目安の終点です"),
      el(
        "p",
        "ここで中断できます。回答や読書時間による完了判定ではありません。続ける場合も全内容を読めます。",
      ),
    );
    if (index + 1 < book.blocks.length)
      checkpoint.append(
        button("次回は次のブロックから", () => {
          planStart = index + 1;
          go(index + 1);
        }),
      );
    main.append(checkpoint);
  }
  if (resume)
    main.append(
      el(
        "p",
        "再開先は今回の起動時に読み込んだ前回のブロックです。図や回答の表示は復元しません。今回の移動は次回の再開位置になります。",
        "muted",
      ),
    );
  main.append(introduction);
  const sources = el("details", undefined, "sources");
  sources.append(el("summary", "出典と今回の範囲"));
  const p = el(
    "p",
    "2026-10-10 に公式資料を再確認。RFC §3 は探索停止と全要求名の確認、§4.2 は issue の許可、§1・§5.3 は発行条件と限界の根拠。非ワイルドカード、flags 0、issue / iodef、正常 DNS 応答のみ。CNAME、issuewild、未知 critical 128、CA パラメータ、DNSSEC・障害は対象外です。汎用 CAA 判定器ではありません。",
  );
  sources.append(p);
  for (const [title, url] of [
    [
      "RFC 8659 §1・§3–4・§5.3",
      "https://www.rfc-editor.org/rfc/rfc8659.html#section-3",
    ],
    ["Let’s Encrypt CAA ドキュメント", "https://letsencrypt.org/docs/caa/"],
  ]) {
    const a = el("a", title);
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    sources.append(a);
  }
  main.append(sources);
}
window.addEventListener("popstate", () => {
  if (proposalApplying) {
    deferredPopstate = location.hash.slice(1);
    return;
  }
  const i = book.blocks.findIndex((b) => b.id === location.hash.slice(1));
  if (i !== index) go(i < 0 ? 0 : i, false);
});
installNavigationShortcuts(
  () => shortcutsEnabled && !reviewOpen && !proposalApplying,
  (direction) => {
    const target = index + direction;
    if (target < 0 || target >= book.blocks.length) return false;
    go(target);
    return true;
  },
);
render();
if (loaded.error) save();
