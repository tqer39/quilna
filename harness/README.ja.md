# 開発ハーネス

[English](README.md) | [日本語](README.ja.md)

Goで動く、信頼済みローカル仕様に限定した開発ループの最小実装です。
製品の収集・教材生成・同期とは別のプロセス、状態、利用枠で管理します。
Go 1.27.1、Git、`/usr/bin/sqlite3`を使います。追加Go依存はありません。
初期対応はmacOS/Linuxです。Windowsには対応していません。

## 動作と合格条件

`implement`（任意）→`checks`→独立した`review`→必要なら`repair`→再検証の順に実行します。
修正は最大2巡です。全コマンドは直列で、同一workspaceの別runも排他します。
並行開発では担当ごとに独立worktreeを用意し、統合を別タスクにします。

次の条件がすべて揃った場合だけ`accepted`にします。

- 固定した仕様の内容、コードハッシュ、検証証拠が整合する。
- すべてのcheckが終了コード0で完了し、コードを変更していない。
- reviewerが同じコードハッシュについて、指摘なしの`approve`を返す。
- reviewerがコードを変更していない。

コマンドreviewの独立性は、呼出元が別担当・信頼済みreviewerを指定して確保します。
このCLIはreviewerの判断の正しさや、同じ人が両役を設定しないことを証明しません。
固定試験の合格も、教材の意味的品質を保証するものではありません。

## 起動

```bash
cd harness
GOCACHE=/private/tmp/adaptive-harness-gocache \
  go build -o /private/tmp/textbook-harness ./cmd/harness
/private/tmp/textbook-harness run -task /absolute/path/task.json -state /absolute/path/state
/private/tmp/textbook-harness status -state /absolute/path/state -run RUN_ID
/private/tmp/textbook-harness stop -state /absolute/path/state -run RUN_ID
/private/tmp/textbook-harness resume -state /absolute/path/state -run RUN_ID
```

`run`は生成したIDをstderrに表示し、結果をJSONでstdoutへ返します。
実行・再開は合格時だけ終了コード0です。status/stopは読取・要求の成功時に0です。
`status`の`codeHash`は証拠対象、`currentCodeHash`は現在のファイル、`stale`は相違です。
合格済みrunも、コードや証拠が変わった後のresumeは成功しません。

workspaceはcanonicalな絶対パスで、Gitのtoplevelと一致するcheckout rootを指定します。
同じworktree内のサブディレクトリを別workspaceとして登録することは拒否します。
stateはworkspaceの外、またはGitでignoreされ、追跡されていないディレクトリに置きます。
SQLite台帳、ログ、ロックを秘密情報として扱い、stateは0700、ファイルは0600で作成します。
workspace排他は`/tmp/adaptive-harness-locks-UID`で全stateディレクトリに共通です。
Git管理領域へファイルを書きません。

## 仕様の例

以下は契約例です。実行ファイルは利用者が用意し、絶対パスに置き換えます。
コマンド配列の文字列に秘密を入れないでください。仕様は台帳へ保存します。

```json
{
  "version": 1,
  "name": "reader-offline-search",
  "workspace": "/absolute/path/isolated-worktree",
  "goal": "保存済み記事をオフラインで検索できる",
  "acceptance": ["通信なしで一致記事を表示する", "既存の閲覧動作が通る"],
  "implement": {
    "command": ["/absolute/path/implementation-agent"],
    "timeoutSeconds": 120
  },
  "checks": [
    {
      "command": ["/absolute/path/trusted-test-runner"],
      "timeoutSeconds": 120
    }
  ],
  "review": {
    "kind": "command",
    "command": ["/absolute/path/independent-reviewer"],
    "timeoutSeconds": 120
  },
  "repair": {
    "command": ["/absolute/path/repair-agent"],
    "timeoutSeconds": 120
  },
  "maxRepairCycles": 2,
  "timeoutSeconds": 900,
  "logLimitBytes": 65536,
  "maxOperations": 16
}
```

