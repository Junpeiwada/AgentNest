import { Router } from "express";
import { getSession, interruptSession } from "../claude/executor.js";

const router = Router();

router.get("/api/status", (_req, res) => {
  const session = getSession();
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

router.post("/api/interrupt", async (_req, res) => {
  // stillQueued が非空なら停止しきれていない（キューに残る処理がある）。
  // 既存クライアント互換のため interrupted は従来どおり返し、詳細を追加フィールドで渡す。
  const { interrupted, stillQueued } = await interruptSession();
  res.json({ interrupted, stillQueued });
});

export default router;
