# 実装言語の選定

[English](0001-language.md) | [日本語](0001-language.ja.md)

## 要件

ブラウザアプリ、開発ハーネス、既存の Apple アプリを同じリポジトリで維持します。
ブラウザ版を先に受け入れる条件と、各コンポーネントの既存検証を保持します。

## 候補

TypeScript はブラウザ API とアプリ内の型共有に適しています。
Go は単体の開発ハーネス、Swift は Apple フレームワークとの連携に適しています。
単一言語への統一には、すでに動くコンポーネントの置き換えが必要です。

## 選定理由

ブラウザ版に TypeScript、`harness/` に Go、`apple/` に Swift を継続します。
dev-standards の主プロファイルを `node-npm` とし、Go/Swift パッケージを companion として宣言します。
追加タスクは既存の Go 整形・vet・race テストと、Swift パッケージのテスト・macOS ビルドを実行します。
ネイティブ UI の受け入れ、iOS ビルド、性能ベンチマークの成功を意味しません。
Swift companion の検証により、共通 standards ワークフローの実行対象は現在 macOS に限定されます。
既存の Linux ブラウザ/Go CI と Apple CI は維持します。
