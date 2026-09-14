import { Router } from "express";
import { getClientId } from "./connectionId.js";
import { listAgents, deleteOwnedAgent, sanitizeId, gcSessions } from "../claude/executor.js";

const router = Router();

// GET /api/agents: 自分（X-Client-Id）が所有するAgentの一覧を返す。
// タブを閉じてagentIdを紛失しても、この一覧から選んで /api/reconnect に戻れるようにするための入口。
router.get("/api/agents", (req, res) => {
  // agentId/clientId分離対応: X-Client-Id が無い/不正な場合は400
  const clientId = getClientId(req, res);
  if (!clientId) {
    res.status(400).json({ error: "X-Client-Id header is required" });
    return;
  }

  // GCの起動トリガー: gcSessions() は元々 executeChat（新規Agent作成時）からしか
  // 呼ばれておらず、SESSION_GC_TTL_MS を2時間に延長したことで「大量のAgentが完了した後、
  // 誰も新規Agentを起こさない」期間はメモリを掴み続けたまま放置される問題があった。
  // この一覧取得エンドポイントはフロントが6秒間隔でポーリングする副作用のない読み取り経路
  // なので、ここにもGCを載せることで放置時でも定期的に掃除が回るようにする
  // （setIntervalは増やさない方針のまま、既存のポーリングに便乗する形）。
  // 処理コストは現状の規模（SESSION_MAX_COUNT=20程度）では軽量（gcSessions の doc comment 参照）。
  // 一覧を返す前にGCを行うことで、掃除済みの状態を反映した一覧を返す。
  gcSessions();

  // listAgents は要約型（AgentSummary）のみ返す。pendingPermissionの中身（ツール入力等）は
  // 一覧に含めない設計（executor.ts の toAgentSummary 参照）。
  res.json({ agents: listAgents(clientId) });
});

// DELETE /api/agents/:agentId: 所有者のAgentを明示的に破棄する（abort + Mapからの削除）。
// 他clientIdのagentIdは404（存在を秘匿する。他ルートと同じ方針）。
router.delete("/api/agents/:agentId", (req, res) => {
  const clientId = getClientId(req, res);
  if (!clientId) {
    res.status(400).json({ error: "X-Client-Id header is required" });
    return;
  }

  // :agentId はパスパラメータでありヘッダではないため getAgentId（ヘッダ専用）は使わず、
  // 同じUUID検証を行う sanitizeId を直接使う。不正形式は存在しないagentIdと同様に404にする
  // （形式エラーで400にすると、不正な値かどうかで応答が変わり存在の秘匿方針とずれるため）。
  const agentId = sanitizeId(req.params.agentId);
  const deleted = agentId ? deleteOwnedAgent(clientId, agentId) : false;
  if (!deleted) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json({ deleted: true });
});

export default router;
