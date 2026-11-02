# 実装言語の選定

[English](0001-language.md) | [日本語](0001-language.ja.md)

## 要件

ブラウザーアプリ、ローカル実行ハーネス、既存のネイティブ実験を保持し、開発設定を再現可能にします。

## 候補

既存の TypeScript、Go、Swift の構成と、単一言語へ統合する構成を比較します。

## 選定理由

ブラウザーと Workers は TypeScript、ハーネスは Go、Apple の実験は Swift を継続します。
mise-project で既存のブラウザーとハーネスの検証を共通タスクへ接続します。
ブラウザーの操作性が承認されるまではネイティブ機能開発を保留します。
Apple の検証は既存の専用 macOS CI とローカルタスクで維持し、共通 Linux CI では Swift の検証を行ったと扱いません。
