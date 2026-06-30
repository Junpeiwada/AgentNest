# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

開発に関する詳細な仕様・設計・ガイドは `Docs/` 配下を参照。主要なもの:

- [Docs/仕様-AgentNest全体.md](Docs/仕様-AgentNest全体.md) — 全体仕様
- [Docs/仕様-Gitタブ.md](Docs/仕様-Gitタブ.md) — Gitタブ（`/git` ルート、`server/routes/git.ts`）
- [Docs/仕様-モデル選択.md](Docs/仕様-モデル選択.md) — モデル選択（`server/routes/models.ts`、起動時に `supportedModels()` で取得しキャッシュ）
- [Docs/仕様-実行モード選択.md](Docs/仕様-実行モード選択.md) — 実行モード選択（`ModeSelector.tsx`）
- [Docs/設計-URL.md](Docs/設計-URL.md) / [Docs/設計-画面.md](Docs/設計-画面.md) — URL・画面設計
- [Docs/ガイド-テスト.md](Docs/ガイド-テスト.md) / [Docs/ガイド-運用.md](Docs/ガイド-運用.md) — テスト・運用ガイド
- [Docs/ガイド-署名と公証.md](Docs/ガイド-署名と公証.md) — macOSコード署名・公証（Developer ID、notarization、書類フォルダTCC対策）

`Docs/` の各Markdownの見出しを変更したら、[Tools/GenDocsToc/gen_toc.py](Tools/GenDocsToc/gen_toc.py) で目次を再生成する（冪等）:

```bash
Tools/.venv/bin/python Tools/GenDocsToc/gen_toc.py Docs/*.md
```

## 重大なルール

### テスト修正の禁止（確認必須）
テストコード（`tests/`配下）を編集する前に、必ず [Docs/ガイド-テスト.md](Docs/ガイド-テスト.md) を参照すること。ユーザーの明示的な承認なしにテストコードをEdit/Writeしてはならない。

## 開発コマンド

```bash
# 開発（サーバー + フロントエンド同時起動）
npm run dev

# サーバーのみ（tsx watch、ポート3000）
npm run 開発:サーバーのみ

# フロントエンドのみ（Vite、ポート5173）
npm run 開発:フロントエンドのみ

# Tauriアプリとして開発起動
npm run 開発:Tauriアプリ

# プロダクションビルド（フロントエンドのみ）
npm run build

# Tauriアプリビルド（署名付き）
npm run ビルド:Tauriアプリ

# ビルド→/Applicationsにインストール
npm run ビルド:インストール

# プロダクション起動（ビルド済みフロントエンド必須）
npm start

# テスト（Playwright E2E）
npm test

# テスト（UI モード）
npm run テスト:UIモード

# 単一テスト実行
npx playwright test tests/chat.spec.ts

# フロントエンドのlint
cd frontend && npm run lint
```

**セットアップ**: `npm install && cd frontend && npm install`

## リリース手順

`npm run リリース`（`scripts/release.sh`）で自動リリースされる。

### 前提条件
- GitHub CLI（`gh`）が認証済み
- Tauri署名秘密鍵（updater用minisign）が `~/.tauri/AgentNest.key` に配置済み（環境変数 `TAURI_SIGNING_PRIVATE_KEY` でも可）
- Rust（cargo）がインストール済み
- Appleコード署名・公証（macOS配布で必須。詳細は [Docs/ガイド-署名と公証.md](Docs/ガイド-署名と公証.md)）
  - Keychainに `Developer ID Application: Junpei Wada (L897K2C26B)` 証明書（`tauri.conf.json` の `bundle.macOS.signingIdentity`）
  - 公証用 App Store Connect API キー情報を `~/.tauri/AgentNest.notary.env` に配置（未設定なら公証なしでビルド続行）

### release.sh の処理フロー
1. `npm version patch` でバージョンを自動インクリメント
2. バージョン変更をコミット＆タグ作成
3. `tauri.conf.json` から署名IDを展開し、`~/.tauri/AgentNest.notary.env` から公証情報を読み込み
4. フロントエンドビルド → Tauriビルド（Developer ID署名 + hardened runtime、バンドル内ネイティブ`.node`署名、公証＋staple）
5. `codesign --verify` / `stapler validate` で署名・公証を検証（失敗で中断）
6. GitHub Releasesにdraftリリース作成
7. DMG、`.app.tar.gz`（updater用）、`latest.json` をアップロード
8. 現在のブランチとタグをpush
9. リリースを公開
10. 古いリリースを自動削除（最新のみ保持）

