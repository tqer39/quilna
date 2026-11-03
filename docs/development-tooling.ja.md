# 開発ツール

[English](development-tooling.md) | [日本語](development-tooling.ja.md)

## 共通開発ルール

このリポジトリは [dev-standards](https://github.com/tqer39/dev-standards) の主コンポーネントに `node-npm` を採用し、Go/Swift パッケージを companion として明示的に宣言します。
各検査の範囲は[言語選定記録](decisions/0001-language.ja.md)を参照してください。
混在パッケージの対応と検証タスクの重複拒否は、[本体 PR #13](https://github.com/tqer39/dev-standards/pull/13) で `main` にマージされました。
採用する `0.4.2` のソースは `.standards/cli-source.json` でマージコミットに固定します。そのコミットをビルドし、リリースタグや PR ブランチには依存しません。

新しい checkout では、ソースを別途 clone し、固定した Go ツールチェーンで CLI をビルドします。

```bash
git clone --branch main https://github.com/tqer39/dev-standards.git ../dev-standards
cd ../dev-standards
git checkout --detach da61121476f3e6758a3e729e010d30d190408bc3
mise trust
mise run build
cd ../quilna
../dev-standards/bin/dev-standards sync
mise trust
mise run bootstrap
mise run standards:prepare
```

`../quilna` と異なる場合は、実際の checkout ディレクトリに置き換えてください。
sync 前に `.standards/lock.json` とソース CLI の `version` 出力を照合してください。異なるバンドルを暗黙に更新する手順ではありません。
CLI キャッシュは非公開のローカルデータとして Git から除外します。Node.js と Go の版は mise に固定し、macOS に Swift/Xcode を用意します。
Swift companion があるため、共通検証は現在 macOS で実行します。
既存のブラウザ/Go の Linux ジョブと Apple CI は変更しません。

```bash
mise run standards:version
mise run standards:verify
mise run standards:finish
```

`standards:verify` はブラウザの lint・整形検査・単体/サーバーテスト・ビルド、続けて Go の整形/vet/race テストと Swift パッケージのテスト/macOS ビルドを実行します。
ブラウザ E2E、Workers テスト、iOS ビルド、ネイティブ UI の受け入れ、性能ベンチマークは実行しません。
これらの検査は既存タスクと CI に保持します。ブラウザの整形対象は `src/`、`server/`、`workers/` で、Markdown は既存の文書検査・Markdown lint を継続します。
Codex hooks は設定と検証の確認を要求します。新しい checkout では CLI キャッシュと、アプリ標準のプロジェクト/hook の信頼設定が必要です。

用途に応じて `.standards/mise.project.toml`、`.standards/tasks.project.toml`、`.standards/agents.local.md`、`.standards/*.local` を編集します。
ルートの `mise.toml`、`AGENTS.md`、`.gitignore` などの生成物は直接編集しません。
正本の変更後は次を実行します。

```bash
./.standards/cache/dev-standards plan --output .standards/plans/update.json
# 計画を確認します。終了コード 1 は変更の提案を意味します。
./.standards/cache/dev-standards apply --plan .standards/plans/update.json
mise run standards:prepare
```

初回の companion 宣言は `.standards/companions.json` に保持し、以後の計画では `.standards/repository.yml` の宣言を読みます。
ローカル保守ホストへの登録は別途行います。clone だけでは定期実行を有効にせず、マージ済みソースの採用は自動更新の成功を意味しません。

## ローカルのエージェント計測

[agent-telemetry](https://github.com/tqer39/agent-telemetry) はアプリ本体とは独立して、Claude/Codex の開発セッションを観測します。
ホストごとに一度、同ツールの README に従ってローカルの Docker 基盤と Desktop/CLI のクライアント設定を準備します。
すでに基盤とクライアント設定があれば、この checkout に exporter の追加や会話記録のコピーは不要です。
現在のリポジトリ remote により、Codex worktree を含め、セッションは `project="quilna"` として識別されます。

```bash
mise run telemetry:check
```

このコマンドはローカルの Collector の健康状態と、Prometheus に登録された Quilna のセッション数を読み取ります。
サービスに接続できない場合や、該当セッションが未登録の場合は失敗します。任意のローカル診断であり、CI の依存にはしません。
Desktop の全 OTLP シグナルの到着や、現在のチャットがすでに集計されたことを証明する検査ではありません。
[ローカル Grafana](http://127.0.0.1:3000) で **Agent Telemetry → Agent Sessions** を開き、`quilna` を選択します。
ポートは localhost にバインドし、クライアントのプロンプト記録は無効のまま運用します。
indexer はローカルの会話記録を読んで集計値を公開します。会話本文・ツール結果・コマンドをこのリポジトリへコピーしたり、Loki へ送ったりしないでください。
Desktop の telemetry 設定を初めて変更した後は、対象アプリを完全終了して再起動してください。
