# 本人限定Devの公開と設定

[English](dev-publication.md) | [日本語](dev-publication.ja.md)

現在のサービス名はQuilna（クイルナ）、正式ドメインは [quilna.page](https://quilna.page) です。
ドメイン取得・DNS接続・公開環境の移行は未実施です。
これらの運用作業は[Issue #53](https://github.com/tqer39/quilna/issues/53)、調査と採用判断は[命名の記録](branding.ja.md)で管理します。
以下は旧名称で公開した本人限定Devの記録です。旧URLは `https://tsumiki-text.tqer39.workers.dev` です。
Google認証は設定準備中のため、ログインボタンは無効です。実ログイン成功とは扱いません。
固定CAA教材の試作で、教材生成・クラウド履歴同期・実LLM送信は未実装/無効です。

## 設定ファイル

公開リポジトリはwrangler.dev.example.jsoncだけを追跡します。
本物のaccount ID、D1 ID、許可メールはignoredのwrangler.dev.jsoncへ入力します。
公開済み資源のIDはCloudflare Dashboardで確認してください。秘密値をchat/repo/logへ貼りません。
ローカル設定の欠落時にexampleをそのままdeployしません。placeholderは実資源を指しません。
rootのwrangler.jsoncはlocalhost/off用です。

```bash
cp wrangler.dev.example.jsonc wrangler.dev.jsonc
# ignoredの設定を対象account/既存D1 ID/本人メールに置き換える
npm run build
npx wrangler deploy --config wrangler.dev.jsonc --dry-run
# 資源変更/公開の承認後だけdry-runを外す
```

PRIVATE_DEV=true、assets.run_worker_first=trueが必須です。
本人sessionがなければrootはログイン入口だけ、教材HTML/JSは401です。
Google未設定のauth/BYOK/session APIは503。実キー入力・実senderは常に無効です。
認証済みassetはno-storeとCSPを付与し、logout/失効時はログイン入口へ戻します。
GitHubのソース公開はアプリの認証解除を意味しません。履歴はブラウザ内のみです。

## 作成済み資源と検証

2026-10-12、公開承認と本人のWorkers Free確認後、次の対象だけを作成しました。
既存サービス設定、有料plan、独自domain、Accessは変更していません。

- Worker: tsumiki-text。DO bindingはACCOUNTS / AccountVault、v1 SQLite migration。
- D1: tsumiki-text-auth-dev。AUTH_DBへbindし、0001/0002のmigrationを適用済み。
- 当日のD1 user/session件数は0、Worker Secret一覧も空でした。

公開URLでroot HTTP200、教材HTML/JS401、認証/個人設定API503を確認しました。
320px/390px/1440pxで準備中表示、disabled login、横スクロールなし・JSエラーなしでした。
ローカル画像はtest-results/dev-publicにあり、公開Gitには含めません。
2026-10-17のコード監査修正はPR時点でDevへ再deployしていません。
Freeの実CPU/共有枠/費用やbackup復旧は、この試験だけでは保証できません。

## 認証設定の引き継ぎ

[本人限定認証の入力手順](owner-only-setup.ja.md)を使用します。
Google Web clientのscopeはopenid emailだけ。profile/Drive/Gmail/offline grantを要求しません。
本人だけをtest userにし、アプリでも署名・nonce・verified emailを照合します。

ドメイン接続後は、APP_ORIGINとGoogleのリダイレクトURIを同時に更新します。

```text
https://quilna.page/api/auth/callback/google
```

GOOGLE_CLIENT_IDは公開変数、GOOGLE_CLIENT_SECRETは専用clientのSecretです。
BETTER_AUTH_SECRETは認証cookie/state保護、BYOK_ENCRYPTION_KEYRINGはLLMキーのAES-GCM保存用です。
これらは別用途で、運営共通LLMキーはありません。入力は対象WorkerのVariables and Secretsで行います。
実secretの生成/登録、Google grant、実LLM送信は今回のPR作成に含めません。
設定後の実ログイン、本人/他人拒否、cookie配送、中断/logoutの実環境検証が残ります。