### 自動更新の仕組み
- Tauri updater プラグインが `https://github.com/Junpeiwada/AgentNest/releases/latest/download/latest.json` を参照
- `latest.json` にはバージョン、署名、ダウンロードURLが含まれる
- アプリ内の「更新を確認」ボタンで更新チェック→ダウンロード→再起動で適用
- 署名検証あり（公開鍵は `src-tauri/tauri.conf.json` の `plugins.updater.pubkey`）

### 署名キーの再生成（紛失時）
```bash
npx tauri signer generate -w ~/.tauri/AgentNest.key
```
生成後、公開鍵（`.key.pub`）を `src-tauri/tauri.conf.json` の `pubkey` に設定すること。既存ユーザーは旧キーで署名されたバージョンから更新できなくなるため注意。

## アーキテクチャ

ブラウザからClaude Codeを操作するWebインターフェース。Express APIサーバーがClaude Code SDKを呼び出し、SSE（Server-Sent Events）でフロントエンドにリアルタイムストリーミングする構成。Tauriでデスクトップアプリとしても配布。

### 全体構成

```
AgentNest/
├── server/           # Express APIサーバー
│   ├── index.ts      # アプリ起動、静的ファイル配信、ルートマウント
│   ├── config.ts     # 環境設定（BASE_PROJECT_DIR等）
│   ├── claude/
│   │   ├── executor.ts        # 中核。SDK query()ラッパー、SSE送信、セッション管理、権限フロー
│   │   └── commandExpander.ts # .claude/commands/ スラッシュコマンド展開
│   └── routes/       # chat, repos, sessions, files, permission, reconnect, status, git, models
├── frontend/         # React SPA
│   └── src/
│       ├── hooks/useChat.ts   # SSEストリーム処理・再接続。フロントエンドの中核
│       ├── hooks/             # useGitStatus, useGitHistory, useWakeLock 等
│       ├── components/        # Chat, MessageList, MessageInput, PermissionDialog, ModeSelector, SettingsPanel 等
│       ├── pages/             # ChatPlaceholder, FilesPage, GitPage, RepoRedirect
│       ├── layouts/           # RootLayout, MinimalLayout
│       └── router.tsx         # React Router v7
├── src-tauri/        # Tauriデスクトップアプリ（Rust）
│   ├── src/server.rs # 内蔵Expressサーバーのプロセス管理
│   └── tauri.conf.json
└── tests/            # Playwright E2Eテスト
```

### フロントエンドルーティング（React Router v7）

```
/ (MinimalLayout) → RepoRedirect（リポジトリ自動選択）
/:repo (RootLayout)
  ├── /chat            # チャット画面
  ├── /chat/:sessionId # セッション復元
  ├── /files           # ファイルブラウザ
  ├── /files/*         # ネストされたファイルパス
  └── /git             # Gitタブ（status / 履歴）
```

### 主要な通信フロー

1. ユーザーがメッセージ送信 → POST `/api/chat` （SSEレスポンス）
2. サーバーが `executor.ts` でClaude Code SDK `query()` を実行
3. SSEイベントタイプ: `text`, `activity`, `tool_result`, `permission`, `done`, `error`, `session_id`, `limit_error`
4. ツール実行時に権限要求 → `permission` イベント → フロントエンドでダイアログ表示 → POST `/api/permission` で承認/拒否
5. 切断時は `/api/reconnect` で状態スナップショットを取得し再接続（最大3回リトライ）

### Tauriデスクトップアプリ

- Expressサーバーをバンドルしたバイナリとして内蔵し、アプリ起動時に子プロセスとして起動（`src-tauri/src/server.rs`）
- フロントエンドはTauriウィンドウ内で表示
- ビルドパイプライン: フロントエンドビルド → サーバーバンドル（`scripts/build-server.mjs`） → Tauriビルド（署名付き）
- 自動更新: GitHub Releasesの `latest.json` を参照、署名検証あり

### 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React 19, Vite 8, MUI 7, react-markdown |
| バックエンド | Express 5, tsx (実行), TypeScript |
| デスクトップ | Tauri 2 (Rust) |
| AI | @anthropic-ai/claude-agent-sdk |
| リアルタイム通信 | Server-Sent Events |
| テスト | Playwright（E2E、Chromiumのみ） |

### 設計上の注意点

- セッション状態はサーバーのインメモリ変数 `currentSession` で管理（シングルユーザー前提）
- 開発時はViteプロキシ（`/api` → `localhost:3000`）でCORS回避
- プロダクションではExpressがフロントエンドの静的ファイルも配信
- リポジトリのベースパスは環境変数 `BASE_PROJECT_DIR`（`.env`で設定、`.env.example`参照）
- テストはAPIモックベース（`page.route()` でSSEレスポンスをモック）
