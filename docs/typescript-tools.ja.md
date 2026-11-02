# TypeScriptの開発ツール

[English](typescript-tools.md) | [日本語](typescript-tools.ja.md)

ブラウザ版はTypeScriptで実装しています。ブラウザ向けJavaScriptのビルドにはViteを使い、通常の開発・ビルド・CIでは引き続き`tsc --noEmit`を必須の型チェックにします。

## 任意のtsrs検査

2026-10-20に[CloudflareとVoidZeroがtsrsを発表しました](https://blog.cloudflare.com/typescript-rust-port/)。
TypeScriptコンパイラーのRust移植であり、アプリの実装言語を変更するものではありません。
[公式プロジェクト](https://github.com/oxc-project/tsrs)では現在も実験版と位置付け、TypeScript 7との互換性を目指しています。

```bash
mise run typecheck:tsrs
```

このタスクだけに指定したmiseのnpmツールとして、`tsrs@0.18.0-ts7.1.0-dev.20260929`を固定してインストールします。
プロジェクト全体の必須ツールや実行時依存には追加しません。通常の`npm ci`・ビルド・CIでは、引き続きロックファイルのTypeScript 5.9.3を使います。
miseは既定でnpmのインストール時スクリプトを抑止します。Macの試行で使った2パッケージは、レジストリ署名とattestationを検証しました。
実験版の更新時は配布元と既知の問題を確認します。この検査で任意のパッケージの信頼性を証明できるわけではありません。

公開パッケージにはmacOS arm64と、Linux x64／arm64のGNU／musl向けバイナリーがあります。
今回の実行確認はmacOS arm64のみです。WindowsとmacOS x64向けは配布されていないため、通常の`npm run typecheck`を使います。
対応を検証するまでは、全プラットフォームでtsrsを必須にしません。

## 2026-10-24のローカル試行

変更前のプロジェクト設定はtscに成功し、tsrsではCSSの副作用importに対するTS2882で失敗しました。
`src/vite-env.d.ts`にVite標準のクライアント型参照を追加すると、検査を無効にしたり実行時の動作を変えたりせず、両コンパイラーがimportを解決できました。
追加後はプロジェクトの型チェックが両方で成功しました。別の正常・異常fixtureでも期待どおりに受理・拒否し、異常fixtureでは両方がTS2322とTS2741を報告しました。

同じMac Studio arm64とNode 26.12.1で、プロジェクトの検査を交互に3回実行した中央値です。

| ツール | 経過時間 | プロセスの最大RSS |
| --- | ---: | ---: |
| tsc 5.9.3 | 0.547秒 | 319.0 MB |
| tsrs 0.18.0・TypeScript 7.1開発版 | 0.053秒 | 78.4 MB |

3回すべての測定を非公開のローカル証拠に保持しています。OSキャッシュは消去していません。
コンパイラーの世代と標準ライブラリーが異なるため、Rust単独の効果を測った対照実験や、完全な互換性の証明ではありません。
ブラウザの起動・動作速度、開発全体の時間、LSPや他の機器は測定していません。
tscを必須の検査に残し、[既知の互換性の制約](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md)を確認しながらtsrsを評価します。
