# 実生成の接続判断（未接続）

[English](generation-connection.md) | [日本語](generation-connection.ja.md)

今回動くのは質問保存・本人の手動追加案・差分確認・ローカル教材版の反映です。
AI 生成は未接続です。通常UIに生成成功のfixtureや自動生成風の候補はありません。
外部送信・API 呼び出し・課金・キー取得・OAuth登録・デプロイは実行していません。
既存のCodexログインや見えるAPI設定は、教材サービスの送信・課金許可と扱いません。
秘密ファイル・キー値・トークンを探索していません。利用可能なAPIアカウントは未確認です。
キーはサービス利用者自身が設定するBYOK仕様です。運営共通LLMキーを前提にしません。
[BYOKの模擬画面と保存設計](byok.ja.md)を実装・記録しました。実キー入力は無効です。

## 現在の教材方針 — 2026-11-17

所有者は次の接続にOpenAIを選び、新しいAPIキーの安全な作成を希望しました。設定は未完了です。
目指す製品は[再利用するテーマ別教材](topic-textbooks.ja.md)で、記事からテーマへの入口と、複数の記事から使える普遍的な版を持ちます。
新しい記事ごとに記事専用の教材を生成するという前提は、この方針で置き換えます。実呼び出しの有効化や、既存のBYOK・月額予算の境界の変更ではありません。
送る資料そのもの・モデル・実送信の費用枠は未合意です。キーの作成は送信・課金の許可と分けます。
安全なキー設定では、ローカルの秘密保存先を別途確認します。保存先の確認とキーの書き込みはまだ行っていません。キーをチャット・ソース管理・ブラウザー保存領域・URL・ログへ置きません。
この開発用の設定で、サービス利用者の実キー入力を有効にしたり、未接続の利用者別暗号化保存を省略したりしません。
以下の過去の接続案と通信停止中の実装は、従来の固定CAA教材を対象にした範囲を保持するもので、新しい導線の実装完了ではありません。

### 準備したテーマ教材の生成・レビュー境界

ローカルのブラウザー生成ブランチで、version 2のテーマ要求向けに`server/topic-textbook-format.mjs`と`server/openai-topic-textbook-transport.mjs`を準備しています。出典・引用・前提節・問題の検査はファイルのparserと共通化します。wire上の候補は選択肢の根拠を配列にし、選択肢IDの重複を拒否して一度だけ正規化し、候補のdigestを計算します。レビューのwire出力は各節の検査だけとし、モデルにdigestを書き写させず、サーバーが保持した要求・候補の正確なdigestを付けます。否定されたレビューは否定のまま保持し、合格教材として取り込めません。UTF-8 BOMを含む埋め込みJSONは、古い取り込み済みファイルを含め、元のbyte列そのもののdigestを保持します。構造の検査は事実の正しさを証明しません。

