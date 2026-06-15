# AgentNest 仕様書

---

## 目次

- [概要](#概要)
  - [想定ユースケース](#想定ユースケース)
  - [利用環境](#利用環境)
- [画面構成](#画面構成)
  - [UI 要件](#ui-要件)
- [運用制約](#運用制約)
  - [シングルセッション制](#シングルセッション制)
- [バックエンド API](#バックエンド-api)
  - [`POST /api/chat`](#post-apichat)
  - [`POST /api/permission`](#post-apipermission)
  - [`GET /api/repos`](#get-apirepos)
  - [`GET /api/status`](#get-apistatus)
- [設定](#設定)
  - [ベースディレクトリ](#ベースディレクトリ)
- [Claude Agent SDK 連携](#claude-agent-sdk-連携)
  - [基本呼び出し](#基本呼び出し)
  - [動作](#動作)
- [今後の拡張候補](#今後の拡張候補)

---


## 概要

AgentNest は、ブラウザから Claude Code を操作する汎用 Web インターフェース。
VSCode を使えないユーザーでも、ブラウザのチャット UI から Claude Code と対話的に作業できる。

### 想定ユースケース

- **ブログ記事投稿**: iPhone から Google Photos URL を貼って記事生成・公開（blog リポジトリの `/post` コマンド相当）
- **仕様書生成**: PID リポジトリのコード・DB定義を読み取り、テンプレートに沿った画面仕様書を生成
- **汎用**: 任意のリポジトリに対して Claude Code の全機能を利用

### 利用環境

- **サーバ**: ローカルマシン（macOS）で手動起動
- **アクセス**: Tailscale VPN 経由で外部（iPhone等）からアクセス
- **認証**: Claude Code の Max サブスクリプション（サーバマシンにログイン済み）

> **システム構成・技術スタック・ディレクトリ構成・開発コマンド**については [CLAUDE.md](../CLAUDE.md) を参照。

---

## 画面構成

画面の詳細設計は [設計-画面.md](設計-画面.md) を参照。

### UI 要件

- **レスポンシブ**: iPhone Safari で快適に操作できること
- **リポジトリ選択**: ヘッダーのドロップダウンで対象リポジトリを切り替え
- **ストリーミング表示**: Claude Code の出力をリアルタイムでチャットに表示
- **Markdown レンダリング**: Claude の応答中の Markdown をリッチ表示
- **セッション管理**: リポジトリごとにセッションを維持（対話の継続）
- **新規セッション**: 「新しい会話」ボタンでセッションをリセット
- **権限承認 UI**: Claude Code がツール使用（ファイル書き込み、コマンド実行等）の許可を求めた場合、ブラウザ上に承認/拒否のプロンプトを表示する

---

## 運用制約

### シングルセッション制

サーバは同時に **1つのセッション** のみ処理する。

- 新しいリクエストが来たら、進行中のセッションを無条件で中断（abort）し、新しいセッションに切り替える
- 接続が切れた場合（iPhone スリープ、ネットワーク断等）、再接続すると進行中のセッションに復帰できる
- セッションがハングした場合は、サーバを再起動して復旧する（Tailscale SSH 経由）

---

## バックエンド API

### `POST /api/chat`

チャットメッセージを送信し、Claude Code の応答をストリーミングで返す。

**リクエスト:**
```json
{
  "message": "出荷画面の仕様書を作って",
  "repoId": "pid",
  "sessionId": "abc-123"
}
```

**レスポンス:** SSE ストリーム
```
data: {"type": "text", "content": "DBLayout.dbml を確認しています..."}
data: {"type": "text", "content": "出荷関連のテーブルを特定しました。"}
data: {"type": "permission", "toolName": "write", "description": "posts/2026-03-25.md を作成", "requestId": "req-456"}
data: {"type": "done", "sessionId": "abc-123"}
```

### `POST /api/permission`

権限承認リクエストに応答する。

**リクエスト:**
```json
{
  "requestId": "req-456",
  "approved": true
}
```

### `GET /api/repos`

`BASE_PROJECT_DIR` 環境変数で指定されたディレクトリ直下のディレクトリ一覧を動的に取得して返す。
設定ファイルによる静的定義は不要。

**レスポンス:**
```json
[
  { "id": "blog", "name": "blog", "path": "/path/to/projects/blog" },
  { "id": "PID", "name": "PID", "path": "/path/to/projects/PID" },
  { "id": "AgentNest", "name": "AgentNest", "path": "/path/to/projects/AgentNest" }
]
```

### `GET /api/status`

現在のセッション状態を返す（再接続時に使用）。

**レスポンス:**
```json
{
  "active": true,
  "repoId": "blog",
  "sessionId": "abc-123",
  "pendingPermission": null
}
```

---

## 設定

### ベースディレクトリ

選択可能なリポジトリは `BASE_PROJECT_DIR` 環境変数で指定されたディレクトリ直下に限定される。
サーバ起動時にこのパス配下のディレクトリを動的にスキャンし、リポジトリ一覧を生成する。

- `.env` ファイルに `BASE_PROJECT_DIR=/path/to/your/projects` を設定（`.env.example` を参照）
- 静的な `config.json` でのリポジトリ定義は不要
- ポート番号等の設定は環境変数または起動引数で指定（デフォルト: 3000）

---

## Claude Agent SDK 連携

### 基本呼び出し

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// セッション開始（新規）
const stream = query({
  prompt: message,
  options: {
    cwd: repo.path, // リポジトリルートで実行
  },
});

for await (const msg of stream) {
  console.log(msg);
}

// セッション継続
const resumedStream = query({
  prompt: message,
  options: {
    cwd: repo.path,
    resume: sessionId, // 前回のセッションを引き継ぐ
  },
});
```

### 動作

- Claude Code SDK は指定された `cwd` のリポジトリで動作する
- CLAUDE.md を自動で読み込み、プロジェクトのルール・ガイドに従う
- ファイルの読み書き、コード探索、git 操作を自律的に行う
- `/post` 等のカスタムコマンド相当の処理も、プロンプトで指示すれば実行可能

---

---

## 今後の拡張候補

- **画像アップロード**: iPhone から直接画像をアップロード（Google Photos URL 不要に）
- **通知**: 長時間処理の完了をプッシュ通知
- **複数ユーザー対応**: 簡易認証の追加
