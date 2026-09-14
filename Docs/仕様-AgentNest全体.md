# AgentNest 仕様書

---

## 目次

- [概要](#概要)
  - [想定ユースケース](#想定ユースケース)
  - [利用環境](#利用環境)
- [画面構成](#画面構成)
  - [UI 要件](#ui-要件)
- [運用制約](#運用制約)
  - [マルチセッション制](#マルチセッション制)
- [バックエンド API](#バックエンド-api)
  - [共通: `X-Client-Id` / `X-Agent-Id` ヘッダ](#共通-x-client-id--x-agent-id-ヘッダ)
  - [`POST /api/chat`](#post-apichat)
  - [`POST /api/permission`](#post-apipermission)
  - [`GET /api/repos`](#get-apirepos)
  - [`GET /api/status`](#get-apistatus)
  - [`GET /api/reconnect`](#get-apireconnect)
  - [`POST /api/interrupt`](#post-apiinterrupt)
  - [`GET /api/agents`](#get-apiagents)
  - [`DELETE /api/agents/:agentId`](#delete-apiagentsagentid)
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

### マルチセッション制

サーバは `agentId`（実行1本ごと）と `clientId`（ブラウザ単位の所有者）の2つのIDでセッションを分離し、**複数の端末・タブから同時に利用でき、1タブから複数リポジトリのAgentを並行実行できる**。

- **`clientId`**: ブラウザ単位で不変の UUID。フロントが `localStorage`（キー `agentnest.clientId`）に保持し、チャット系 API すべてに HTTP ヘッダ `X-Client-Id` で載せる（`frontend/src/hooks/useClientId.ts`）。「このブラウザが自分のAgentだと主張してよい単位」であり、同一ブラウザの複数タブで共有されて構わない
- **`agentId`**: Claude Code の実行1本ごとにサーバが発行する UUID。サーバ内部の `Map<agentId, Session>`（`server/claude/executor.ts`）のキーそのもので、以降のリクエストは `X-Agent-Id` ヘッダで対象を名指しする
- `POST /api/chat` は body の `agentId` で継続対象を指定できる（省略時は新規Agentを発行）。**後勝ちabortは廃止**しており、送信しても他の実行中Agentは自動で中断されない。中断するには明示的に `POST /api/interrupt` を叩くか、そのAgentを名指しする必要がある
- 接続が切れた場合（iPhone スリープ、ネットワーク断、タブを閉じる等）、`X-Client-Id` と `X-Agent-Id` を付けて `GET /api/reconnect` すると、自分のAgentにだけ復帰できる。`agentId` を忘れても `GET /api/agents` の一覧から選び直せる
- セッション状態はサーバのインメモリで保持し、永続化しない。サーバを再起動すると実行中の状態は失われる（会話履歴は Claude Code CLI の JSONL に残るため、会話の再開自体は可能）
- 完了済みで購読者のいないAgentは一定時間（2時間）後に破棄される。同時Agent数には `clientId` 単位の上限（8本）と、全clientIdを横断する全体上限（20本）の二段構えがあり、`clientId` 単位の上限を超えても他人の `clientId` のAgentは一切破棄されない
- **認証は行わない**。Tailscale VPN の内側で使う前提であり、`clientId` はAgentの所有者識別が目的でアクセス制御ではない。`localStorage` の値を知られれば他人のAgentを操作できる点は `connectionId` 時代と同じ前提だが、Agentの寿命が延びた分、漏洩の影響が持続する期間も長くなる
- セッションがハングした場合は、サーバを再起動して復旧する（Tailscale SSH 経由）

---

## バックエンド API

### 共通: `X-Client-Id` / `X-Agent-Id` ヘッダ

チャット系 API（`/api/chat`・`/api/reconnect`・`/api/permission`・`/api/interrupt`・`/api/status`・`/api/agents`）は、
リクエストヘッダ `X-Client-Id` にクライアントが発行した UUID を必要とする。サーバはこの値を所有者（`clientId`）
として扱う。欠落している場合や UUID 形式でない場合は `400` を返す（`GET /api/status` は例外、後述）。

対象のAgentを名指しする必要があるエンドポイント（`/api/reconnect`・`/api/permission`・`/api/interrupt`）は、
加えて `X-Agent-Id` ヘッダで `agentId`（サーバが実行1本ごとに発行するUUID。Mapのキー）を指定する。
欠落・不正形式は `400`。`X-Client-Id` が一致しない `agentId`（他人のAgent）を指定した場合は、
存在の有無を秘匿するため `404` を返す（`403` にはしない）。

`POST /api/chat` は `X-Agent-Id` ヘッダではなく、body の `agentId` で継続対象を指定する（後述）。
`X-Connection-Id` ヘッダは廃止しており、送っても無視される（`clientId`/`agentId` としては扱われない）。

```
X-Client-Id: 11111111-1111-1111-1111-111111111111
X-Agent-Id: 22222222-2222-2222-2222-222222222222
```

`GET /api/status` だけは例外で、ヘッダが無ければ（あるいは指定した `agentId` を所有していなければ）
`400` ではなく `{ "active": false }` を返す。Tauri の内蔵サーバ起動待ち（`src-tauri/src/server.rs` の
`wait_for_server`）がこのエンドポイントをヘルスチェックとして使っており、ヘッダを送らないため。

クライアントは `clientId` をブラウザ単位で `localStorage`（キー `agentnest.clientId`）に保持する
（`frontend/src/hooks/useClientId.ts`）。タブを閉じても再訪時に同じ値が使われる。`agentId` は
`POST /api/chat` の応答（SSEの `agent_id` イベント）で受け取り、`useChat`（`frontend/src/hooks/useChat.ts`）が
state として保持して以降のリクエストの `X-Agent-Id` に使う。

### `POST /api/chat`

チャットメッセージを送信し、Claude Code の応答をストリーミングで返す。`X-Client-Id` ヘッダが必須。

**リクエスト:**
```json
{
  "message": "出荷画面の仕様書を作って",
  "repoId": "pid",
  "sessionId": "abc-123",
  "agentId": "22222222-2222-2222-2222-222222222222"
}
```

- `agentId`（任意）: 継続したい既存Agentの指定。省略・null・不正形式なら新規Agentを発行する
- `agentId` を指定したが `X-Client-Id` の所有物でない（存在しない、または他人のAgent）場合は、SSEを開始する前に `404` を返す
- 新規発行・継続のいずれでも、他の実行中Agentは自動では中断されない（後勝ちabortの廃止）

**レスポンス:** SSE ストリーム。先頭で必ず `agent_id` イベントが送られる。
```
data: {"type": "agent_id", "agentId": "22222222-2222-2222-2222-222222222222"}
data: {"type": "text", "content": "DBLayout.dbml を確認しています..."}
data: {"type": "text", "content": "出荷関連のテーブルを特定しました。"}
data: {"type": "permission", "toolName": "write", "toolInput": {...}, "requestId": "req-456"}
data: {"type": "done", "sessionId": "abc-123"}
```

### `POST /api/permission`

権限承認リクエストに応答する。`X-Client-Id` + `X-Agent-Id` が必須。`requestId` が対象 `agentId` に
存在しない、または他 `clientId` の所有であれば `404`。

**リクエスト:**
```json
{
  "requestId": "req-456",
  "approved": true
}
```

AskUserQuestion への回答の場合は `approved` の代わりに `answers`（と任意で `annotations`）を送る。

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

`X-Client-Id` + `X-Agent-Id` で指定したAgentの状態を返す（再接続時に使用）。他人のAgentの情報は返らない。
ヘッダが欠落している場合、または指定した `agentId` を所有していない場合は `400` ではなく
`{ "active": false }` を返す（Tauriのヘルスチェック互換のため。上記共通セクション参照）。

**レスポンス:**
```json
{
  "active": true,
  "repoId": "blog",
  "sessionId": "abc-123",
  "pendingPermission": null
}
```

### `GET /api/reconnect`

切断中に進んでいた分の状態スナップショットを受け取り、以降のイベントを購読し直す。
`X-Client-Id` + `X-Agent-Id` が必須（いずれか欠落・不正形式は `400`）。指定した `agentId` が
存在しない、または他 `clientId` の所有であれば `404`。

**レスポンス:** SSE ストリーム。先頭に現在の状態がまとめて送られ、以降は `/api/chat` と同じイベントが続く。
```
data: {"type": "reconnect_state", "repoId": "blog", "sessionId": "abc-123", "assistantMessage": {...}, "lastUserMessage": "出荷画面の仕様書を作って", "pendingPermission": null, "pendingQuestion": null, "completed": false}
data: {"type": "text", "content": "続きの応答..."}
data: {"type": "done", "sessionId": "abc-123"}
```

- `repoId`: 復帰先の照合用。フロントは現在表示中のリポジトリと一致しない場合、他Agentとの混線を避けるため復帰を静かに中止する
- `lastUserMessage`: 復帰時に画面へ表示するため、切断前の最後のユーザー発言をそのまま返す

### `POST /api/interrupt`

`X-Client-Id` + `X-Agent-Id` で指定したAgentの実行中クエリに割り込む。いずれか欠落は `400`。
他 `clientId` の `agentId` を指定した場合の扱いは所有チェックに委ねる（他Agentは中断されない）。

**レスポンス:**
```json
{
  "interrupted": true,
  "stillQueued": []
}
```

`stillQueued` は割り込み後も残る非同期メッセージの uuid。非空なら停止しきれていないことを意味する。

### `GET /api/agents`

`X-Client-Id` が所有する実行中・完了済みAgentの一覧を返す。フロントは6秒間隔でポーリングし、
Header のバッジ・ポップオーバー表示（`AgentList.tsx`）とタブ復帰後の自動再接続の入口に使う。
呼び出しのたびにGC（`gcSessions`）が走る。`X-Client-Id` が欠落・不正形式なら `400`。

**レスポンス:**
```json
{
  "agents": [
    {
      "agentId": "22222222-2222-2222-2222-222222222222",
      "repoId": "blog",
      "sessionId": "abc-123",
      "completed": false,
      "createdAt": 1757840000000,
      "lastActiveAt": 1757840123000,
      "hasPendingPermission": false,
      "hasPendingQuestion": false
    }
  ]
}
```

並び順は「実行中(`completed: false`)を先に、その中で `createdAt` 降順」。`pendingPermission` /
`pendingQuestion` の中身（ツール名・入力、質問文）は一覧には含めない。有無だけを
`hasPendingPermission` / `hasPendingQuestion` で示し、詳細が必要な場合は該当Agentに
`GET /api/reconnect` または `GET /api/status` で個別に取得する。他 `clientId` のAgentは含まれない。

### `DELETE /api/agents/:agentId`

`X-Client-Id` が所有するAgentを明示的に破棄する（実行中なら中断してからMapから削除）。
他 `clientId` の `agentId` を指定した場合、および存在しない `agentId` の場合はいずれも `404`
（存在を秘匿する）。

**レスポンス:**
```json
{ "deleted": true }
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