`implement`と`repair`は任意です。修正巡数が1以上なら`repair`が必要です。
未知フィールド、重複JSONキー、上限外の数値、末尾の別JSONは拒否します。
実行時の仕様は正規化JSONのSHA-256で固定し、元ファイルと毎回照合します。
版付きコードハッシュはGitのtrackedとnonignored untrackedのパスとモードを対象とします。通常ファイルの本体には固定長SHA-256ダイジェストを使い、任意のバイナリ内容がファイルレコード境界と混同されないようにします。
削除・symlink先の変更も含みます。ignoredなビルド成果物や秘密は対象外です。
旧エンコーディングで作成したcheckpointは安全にstaleとなり、再検証が必要です。ledgerの移行やresetは行いません。
この識別は、プロセス中に一時変更して元に戻す行為を検知する監視ではありません。

各コマンドのstdinには、`goal`、`acceptance`、`codeHash`、`taskHash`、
`findings`、`evidence`、`history`のJSONを渡します。reviewerのstdoutは次の形式のみです。

```json
{"decision":"approve","codeHash":"64文字の小文字SHA-256","findings":[]}
```

`revise`または`reject`には1件以上の指摘が必要です。
未知の判定、不正JSON、hash不一致、指摘付きapproveは合格にしません。
repairの入力には指摘と検証証拠の参照を含めます。
Codexのrepairには、最新の失敗したchecksからstdout／stderrを各8KiBまで直接渡します。
長い結果一覧で失敗行が末尾から消えないよう、同じログのerror／assertion行も合計4KiBまで渡します。
元ログのhashを照合し、診断は非信頼の出力として渡します。
最新のchecksが成功した場合、過去のコンパイルエラーを再送しません。
Codexのreviewには、範囲内で直せる指摘は`revise`、安全に達成できない目標は`reject`と判定するよう伝えます。
`reject`をハーネスが修正要求へ読み替える処理はありません。
固定した担当指示で明示的に許可した場合は、実装・修正担当もローカルの予備検査を行えます。
予備検査は合格証拠に含めず、ハーネス側の固定checksを別に実行します。
macOSの開発ツールがsandbox外への一時書込を要求すると、担当内の予備検査は実行できません。

## 検証用ファイルの固定と証拠の要約

実装・修正を担当へ渡す前に、信頼する検証スクリプトと回帰テストを固定します。

```bash
/private/tmp/textbook-harness freeze-task \
  -task /absolute/path/task.json \
  -file /absolute/path/fixed-regression.swift \
  -file /absolute/path/trusted-test-runner \
  -output /absolute/path/task.frozen.json
/private/tmp/textbook-harness run -task /absolute/path/task.frozen.json -state /absolute/path/state
/private/tmp/textbook-harness summary -state /absolute/path/state -run RUN_ID
```

`freeze-task`は指定された目標・checks・review設定・上限を保ち、canonicalな絶対パス、内容のSHA-256、ファイルモードを持つ
`protectedFiles`を追加します。元ファイルを上書きせず、新しい非公開ファイルを作成し、変更済みの固定ファイルを暗黙に再固定しません。
出力先の親ディレクトリは先に作成してください。固定ファイルは編集対象workspaceの外にも置けます。
明示したファイルだけが対象です。この省略可能なフィールドを持たない既存タスクの動作は変わりません。
通常ファイルを最大256個、各256MiBまで扱います。欠落・symlink・内容やモードの変更・FIFOなどの通常ファイル以外を拒否し、FIFOの書込側を待ちません。
エンジンは各操作の前後、復旧時、既存証拠の確認時に照合します。
これはcheckpointでの変更検出であり、OSによる書込禁止や、checkpoint間に元へ戻された一時変更の検出ではありません。

`summary`は記録されたソースハッシュに対する最新checks、終了コード、所要時間、ハッシュ付きログ参照と、
過去の失敗数・修復回数・同一チェックの繰り返し・証拠に記録されたモデル利用量を返します。
未完了の処理は`phase`と`pendingOperation`で別に示し、まだ証拠になっていない利用量を履歴カウンターで推測しません。
終了コード0は要約の読取成功を意味し、現在の合格を意味しません。`status`と`stale`を併せて確認してください。
チェック番号がない旧証拠の繰り返し回数は、推測せず不明（`null`）として返します。
利用量はthread／turnの組ごとに記録された累積totalが最大のカウンターを採用し、復旧で同じturnを二重計上しません。
カウンターを持つturn数と、turnの識別情報が不明な操作数を明示します。欠けた利用量は不明のままです。
これは記録された累積リクエストカウンターであり、1回のコンテキスト長・金額・新たなモデル品質測定ではありません。

