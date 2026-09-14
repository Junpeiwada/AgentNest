import { useCallback, useEffect, useRef, useState } from "react";
import { useClientId } from "./useClientId";

/**
 * `GET /api/agents` が返す1件分の要約。
 * サーバ側の `AgentSummary`（server/claude/executor.ts）とフィールドを合わせる。
 */
export interface AgentSummary {
  agentId: string;
  repoId: string;
  sessionId: string | null;
  completed: boolean;
  createdAt: number;
  lastActiveAt: number;
  hasPendingPermission: boolean;
  hasPendingQuestion: boolean;
}

// ポーリング間隔: 実行中Agent一覧はHeaderのバッジ・ポップオーバー表示にしか使わない
// 補助的な情報で、リアルタイム性は不要（本流のチャットはSSEで別途リアルタイム更新される）。
// 一方であまり長いと「別タブで起こしたAgentが一覧に出るまでのラグ」が気になる。
// 双方のバランスで6秒とする（5〜10秒の常識的な範囲の下寄り）。
const POLL_INTERVAL_MS = 6_000;

/**
 * 自分（clientId）が所有する実行中/完了済みAgentの一覧を購読するフック。
 *
 * ポーリングで `GET /api/agents` を叩き続け、Headerのバッジ・ポップオーバーの
 * データ源になる。手動再取得用に `refresh` も公開し、ポップオーバーを開いた
 * 瞬間や破棄操作の直後など「今すぐ最新化したい」場面で使えるようにする。
 */
export function useAgents() {
  const clientId = useClientId();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // 実行中(completed=false)の件数。Headerのバッジ表示に使う。
  const runningCount = agents.filter((a) => !a.completed).length;

  // fetch中に古いレスポンスが後から届いて新しい状態を上書きしないためのガード
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const res = await fetch("/api/agents", {
        headers: { "X-Client-Id": clientId },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== requestSeqRef.current) return; // 追い越された古いレスポンスは無視
      setAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch {
      // サーバ未起動・一時的なネットワーク断は無視して次回ポーリングに委ねる
    } finally {
      if (seq === requestSeqRef.current) setIsLoading(false);
    }
  }, [clientId]);

  // レビュー指摘#6: バックグラウンドタブでもポーリングが動き続けると、iPhoneから
  // Tailscale経由で使う運用で電池消費に効く。document.visibilityStateがvisibleのときだけ
  // 実際に取得し、非表示中はタイマー自体を止める（単に取得をスキップするだけだと
  // setIntervalの発火自体は継続してしまい省電力効果が薄いため、タイマーごと止める）。
  // visibilitychangeで復帰した瞬間は次のポーリングを待たず即座に再取得する。
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (timer !== null) return;
      timer = setInterval(refresh, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") {
      refresh();
      startPolling();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopPolling();
    };
  }, [refresh]);

  /** 指定Agentを破棄する（DELETE /api/agents/:agentId）。成功したら一覧も即時更新する。 */
  const deleteAgent = useCallback(
    async (agentId: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
          method: "DELETE",
          headers: { "X-Client-Id": clientId },
        });
        if (res.ok) await refresh();
        return res.ok;
      } catch {
        return false;
      }
    },
    [clientId, refresh]
  );

  return { agents, runningCount, isLoading, refresh, deleteAgent };
}
