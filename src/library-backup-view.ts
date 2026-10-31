import {
  discardBackup,
  exportLibrary,
  pendingBackup,
  restoreBackup,
  validateBackup,
} from "./library-backup";
import {
  backupKinds,
  type BackupCounts,
  type BackupPreview,
} from "./library-backup-format";
import { button, el } from "./ui";
const names = {
  documents: "文書",
  documentVersions: "本文の版",
  feeds: "購読",
  articles: "記事",
  highlights: "ハイライト",
  connections: "記事の関連",
  quoteConnections: "引用の関連",
  learning: "学び",
};
function countsText(counts: BackupCounts) {
  return backupKinds.map((k) => `${names[k]} ${counts[k]}件`).join(" / ");
}
export class LibraryBackupView {
  readonly root = el(
    "section",
    undefined,
    "rss-translation-settings rss-backup",
  );
  private readonly details = el("details");
  private readonly status = el("p", "", "muted");
  private readonly create = button(
    "バックアップを作成",
    () => void this.createFile(),
  );
  private readonly download = el("a");
  private readonly file = el("input");
  private readonly inspect = button(
    "選んだファイルを検証",
    () => void this.inspectFile(),
  );
  private readonly restore = button(
    "不足している記録を復元",
    () => void this.restoreFile(),
  );
  private readonly cancel = button("処理を中止", () =>
    this.controller?.abort(),
  );
  private readonly retry = button(
    "検証済みファイルを再確認",
    () => void this.refresh(),
  );
  private readonly discard = button("検証用の一時ファイルを破棄", () => {
    if (
      !confirm(
        "検証用の一時ファイルを破棄しますか？ 記事・引用・学びと、ダウンロード済みのファイルは残ります。",
      )
    )
      return;
    const id = this.preview?.id;
    void this.run(async (_signal, progress) => {
      await discardBackup(id);
      this.preview = undefined;
      this.renderPreview();
      progress(
        "検証用の一時ファイルを破棄しました。記事・引用・学びは保持しています。",
      );
    });
  });
  private readonly summary = el(
    "p",
    "復元するファイルを選んで検証してください。",
    "muted",
  );
  private preview?: BackupPreview;
  private busy = false;
  private generation = 0;
  private controller?: AbortController;
  private downloadURL?: string;
  constructor(private readonly changed: () => Promise<void>) {
    this.root.setAttribute("aria-label", "記事ライブラリのバックアップ");
    this.status.setAttribute("role", "status");
    this.file.type = "file";
    this.file.accept = ".quilna.gz,application/gzip";
    this.file.id = "rss-backup-file";
    const label = el("label", "復元するQuilnaバックアップ");
    label.htmlFor = this.file.id;
    this.download.hidden = true;
    this.details.append(
      el("summary", "記事ライブラリのバックアップ・復元"),
      el(
        "p",
        "購読・記事の原文と訳文・本文の保存履歴・既読/保存・タグ・ハイライト/メモ・関連・自分の学びをファイルに保存します。ファイルは暗号化されず、記事と個人のメモを含みます。",
      ),
      el(
        "p",
        "認証情報、クラウド収集の設定、表示/音声設定、サンプル教材の履歴、未保存の下書きは含みません。各保存領域を順に取得するため、編集中は時点がずれる場合があります。",
        "muted",
      ),
      this.create,
      this.download,
      label,
      this.file,
      this.inspect,
      this.summary,
      el(
        "p",
        "復元はこのブラウザにないIDの記録だけを追加します。同じIDの既存の内容・既読・保存状態は変更せず、相違の件数を表示します。中止・容量不足で一部だけ追加された場合も、再試行で重複せず続けられます。検証済みファイルは再試行用にこのブラウザへ保持するため、復元先とは別に保存容量が必要です。復元後は一時ファイルを破棄できます。",
        "muted",
      ),
      this.restore,
      this.retry,
      this.discard,
      this.cancel,
      this.status,
    );
    this.root.append(this.details);
    this.details.addEventListener("toggle", () => {
      if (this.details.open) void this.refresh();
    });
    this.file.addEventListener("change", () => {
      this.generation++;
      this.preview = undefined;
      this.renderPreview();
      this.controls();
    });
    this.controls();
  }
  private controls() {
    this.create.disabled =
      this.file.disabled =
      this.inspect.disabled =
      this.retry.disabled =
      this.discard.disabled =
        this.busy;
    this.restore.disabled = this.busy || !this.preview;
    this.cancel.hidden = !this.busy;
  }
  private renderPreview() {
    this.summary.textContent = this.preview
      ? `検証済み：${this.preview.fileName}（${new Date(this.preview.header.createdAt).toLocaleString("ja-JP")}） ${countsText(this.preview.counts)}`
      : "復元するファイルを選んで検証してください。";
  }
  async refresh() {
    if (this.busy) return;
    const generation = ++this.generation;
    try {
      const preview = await pendingBackup();
      if (generation !== this.generation) return;
      this.preview = preview;
      this.renderPreview();
      this.controls();
    } catch (error) {
      if (generation !== this.generation) return;
      this.preview = undefined;
      this.renderPreview();
      this.controls();
      this.status.textContent = (error as Error).message;
    }
  }
  private async run(
    action: (
      signal: AbortSignal,
      progress: (message: string) => void,
    ) => Promise<void>,
  ) {
    if (this.busy) return;
    this.busy = true;
    this.generation++;
    const controller = (this.controller = new AbortController());
    this.controls();
    try {
      await action(controller.signal, (message) => {
        this.status.textContent = message;
      });
    } catch (error) {
      this.status.textContent = (error as Error).message;
    } finally {
      this.busy = false;
      this.controller = undefined;
      this.controls();
    }
  }
  private async createFile() {
    await this.run(async (signal, progress) => {
      this.download.hidden = true;
      if (this.downloadURL) URL.revokeObjectURL(this.downloadURL);
      progress("バックアップを読み出しています…");
      const result = await exportLibrary(progress, signal);
      this.downloadURL = URL.createObjectURL(result.blob);
      this.download.href = this.downloadURL;
      this.download.download = `quilna-library-${result.header.createdAt.replace(/[:.]/g, "-")}.quilna.gz`;
      this.download.textContent = "作成したバックアップをダウンロード";
      this.download.hidden = false;
      progress(
        `ファイルを作成しました。ダウンロードして端末に保存してください。${countsText(result.counts)}`,
      );
    });
  }
  private async inspectFile() {
    const file = this.file.files?.[0];
    if (!file) {
      this.status.textContent = "復元するファイルを選んでください。";
      return;
    }
    await this.run(async (signal, progress) => {
      this.preview = undefined;
      this.renderPreview();
      progress("ファイル全体を検証しています。記事はまだ変更していません…");
      this.preview = await validateBackup(file, progress, signal);
      this.renderPreview();
      progress(
        "検証が完了しました。件数と対象を確認して、復元ボタンを押してください。",
      );
    });
  }
  private async restoreFile() {
    const id = this.preview?.id;
    if (!id) return;
    await this.run(async (signal, progress) => {
      progress("不足している記録を復元しています…");
      try {
        const result = await restoreBackup(id, progress, signal);
        progress(
          `復元が完了しました。追加 ${result.added}件 / 同じ記録 ${result.identical}件 / 内容が異なる既存記録 ${result.conflicts}件。既存の記録は変更していません。`,
        );
      } finally {
        try {
          await this.changed();
        } catch {
          this.status.textContent +=
            " 記事一覧の再読み込みに失敗しました。設定を閉じて画面を再読み込みしてください。";
        }
      }
    });
  }
}