モデルとコマンドへの入力には、現在のソースに対する最新checksと短い`history`要約を渡します。
過去の証拠全体は台帳とログに残し、失敗数や修復回数を隠しません。
詳細ログは必要なときに読み、再利用前に記録されたSHA-256を照合してください。
保守された製品向けタスク生成、実行成果物のmanifest、代表タスクでの実モデル比較は後続作業です。
ネイティブUIや実機が使えない場合は外部の前提条件として明示し、ソース修正を繰り返す理由にしません。

## 停止・再開と証拠

操作の開始をSQLiteへ記録してから子プロセスを起動します。
ログ、終了コード、開始時刻、経過時間、操作前後のコードハッシュを残します。
ログファイルのSHA-256も台帳へ保存し、再開前に改変を検査します。
SQLiteはFULL同期、明示トランザクション、排他ロックを使います。
同じrunと同じworkspaceを二重起動しません。プロセス終了でOSロックは解放されます。

stopまたはシグナルで同一プロセス群へSIGKILLを送り、孫プロセスと継承パイプも処理します。
待機の上限、操作数、合計実行時間、操作ごとの出力byte上限を設けています。
台帳障害、ログ上限、タイムアウト、修正上限、コードの予期しない変更では停止します。
セッションを分離した子など、プロセス群から離脱する任意コードの封じ込めは行いません。

- clean stop済みのverificationは、コードが同一なら再実行できます。
- クラッシュで旧プロセスの終了が不明なら、自動再実行しません。
  利用者が旧プロセスの終了を確認した後、`resume -reconcile-local`を指定します。
- ローカル編集が中断した場合、再送しません。利用者が差分を確認した後だけ、
  `resume -reconcile-local`で編集を再実行せずchecksへ進めます。
- モデルへの送信が不明な場合、新しいturnを自動送信しません。
  保存済みthread/turn IDがあれば、再開時に完了済み結果の読取照合だけを行います。
  ID不足、未完了、失敗、不一致は保留します。

停止は外部サービス側の処理や消費枠を取り消せた保証ではありません。
クラッシュ中の経過時間を完全に計測するものではありませんが、開始済み操作数は消費済みです。

## Codex app-server adapter

デフォルトでは無効です。`implement`・`review`・`repair`を次の形式にし、
CLIにも`-allow-codex`を指定する必要があります。各担当は別threadで実行します。

```json
{
  "kind": "codex",
  "codex": {
    "enabled": true,
    "binary": "/absolute/path/native-codex-binary",
    "home": "/absolute/path/configured-codex-home",
    "model": "利用者が選んだモデルID"
  },
  "timeoutSeconds": 120
}
```

binaryはnativeなCodex実行ファイルを指定します。NodeをPATHに要求するnpm wrapperは非対応です。
モデルactionには任意の`instructions`を指定できます。最終出力は`{"summary":"変更内容"}`の構造化JSONです。
検証コマンドはモデルに担当させず、固定したローカル`checks`を実行します。
homeは利用者が指定するCODEX_HOMEです。既存のChatGPTログインを公式CLI経由で利用できます。
ハーネス自身が認証ファイルを読み取ったり、資格情報をログへ保存したりする処理はありません。
ハーネスはログイン、契約、APIキーの探索、入金を行いません。
`account/read`がChatGPT認証を返さない場合は停止し、APIキー認証へfallbackしません。
この版の実接続は個人Proの`pro`／`prolite`を対象とし、その他の契約は安全側に停止します。
ChatGPT認証の存在だけで、指定モデルの利用権限や残量があるとは判定しません。

