import { Router } from "express";
import { getConnectionId } from "./connectionId.js";
import { getSession, interruptSession } from "../claude/executor.js";

const router = Router();

router.get("/api/status", (req, res) => {
  // X-Connection-Id が無い場合は「セッション無し」として扱い、400にはしない。
  // このエンドポイントは Tauri の内蔵サーバ起動待ち（src-tauri/src/server.rs の wait_for_server）が
  // ヘルスチェックとして叩いており、reqwest はヘッダを付けない。400にするとアプリが起動不能になる。
  const connectionId = getConnectionId(req, res);
  if (!connectionId) {
    res.json({ active: false });
    return;
  }

  const session = getSession(connectionId);
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
  // マルチセッション対応: X-Connection-Id が無い/不正な場合は400
  const connectionId = getConnectionId(req, res);
  if (!connectionId) {
    res.status(400).json({ error: "X-Connection-Id header is required" });
    return;
  }

  // stillQueued が非空なら停止しきれていない（キューに残る処理がある）。
  // 既存クライアント互換のため interrupted は従来どおり返し、詳細を追加フィールドで渡す。
  const { interrupted, stillQueued } = await interruptSession(connectionId);
  res.json({ interrupted, stillQueued });
});

export default router;
