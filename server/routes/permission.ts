import { Router } from "express";
import { getConnectionId } from "./connectionId.js";
import { resolvePermission, resolveQuestion } from "../claude/executor.js";

const router = Router();

router.post("/api/permission", (req, res) => {
  // マルチセッション対応: X-Connection-Id が無い/不正な場合は400
  const connectionId = getConnectionId(req, res);
  if (!connectionId) {
    res.status(400).json({ error: "X-Connection-Id header is required" });
    return;
  }

  const { requestId, approved, answers, annotations } = req.body;

  if (!requestId) {
    res.status(400).json({ error: "requestId is required" });
    return;
  }

  // AskUserQuestion の回答（answers が undefined でない = question への応答）
  if (answers !== undefined) {
    const isDeny = typeof answers === "object" && answers !== null && Object.keys(answers).length === 0;
    const resolved = resolveQuestion(
      connectionId,
      requestId,
      isDeny ? {} : answers as Record<string, string>,
      isDeny ? undefined : annotations as Record<string, { notes?: string }> | undefined,
      isDeny
    );
    if (!resolved) {
      res.status(404).json({ error: "No pending question with this requestId" });
      return;
    }
    res.json({ ok: true });
    return;
  }

  if (typeof approved !== "boolean") {
    res.status(400).json({ error: "approved or answer is required" });
    return;
  }

  const resolved = resolvePermission(connectionId, requestId, approved);
  if (!resolved) {
    res.status(404).json({ error: "No pending permission with this requestId" });
    return;
  }

  res.json({ ok: true });
});

export default router;
