import { Router } from "express";
import { getConnectionId } from "./connectionId.js";
import { executeChat as defaultExecuteChat, log as serverLog, sanitizeModelOptions, sanitizePermissionMode } from "../claude/executor.js";
import { expandSlashCommand as defaultExpandSlashCommand } from "../claude/commandExpander.js";
import { BASE_DIR } from "../config.js";

export type ExecuteChatFn = typeof defaultExecuteChat;
export type ExpandSlashCommandFn = typeof defaultExpandSlashCommand;

export function createChatRouter(
  executeChatFn: ExecuteChatFn = defaultExecuteChat,
  expandSlashCommandFn: ExpandSlashCommandFn = defaultExpandSlashCommand,
) {
  const router = Router();

  router.post("/api/chat", async (req, res) => {
    // マルチセッション対応: X-Connection-Id が無い/不正な場合は、SSEヘッダを送る前に400を返す
    const connectionId = getConnectionId(req, res);
    if (!connectionId) {
      res.status(400).json({ error: "X-Connection-Id header is required" });
      return;
    }

    const { message, repoId, sessionId, permissionMode, images, model, effort } = req.body;

    if (!message || !repoId) {
      res.status(400).json({ error: "message and repoId are required" });
      return;
    }

    // 外部入力の model/effort/permissionMode はサーバ側で検証・正規化（信頼境界）
    const modelOptions = sanitizeModelOptions({ model, effort });
    const safePermissionMode = sanitizePermissionMode(permissionMode);

    const repoPath = `${BASE_DIR}/${repoId}`;

    // スラッシュコマンドを展開
    const { prompt } = await expandSlashCommandFn(message, repoPath);

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setTimeout(0); // SSE接続のタイムアウトを無効化
    res.flushHeaders();

    let connectionOpen = true;
    const sseStartTime = Date.now();

    const send = (data: object, flush = false) => {
      if (!connectionOpen) return;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (flush && typeof (res as any).flush === "function") {
          (res as any).flush();
        }
      } catch (err) {
        serverLog("SSE_WRITE_ERROR", { type: (data as any).type, error: String(err) });
        connectionOpen = false;
      }
    };

    // 15秒ごとにkeepaliveを送信（SSE接続維持）
    const keepalive = setInterval(() => {
      if (!connectionOpen) return;
      try {
        res.write(": keepalive\n\n");
      } catch (err) {
        serverLog("SSE_KEEPALIVE_ERROR", { error: String(err) });
        connectionOpen = false;
      }
    }, 15_000);

    executeChatFn(connectionId, prompt, repoId, repoPath, sessionId ?? null, safePermissionMode, {
      onText: (content) => {
        send({ type: "text", content });
      },
      onActivity: (activity) => {
        send({ type: "activity", activity });
      },
      onToolResult: (result) => {
        send({ type: "tool_result", toolName: result.toolName, content: result.content, filePath: result.filePath, structuredPatch: result.structuredPatch, toolInput: result.toolInput });
      },
      onLimitError: (error) => {
        send({ type: "limit_error", error });
      },
      onSessionId: (sessionId) => {
        send({ type: "session_id", sessionId });
      },
      onPermission: (permission) => {
        console.log("[PERMISSION]", permission.toolName, "requestId:", permission.requestId, "connectionOpen:", connectionOpen);
        send({
          type: "permission",
          toolName: permission.toolName,
          toolInput: permission.toolInput,
          requestId: permission.requestId,
        }, true);
      },
      onQuestion: (q) => {
        send({ type: "question", requestId: q.requestId, questions: q.questions }, true);
      },
      onSessionState: (state) => {
        send({ type: "session_state", state });
      },
      onToolProgress: ({ toolUseId, toolName, elapsedSeconds }) => {
        send({ type: "tool_progress", toolUseId, toolName, elapsedSeconds });
      },
      onDone: (sid) => {
        clearInterval(keepalive);
        serverLog("SSE_DONE", { connectionId, sessionId: sid, connectionOpen });
        send({ type: "done", sessionId: sid });
        if (connectionOpen) {
          try { res.end(); } catch {}
        }
      },
      onError: (error) => {
        clearInterval(keepalive);
        serverLog("SSE_ERROR", { connectionId, error, connectionOpen });
        send({ type: "error", error });
        if (connectionOpen) {
          try { res.end(); } catch {}
        }
      },
    }, images, modelOptions).catch((err) => {
      clearInterval(keepalive);
      serverLog("SSE_UNHANDLED_ERROR", { connectionId, name: err?.name, message: err?.message, stack: err?.stack });
      send({ type: "error", error: err?.message ?? "Internal server error" });
      if (connectionOpen) {
        try { res.end(); } catch {}
      }
    });

    // Handle client disconnect — session continues for reconnection
    req.on("close", () => {
      serverLog("SSE_CLIENT_DISCONNECT", { connectionId, repoId, sessionId: sessionId ?? null, elapsedSec: Math.round((Date.now() - sseStartTime) / 1000) });
      connectionOpen = false;
      clearInterval(keepalive);
    });
  });

  return router;
}

export default createChatRouter();
