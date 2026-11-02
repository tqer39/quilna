# Workersの利用者別BYOK実装（実入力・実通信off）

[English](workers-byok.md) | [日本語](workers-byok.ja.md)

モック画面に加えて、暗号化保存とAPI、利用者別予算をWorkers用に実装しました。
ローカルMiniflare/workerdのSQLite Durable Objectで検証しています。
実環境の認証・暗号鍵・保存binding・送信条件は未設定です。実入力は引き続き無効です。
運営共通LLMキーは使いません。利用者が供給するLLMキーと、システムの暗号化用秘密は別です。

## ローカル実行

```bash
npm ci
npm run workers:local
```

127.0.0.1:8787でdistを配信し、/api/sessionは503 auth-unconfiguredを返します。
既存の127.0.0.1:5173とは別originなので、localStorage履歴は自動移行しません。
このコマンドはMiniflareを直接使い、Wranglerのアカウント設定・.env・.dev.varsを読みません。
外部fetchを拒否し、認証・キー入力・provider通信を有効化しません。停止はCtrl+Cです。
保存先.local-state/worker-devはGit除外。通常のoff起動ではcredentialを作成しません。

```bash
npm run workers:build
npm run test:workers
```

Workers bundleは.local-state/worker-buildに作成します。deployはしません。
テストはその場限りのダミー文字列・暗号鍵・テスト署名を使い、一時SQLite保存先を終了時に破棄します。
テスト署名はGoogleに通用しません。実サービスのキー・OAuth grant・永続権限を生成しません。

## 本番とテストの認証境界

認証はBetter Auth 1.7.7＋認証専用D1へ置換しました。AccountVault DOの保存/予算は維持します。
未設定時は停止し、実キー入力・実senderは無効です。テストidentityをenv/headerで選択できません。
Google callbackはAPP_ORIGINに `/api/auth/callback/google` を加えた完全一致です。
[最新の認証方式・DB・外部設定手順](better-auth.ja.md)を参照してください。
独自LoginState DO、AUTH_SESSIONS、AUTH_STATE_KEYRINGは現在の構成から除去しました。

## credential API

APP_ORIGIN完全一致、同originのGETはFetch Metadataも確認します。
認証済みsubjectのhashで利用者ごとのDOを決定し、保存ownerをpinします。
APIにuserId/ownerを渡しても所有者を変更できません。DOは内部bindingからのみ呼ぶ構成です。
変更はsession別CSRF token、有効期限1時間、20操作/分、JSON・byte上限・strict schemaで保護します。
確認/生成の回数も同じ変更制限を使います。responseはno-storeで、例外本文やsecretを返しません。

| Method / path | 処理 |
| --- | --- |
| GET /api/session | CSRF metadata。現状realKeyInputEnabled=false |
| GET /api/credentials/{provider} | 登録版・候補model・状態のみ |
| POST /api/credentials/{provider} | 新規登録 |
| PUT /api/credentials/{provider} | 版を指定した差し替え |
| PATCH /api/credentials/{provider} | モデル候補の選択、確認状態のリセット |
| DELETE /api/credentials/{provider} | active暗号文削除、tombstone版を保持 |
| POST /api/credentials/{provider}/check | 承認した公開CAA確認文を共通予算経路で確認 |
| GET /api/budget | 当人のspent/heldと500000 milli-yen上限 |
| POST /api/proposals | 当人のcredentialを予約後に解決し、教材案を検証 |

providerはopenai/anthropicのみ。登録/置換はrequestId(UUID)、expectedRevision、model、keyを受けます。
削除はrequestIdとexpectedRevisionのみ。モデル選択はさらにmodelを受け、keyを受けません。
確認はrequestId、expectedRevision、approvedPublicText=trueを受けます。確認文はserver側の固定公開文です。
キーは10–500のASCII文字に制限し、送信先・任意endpoint・別利用者IDを受けません。
登録・差し替え・削除のrequestIdは冪等で、異なる内容の再利用は拒否します。
削除後の古い登録要求を再送しても復活せず、同じ版への並列置換は1件だけ確定します。
正常書込の応答が失われた場合、失敗と断定して別IDで無条件再送せず、状態/版を再確認します。

src/credential-client.tsも型付きで準備しました。sessionの許可がない限りキー変更要求を送らず、
同origin・redirect拒否・retryなし・metadata検証・キー非保存の契約です。
実sessionの保存metadata表示に接続しました。変更入力はまだ無効で、別の模擬UIはメモリ内操作だけです。
本番handlerのcredentialsEnabledはfalse、generationは未登録で、テスト成功を実接続成功とは表示しません。