実adapterはstdioのinitialize→initialized→account/read→契約枠確認→thread/start→turn/startを実装します。
新しいreviewはread-only、実装・修正はworkspace-writeとし、子ツールのnetworkAccess=falseを要求します。
モデルサービスへの接続自体にはネットワークを使います。
構造化JSON schemaを指定し、completedのturnと対応する最終出力だけを採用します。
保存する出力の`logLimitBytes`と、一時的な通信量の上限を分けています。
protocolは1メッセージ4MiB・累積64MiB・待機queue 4MiB／1,000件を上限とし、生の通信内容は保存しません。
診断出力の上限、不正JSON、通信上限の停止理由を通常の中断と区別します。
承認・追加ツール・ユーザー入力のserver requestはすべて拒否して停止します。
resumeはthread/readで既存turnを照合し、turn/startを送りません。
モデル編集の回復には利用者による差分確認と`-reconcile-local`も必要です。

各turn前にChatGPT認証と契約内枠を確認し、追加クレジットを持つ経路や不明な残量では停止します。
確認できた利用枠・モデル・provider・速度tier・thread／turn・token使用量を証拠へ保存します。
失敗状態と公式エラー種別・HTTP statusを保存し、生のエラーメッセージは保存しません。
速度tierはStandardに固定し、購入・入金・枠リセット・APIキーへの切替は行いません。
利用枠はmaxOperations・修正回数・時間でも抑えます。
残量の読取は枠の予約ではなく、他のチャットによる並行消費や1turnの消費上限までは保証しません。
token・円建ての厳密な予算上限は未実装で、アプリの月500円台帳とは別です。
Claude adapter、API課金経路、自動push、デプロイ、署名は未実装です。

実モデルを使う再現手順と検証範囲は[Codex実接続の検証](../docs/codex-live-validation.ja.md)を参照してください。

## 権限・秘密の境界

このCLIはOS sandboxの代替ではありません。worktreeもセキュリティ隔離ではありません。
信頼済みローカル仕様だけを使い、ネット取得文やモデルの出力をcommandへ変換しません。
コマンドにはAPIキー、proxy、シェル初期化設定、親のHOMEを継承しません。
専用の一時HOMEと固定PATHを使います。必要なtoolchainは信頼済みrunner内で明示します。
既知のtoken形式をログで伏せますが、任意の秘密の検出・消去を保証するものではありません。
秘密を読み得るコマンドを設定しないでください。

Codex本体は認証を持つ信頼側です。
CLI 0.148.0のread-onlyは機密ファイルの読取隔離を保証しません。
本番の開発では秘密を置かない専用ユーザー／隔離環境と、専用Codex設定を推奨します。
実接続smokeは秘密を持たない一時Git作業場で行い、認証は信頼側のCLIだけが扱います。
Xcode runnerはmacOS側で別に用意し、署名・公開資格情報を検証用エージェントへ渡さない構成にします。

## 検証と制約

```bash
cd harness
GOCACHE=/private/tmp/adaptive-harness-gocache GOTMPDIR=/private/tmp \
  go test -race ./...
GOCACHE=/private/tmp/adaptive-harness-gocache GOTMPDIR=/private/tmp \
  go vet ./...
```

offline check/review/repairと、fake app-serverプロセスを使った実adapter経路を回帰試験します。
停止・再開、二重起動、コード／仕様／ログ改変、孫プロセス、パイプ、出力上限、
不正review、修正上限、モデル結果不明、回復時のhash・時間上限を対象にします。
2026-10-22、Pro認証の`gpt-5.6-terra`で実装・独立レビュー・修正を実行しました。
5つの別thread、修正1巡、固定Unicode境界試験の不合格→合格を確認しました。
結果と失敗時の制約は[実接続の検証記録](../docs/codex-live-validation.ja.md)へ記録しています。
一般的なreview精度、長時間無人運転、利用枠の予約は未検証・未対応です。

公式仕様とローカルCodex CLI 0.148.0の生成schemaを照合しました。

- [Go os/exec](https://pkg.go.dev/os/exec)
- [Go Process.Killの対象](https://pkg.go.dev/os#Process.Kill)
- [Codex app-server](https://developers.openai.com/codex/app-server)
