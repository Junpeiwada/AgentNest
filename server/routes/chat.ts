import { Router } from "express";
import { getClientId } from "./connectionId.js";
import {
  executeChat as executeChatCore,
  getOwnedSession,
  log as serverLog,
  sanitizeId,
  sanitizeModelOptions,
  sanitizePermissionMode,
  AgentNotFoundError,
  type ChatCallbacks,
  type ImageData,
  type ModelOptions,
  type PermissionMode,
} from "../claude/executor.js";
import { expandSlashCommand as defaultExpandSlashCommand } from "../claude/commandExpander.js";
import { BASE_DIR } from "../config.js";

// agentId/clientId分離対応（フェーズ2）: API契約を X-Client-Id + body.agentId に切り替えた。
// executor.ts の executeChat は「継続対象を明示的に指定したときだけその Agent を中断する」設計
// なので、ExecuteChatFn もそれをそのまま反映するシグネチャにする。フェーズ1にあった
// 「同一clientIdの最新Agentへ常に委譲する」アダプタ（後勝ちabortの意図的な再現）は廃止した。
// これにより同一 clientId から複数 Agent を並行起動しても、明示的に名指ししない限り
// 互いに中断されない。
export type ExecuteChatFn = (
  clientId: string,
  continueAgentId: string | null,
  message: string,
  repoId: string,
  repoPath: string,
  resumeSessionId: string | null,
  permissionMode: PermissionMode,
  callbacks: ChatCallbacks,
  images?: ImageData[],
  modelOptions?: ModelOptions
) => Promise<string>;
export type ExpandSlashCommandFn = typeof defaultExpandSlashCommand;

const defaultExecuteChat: ExecuteChatFn = executeChatCore;

export function createChatRouter(
  executeChatFn: ExecuteChatFn = defaultExecuteChat,
  expandSlashCommandFn: ExpandSlashCommandFn = defaultExpandSlashCommand,
) {
  const router = Router();

  router.post("/api/chat", async (req, res) => {
    // agentId/clientId分離対応: X-Client-Id が無い/不正な場合は、SSEヘッダを送る前に400を返す
    const clientId = getClientId(req, res);
    if (!clientId) {
      res.status(400).json({ error: "X-Client-Id header is required" });
      return;
    }

    const { message, repoId, sessionId, permissionMode, images, model, effort, agentId } = req.body;

    if (!message || !repoId) {
      res.status(400).json({ error: "message and repoId are required" });
      return;
    }

    // body.agentId は継続対象の明示指定。省略/nullなら新規Agentを起こす。
    // 他のヘッダ（X-Client-Id等）と同様に sanitizeId でUUID形式を検証する。
    // 形式が不正なら「指定なし」と同義に扱う（新規発行に倒し、他Agentを誤って巻き込まない）。
    // なお形式が正しくても所有権（clientId一致）の検証は executeChatFn 側（executeChat）が行い、
    // 不一致・不存在は AgentNotFoundError として投げられる（下のSSE開始前チェックで404にする）。
    const continueAgentId = sanitizeId(agentId);

    // 継続対象の所有権はSSEヘッダを送る前に検証する。不存在・他clientId所有のどちらであっても
    // 404を返す（存在有無を区別すると、他人のagentIdが実在するかどうかを推測できてしまうため、
    // 理由を秘匿して一律404にする——計画書「他人のAgentへの操作は404で秘匿」の方針）。
    // executeChat 内でも同じ検証を行い AgentNotFoundError を投げるが、SSE開始後では
    // HTTPステータスを変えられないため、ここで事前チェックしてステータス404で返せるようにする。
    if (continueAgentId && !getOwnedSession(clientId, continueAgentId)) {
      res.status(404).json({ error: "Agent not found" });
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
    let resolvedAgentId: string | null = null;
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

    executeChatFn(clientId, continueAgentId, prompt, repoId, repoPath, sessionId ?? null, safePermissionMode, {
      // executor.ts がセッション生成直後・他のどのコールバックよりも先に呼ぶ。
      // フロントが以降のリクエストで X-Agent-Id としてこのAgentを名指しできるようにする。
      onAgentId: (agentId) => {
        resolvedAgentId = agentId;
        send({ type: "agent_id", agentId });
      },
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
        serverLog("SSE_DONE", { clientId, agentId: resolvedAgentId, sessionId: sid, connectionOpen });
        send({ type: "done", sessionId: sid });
        if (connectionOpen) {
          try { res.end(); } catch {}
        }
      },
      onError: (error) => {
        clearInterval(keepalive);
        serverLog("SSE_ERROR", { clientId, agentId: resolvedAgentId, error, connectionOpen });
        send({ type: "error", error });
        if (connectionOpen) {
          try { res.end(); } catch {}
        }
      },
    }, images, modelOptions).catch((err) => {
      clearInterval(keepalive);
      // AgentNotFoundError は本来SSE開始前のgetOwnedSessionチェックで弾かれ404で返る想定だが、
      // チェックとexecuteChat内検証の間でセッションが破棄される等のレースに備えた保険。
      // SSEを開始済みのためHTTPステータスは変更できず、errorイベントで通知するに留める。
      const isAgentNotFound = err instanceof AgentNotFoundError;
      serverLog(isAgentNotFound ? "SSE_AGENT_NOT_FOUND" : "SSE_UNHANDLED_ERROR", { clientId, agentId: resolvedAgentId, name: err?.name, message: err?.message, stack: err?.stack });
      send({ type: "error", error: isAgentNotFound ? "Agent not found" : (err?.message ?? "Internal server error") });
      if (connectionOpen) {
        try { res.end(); } catch {}
      }
    });

    // Handle client disconnect — session continues for reconnection
    req.on("close", () => {
      serverLog("SSE_CLIENT_DISCONNECT", { clientId, agentId: resolvedAgentId, repoId, sessionId: sessionId ?? null, elapsedSec: Math.round((Date.now() - sseStartTime) / 1000) });
      connectionOpen = false;
      clearInterval(keepalive);
    });
  });

  return router;
}

export default createChatRouter();
