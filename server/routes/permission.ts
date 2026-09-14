import { Router } from "express";
import { getClientId, getAgentId } from "./connectionId.js";
import { resolveOwnedPermission, resolveOwnedQuestion } from "../claude/executor.js";

const router = Router();

router.post("/api/permission", (req, res) => {
  // agentId/clientId分離対応: X-Client-Id が無い/不正な場合は400
  const clientId = getClientId(req, res);
  if (!clientId) {
    res.status(400).json({ error: "X-Client-Id header is required" });
    return;
  }

  // X-Agent-Id は必須（どのAgentへの応答かを名指しする）。欠落・不正は400。
  const agentId = getAgentId(req);
  if (!agentId) {
    res.status(400).json({ error: "X-Agent-Id header is required" });
    return;
  }

  const { requestId, approved, answers, annotations } = req.body;

  if (!requestId) {
    res.status(400).json({ error: "requestId is required" });
    return;
  }

  // 所有者チェックは Owned 系ラッパー（resolveOwnedPermission / resolveOwnedQuestion）に集約する。
  // 他 clientId の agentId・requestId は404で弾く（存在を秘匿する）。

  // AskUserQuestion の回答（answers が undefined でない = question への応答）
  if (answers !== undefined) {
    const isDeny = typeof answers === "object" && answers !== null && Object.keys(answers).length === 0;
    const resolved = resolveOwnedQuestion(
      clientId,
      agentId,
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

  const resolved = resolveOwnedPermission(clientId, agentId, requestId, approved);
  if (!resolved) {
    res.status(404).json({ error: "No pending permission with this requestId" });
    return;
  }

  res.json({ ok: true });
});

export default router;
