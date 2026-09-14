import { Router } from "express";
import { getClientId, getAgentId } from "./connectionId.js";
import { getOwnedSession, interruptOwnedSession } from "../claude/executor.js";

const router = Router();

router.get("/api/status", (req, res) => {
  // X-Client-Id / X-Agent-Id が無い場合は「セッション無し」として扱い、400にはしない。
  // このエンドポイントは Tauri の内蔵サーバ起動待ち（src-tauri/src/server.rs の wait_for_server）が
  // ヘルスチェックとして叩いており、reqwest はヘッダを付けない。400にするとアプリが起動不能になる。
  const clientId = getClientId(req, res);
  const agentId = getAgentId(req);
  if (!clientId || !agentId) {
    res.json({ active: false });
    return;
  }

  // 所有者チェックは getOwnedSession に集約する。他clientIdのagentIdは「存在しない」と同じ扱い。
  const session = getOwnedSession(clientId, agentId);
  if (!session) {
    res.json({ active: false });
    return;
  }
  res.json({
    active: true,
    repoId: session.repoId,
    sessionId: session.sessionId,
    pendingPermission: session.pendingPermission,
  });
});

router.post("/api/interrupt", async (req, res) => {
  // agentId/clientId分離対応: X-Client-Id が無い/不正な場合は400
  const clientId = getClientId(req, res);
  if (!clientId) {
    res.status(400).json({ error: "X-Client-Id header is required" });
    return;
  }

  // X-Agent-Id は必須（明示的に指定されたAgentのみ中断する。他Agentを巻き込まない）。
  const agentId = getAgentId(req);
  if (!agentId) {
    res.status(400).json({ error: "X-Agent-Id header is required" });
    return;
  }

  // stillQueued が非空なら停止しきれていない（キューに残る処理がある）。
  // 既存クライアント互換のため interrupted は従来どおり返し、詳細を追加フィールドで渡す。
  // 所有者チェックは interruptOwnedSession に集約する。
  const { interrupted, stillQueued } = await interruptOwnedSession(clientId, agentId);
  res.json({ interrupted, stillQueued });
});

export default router;
