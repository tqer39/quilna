# 1Password経由のクラウド認証設定

[English](onepassword-cloud-auth.md) | [日本語](onepassword-cloud-auth.ja.md)

## 対象範囲

`sync-cloud-auth.yml`は手動実行で1Passwordから承認済みの認証情報を読み、既存の`quilna-private` Workerの認証Secret 3項目を更新します。
アプリのソース公開、Worker作成、D1 migration、プラン変更、収集開始は行いません。
先にワークフローをレビューして`main`へマージする必要があります。マージと実環境での実行は別の操作です。
ローカルの模擬テストは、1Passwordへの実接続、実Secret更新、Googleログインの成功を証明しません。

1Passwordを正本とし、Workerがログイン処理で使うためCloudflareにも暗号化した実行用コピーを保持します。
1Passwordでの変更は、手動同期が成功した後に反映されます。即時・定期同期ではありません。
`BETTER_AUTH_SECRET`は固定のランダムな署名鍵であり、実行のたびに作り直しません。変更すると既存セッションが無効になります。

## 本人による初期設定

1. 専用Vault（例：`quilna-secrets`）と1つ以上の項目（例：`Quilna Auth`、`Quilna Cloudflare CI`）を作成します。
   サービスアカウントは組み込みのPersonal/Private Vaultへアクセスできないため、別の専用Vaultを使います。
2. 項目に次のフィールドを保存します。以下はフィールド名の例であり、秘密値ではありません。

   | フィールド | 値 |
   | --- | --- |
   | `GOOGLE_CLIENT_ID` | Quilna用Web OAuthクライアントID |
   | `GOOGLE_CLIENT_SECRET` | 同じクライアントのシークレット |
   | `BETTER_AUTH_SECRET` | 別途安全にランダム生成した32文字以上の文字列。64文字を推奨 |
   | `CLOUDFLARE_API_TOKEN` | 承認済みアカウント・資源でWorker設定の読み取りとSecret更新を許可する専用トークン |

   Cloudflareは、このAPI操作に使える最小の資源・権限範囲に絞ります。Global API Key、別アプリのトークン、課金・DNS・D1書き込み権限は使いません。
   秘密値は非表示フィールドにします。チャット、Git、ワークフローYAML、artifact、平文ファイルへ値を保存しないでください。
3. 新しいサービスアカウント`Quilna GitHub Actions`を作成し、専用Vaultへの**項目の読み取りだけ**を許可します。書き込み・共有・Vault作成・別Vaultへのアクセスは許可しません。
   一度だけ表示されるトークンを安全に保存します。このアカウントが読めるVaultの外に保管し、認証情報の作成・送信は本人が行います。
   現在のアカウントでサービスアカウントを利用できない場合は機能を確認して止め、有料プランへ自動変更しません。
4. GitHubのリポジトリ設定にEnvironment `quilna-private`を作成します。
   デプロイ元ブランチを`main`に限定し、本人によるレビューを必須にして、利用できる場合は管理者による回避も無効にします。
   実行者と承認者が同じ1人のオーナーの場合、待機中のジョブを本人が承認できるよう**Prevent self-review**は無効にします。
   接続用トークンだけをEnvironment Secret `OP_SERVICE_ACCOUNT_TOKEN`に保存します。リポジトリ全体のSecretにはしません。
5. 以下のEnvironment変数を追加します（秘密値ではない設定）。

   | 変数 | 値 |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | 承認済みの32文字のアカウントID |
   | `QUILNA_APP_ORIGIN` | 承認済みの`https://quilna-private.<subdomain>.workers.dev`。末尾のスラッシュなし |
   | `QUILNA_OWNER_EMAIL` | 承認済みの本人Googleメールアドレス |
   | `OP_REF_GOOGLE_CLIENT_ID` | クライアントIDの`op://<vault-id>/<item-id>/<field-id>` |
   | `OP_REF_GOOGLE_CLIENT_SECRET` | Googleシークレットの参照 |
   | `OP_REF_BETTER_AUTH_SECRET` | 固定のセッション署名鍵の参照 |
   | `OP_REF_CLOUDFLARE_API_TOKEN` | Cloudflareトークンの参照 |

   名前変更や空白による曖昧さを避けるため、参照にはIDを優先し、1Passwordの開発者向け機能からコピーします。
   上記のASCIIフィールド名も使えます。日本語などASCII以外のフィールド名ではフィールドIDが必要です。
   GitHub変数には参照だけを置き、認証情報の値は1Passwordに保持します。
6. Googleアプリはテスト中のまま、承認済みの本人アドレスをテストユーザーへ追加します。
   Webクライアントのcallbackは引き続き`APP_ORIGIN + /api/auth/callback/google`です。

## 実行と検証

レビュー済みワークフローが`main`に入った後、**Actions → Sync cloud authentication from 1Password → Run workflow**で`main`を選び、確認欄に`quilna-private`を入力します。
対象コミットを確認して、保護されたEnvironmentのジョブを承認します。
コミット固定の公式Actionとバージョン固定の1Password CLIで4つの参照を読み込みます。サービスアカウントトークンは取得ステップだけへ渡し、環境変数への一括exportを無効にします。
取得値は直後の同期ステップだけへ環境変数で渡し、シェルのコマンド文字列へ埋め込みません。
取得後に依存インストール、ビルド、テスト、artifactアップロード、アプリソースのデプロイは実行しません。

同期スクリプトは更新前に、既存Workerの本人メール・origin・本人限定モード・D1 bindingを照合します。
Cloudflareのbulk secrets APIで`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`BETTER_AUTH_SECRET`だけを暗号化Secretとして更新し、3項目の型と他bindingの保持を再確認します。
クライアントID自体は秘密値ではありませんが、3項目を一括反映するためSecret bindingを使います。
この方式では、後のソースデプロイでSecretを置き換えないよう、ignoredの本人用設定を含むWranglerの`vars`に`GOOGLE_CLIENT_ID`を含めません。
他の設定、ソース、asset経路、preview設定、migrationには書き込みません。

認証情報の欠落、対象外ブランチ、対象設定の不一致、APIエラーでは停止します。
Actionsのdebugログは無効にします。同期スクリプトはAPI応答本文や秘密値を出力・保存しません。Actionのマスキングは補助対策であり、秘密値を出力してよい理由にはしません。
タイムアウトや更新後検査の失敗でも、更新自体は反映されている場合があります。再実行前に対象を確認してください。書き込みの自動再試行・認証情報の自動巻き戻しは行いません。
手動・ソースデプロイとの同時実行を避けます。GitHubのconcurrencyが直列化するのは、このワークフロー同士だけです。

成功後、設定待ち画面の変化、本人ログイン、別アカウント拒否、静的assetの非公開性、認証後の収集を別途検証します。
同期成功だけではGoogle認証情報の組み合わせの有効性や、PC停止中の収集成功は分かりません。

## 参照

- [1Password GitHub Actions](https://www.1password.dev/ci-cd/github-actions)
- [サービスアカウントの設定と制約](https://www.1password.dev/service-accounts/get-started)
- [CloudflareのSecret一括更新](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/bulk_update/)
- [Secret参照の構文](https://www.1password.dev/cli/secret-reference-syntax)
- [クラウドリーダーの実装と検証（PR #63）](https://github.com/tqer39/quilna/pull/63)
