# 変更範囲に応じたCI検証

[English](ci-selection.md) | [日本語](ci-selection.ja.md)

Issue #45は、ブラウザ・文書変更で無関係なプラットフォームのビルドを繰り返す問題を追跡します。
`Prototype checks`は全PRとmainへのpushで起動し、workflow全体のpathフィルターは使いません。`workflow_dispatch`では明示的に全プラットフォームを検証します。
2026-10-24の読取確認で、`main`ルールセットの必須status contextは`workflow-result`でした。従来のbranch-protectionエンドポイントはコネクターからアクセスできませんでした。
このcontextを維持し、リポジトリの保護設定は変更しません。

## 選択と必須判定

`scripts/ci-selection.mjs`は、PRではイベントのbase SHAとのmerge baseからheadまで、mainのpushではbefore/afterのコミットを比較します。
checkoutで全履歴を取得します。Gitの失敗やコミット識別子の欠落では選択ジョブを失敗させ、文書だけの成功として扱いません。
新規ブランチ・手動実行・未知のイベントでは全プラットフォームを選択します。Git出力はNUL区切りで扱い、rename検出を無効化して削除元と追加先の両方を選択に含めます。

| 変更ファイル | 選択する製品検査 |
| --- | --- |
| `docs/`内のMarkdown、ルートREADME、Apple/harnessのREADME英日ペア | 製品検査なし。既定のセキュリティ・lint・選択回帰は実行 |
| `src/`、`server/`、`workers/`、`public/`、`tests/`、Webのビルド・テスト設定 | 型検査、単体/server、ビルド、Worker・ブラウザ検査、200ms検索ゲート |
| READMEペアを除く`apple/` | Swiftテスト・ビルド、iOS simulatorビルド |
| READMEペアとGo依存を除く`harness/` | Linux/macOSのGoハーネス検査 |
| 依存、実行環境の固定値、script、workflow、skill、AGENTS、選択テスト、未分類のパス | 全プラットフォーム |

複数範囲の変更では選択結果を合わせます。Go module/lock変更でも全プラットフォームを選びます。
常時実行する`checks`ジョブでは、依存導入前の方針検査、フック無効のlock付き導入、npm監査・署名検証、リポジトリのlint・文書検査、選択回帰を維持します。
条件付きにするのは製品検査のstepだけです。日次監査・PR依存レビュー・Go脆弱性検査を含む`security.yml`は変更しません。

必須の`workflow-result`ジョブは`always()`で、選択・既定の検査・両プラットフォームジョブに依存します。
明示的に選択しなかったプラットフォームだけ`skipped`を受理します。必要なジョブの失敗・中断・欠落・予期しないskipでは必須判定も失敗します。
選択出力の欠落も失敗にし、無関係なビルドの意図的な省略と、必要な検証の欠落を区別します。
読取専用権限、変更不能なAction参照、checkout認証情報の非保持を維持します。
Web変更を選択した場合はブラウザ検証前に対象SHAを記録し、機能テストとタグなし・大量タグ付きの検索ゲートを実行して、合成データの結果を14日間保存します。SHA記録に成功し、中断されていない場合は検証失敗後もアップロードします。文書だけの実行ではブラウザ成果物を省略し、検証開始後に証跡がなければアップロードエラーとします。個人DBや無関係なローカル状態は対象外です。

## 検証と制約

```bash
mise exec -- node --test tests/server/ci-selection.test.mjs
mise run lint
mise exec -- npm test
```

回帰テストは、代表的な選択・混在変更・実際の一時Gitリポジトリでのrename/削除/改行入りパス・base側だけの変更・不正revision・必須判定の失敗/中断/skipを扱います。
選択回帰は文書だけのCIでも実行し、製品ビルドを必要としません。workflowの契約回帰で機能・検索検査と失敗時の証跡アップロードを必須にしています。統合前の設定では検索stepがなく、この回帰が失敗します。
選択scriptやworkflow自体の変更では製品検査をすべて実行します。全体検証のPRが成功しても、その後の文書だけの実行のジョブ数・所要時間を証明しません。
マージ後、実際の文書だけの実行とブラウザだけの実行を旧workflowと比較してから、実測の時間短縮を主張します。
PR #64は検証済みPR #63のブランチ（`codex/browser-reading-workflow`）に依存する形とし、製品側の検索ゲートと証跡保存を維持したCI差分にします。アプリのソースはPR #63と同じです。この準備ではどちらのPRもmainへマージしません。#63の統合後は#64のbaseをmainへ変更し、正確な差分と必須判定を再確認してから統合します。

- [GitHubの必須チェックの説明](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
- [GitHubのworkflow構文](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [セキュリティ保守](security-maintenance.ja.md)
