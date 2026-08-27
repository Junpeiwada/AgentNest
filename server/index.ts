import "./config.js"; // Load .env before anything else
import { CLAUDE_CLI_PATH } from "./config.js";
import express from "express";
import cors from "cors";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import reposRouter from "./routes/repos.js";
import statusRouter from "./routes/status.js";
import chatRouter from "./routes/chat.js";
import permissionRouter from "./routes/permission.js";
import reconnectRouter from "./routes/reconnect.js";
import sessionsRouter from "./routes/sessions.js";
import filesRouter from "./routes/files.js";
import gitRouter from "./routes/git.js";
import modelsRouter from "./routes/models.js";
import { prefetchModels, sanitizeConnectionId } from "./claude/executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));

// マルチセッション対応: HTTPヘッダ `X-Connection-Id`（タブ・端末ごとのUUID）を検証し res.locals に格納する。
// このミドルウェア自体は 400 を返さない（connectionId を使わないルートもあるため）。
// 実際に connectionId を要求するルート（chat/reconnect/permission/status）側で
// res.locals.connectionId が null なら 400 を返す。
app.use((req, res, next) => {
  res.locals.connectionId = sanitizeConnectionId(req.header("X-Connection-Id"));
  next();
});

// API routes
app.use(reposRouter);
app.use(statusRouter);
app.use(chatRouter);
app.use(permissionRouter);
app.use(reconnectRouter);
app.use(sessionsRouter);
app.use(filesRouter);
app.use(gitRouter);
app.use(modelsRouter);

// Serve frontend static files in production
// バンドル版（dist-server/frontend/dist/）と開発版（../frontend/dist/）の両方に対応
const frontendDistBundled = path.join(__dirname, "frontend/dist");
const frontendDist = existsSync(frontendDistBundled)
  ? frontendDistBundled
  : path.join(__dirname, "../frontend/dist");
// assetsはハッシュ付きなので長期キャッシュOK、HTMLはキャッシュしない
app.use("/assets", express.static(path.join(frontendDist, "assets"), { maxAge: "1y" }));
app.use(express.static(frontendDist, { etag: false, lastModified: false, maxAge: 0 }));
app.get("/{*path}", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(frontendDist, "index.html"));
});

// errorイベントを先に登録し、listenの前にエラーを捕捉する
const server = app.listen(PORT, "0.0.0.0");

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    let detail = `ポート ${PORT} は既に使用されています`;
    try {
      const out = execFileSync("lsof", ["-i", `:${PORT}`, "-sTCP:LISTEN", "-Fn", "-Fp"], { encoding: "utf-8" });
      const pidMatch = out.match(/^p(\d+)$/m);
      if (pidMatch) {
        const pid = pidMatch[1];
        let processName = "不明";
        try {
          processName = execFileSync("ps", ["-p", pid, "-o", "ucomm="], { encoding: "utf-8" }).trim();
        } catch { /* ignore */ }
        detail += ` (プロセス: ${processName}, PID: ${pid})`;
      }
    } catch { /* lsof失敗時は基本メッセージのみ */ }
    console.error(detail);
    if (typeof process.send === "function") {
      process.send({ type: "error", message: detail });
    }
  } else {
    console.error("サーバーエラー:", err.message);
    if (typeof process.send === "function") {
      process.send({ type: "error", message: err.message });
    }
  }
  process.exit(1);
});

server.on("listening", () => {
  console.log(`AgentNest server running on http://0.0.0.0:${PORT}`);
  // Claude Code CLI はユーザー環境のものを使う（SDK同梱バイナリは非同梱）。
  // 未解決だと query() がCLI起動に失敗するため、起動時に明示する。
  if (CLAUDE_CLI_PATH) {
    console.log(`Claude Code CLI: ${CLAUDE_CLI_PATH}`);
  } else {
    console.error(
      "警告: Claude Code CLI (`claude`) が見つかりません。チャットは動作しません。\n" +
        "  公式インストーラで Claude Code を導入するか、環境変数 CLAUDE_CLI_PATH で実行ファイルのパスを指定してください。"
    );
  }
  if (typeof process.send === "function") {
    process.send({ type: "ready", port: PORT });
  }
  // モデル一覧を非ブロッキングでプリフェッチ（起動を遅らせず、失敗してもサーバは継続）
  prefetchModels().catch(() => {});
});

// サーバークラッシュ防止: 未処理のエラーをログして継続
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED_REJECTION]", reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT_EXCEPTION]", err);
  process.exit(1);
});