transportにはモデル・推論量・資格情報（文字列またはホスト内だけの非同期解決関数）・HTTP送信処理を明示的に渡す必要があります。生成とレビューの各段階でprompt全体と出力schemaを固定したOpenAIの入力token数APIへ渡して数え、その後に厳密なJSON出力・`store: false`・toolなし・streamingなしで最大1回のResponses要求を行います。自動再送やredirectはしません。モデル・tier・使用量が一致しない応答は未確認のままです。上限内の完全な応答で使用量を検証できた場合は、不正・拒否・途中終了・中断でもその使用量を保持し、中断した出力を候補として返しません。上限を超えた応答、不正な応答、その他の未確認な応答からは使用量を確定できず、照合が済むまで予算予約を保持する必要があります。資源上限は入力32,000 token・出力16,000 token・応答192,000 byteで、既存のCAA用transportの小さい上限は保持します。公式の[入力token数API](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)と[Structured Outputsガイド](https://developers.openai.com/api/docs/guides/structured-outputs)を参照してください。

生成とレビューは会話状態を共有しない別の要求であり、モデルが異なることや意味の正しさは保証しません。実送信を有効にする前に、registry・予算の接続で正確なモデル識別子と適用単価を承認する必要があります。別名が異なる応答モデルへ解決された場合は未確認のままにします。test-onlyの表示は呼び出し元が合成応答を注入する構成を表し、ネットワークを遮断する仕組みではありません。

注入するテーマ用contractをNodeの予算サービスと`FileLedger`へつなぎ、CAA追記と共用するようにしました。明示的に注入した`AccountVaultCore.proposeTopic`でも、所有者に束縛したWorkers台帳adapter・暗号化資格情報のlease・CAAと同じ予算を使います。予約前に実際のadapterを検査し、秘密は永続予約後に解決し、別アカウントの台帳が発行した候補を拒否し、資格情報のrevisionが変わった進行中の応答を返しません。計数・生成前に報告された資格情報の失敗は未送信と確認できるため、不明の保留にせず使用量0で記録します。資格情報を解決できない失敗は`credential-unavailable`とし、失効・中止と区別します。資格情報のleaseが秘密をまだ渡していない間は、サービスの期限超過でもcoreが未送信を確認して使用量0で拒否し、遅い解決がproviderへ進むことを防ぎます。秘密を渡した後の不確実な結果は予約を保持します。既存CAA経路でも送信前の資格情報解決に失敗した場合は使用量0で記録し、秘密を渡した後のproviderの失敗は保守的な不明の保留を維持します。キー削除で有料の保存済み候補を消すことはなく、同じ所有者が`lookupTopic`で操作を明示的に回収できます。この照会に資格情報・有効な生成設定・新たな送信は不要で、処理中・不明の保留を保持し、操作入力の差し替えを拒否します。所有者付きの読み取り経路はメモリー上のtransactionテスト代替と、ローカルMiniflareのSQLite Durable Objectで確認しました。認証を通すオフラインHTTP検証では、生成・レビュー、再起動／キー削除後の保存結果の照会、利用者分離、予算共用を合成provider応答で確認し、外部通信を禁止しています。本番の構築と実際のCookie認証bridgeも、オフラインOAuth応答で照会が可能な一方、生成と実キー入力が無効であることを確認しました。ローカル実行系の根拠であり、本番配備や実モデルの結果ではありません。生成とレビューはそれぞれ送信前に予約し、処理中・不明の保留を共有します。不正な出力や否定されたレビューも、確認済み使用量を費用に記録します。registryの入力8,000・出力2,000 tokenという小さい上限は保持し、transportの資源上限によって増やしません。レビューには、同じ台帳に保存した正確な要求・候補のbyte列と、サーバーが発行した生成の操作IDが必要です。操作のdigestを現在の単価・モデル設定と分けて不変の入力に結び付け、Nodeでは設定変更や価格確認の失効後も元の操作IDと結果を再送せず取り出せます。アカウントcoreの新しい提案は現在の資格情報を確認し、資格情報や設定を除去した後の保存結果は独立した所有者付き照会で取り出します。読み取り専用の台帳snapshotはファイルの作成・再書き込みをしません。予約前にtransportの静的な設定を確認し、providerの拒否・途中終了・入力上限・中断の理由を限られた区分で保持します。拒否・保留された操作を再送せず、やり直す場合は新しい要求の識別子が必要です。wire上は毎回`approvedPublicText: true`を要求しますが、その値だけで人間の確認を証明したとは扱わず、プレビュー・確認の画面は未接続です。`reserved`は処理中または保持された予約であり、完了ではありません。完了したレビューには別に計算した`allChecksPassed`を付け、操作の完了をレビューの合格とは扱いません。共通台帳の可搬なenvelopeは既存のCAA記録を保持します。固定したNode実行系で、合成応答によるサービス・transportの回帰と、完了したCAA記録との共存を検査しました。現在のtoken上限で実用的な教材の実生成・レビューが完了するかは未検証です。ファイル形式の大きい構造上限で受け付ける教材が、すべてこのtoken上限へ収まるとは約束せず、適切なモデル別上限と内容の評価を有効化の条件として残します。

実装したPOST経路は`/api/topic-textbooks/proposals`と`/api/topic-textbooks/operations`です。現在の検証済み`X-Library-Account`・sessionのCSRF・正確なOriginを要求します。本文受信後とアカウント処理を待った後で本人・sessionを再確認し、変わった文脈へ古い候補を返しません。提案の配送には実資格情報の機能gateを維持し、操作の照会はキー入力を有効にせず利用できます。テーマ本文は384,000 byte、分離した内部commandは本人・CSRFのメタデータ用に4,096 byteを加え、アカウント付き応答は262,144 byteを上限とします。既存CAA経路の入力32,768 byte・応答20,000 byteは保持します。どちらかの本人再確認を外すと、対応するsession競合の制御された回帰が失敗することも確認しました。不正な入力・容量超過・JSON以外の本文は配送前に400／413／415とし、未発行のレビュー候補は予約の保留とせず409 `unissued-draft`で返します。操作の照会はCSRFを確認し、共通の1分20回の変更枠は消費しません。処理中・不明の結果と入力変更の競合を区別し、応答容量の失敗は502 `response-limit`とします。

引き続き生成は注入による準備段階です。実生成の起動・ブラウザー設定・実際の利用者別資格情報の設定・読書と保存の画面・実内容の評価は接続する必要があります。テーマ用のcore設定は既定でnullとし、明示的に注入するtest-onlyのadapterだけを受け付けます。本番の構築では有効にしません。資源上限を支出許可や月額予算の保証にはしません。この検査でモデル・送信範囲・資格情報の保存先・実リクエストが承認されたとは扱いません。

## 過去の接続案と、先に必要な本人承認

本人は最初のproviderにOpenAIとAnthropicを選びました。用途ごとのmodel採用・実送信は未承認です。
用途ごとに複数provider/modelを選択できるregistryとadapter境界を用意しました。
OpenAI Responses API / gpt-6-luna と Anthropic Messages API / claude-haiku-5-5 が低価格の候補です。
2026-10-11に公式のAPIモデルページを取得し、API名・Responses・Structured Outputs対応を確認しました。
子モデル一覧は根拠にしていません。実アカウントの利用可否・課金設定は未確認です。
生成形式は許可済み JSON schema とZod検証で、任意JS/MDX/SVGコードを実行しません。
この候補は接続済み・動作検証済みという意味ではありません。

承認してほしい範囲は、選んだ1件の公開技術質問と、関連する固定教材の最小抜粋・公式根拠だけです。
送信先は本人がその回に選択するOpenAIまたはAnthropicのAPI。回答履歴・誤答・自己申告・感想・匿名ID・学習時刻は送信しません。
質問自由文に私的情報が入り得るため、送信本文のpreviewと本人選択を必須にします。
個人・企業の内部名、秘密、実DNS設定やログが混入した質問は、そのまま送信しません。
送信・保存条件と、使用する本人管理のAPIアカウントを確認するまで実接続は保留します。

OpenAIのデータ資料では API データは通常学習に使われず、標準の不正利用監視ログは30日です。
Responses の store=false はアプリケーション状態の保存を抑える設定で、無条件の無保存保証ではありません。
Zero Data Retention の資格や設定は未確認で、ここでは約束しません。
無料APIも無条件に私的情報を送れるとは扱いません。
AnthropicのCommercial APIは通常入力・出力を30日以内に削除しますが、契約・不正利用・法令等の例外があります。
Structured Outputsには機能別ZDRとschema cache（最終利用から最大24時間）の条件があります。
本人のworkspaceの契約やZDR適用は未確認です。両社とも無条件の無保存保証として扱いません。

## 月500円のハード上限

500円は本人一人のAIを含むプロダクト運用全体、実習費は別です。
BYOKでは当人の全providerを合算し、利用者間では予算を分離します。共用基盤費の配賦は未確定です。
Workersの利用者別台帳・暗号化保存は[ローカル実装と未接続部分](workers-byok.ja.md)を参照してください。
今のブラウザだけの試作に、有料API呼び出しはありません。
ブラウザとは別に、localhost の通信offサーバーと予算予約台帳を実装しました。
Googleログインは開発に不要。localhost限定・Origin確認・CSRF対策を付け、秘密をブラウザへ返しません。
鍵の安全な設定方法は本人が選択します。repo/localStorage/ログ/URLへ鍵を保存しません。

送信前に必要な制御：

1. 月ごとの spent + reserved + 固定運用費 + 安全余白 が500円以下になる予約だけ受け付ける。
2. 予約と更新をサーバーの永続台帳・排他トランザクションで行う。同時実行は1件。
3. 入力上限8000 token、請求対象の出力上限2000 token、ツール呼び出しなしを初期候補にする。
4. SDKを含め自動retryは0。再試行も新しい予約が必要で、重複送信は request ID で抑止する。
5. timeout・中断・結果不明は予約を勝手に返さず、実使用が確認できるまで確保する。
6. 価格・為替・税・決済手数料・運用費の上界を確定できないときは送信しない。
7. 上限到達、価格更新未確認、台帳障害では生成を停止し、読書とローカル質問保存は続けられる。

2026-10-11 の公式標準価格では gpt-6-luna の短文脈は入力$0.10/出力$0.50（各100万token）。
8000入力+2000出力の標準短文脈料金は$0.0018です。追加有料ツールは使いません。
予約には長文脈のcache-write入力上界$0.25/出力$0.75を使う例なら最大$0.0035です。
仮の計画用換算200円/$、20%の余白なら0.84円で、1円に切り上げて予約する例になります。
200円/$は現在為替の断定ではありません。決済の円建て上界が不明なら、この例で実送信しません。
たとえば固定運用200円・別の安全余白100円を確保すると、AI予約は残り200円以内です。
実測の運用費や適用税・料金を確認していないので、月の生成件数や500円以内の実運用達成は保証しません。
予算予約・台帳・両社のHTTP transportは通信offで実装済み、ネットワークモックのみで検証しました。
Anthropic Haiku 5.5も短文脈は入力$0.10/出力$0.50（各100万token）、100K超では$0.50/$2.50です。
予約には長文脈1時間cache-writeの入力上界$1.00と出力$2.50を採用し、同じ上限tokenで$0.013です。
上記の仮換算では3.12円（台帳3120 milli-yen）。cache-controlは送信せず、低い実料金を予算に先取りしません。
候補の価格は2026-10-11確認です。アカウントの適用料金や初期入金は別途確認が必要です。
公式の価格メタデータだけでは送信できず、費用上界・保存条件・用途選択・送信承認が未設定なら停止します。
現在の正常起動はすべて未接続です。「月500円保証済み」という表示や保証はありません。

## 初期入金と、接続前に進められる範囲

OpenAIの新APIアカウントのprepaid初回購入は最低$5、既定$10。自動入金は設定時に既定で有効です。
購入creditは1年で失効し、原則返金されません。既存残高・無料creditの有無は調べていません。Anthropicの本人契約・初回入金額も未確認です。
初期入金は月の実使用額とは別ですが、現金支出の500円制約から自動的に除外しません。
実決済の円額が500円を超える場合、別枠の初期入金を本人が認めない限り接続を保留します。
prepaid残高・自動入金上限は即時の使用額上限ではなく、停止遅延もあるため自前の予約台帳が必要です。

課金・送信の承認前に、外部通信を無効にした状態で次をローカル実装しました。

- 永続予算台帳・原子的な予約・月次区切り・同時1件・結果不明の予約維持・二重送信防止。
- 送信preview・本人選択・入力/出力制限・schema検証・失敗時に教材を変えない経路。
- localhost/Origin/CSRF/要求サイズを検査するサーバー、transportを差替えるadapter契約。
- ネットワークを使わないstubと両社のHTTPモックで、上限・競合・timeout・retryなし・秘密非露出のテスト。

この段階のadapterは未接続と表示し、準備したtransport・APIキー・支払・実リクエストは有効化しません。
従来の固定CAA導線で保留していた判断は「どのprovider/modelに、previewした公開技術質問を送ることを許可するか」でした。現在のテーマ別導線で送る範囲は、上記のとおり改めて合意が必要です。
初期入金の許容と実送信は、円建て額・送信本文を確認して別に承認します。
方針決定後に必要なのは、本人によるAPI project/利用権限確認、必要なら支払設定と自動入金off、
利用者自身のキーをサービスの設定画面から安全に登録・管理できる認証と暗号化保存です。
運営者による共通LLMキーの設定や、利用者がキーをチャットへ貼り付ける方法は前提にしません。
既存credential、Codexログイン、課金アカウントを探索・流用しません。

## 通信off実装の契約と限界

server/registry.mjs は候補をdisabledで保持し、用語説明・教材追加・根拠確認の用途選択は未設定です。
registryの各項目はprovider/model、用途、入出力上限、structured output能力、データ条件と承認状態、
価格・価格確認日を持ちます。現在の公開契約はdisabled/test-onlyのみで、live送信を有効にする経路がありません。
server/adapter.ts は型付きの薄い境界です。provider SDK・LiteLLM Proxy・AI SDKは導入していません。
将来の互換endpointやSDKへの差替えでも、台帳・上限・出典検査はadapterの外に残します。
障害時の他providerへの自動fallback・並列送信は行いません。stubはtests/server内に限定しました。

台帳は.local-state/generation/budget.json（Git除外、作成mode 0600）です。
排他directoryの作成→schema確認→一時fileにfsync→atomic rename→directory fsyncを送信前に完了します。
全provider共通500000 milli-yenから固定費・安全余白を引いて整数予約し、provider別上限も設定できます。
実行中・結果不明は全providerで新規実行を止め、月をまたいでも自動解放しません。
request IDとpayload/model/sourceのhashで重複を防ぎます。質問本文や秘密、provider例外を台帳に残しません。
成功proposalのJSONと出典引用はローカル保存されます。不正出力でも確認できた費用はspentへ記録します。
price/FX/費用条件を同月で変更した場合も保留し、破損台帳や残ったlockを自動リセットしません。
異常停止後の手動費用照合・lock復旧ツールは未実装です。予約を消して無条件再送してはいけません。
fsyncを含む永続化はMac Studioで検証し、Windows/Linux実機や電源断の障害注入は未検証です。

HTTPは127.0.0.1:5274のみ、Host完全一致、Originは `http://127.0.0.1:5173` のみです。
GET /sessionで一時CSRF tokenを渡し、POST /proposalsはtoken・JSON・body上限・入力schemaを確認します。
学習履歴・キーなどの追加入力fieldを拒否し、CORSは許可originのみ、レスポンスはno-storeです。
外部出典のfetch/SSRF経路はなく、サーバーが保持する指定公式URLのsnapshotだけを参照する契約です。
出典は30日以内・未来でない確認時刻を必要とし、生成の引用がsnapshot本文に存在することを確認します。
引用一致は内容の意味的正しさの証明ではありません。出典取得と現行schemaへの反映接続は未実装です。
返せるJSONは説明・二つの固定図・四つの既存CAA scenarioに限り、JS/MDX/任意図コードは拒否します。
読書UIは接続していないため生成ボタンや生成済みstub結果を表示せず、本人の手動反映経路を維持します。

HTTPの本文byte上限は資源保護で、token数の保証には使いません。
予約永続化後、完全なprompt/schemaをOpenAI input_tokensまたはAnthropic count_tokensで計数します。
計数値＋model別余白が入力上限以内の場合のみ、そのproviderの生成を1回送信します。
計数にも質問・抜粋・出典が外部送信されるので、本文previewと本人承認を先に必要とします。
Anthropicは計数無料と公式に説明していますが推定値です。実生成との差の厳密な上界は未確認です。
OpenAIの計数課金条件も未確定です。tokenCountMargin=null / tokenCountTermsConfirmed=falseのまま停止します。
モックの256token余白は試験値で、実APIの上界保証ではありません。
送信後のusage超過検査だけでは事前の費用上限を保証できないため、計数の上界確認を有効化条件に残します。
生成では出力上限2000、OpenAI reasoning none、Anthropic thinking disabled / effort lowを指定します。
思考tokenを含むusage.output_tokensを利用し二重加算しません。Anthropicのcache入力は別内訳を合算します。
usageにregistryの保守的単価・円換算上界を掛け、整数で切り上げてspentに記録します。
これは請求書照合済み金額ではありません。usage/モデル/料金tierが不明、上限超過なら予約を保持します。
拒否・出力切れ・不正JSON・出典不一致も、usageが確認できれば費用を記録し教材案は返しません。
タイムアウト後に計数が遅れて返っても生成を送りません。自動retry・redirect・fallbackはありません。
実キーの登録・設定は行っていません。利用者別credentialの安全な保存経路を接続するまで無効です。
transport factoryは明示的に渡された秘密だけをAuthorization headerに使い、環境変数も読みません。
通常起動はfactoryを登録せず、prepared transportはGenerationServiceでも拒否します。
frontendのbundleへserverコード・キー名・台帳が入らない構成です。

## 従来の固定CAAのsetupと承認文面案

従来の案ではOpenAI / Anthropicを候補に選んでいましたが、現在の次の接続には上記のとおりOpenAIを選択しています。課金projectへのアクセスとmodel利用可否は未確認です。
用語説明・教材追加・根拠確認の各用途で、どのmodelを使うかは未選択です。
アカウントIDやキー値をチャットへ送る必要はありません。OpenAIの場合も既存projectをこちらで探索しません。
既存残高がなければ、初期入金の円建て額と500円制約の扱いを別に確認します。
実キー入力はserver側の利用者別認証・暗号化保存経路を完成させてから有効にします。
設定画面は模擬操作のみで、平文キーをlocalStorage/repo/ログへ保存しません。
実送信前には計数上界・計数料金・円建て費用上界・秘密の安全な設定・出典snapshot取得を確定します。
HTTPモック成功は実APIの受理・教材品質の確認ではありません。本文previewからserverへ渡すUI接続と、
結果不明の予約を請求記録に照合する復旧経路も未実装です。初回の小さい実送信は別途承認が必要です。

承認文面案：

> 用途ごとに私が選んだprovider/modelへ、previewで確認した公開技術質問・関連教材の最小抜粋・公式根拠だけを
> 送ることを許可します。学習履歴・ID・時刻は送らず、説明されたAPI保存条件を受け入れます。
> 月500円は全providerと固定運用費の合計で、費用上界が不明なら送信停止。自動retryや別providerへのfallbackは
> 行いません。キー設定と初期入金は方法・円額を確認して別途承認し、教材反映は差分確認後に私が選択します。

この文面は過去の固定CAA向けの案であり、テーマ別教材の承認依頼ではありません。現時点で送信・保存条件・鍵設定・支払の承認を得たとは扱いません。テーマ別のリクエストには、新しいpreviewと送信範囲の合意が必要です。

## 接続後も本人反映を分ける

生成物は不足点と根拠を持つ提案として保存し、出典不足・不一致・鮮度不足・schema不正では保留します。
取得した出典本文を根拠として保持し、モデルが書いたURLを「確認済み」と扱いません。
差分・キャンセル・版競合検査・本人の反映選択を通ってから新しい教材版にします。
書き換えた版の旧回答・snapshot・質問元文脈は残します。生成が失敗しても教材を変更しません。

公式資料（2026-10-11確認）：

- [価格](https://developers.openai.com/api/docs/pricing)
- [APIモデルと対応機能](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [データの扱い](https://developers.openai.com/api/docs/guides/your-data)
- [初期入金とprepaid](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing)

両社のtransportと計数・使用量の公式資料（2026-10-11確認）：

- [OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting)
- [OpenAI reasoningと出力上限](https://developers.openai.com/api/docs/guides/reasoning)
- [Anthropic Haiku 5.5モデル・料金](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Anthropic Messages契約](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic APIデータ保管条件](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
