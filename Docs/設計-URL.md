# URL設計

---

## 目次

- [設計思想](#設計思想)
  - [原則](#原則)
- [URL体系](#url体系)
  - [ルート一覧](#ルート一覧)
  - [sessionID の扱い](#sessionid-の扱い)
- [Chatの再マウント制御](#chatの再マウント制御)
  - [chatKey の算出（核心）](#chatkey-の算出核心)
  - [再マウントが発生するケースと発生しないケース](#再マウントが発生するケースと発生しないケース)
  - [URL同期の方法](#url同期の方法)
- [ナビゲーションフロー](#ナビゲーションフロー)

---


## 設計思想

**チャットのライフサイクルとURLルーティングを分離する。**

チャットコンポーネントはSSEストリーミング接続を持つステートフルなコンポーネントであり、URL遷移による意図しない再マウントで接続が切断されてはならない。チャットの再マウントは「明示的なユーザーアクション」（新規作成・履歴選択・リポジトリ変更）のときのみ発生させる。

### 原則

1. **Chatは明示的な操作（New / History選択）がない限りアンマウントしない**: URL遷移、タブ切り替え、ブラウザの戻る/進む、いずれもChatを破壊しない。これにより進行中のSSEストリーミングやチャット表示が保持される
2. **Chatの再マウントトリガーは3つだけ**: 新規チャット作成（New）、履歴からのセッション選択（History）、リポジトリ変更
3. **URLは状態の「反映」であり「駆動源」ではない**: chatKeyの算出にURLパラメータを使わない
4. **ファイルタブのナビゲーションはURLベース**: 戻る/進むが自然に機能する

## URL体系

### ルート一覧

| URL パターン | 画面 | 例 |
|---|---|---|
| `/` | リポジトリ未選択 | -- |
| `/:repo/chat` | チャット（新規 or 進行中） | `/AgentNest/chat` |
| `/:repo/chat/:sessionId` | チャット（セッション復帰） | `/AgentNest/chat/abc123` |
| `/:repo/files` | ファイル一覧（ルート） | `/AgentNest/files` |
| `/:repo/files/*path` | ファイル一覧 or ファイル閲覧 | `/AgentNest/files/src/App.tsx` |

### sessionID の扱い

- **新規チャット開始時**: URLは `/:repo/chat` のまま変えない
- **会話中にsessionIdが確定しても**: URLを変更しない（`navigate()` を呼ばない）
- **セッション履歴から選択時**: `/:repo/chat/:sessionId` に遷移し、メッセージfetch後にChatを再マウント
- **理由**: SSEストリーミング中にReact Routerの `navigate()` を実行すると、URLパラメータの変化 → chatKeyの変化 → Chatの再マウント → SSE接続切断という連鎖が発生する

## Chatの再マウント制御

### chatKey の算出（核心）

```
chatKey = urlSessionIdからではなく、明示的アクションから算出する

- 新規チャット: `new:{repoId}:{newChatNonce}`
- 履歴復帰:     `session:{sessionId}`    （fetchedSessionから取得）
- リポジトリ変更: repoId変更でnonce更新 → 新規チャットと同じ
```

**重要**: `chatKey` の算出にURL由来の値（`useParams` の `:sessionId`）を直接使わない。代わりに、明示的なアクション（ボタンクリック、履歴選択）が発生したときにのみstateを更新し、そのstateからchatKeyを算出する。

### 再マウントが発生するケースと発生しないケース

| 操作 | chatKey変化 | 再マウント |
|---|---|---|
| メッセージ送信（sessionId確定） | 変化なし | しない |
| ファイルタブ → チャットタブ | 変化なし | しない |
| チャットタブ → ファイルタブ | 変化なし | しない |
| ファイルタブ内で戻る/進む | 変化なし | しない |
| ブラウザリロード | -- | 初回マウント |
| 「新規チャット」ボタン | nonce更新 | する |
| 履歴からセッション選択 | sessionId変更 | する |
| リポジトリ変更 | repoId変更 | する |

### URL同期の方法

チャットの状態変化に伴うURL更新は `window.history.replaceState` を使い、React Routerのナビゲーションを**バイパス**する。これにより、URLバーの表示は更新されるが、React Routerの再レンダリングは発生しない。

```ts
// sessionId確定時のURL同期（再マウントを起こさない）
onSessionIdChange={(sessionId) => {
  if (sessionId) {
    const newUrl = `/${encodeURIComponent(repoId)}/chat/${encodeURIComponent(sessionId)}`;
    window.history.replaceState(null, "", newUrl);
  }
}}
```

一方、以下の場合はReact Routerの `navigate()` を使う（意図的な再マウントが必要なため）：
- 履歴からセッション選択 → `navigate(`/:repo/chat/:sessionId`)`
- ファイルタブ切り替え → `navigate(`/:repo/files`)`
- リポジトリ変更 → `navigate(`/:newRepo/chat`)`

## ナビゲーションフロー

```
ユーザー操作                          URL変化                    Chat再マウント
───────────────────────────────────────────────────────────────────────────
アプリ起動                            /AgentNest/chat             初回マウント
メッセージ送信 → sessionId確定         /AgentNest/chat             なし（URLも変えない）
「ファイル」タブクリック                /AgentNest/files            なし（display:none）
「src」フォルダクリック                /AgentNest/files/src        なし
ブラウザ「戻る」                       /AgentNest/files            なし
「チャット」タブクリック                /AgentNest/chat             なし（display:flex）
セッション履歴から選択                 /AgentNest/chat/abc123      する（navigate）
「新規チャット」ボタン                 /AgentNest/chat             する（nonce更新）
リポジトリ切り替え(MyProject)          /MyProject/chat             する（repoId変更）
```

> 実装方針（ルート定義・RootLayout責務・状態管理等）は実装完了済みのため [アーカイブ/実装方針-URL.md](アーカイブ/実装方針-URL.md) に移動。
