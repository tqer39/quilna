# 本人限定Devの認証設定

[English](owner-only-setup.md) | [日本語](owner-only-setup.ja.md)

初期のログイン許可対象は、署名検証済みGoogle ID tokenのemailが本人の設定値と一致し、
email_verified=trueであるアカウントだけです。公開文書では実メールを記載せず、設定例は `owner@example.invalid`。
GOOGLE_ALLOWED_EMAILは1件必須。未設定・不正値では認証を停止し、全員許可にfallbackしません。
既存sessionもverified emailと設定値を毎回照合します。client指定userId/email/検証済みフラグを信用しません。
所有者は引き続きBetter Authのverified user.idで決め、メールをvaultのIDとして使いません。

サービス名は「Quilna（クイルナ）」、正式ドメインは `https://quilna.page` です。
ドメイン取得・DNS接続・公開環境の移行は未実施です。以下は移行後の設定例で、適用済みの値ではありません。
既存Devの記録は[公開と設定](dev-publication.ja.md)を参照してください。設定例の許可メールは本人の値に置き換えます。
今回の名称変更ではdomainの購入・設定は行いません。既存Kazokubiのdomain/認証/DBは変更しません。

検証：本番entry経由のmock OAuthで本人許可、他アカウント/未検証email拒否、
client指定ID無効、設定欠落停止、既存sessionの再照合を確認しました。Workers全28件が成功しています。

## 本人が承認する項目

Dev公開の承認とFreeの本人確認を受領し、専用資源の作成・公開は完了しました。安全な秘密入力を引き継ぎます。

- 正式ドメイン（接続待ち）：`https://quilna.page`。
- 閲覧とログインの初期対象：本人 `owner@example.invalid` のみ。
- アプリの本人限定認証と必要なOAuth/D1/DO資源を準備すること。Access追加は行わない。
- 公開前に他アカウントの拒否を確認すること。実キー入力・実AI送信は引き続き無効。

全Workersの共通設定は変更していません。Google client/secret設定は未実施です。

## 公開先を承認した後の具体入力

| 設定 | 入力内容/用途 | 入力先 |
| --- | --- | --- |
| APP_ORIGIN | 承認したHTTPS origin、末尾slashなし | Worker Variables |
| GOOGLE_ALLOWED_EMAIL | `owner@example.invalid`（本人限定の認可） | Worker Variables |
| GOOGLE_CLIENT_ID | Google Web OAuth clientのID | Worker Variables |
| GOOGLE_CLIENT_SECRET | そのWeb clientのsecret | Worker Secret |
| BETTER_AUTH_SECRET | 32文字以上の十分な乱数、認証cookie/state保護 | Worker Secret |
| BYOK_ENCRYPTION_KEYRING | LLMキー保存のAES-256用keyring | Worker Secret |

ドメイン接続後に適用する公開設定例：

```json
{
  "APP_ORIGIN": "https://quilna.page",
  "GOOGLE_ALLOWED_EMAIL": "owner@example.invalid"
}
```

Google Web OAuth clientのAuthorized redirect URIは、次の完全一致です。

```text
https://quilna.page/api/auth/callback/google
```

実装が要求するscopeはopenid emailだけ。profile/Drive/Gmailのscopeやoffline grantは要求しません。
同意画面をTestingで準備する場合は、本人だけをtest userに登録します。
Googleのtest users設定だけに依存せず、アプリ側でもverified emailを照合します。
ID/secretは同じWeb clientの組み合わせを使います。callbackに別host/pathを混ぜません。

secretは本人がCloudflare Dashboardの対象WorkerのVariables and Secretsへ直接安全に入力します。
chat・repo・URL・logへ貼りません。この手順は実secretの生成/取得/設定を今回行った意味ではありません。
Better Auth secretとBYOK暗号鍵は別用途で、運営共通のLLMキーを設定する項目はありません。
BYOK keyringはactive版と各版の32byte base64鍵を持つJSONです。backup/rotationも本人が管理します。
設定例へ本物の鍵値を埋め込みません。本人のLLMキーは、安全性確認後にアプリの本人用設定画面へ入力します。

## DBと公開前の確認

1. 認証専用D1を準備し、AUTH_DBへbindする。実database_idを対象Workerの設定へ入れる。
   migrations/auth/0001_better_auth.sql、0002_app_guard.sqlを順番に適用する。
2. ACCOUNTSをSQLite Durable ObjectのAccountVaultへbindし、wrangler.jsoncのv1 migrationを適用する。
   認証はD1、BYOK/個人別予算はDO。旧LoginState DO/AUTH_SESSIONSは不要。
3. Workers Free/D1/SQLite DOの利用条件・現在の無料枠・超過時の停止/課金設定を確認する。
   他サービスの既存利用量を含むアカウント全体の適用枠も確認し、有料planへ自動的に切り替えない。
   DB/基盤費も本人の月500円に含める。無料枠内・実CPU上限内をローカル試験だけで保証しない。
4. 本人限定Devのアプリ認証/fail-closedを確認してから公開する。実Google callback、cookie、中断/logout、
   他アカウント拒否、D1/DO保存/復旧、実CPU/cold startと費用を確認する。
5. 実キー入力を許可するgateの変更はその確認後にレビューする。実AI送信はさらに別承認。

専用D1/SQLite DO/Workerを作成・公開し、匿名asset/API拒否と準備中画面を実URLで検証しました。
実grant・secret設定・push/PR・domain購入・実Google/AI通信は行っていません。
公開結果とDB/versionは[公開記録](dev-publication.ja.md)を参照してください。

- [認証実装と検証範囲](better-auth.ja.md)
- [Cloudflare D1料金/無料枠](https://developers.cloudflare.com/d1/platform/pricing/)
- [Durable Objects料金/無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