## 暗号化と永続化

workers/crypto.mjsはAES-256-GCM、ランダム96bit nonce、owner/provider/revision/keyVersionをAADとして使います。
保存するキー本体はnonceと暗号文だけ。鍵は非extractableなWeb Crypto keyとして処理します。
master keyringはBYOK_ENCRYPTION_KEYRINGとしてstorageとは分離して供給する契約です。
active versionと最大4版の32byte base64鍵を持ちます。欠落/不正設定/復号失敗は停止します。
旧版の読取と、新しいactive版での書込は実装済み。全件の移行・旧鍵撤去・復旧手順の本番検証は残ります。
冪等性fingerprintはHKDFで用途を分けたHMACです。キーそのものやfingerprintをbrowserへ返しません。
JavaScript上の全コピーを即時zeroizeできるとは約束しません。module共通の利用者キーcacheは作りません。

DOのtransactionとsyncで永続化を確認してから外部送信境界へ進みます。
保存失敗はtransactionをrollbackし、commit後のack不明では版を再確認する必要があります。
削除はactive暗号文を除去し、再登録でもrevisionを巻き戻しません。進行中の結果も旧版なら表示しません。
provider側の失効やバックアップ/PITRの即時消去とは異なります。
削除済み状態を復旧時にも守る手順、保持期限、バックアップからの復元試験は未実装/未検証です。

## 一人ごとの月500円

予算は利用者ごとのDOに保存し、その人のOpenAI/Anthropic料金を合算します。
全BYOK利用者を運営費500円に収める設計ではありません。
個人のAI費＋その人に適用する固定運用費＋余白を500円以内に予約できる場合だけ進めます。
共用基盤費の配賦や本人の実請求の上界は未確定なので、実運用500円保証とはしません。
SQLiteのbudget_recordsへ要求単位で保存し、共通ledger schemaとGenerationServiceを再利用します。
予約・精算・不明結果・同月policy変更の停止・月跨ぎ・冪等性を維持します。
秘密の復号は予約後だけ。削除/差し替えでleaseの版が変わったら案を返しません。
確認済み費用は残し、不明費用は予約を維持します。キー削除で予算を消すことはありません。
予算recordsは最大20000、credential変更履歴は2000で停止します。保持/照合/集計の運用拡張は別途必要です。

接続確認も無料と断定せず、生成と同じ使用量予約を使います。現状はネットワークモックのみです。
計数課金・推定誤差上界・価格/税/為替/固定費・公式出典取得・費用照合/不明予約復旧は未確定です。
全provider共通の自動retry/fallbackはありません。詳細は[生成接続判断](generation-connection.ja.md)を参照。

## 本人限定Devの公開準備

サービス名は「Quilna（クイルナ）」、正式ドメインは `https://quilna.page` です。
既存Devの公開記録とは区別し、ドメイン取得・DNS接続・公開環境の移行は未実施です。
本番独自domain・有料plan・LLM実送信・GitHub push/PRは対象外です。
[公開設定と安全なhandoff](dev-publication.ja.md)、[本人限定の入力手順](owner-only-setup.ja.md)を参照してください。

## 検証と制約

WorkersのJSはZod実行時schemaとNode/Miniflare試験で検証しています。
frontend/API client/adapter契約はTypeScriptで確認します。全Workers JSを静的型検査したとは扱いません。
テストprincipal、テスト署名、ダミーキー、モック生成だけを使用しました。
実Googleログイン・実キー・provider送信・入金・秘密設定・Cloudflare account利用・deploy・公開は未実施です。
Windows/Linux実機、電源断、本番backup/PITR、課金時の運用上界は未検証です。

Workers dev dependenciesはnpmのrepo内共通依存（Wrangler/Miniflare/esbuild）です。global installはしません。
今回のWranglerが依存するMiniflare 5 alphaと同版を使い、公式packageの互換変換APIで試験しています。
lockfileを保存しました。実機確認はMac Studioのみで、native workerdのOS/architecture制約は別途確認が必要です。
既存markdownlint系のhigh 5件は継続しています。修正版のbracesは未公開で、監査除外やforce downgradeはしません。
[既存の監査記録](dependency-audit.ja.md)に該当経路と影響範囲を記録しています。

公式資料（2026-10-11確認）：

- [SQLite DOのtransaction/storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Miniflare Durable Objects](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/)
