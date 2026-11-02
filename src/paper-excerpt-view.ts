import { type PaperSnapshot } from "./paper-format";
import { PaperTextClient } from "./paper-text-client";
import {
  paperExcerpt,
  type PaperExcerpt,
  type PaperTextSnapshot,
} from "./paper-text-format";
import { savePaperExcerpt } from "./paper-excerpt-store";
import { button, el } from "./ui";
/** Navigate only after an explicit source/license link activation, without the app referrer. */
function external(text: string, url: string) {
  const link = el("a", text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
/** A disposable selected-paper workflow keeps late body/quote results outside newer selections. */
export function paperExcerptView(
  paper: PaperSnapshot,
  onSaved: () => Promise<void>,
  options: { record?: PaperExcerpt; saved?: boolean } = {},
  client: Pick<PaperTextClient, "lookup"> = new PaperTextClient(),
) {
  const root = el("section"),
    form = el("form"),
    input = el("input"),
    label = el("label", "Europe PMCのPMCID"),
    submit = el("button", "PMCIDをEurope PMCへ送って本文を確認"),
    notice = el("p"),
    body = el("section"),
    quote = el("section");
  root.setAttribute("aria-label", "論文本文と引用");
  body.setAttribute("aria-label", "取得した論文本文");
  quote.setAttribute("aria-label", "論文引用のプレビュー");
  notice.setAttribute("aria-live", "polite");
  input.id = "paper-pmcid";
  input.type = "text";
  input.maxLength = 15;
  input.placeholder = "PMC1234567";
  input.autocomplete = "off";
  label.htmlFor = input.id;
  submit.type = "submit";
  let active = true,
    revision = 0,
    controller = new AbortController(),
    busy = false,
    source: PaperTextSnapshot | null = null,
    focusQuote: HTMLElement | null = null,
    sourceCaptured: HTMLElement | null = null,
    bibliographyCaptured: HTMLElement | null = null;
  /** Cancellation also invalidates transports and digest work which ignore an abort signal. */
  function invalidate() {
    revision++;
    controller.abort();
    controller = new AbortController();
    busy = false;
    submit.disabled = false;
    cancel.hidden = true;
  }
  const cancel = button("本文の確認を中止", () => {
    invalidate();
    notice.textContent =
      "本文の確認を中止しました。前の本文と保存済みの引用は保持しています。";
  });
  cancel.hidden = true;
  form.append(
    el("h3", "公開本文から引用する"),
    el(
      "p",
      "このボタンを押すと、入力したPMCIDをEurope PMC（www.ebi.ac.uk）へ送ります。IPとアクセス内容が提供元に記録されます。アカウント・メール・記事・学習履歴は送りません。公開本文XMLを受信し、DOI・PMCIDとCC BY 4.0／CC0の表示を照合してから段落を表示します。条件を確認できない応答は保存しません。PDFや画像は追加取得しません。登録やAPIキーは不要です。",
    ),
    label,
    input,
    submit,
    cancel,
  );
  root.append(form, notice, body, quote);
  input.addEventListener("input", () => {
    invalidate();
    notice.textContent =
      "PMCIDを確認してから送信してください。前の本文は元のPMCID付きで保持しています。";
  });
  /** Update first-retained capture dates without replacing focused quote controls. */
  function dates(value: PaperTextSnapshot) {
    if (sourceCaptured)
      sourceCaptured.textContent = new Date(value.capturedAt).toLocaleString(
        "ja-JP",
      );
    if (bibliographyCaptured)
      bibliographyCaptured.textContent = new Date(
        value.paper.capturedAt,
      ).toLocaleString("ja-JP");
  }
  /** Freeze one exact quote and show all stored/exported provenance before any save or download. */
  function showQuote(record: PaperExcerpt, saved = false) {
    quote.replaceChildren();
    const heading = el("h4", "論文引用のプレビュー"),
      state = el(
        "p",
        saved ? "この引用は保存済みです。" : "この引用はまだ保存していません。",
      );
    heading.tabIndex = -1;
    focusQuote = heading;
    let saving = false,
      isSaved = saved,
      retained = record;
    const quoteDate = el(
      "dd",
      new Date(record.createdAt).toLocaleString("ja-JP"),
    );
    const save = button(
      saved ? "引用を保存済み" : "この論文引用を保存",
      async () => {
        if (!active || !save.isConnected || saving || isSaved) return;
        saving = true;
        save.setAttribute("aria-disabled", "true");
        state.textContent = "論文引用を保存しています…";
        try {
          const result = await savePaperExcerpt(retained);
          void onSaved();
          if (!active || !save.isConnected) return;
          retained = result.record;
          source = result.record.source;
          dates(source);
          quoteDate.textContent = new Date(retained.createdAt).toLocaleString(
            "ja-JP",
          );
          isSaved = true;
          save.textContent = "引用を保存済み";
          state.textContent = result.reused
            ? "同じ引用は保存済みです。最初の本文・書誌・引用の取得記録を保持しました。"
            : "論文引用を保存しました。以前の記録は変更していません。";
        } catch (error) {
          if (active && save.isConnected) {
            state.textContent = (error as Error).message;
            save.setAttribute("aria-disabled", "false");
          }
        } finally {
          saving = false;
        }
      },
    );
    save.setAttribute("aria-disabled", String(saved));
    const download = button("この論文引用をファイルに保存", () => {
      if (!active || !download.isConnected) return;
      const url = URL.createObjectURL(
          new Blob([JSON.stringify(retained)], { type: "application/json" }),
        ),
        link = el("a");
      link.href = url;
      link.download = `quilna-paper-excerpt-${retained.digest.slice(0, 12)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const details = el("details"),
      facts = el("dl");
    for (const [name, value] of [
      ["DOI", record.source.facts.doi],
      ["PMCID", record.source.facts.pmcid],
      ["段落の位置", record.block],
      ["段落内の位置（UTF-16）", `${record.start}〜${record.end}`],
      ["本文記録のhash", record.source.digest],
      ["XMLテキストのhash", record.source.facts.xmlTextDigest],
    ])
      facts.append(el("dt", name), el("dd", value));
    facts.append(el("dt", "引用を選んだ日時"), quoteDate);
    details.append(el("summary", "出典と引用位置の詳細"), facts);
    quote.append(
      heading,
      el("blockquote", record.text),
      el("p", `${record.source.facts.pmcid} · ${record.source.facts.doi}`),
      el(
        "p",
        "引用ファイルには、この引用と位置、保存した段落テキスト、書誌・出典・利用条件・取得日時が含まれます。回答・個人メモ・ログイン情報は含みません。共有前に内容と利用条件を確認してください。教材生成にはまだ接続していません。",
      ),
      details,
      state,
      save,
      download,
    );
    heading.focus();
  }
  /** Render only text and application-created links; all source locations belong to this immutable snapshot. */
  function showSource(
    value: PaperTextSnapshot,
    record?: PaperExcerpt,
    saved = false,
  ) {
    invalidate();
    source = value;
    input.value = value.facts.pmcid;
    quote.replaceChildren();
    focusQuote = null;
    const heading = el(
        "h4",
        `${value.facts.title || "題名不明"} · ${value.facts.pmcid}`,
      ),
      facts = el("dl"),
      select = el("select"),
      selectLabel = el("label", "引用する段落"),
      text = el("textarea"),
      textLabel = el("label", "引用する段落の本文");
    heading.tabIndex = -1;
    /** Return the detail for capture-time updates after an identical save reuses an earlier observation. */
    const fact = (name: string, content: string) => {
      const detail = el("dd", content || "不明");
      facts.append(el("dt", name), detail);
      return detail;
    };
    fact("本文の著者", value.facts.authors.join(" / "));
    fact("本文のDOI", value.facts.doi);
    fact("本文の種類", value.facts.articleType || "不明");
    fact(
      "XMLに記載された本文の版",
      value.facts.version || "不明（書誌の版番号からは推測しません）",
    );
    sourceCaptured = fact("本文を取得した日時", "");
    bibliographyCaptured = fact("対応する書誌を取得した日時", "");
    dates(value);
    fact("提供元の利用条件", value.facts.license.statement);
    fact("著作権表記", value.facts.license.copyright);
    select.id = "paper-text-block";
    selectLabel.htmlFor = select.id;
    text.id = "paper-text-paragraph";
    textLabel.htmlFor = text.id;
    text.readOnly = true;
    text.rows = 8;
    for (const [i, block] of value.facts.blocks.entries()) {
      const option = el(
        "option",
        `${i + 1}. ${block.sections.join(" / ") || "見出しなし"} · ${Array.from(block.text).slice(0, 40).join("")}`,
      );
      option.value = block.path;
      select.append(option);
    }
    if (record) select.value = record.block;
    /** Paragraph navigation invalidates an old selection without replacing its retained body. */
    function paragraph() {
      invalidate();
      quote.replaceChildren();
      focusQuote = null;
      text.value = source!.facts.blocks.find(
        (b) => b.path === select.value,
      )!.text;
    }
    select.addEventListener("change", paragraph);
    paragraph();
    /** Selection offsets are read from the immutable paragraph, never from user-edited text. */
    async function choose(whole: boolean) {
      if (!active || !source) return;
      invalidate();
      const current = revision,
        selected = source;
      input.value = selected.facts.pmcid;
      try {
        const excerpt = await paperExcerpt(
          selected,
          select.value,
          whole ? 0 : text.selectionStart,
          whole ? text.value.length : text.selectionEnd,
        );
        if (active && current === revision) {
          showQuote(excerpt);
          notice.textContent =
            "引用する範囲を確認しました。内容と利用条件を確認してから保存してください。";
        }
      } catch {
        if (active && current === revision)
          notice.textContent =
            "引用する範囲を段落から選んでください。空白だけの範囲、絵文字の途中、6000 UTF-16単位を超える範囲は使えません。";
      }
    }
    const range = button("選択した範囲を引用として確認", () => {
        void choose(false);
      }),
      whole = button("この段落全体を引用として確認", () => {
        void choose(true);
      });
    body.replaceChildren(
      heading,
      el(
        "p",
        record
          ? "ファイルまたは保存領域内の記録です。今回、提供元との照合や更新確認は行っていません。"
          : "Europe PMCから取得したXMLの段落テキストです。内容・査読・版や利用条件の正しさを保証する記録ではありません。",
      ),
      facts,
      external(
        "Europe PMCの出典を開く",
        `https://europepmc.org/articles/${value.facts.pmcid}`,
      ),
      el("p"),
      external("提供元が示した利用条件を開く", value.facts.license.url),
      el(
        "p",
        `段落の空白を整え、上付き・下付きは ^{…}・_{…} と表します。未対応の図・表・数式・コード等${value.facts.omitted}箇所を除いています。出版社PDFのページや完全な組版の再現ではありません。引用位置はこの保存したテキストに対応します。`,
      ),
      selectLabel,
      select,
      textLabel,
      text,
      range,
      whole,
    );
    if (record) showQuote(record, saved);
    else heading.focus();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!active || busy) return;
    invalidate();
    const current = revision;
    busy = true;
    submit.disabled = true;
    cancel.hidden = false;
    notice.textContent =
      "Europe PMCの公開本文と利用条件を確認しています…前の本文は引き続き選べます。";
    try {
      const value = await client.lookup(input.value, paper, controller.signal);
      if (!active || current !== revision) return;
      showSource(value);
      notice.textContent =
        "本文の対応と利用条件の表示を確認しました。引用する段落を選んでください。";
    } catch (error) {
      if (active && current === revision)
        notice.textContent = (error as Error).message;
    } finally {
      if (active && current === revision) {
        busy = false;
        submit.disabled = false;
        cancel.hidden = true;
      }
    }
  });
  if (options.record) {
    if (options.record.source.paper.digest === paper.digest)
      showSource(options.record.source, options.record, options.saved);
    else
      notice.textContent =
        "引用と選択した書誌の対応を確認できません。保存済みの記録は保持しています。";
  }
  return {
    root,
    dispose() {
      active = false;
      invalidate();
    },
    focus() {
      focusQuote?.focus();
    },
  };
}
