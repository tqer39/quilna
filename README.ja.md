# Quilna（クイルナ）

[English](README.md) | [日本語](README.ja.md)

Quilna（クイルナ）は、人間が情報を選び、考え、自分の教科書を編むためのサービスです。
リポジトリ名は `quilna`、正式ドメインは [quilna.page](https://quilna.page) です。
今回の改名ではドメイン取得・DNS接続・本番公開は行っていません。現在のアプリと教材本文は日本語です。
調査範囲と採用判断は[命名とドメインの記録](docs/branding.ja.md)、ドメイン取得・DNS接続・Dev再デプロイは[Issue #53](https://github.com/tqer39/quilna/issues/53)を参照してください。

合意した全機能をブラウザ版で完成させ、プロジェクトオーナーの明示的な使いやすさの受け入れ後に、iOS・macOSを1プラットフォームずつ進めます。
ネイティブ版の機能開発は保留しています。[開発順序と受け入れ条件](docs/product-development.ja.md)を参照してください。

SwiftUIのmacOS／iOS最小アプリを`apple/`、Go製の開発ハーネスを`harness/`に追加しています。
ネイティブ版はRSS／Atomの収集・ブックマーク・Appleの端末内翻訳と、固定の日本語教材・理解問題・回答履歴を扱います。
記事・日本語訳・ブックマーク・回答履歴をSQLiteへ保存します。実LLMによる教材生成と端末間同期は未接続です。
[ネイティブ版とハーネスの手順・検証範囲](docs/native-harness.ja.md)と
[ツール／SaaSの選定](docs/harness-tools.ja.md)を参照してください。
開発用Codexは既存Pro認証で実装・レビュー・修正を実検証済みです。
[実接続の結果と再現手順](docs/codex-live-validation.ja.md)を参照してください。製品の教材生成とは別の接続です。
ブラウザ版はサイト・記事のURLから配信元を探し、RSS/Atomの登録・更新、記事閲覧、ローカル保存へ進みます。
[起動・保存範囲・各インターフェースのバックエンド構成](docs/browser-rss.ja.md)を参照してください。
以下の教材機能は「設定 → デモ教材 → デモ教材を開く」から開けます。

旧名称の本人限定Devは公開済みで、Google認証は設定準備中です。
[既存の公開記録](docs/dev-publication.ja.md)を参照してください。
本番domainの購入・公開とLLM実送信はこの作業に含めません。
[公開前の最小準備](docs/workers-byok.ja.md)を参照してください。

忙しい SRE が読む・図を操作する・予測して答える・説明練習をする教科書の試作。
固定 CAA 教材 1 セクションのみ。v1.8.0 は短い全 13 ブロック、目安 25–35 分です（図の予想・ふりかえりは任意で追加）。
生成機能・実Google接続・クラウド同期は未実装です。
「自分のAPIキー設定」でOpenAI / AnthropicのBYOK管理を模擬操作できます。実キー入力は無効です。
模擬設定はメモリ内のみ・実API未接続。[保存設計と実接続前の準備](docs/byok.ja.md)を参照してください。
Workers用の暗号化保存・利用者API・個人別予算・Googleログイン/session/logoutコードもローカル実装済みです。
認証はBetter Auth 1.7.7＋専用D1へ置換済みです。[設定と検証範囲](docs/better-auth.ja.md)。
Google設定欄は実APIへ接続済みですが、未設定時は停止し、実キー入力・送信は引き続き無効です。
`npm run workers:local`で通信offのWorkers配信を試せます。[詳細と未接続部分](docs/workers-byok.ja.md)。

## ローカル起動

`mise.toml`に設定した修正版のNode.js 26.12.1とnpmを使用します。
`package.json`では保守中の22/24系についてもセキュリティ上の最低版を指定しています。CIは26.12.1で実行します。
macOS / Windows / Linux で共通の手順です。

```bash
mise install node
mise exec -- npm ci
mise exec -- npm run dev
```

ブラウザで <http://127.0.0.1:5173> を開きます。
RSS更新時は、ローカルの取得処理から登録先の公開HTTPS配信元へ接続します。
RSSの記事と購読はこのブラウザのIndexedDBへ保存し、端末間では同期しません。
AI API・実アカウントへの接続や、新たなクラウド公開は行いません。
以下のキー操作と回答履歴は設定内の「デモ教材」の動作です。
Nで次、Pで前のブロックへ移動できます。大文字も可。入力欄・用語dialogでは発火しません。
「N：次へ / P：前へ」のチェックで単文字shortcutを無効化できます。設定保存失敗時は同タブのみ有効です。
履歴はこのブラウザの localStorage に保存します。
別ポート・別ブラウザの履歴とは共有されず、ブラウザデータを削除すると消えます。

## Mac Studio で会話終了後も起動を維持

リポジトリのディレクトリで、既存の tmux を使用します。
すでに起動中の場合は同じセッションを二重に作成しません。

```bash
tmux new-session -d -s adaptive-textbook-caa 'npm run dev -- --strictPort'
tmux capture-pane -p -t adaptive-textbook-caa
```

サーバーは detached tmux 内で動き、会話用 terminal session から独立します。
Mac の再起動・tmux 終了・サーバーの停止までは閲覧できます。
システム自動起動は設定していません。競合時は別ポートへ移らず起動を止めます。

`http://127.0.0.1:5173/` はサーバーを動かしている Mac Studio でのみ開けます。
別の Mac・iPhone の localhost はその端末自身です。
このlocalhostサーバーは外部ネットワークへ公開しません。別途公開したDevはログイン設定準備中です。

停止する場合はこのセッションだけを指定します。

```bash
tmux kill-session -t adaptive-textbook-caa
```

## 検証

ブラウザ版の実装言語は引き続きTypeScriptです。`mise run typecheck:tsrs`で任意のRust製コンパイラー検査を実行できます。[試行結果と互換性の制約](docs/typescript-tools.ja.md)を参照してください。

[継続保守の手順](docs/security-maintenance.ja.md)で、Renovate、全依存の監査、実行環境・証明書の更新、日次検査を説明しています。
プロジェクトの`.npmrc`でインストールスクリプトを抑止します。明示したnpmコマンドは実行されます。

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`mise run lint` も同じ lint を実行し、文書の言語ペアとローカルのMarkdownリンクも検査します。
初回の依存・Chromium ダウンロードのみネットワークが必要です。
スクリーンショットは `test-results/` に保存します。
Mac Studio 上の Chromium で desktop / mobile viewport を検証します。
Windows / Linux や物理スマホでの動作はまだ検証していません。

## 実装の分離

- `src/schema.ts` / `src/book.ts`: Zod 検証済み教材と安定した block ID
- `src/ui.ts`: 共通 UI と制限 Markdown（段落・太字・インラインコード）
- `src/renderer.ts`: 型に応じた読書・問題レンダラー
- `src/process-diagrams.ts`: 発行前のシーケンスとステップで追う探索フロー
- `src/caa.ts` / `src/diagram.ts` / `src/scope-diagram.ts`: 共通の意味論と SVG 図解
- `src/resume-review.ts`: 任意の1問復習と、想起・自己申告の分離
- `src/improvements.ts` / `src/question-workbench.ts`: 質問・根拠・手動差分・本人反映とローカル版管理
- `src/history.ts`: 回答履歴と再開位置を別フィールドに保存
- `src/main.ts`: 目次・時間配分・ナビゲーション
- `src/navigation-shortcuts.ts`: 無効化可能なN/P移動と入力・modal・IMEの除外
- `src/terms.ts`: 文脈別の静的用語説明
- `src/feedback.ts`: 正誤・保存成否・注意を区別する共通状態表示
- `src/diagram-exercise.ts` / `src/diagram-learning.ts`: 図の予想・設定 snapshot・比較・ふりかえり
- `src/question-support.ts`: 選択別の誤概念と理由確認
- `src/reader-dialog.ts`: 読書位置を保つ説明画面・Back/Forward
- `src/learning-plan.ts`: ブロック単位の編集上の時間目安と終点
- `src/mobile-dns-tree.ts`: 文字を縮小しないスマホの DNS 木

HTML はテキストとして扱います。任意 JS、MDX、生成コードを実行しません。
教材 ID/version とローカル匿名利用者 ID、block ID、attempt ID、時刻を記録します。
保存失敗時はタブ内の回答を保持し、再試行を表示します。
破損した保存データを自動で上書きしません。

[設計・課題・検証記録](docs/prototype.ja.md)を参照してください。

[質問と用語から教材を成長させる設計](docs/growing-textbook.ja.md)も記録しています。
静的な用語説明は利用できます。将来の会話・質問からの教材生成機能は未実装です。

## インストール済み Chrome での検証

```bash
npx playwright test --config=playwright.chrome.config.ts
```

通常 Chromium と Chrome は各 2 worker、独立した BrowserContext で実行します。
画像はテスト・project・repeat/retry ごとの出力先に分離し、両 runner の出力 directory も別です。
失敗時は trace を保存します。原因未特定の初回タイムアウトは
[調査記録](docs/browser-timeout-investigation.ja.md) を参照してください。

[生成APIの接続判断と500円上限](docs/generation-connection.ja.md)。
質問と手動差分の保存・反映はローカルで利用可能、AI生成は未接続です。

## 通信offサーバー（任意）

```bash
npm run server:off
```

127.0.0.1:5274のみで起動し、正しいHost/Origin/CSRFを持つ要求にも生成未接続を返します。
読書UIはこのサーバーへ接続せず、providerの送信・課金・キー設定は行いません。
`server/`に用途別model registry、薄いadapter境界、全provider共通の永続予算予約を分離しています。
OpenAI / Anthropicの計数・生成HTTPコードは準備済みですが、ネットワークモックのみで検証し通常起動では登録しません。
API送信・鍵設定・課金は未実施です。候補と有効化前の残りは[接続判断](docs/generation-connection.ja.md)に記録しています。
`.local-state/`はGit除外です。月500円の実費達成は未確認で、費用条件が未設定なら停止します。
backendはNodeの標準moduleとZodのみ、stubはテスト内のみです。
`npm test`は教材のVitestとbackendのNode testを実行し、HTTP試験はlocalhostの一時portを使用します。

## ドキュメント

英語版は`.md`、日本語訳は`.ja.md`です。各ページから対応する言語版へ切り替えられます。
貢献時の指示は[AGENTS.md](AGENTS.md)、無関係な文書の再翻訳を避ける更新方法は
[ドキュメントのルール](docs/rules/documentation.ja.md)を参照してください。
