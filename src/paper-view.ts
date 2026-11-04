import { hasAccountLibrary } from "./library-context";
import { button, el } from "./ui";
import { pushReaderURL, revealReaderAnchor } from "./reader-route";
import { PaperClient } from "./paper-client";
import { paperSearchView } from "./paper-search-view";
import {
  paperDOI,
  paperFileLimit,
  parsePaper,
  type PaperSnapshot,
} from "./paper-format";
import { listPapers, savePaper, paperKey, readPaper } from "./paper-store";
import { readPaperExcerpt } from "./paper-excerpt-store";
import { paperExcerptView } from "./paper-excerpt-view";
import { paperExcerptLibrary } from "./paper-excerpt-library";
import {
  parsePaperExcerpt,
  paperExcerptLimit,
  type PaperExcerpt,
} from "./paper-text-format";

/** Render a date without adding a missing month/day or confusing it with full-text revision time. */
function displayDate(value: PaperSnapshot["metadata"]["dates"]["published"]) {
  return (
    [value.parts?.join("-"), value.timestamp].filter(Boolean).join(" / ") ||
    "不明"
  );
}
/** External source navigation is explicit and never sends the app's referrer. */
function doiLink(doi: string) {
  const link = el("a", `https://doi.org/${doi}`);
  link.href = `https://doi.org/${encodeURIComponent(doi)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
/** Bibliographic preview/library with explicit provider dispatch and immutable local observations. */
export async function paperView(root: HTMLElement, client = new PaperClient()) {
  document.title = "論文の書誌情報 · Quilna";
  root.className = "paper-page";
  const header = el("header"),
    title = el("h1", "論文の書誌情報"),
    back = el("a", "記事の一覧へ戻る");
  back.href = "/?view=feeds";
  header.append(title, back);
  const main = el("main"),
    form = el("form"),
    input = el("input"),
    label = el("label", "DOIまたは https://doi.org/ のURL"),
    notice = el("p"),
    preview = el("section"),
    library = el("section"),
    file = el("input"),
    fileLabel = el("label", "保存した書誌ファイルを確認");
  input.id = "paper-doi";
  input.type = "text";
  input.maxLength = 8192;
  input.autocomplete = "off";
  label.htmlFor = input.id;
  input.placeholder = "10.1234/example";
  notice.setAttribute("role", "status");
  preview.setAttribute("aria-label", "書誌情報のプレビュー");
  library.setAttribute("aria-label", "保存した書誌情報");
  file.type = "file";
  file.accept = ".json,application/json";
  file.id = "paper-file";
  fileLabel.htmlFor = file.id;
  let revision = 0,
    listRevision = 0,
    controller = new AbortController(),
    busy = false,
    libraryAfter: string | undefined,
    excerptView: ReturnType<typeof paperExcerptView> | null = null;
  let routeRevision = 0;
  function pageURL(key: string, cursor?: string) {
    const url = new URL(location.href);
    if (cursor) url.searchParams.set(key, cursor);
    else url.searchParams.delete(key);
    pushReaderURL(url);
    routeRevision++;
    // Paging during a pending detail read still keeps that detail in the URL.
    // Restart its restore so cancellation cannot leave an empty preview behind.
    if (
      !preview.hasChildNodes() &&
      (url.searchParams.has("paper") || url.searchParams.has("excerpt"))
    )
      void restoreRoute();
  }
  function selectURL(paper = "", excerpt = "") {
    const url = new URL(location.href);
    url.searchParams.set("view", "papers");
    for (const [key, value] of Object.entries({ paper, excerpt })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    url.hash = "";
    pushReaderURL(url);
  }
  async function restoreRoute() {
    const href = location.href,
      params = new URL(href).searchParams;
    changed(false);
    const ticket = routeRevision;
    notice.textContent = "";
    try {
      await Promise.all([
        refresh(params.get("paperAfter") || undefined),
        excerpts.restore(params.get("excerptAfter") || undefined),
      ]);
      if (ticket !== routeRevision || href !== location.href) return;
      if (params.get("excerpt")) {
        const record = await readPaperExcerpt(params.get("excerpt")!);
        if (ticket !== routeRevision || href !== location.href) return;
        if (!record)
          throw Error("このURLの論文引用は現在のライブラリにありません。");
        show(record.source.paper, false, record, true, false);
      } else if (params.get("paper")) {
        const record = await readPaper(params.get("paper")!);
        if (ticket !== routeRevision || href !== location.href) return;
        if (!record)
          throw Error("このURLの書誌情報は現在のライブラリにありません。");
        show(record, true, undefined, false, false);
      }
      if (
        !revealReaderAnchor() &&
        ((!params.get("paper") && !params.get("excerpt")) ||
          typeof history.state?.readerScroll === "number")
      )
        window.scrollTo(0, Number(history.state?.readerScroll) || 0);
    } catch (error) {
      if (ticket === routeRevision && href === location.href)
        notice.textContent = (error as Error).message;
    }
  }
  window.addEventListener("popstate", () => void restoreRoute());
  const cancel = button("確認を中止", () => {
    revision++;
    controller.abort();
    controller = new AbortController();
    busy = false;
    lookup.disabled = cancel.disabled = false;
    cancel.hidden = true;
    notice.textContent =
      "書誌情報の確認を中止しました。保存済みの記録は保持しています。";
  });
  cancel.hidden = true;
  const lookup = el("button", "DOIをCrossrefへ送って確認");
  lookup.type = "submit";
  form.append(
    el("h2", "DOIから確認"),
    el(
      "p",
      "このボタンを押すと、入力したDOIをCrossref（api.crossref.org）へ送ります。IPと要求内容が提供元に記録されます。アカウント・メール・記事・学習履歴は送りません。応答に抄録が含まれる場合も保存・表示・書き出しから除きます。このDOI確認では本文やPDFを追加取得しません。登録やAPIキーは不要です。",
    ),
    label,
    input,
    lookup,
    cancel,
  );
  const imported = el("section");
  imported.append(el("h2", "書誌ファイルから確認"), fileLabel, file);
  const search = paperSearchView(
    client,
    (doi) => {
      input.value = doi;
      changed();
      form.requestSubmit();
    },
    changed,
  );
  const excerptFile = el("input"),
    excerptLabel = el("label", "保存した論文引用ファイルを確認");
  excerptFile.id = "paper-excerpt-file";
  excerptFile.type = "file";
  excerptFile.accept = ".json,application/json";
  excerptLabel.htmlFor = excerptFile.id;
  imported.append(
    el("h3", "論文引用ファイルから確認"),
    excerptLabel,
    excerptFile,
  );
  const excerpts = paperExcerptLibrary(
    (record) => show(record.source.paper, false, record, true),
    (cursor) => pageURL("excerptAfter", cursor),
  );
  main.append(
    search.root,
    form,
    imported,
    notice,
    preview,
    library,
    excerpts.root,
  );
  root.replaceChildren(header, main);

  /** Changing the pending input invalidates even a transport that ignores cancellation. */
  function changed(navigate = true) {
    routeRevision++;
    if (navigate) selectURL();
    document.title = "論文の書誌情報 · Quilna";
    excerptView?.dispose();
    excerptView = null;
    search.cancel();
    revision++;
    controller.abort();
    controller = new AbortController();
    busy = false;
    lookup.disabled = false;
    cancel.hidden = true;
    preview.replaceChildren();
  }
  input.addEventListener("input", () => {
    changed();
    notice.textContent = "DOIを確認してから送信してください。";
  });
  window.addEventListener("pagehide", () => changed(false));
  // pagehide clears the detail, but a cached page keeps the URL that names it.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void restoreRoute();
  });
  /** Show selected facts as text, including explicit uncertainty and deposited relationship records. */
  function show(
    p: PaperSnapshot,
    saved = false,
    excerpt?: PaperExcerpt,
    excerptSaved = false,
    navigate = true,
  ) {
    routeRevision++;
    if (navigate)
      selectURL(saved ? paperKey(p) : "", excerptSaved ? excerpt?.digest : "");
    document.title = `${p.metadata.titles.join(" / ") || "題名不明"} · Quilna`;
    excerptView?.dispose();
    excerptView = null;
    search.cancel();
    const current = ++revision;
    controller.abort();
    controller = new AbortController();
    busy = false;
    lookup.disabled = false;
    cancel.hidden = true;
    const m = p.metadata,
      heading = el("h2", m.titles.join(" / ") || "題名不明"),
      facts = el("dl");
    heading.tabIndex = -1;
    /** Return the value node so a confirmed save can update it without replacing focused controls. */
    const fact = (name: string, value: string) => {
      const detail = el("dd", value || "不明");
      facts.append(el("dt", name), detail);
      return detail;
    };
    fact("DOI", m.doi);
    fact(
      "著者",
      m.authors
        .map((a) =>
          [
            a.name ||
              [a.given, a.family].filter(Boolean).join(" ") ||
              "氏名不明",
            a.orcid,
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join(" / "),
    );
    fact("種類", m.type || "不明");
    fact("登録された版番号", m.version || "不明");
    fact("掲載誌・収録先", m.container.join(" / "));
    fact("出版社", m.publisher || "不明");
    fact("登録された出版社のリンク", m.publisherURL || "不明");
    for (const [key, name] of Object.entries({
      published: "公開日",
      online: "オンライン公開日",
      print: "印刷版公開日",
      created: "DOI登録日時",
      deposited: "メタデータ登録更新日時",
      indexed: "索引更新日時",
    }))
      fact(name, displayDate(m.dates[key as keyof typeof m.dates]));
    fact(
      "巻・号・ページ・記事番号",
      [
        m.volume && `巻 ${m.volume}`,
        m.issue && `号 ${m.issue}`,
        m.page && `ページ ${m.page}`,
        m.articleNumber && `記事番号 ${m.articleNumber}`,
      ]
        .filter(Boolean)
        .join(" / "),
    );
    const capturedAtDisplay = fact(
      "提供元・取得日時",
      `Crossref · ${new Date(p.capturedAt).toLocaleString("ja-JP")}`,
    );
    const relationships = el("div");
    relationships.append(el("h3", "版・訂正などの登録関係"));
    if (!m.relations.length && !m.updates.length)
      relationships.append(
        el(
          "p",
          "登録された関係情報はありません。訂正・撤回がないことの保証ではありません。",
        ),
      );
    for (const r of m.relations)
      relationships.append(
        el(
          "p",
          `${r.kind} · ${r.identifierType || "識別子の種類不明"} · ${r.identifier}`,
        ),
      );
    for (const u of m.updates)
      relationships.append(
        el(
          "p",
          `${u.type || "更新種別不明"} · ${u.label || "説明不明"} · ${u.doi} · ${u.date?.join("-") || "日付不明"}`,
        ),
      );
    let saving = false,
      isSaved = saved,
      activeSnapshot = p;
    const state = el(
        "p",
        saved ? "この記録は保存済みです。" : "まだ保存していません。",
      ),
      save = button("この書誌情報を保存", async () => {
        if (saving || isSaved) return;
        saving = true;
        save.setAttribute("aria-disabled", "true");
        state.textContent = "書誌情報を保存しています…";
        try {
          const result = await savePaper(activeSnapshot);
          if (current !== revision) return;
          activeSnapshot = result.snapshot;
          capturedAtDisplay.textContent = `Crossref · ${new Date(activeSnapshot.capturedAt).toLocaleString("ja-JP")}`;
          isSaved = true;
          const currentExcerpt =
            new URL(location.href).searchParams.get("excerpt") || "";
          selectURL(
            currentExcerpt ? "" : paperKey(activeSnapshot),
            currentExcerpt,
          );
          save.textContent = "保存済み";
          state.textContent = result.reused
            ? "同じ書誌情報は保存済みです。最初の取得記録を保持しました。"
            : "書誌情報を保存しました。以前の記録は変更していません。";
          await refresh(libraryAfter);
        } catch (error) {
          if (current === revision) {
            state.textContent = (error as Error).message;
            save.setAttribute("aria-disabled", "false");
          }
        } finally {
          saving = false;
        }
      }),
      download = button("この記録をファイルに保存", () => {
        const url = URL.createObjectURL(
            new Blob([JSON.stringify(activeSnapshot)], {
              type: "application/json",
            }),
          ),
          link = el("a");
        link.href = url;
        link.download = `quilna-paper-${activeSnapshot.digest.slice(0, 12)}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    save.disabled = saved;
    preview.replaceChildren(
      heading,
      button("保存一覧へ戻る", () => {
        changed();
        library.querySelector<HTMLElement>("h2")?.focus();
      }),
      el(
        "p",
        "提供元の書誌情報を取得した時点の記録です。本文・抄録や実際の論文の版、内容の正しさ、査読・訂正・撤回の網羅性を確認したものではありません。",
      ),
      facts,
      doiLink(m.doi),
      relationships,
      state,
      save,
      download,
    );
    excerptView = paperExcerptView(
      p,
      (record, visible) => {
        if (visible && current === revision) selectURL("", record.digest);
        return excerpts.refresh();
      },
      {
        record: excerpt,
        saved: excerptSaved,
      },
    );
    preview.append(excerptView.root);
    if (excerpt) excerptView.focus();
    else heading.focus();
    if (navigate)
      history.replaceState({ ...history.state, readerScroll: scrollY }, "");
  }
  /** Give each library action a stable focus identity independent of row order. */
  function libraryButton(key: string, text: string, action: () => void) {
    const control = button(text, action);
    control.dataset.paperFocusKey = key;
    return control;
  }
  /** Preserve focus as it exists at publication time, without moving focus from outside the library. */
  function renderLibrary(...children: HTMLElement[]) {
    const active = document.activeElement as HTMLElement | null,
      key =
        active && library.contains(active)
          ? active.dataset.paperFocusKey
          : undefined,
      heading = children[0];
    heading.tabIndex = -1;
    heading.dataset.paperFocusKey = "heading";
    library.replaceChildren(...children);
    if (key) {
      const target = Array.from(
        library.querySelectorAll<HTMLElement>("[data-paper-focus-key]"),
      ).find((node) => node.dataset.paperFocusKey === key);
      (target ?? heading).focus({ preventScroll: true });
    }
  }
  /** Keep library paging independent of the selected preview and refuse stale page completions. */
  async function refresh(after?: string) {
    const current = ++listRevision;
    libraryAfter = after;
    try {
      const page = await listPapers(after);
      if (current !== listRevision) return;
      const content: HTMLElement[] = [el("h2", "保存した書誌情報")];
      if (!page.snapshots.length)
        content.push(el("p", "保存した書誌情報はありません。"));
      for (const p of page.snapshots) {
        const row = el("div", undefined, "paper-row");
        row.append(
          el(
            "p",
            `${p.metadata.titles.join(" / ") || "題名不明"} · ${p.metadata.doi} · ${new Date(p.capturedAt).toLocaleString("ja-JP")}`,
          ),
          libraryButton(paperKey(p), "書誌情報を開く", () => show(p, true)),
        );
        content.push(row);
      }
      if (after)
        content.push(
          libraryButton("first", "先頭の20件", () => {
            pageURL("paperAfter");
            void refresh();
          }),
        );
      if (page.next)
        content.push(
          libraryButton("next", "次の20件", () => {
            pageURL("paperAfter", page.next);
            void refresh(page.next);
          }),
        );
      renderLibrary(...content);
    } catch (error) {
      if (current === listRevision)
        renderLibrary(
          el("h2", "保存した書誌情報"),
          el("p", (error as Error).message),
          libraryButton("retry", "保存一覧を再試行", () => {
            void refresh(after);
          }),
        );
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    changed();
    const current = revision;
    try {
      paperDOI(input.value);
    } catch {
      notice.textContent =
        "有効なDOI、または https://doi.org/ のURLを入力してください。";
      return;
    }
    busy = true;
    lookup.disabled = true;
    cancel.hidden = false;
    notice.textContent = "Crossrefの書誌情報を確認しています…";
    try {
      const p = await client.lookup(input.value, controller.signal);
      if (current !== revision) return;
      show(p);
      notice.textContent =
        "書誌情報を確認しました。内容を確認してから保存してください。";
    } catch (error) {
      if (current === revision) notice.textContent = (error as Error).message;
    } finally {
      if (current === revision) {
        busy = false;
        lookup.disabled = false;
        cancel.hidden = true;
      }
    }
  });
  file.addEventListener("change", async () => {
    changed();
    const current = revision,
      selected = file.files?.[0];
    file.value = "";
    if (!selected) return;
    try {
      if (selected.size > paperFileLimit)
        throw Error("書誌ファイルは1,000,000バイト以内で選んでください。");
      const p = await parsePaper(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        ),
      );
      if (current !== revision) return;
      show(p);
      notice.textContent =
        "書誌ファイルを確認しました。提供元への通信は行っていません。内容を確認してから保存してください。";
    } catch (error) {
      if (current === revision)
        notice.textContent =
          error instanceof TypeError
            ? "書誌ファイルを確認できません。UTF-8の対応するJSONファイルを選んでください。保存済みの記録は保持しています。"
            : (error as Error).message;
    } finally {
      if (current === revision) file.value = "";
    }
  });
  excerptFile.addEventListener("change", async () => {
    changed();
    const current = revision,
      selected = excerptFile.files?.[0];
    excerptFile.value = "";
    if (!selected) return;
    try {
      if (selected.size > paperExcerptLimit)
        throw Error("論文引用ファイルは3,000,000バイト以内で選んでください。");
      const record = await parsePaperExcerpt(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        ),
      );
      if (current !== revision) return;
      show(record.source.paper, false, record);
      notice.textContent =
        "論文引用ファイルを確認しました。提供元への通信は行っていません。保存・共有の前に本文・引用・利用条件を確認してください。";
    } catch (error) {
      if (current === revision)
        notice.textContent =
          error instanceof TypeError
            ? "論文引用ファイルを確認できません。UTF-8の対応するJSONファイルを選んでください。保存済みの記録は保持しています。"
            : (error as Error).message;
    }
  });
  main.append(
    el(
      "p",
      hasAccountLibrary()
        ? "書誌情報と論文引用はこのブラウザの現在のログイン専用のライブラリに保存します。別の端末とは同期しません。記事のバックアップとは別です。必要な記録は書誌ファイルとして保存できます。同じDOIの変更された登録情報は別の記録として残します。"
        : "書誌情報と論文引用はこのブラウザのプロフィールに保存します。ログインごとの分離や同期はありません。別の人とはプロフィールを分けてください。記事のバックアップとは別です。必要な記録は書誌ファイルとして保存できます。同じDOIの変更された登録情報は別の記録として残します。",
    ),
  );
  await restoreRoute();
}
