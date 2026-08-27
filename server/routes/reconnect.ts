import { Router } from "express";
import { getConnectionId } from "./connectionId.js";
import { subscribeToSession, getSession, log as serverLog } from "../claude/executor.js";

const router = Router();

router.get("/api/reconnect", (req, res) => {
  // マルチセッション対応: X-Connection-Id が無い/不正な場合は400
  const connectionId = getConnectionId(req, res);
  if (!connectionId) {
    res.status(400).json({ error: "X-Connection-Id header is required" });
    return;
  }

  const currentSessionExists = !!getSession(connectionId);
  serverLog("RECONNECT_ATTEMPT", { connectionId, timestamp: new Date().toISOString(), currentSessionExists });

  const sub = subscribeToSession(connectionId);
  if (!sub) {
    serverLog("RECONNECT_NO_SESSION", { connectionId, currentSessionExists, message: "No active session found" });
    res.status(404).json({ error: "No active session" });
    return;
  }

  const { session, addListener, unsubscribe } = sub;

  serverLog("RECONNECT_OK", {
    connectionId,
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
    sessionId: session.sessionId,
    assistantMessage: session.assistantMessage,
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
    serverLog("RECONNECT_CLIENT_DISCONNECT", { connectionId, sessionId: session.sessionId });
    connectionOpen = false;
    clearInterval(keepalive);
    unsubscribe();
  });
});

export default router;
