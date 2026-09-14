import { Router } from "express";
import { getClientId, getAgentId } from "./connectionId.js";
import { subscribeOwnedSession, log as serverLog } from "../claude/executor.js";

const router = Router();

router.get("/api/reconnect", (req, res) => {
  // agentId/clientId分離対応: X-Client-Id が無い/不正な場合は400
  const clientId = getClientId(req, res);
  if (!clientId) {
    res.status(400).json({ error: "X-Client-Id header is required" });
    return;
  }

  // 一覧APIはフェーズ3で追加する。それまでは名指し必須にする（欠落は400）。
  const agentId = getAgentId(req);
  if (!agentId) {
    res.status(400).json({ error: "X-Agent-Id header is required" });
    return;
  }

  serverLog("RECONNECT_ATTEMPT", { clientId, agentId, timestamp: new Date().toISOString() });

  // 所有者チェックは subscribeOwnedSession に集約する。他clientIdのagentIdは
  // 「存在しない」のと区別せず404にする（存在を秘匿するため403ではなく404）。
  const sub = subscribeOwnedSession(clientId, agentId);
  if (!sub) {
    serverLog("RECONNECT_NOT_FOUND", { clientId, agentId, message: "No owned session found" });
    res.status(404).json({ error: "No active session" });
    return;
  }

  const { session, addListener, unsubscribe } = sub;

  serverLog("RECONNECT_OK", {
    clientId,
    agentId,
    sessionId: session.sessionId,
    completed: session.completed,
    partsCount: session.assistantMessage.parts.length,
  });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setTimeout(0); // SSE接続のタイムアウトを無効化
  res.flushHeaders();

  let connectionOpen = true;

  const send = (data: object) => {
    if (!connectionOpen) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      serverLog("RECONNECT_WRITE_ERROR", { type: (data as any).type, error: String(err) });
      connectionOpen = false;
    }
  };

  // Send current state snapshot so the client can restore its UI
  send({
    type: "reconnect_state",
    // P4-5: 復帰先リポジトリの照合用。フロントは現在表示中のrepoIdと一致しない場合、
    // 「他Agentと混線させない」ため復帰を中止する（静かに諦める）。
    repoId: session.repoId,
    sessionId: session.sessionId,
    assistantMessage: session.assistantMessage,
    // P4-2根本対応: ユーザーの元発言を復帰時に画面へ復元するため、そのまま渡す。
    // 取得できた場合はフロント側で「実行中だった会話を再開しました」の注記を不要にできる。
    lastUserMessage: session.lastUserMessage,
    pendingPermission: session.pendingPermission,
    pendingQuestion: session.pendingQuestion,
    completed: session.completed,
  });

  // If session already completed, close immediately
  if (session.completed) {
    send({ type: "done", sessionId: session.sessionId });
    res.end();
    return;
  }

  const keepalive = setInterval(() => {
    if (!connectionOpen) return;
    try {
      res.write(": keepalive\n\n");
    } catch (err) {
      serverLog("RECONNECT_KEEPALIVE_ERROR", { error: String(err) });
      connectionOpen = false;
    }
  }, 15_000);

  // 以降のイベントを購読する。
  // 終端イベント（done / error）を受け取ったら購読を解除してストリームを閉じる。
  // 閉じないと session.listeners にリスナーが残り続け、executor 側のGC
  // （完了済みかつ購読者なしのセッションを破棄する処理）が永久に動かない。
  // クライアント側も reader.read() で待ち続けて再接続処理が終わらなくなる。
  addListener((data) => {
    send(data);
    const type = (data as { type?: string }).type;
    if (type === "done" || type === "error") {
      clearInterval(keepalive);
      unsubscribe();
      connectionOpen = false;
      try { res.end(); } catch { /* 既に閉じていれば無視 */ }
    }
  });

  req.on("close", () => {
    serverLog("RECONNECT_CLIENT_DISCONNECT", { clientId, agentId, sessionId: session.sessionId });
    connectionOpen = false;
    clearInterval(keepalive);
    unsubscribe();
  });
});

export default router;
