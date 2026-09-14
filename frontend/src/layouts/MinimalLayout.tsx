import { useState, useCallback } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { chatPath, chatSessionPath } from "../utils/paths";
import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { theme } from "../theme";
import Header from "../components/Header";

export default function MinimalLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  // URLの最初のセグメントからリポジトリ名を取得
  const firstSegment = location.pathname.split("/")[1] ?? "";
  const repoId = firstSegment ? decodeURIComponent(firstSegment) : "";

  const [newChatNonce, setNewChatNonce] = useState(0);
  // 履歴から選択されたセッションID（URLではなくstateで管理）
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  // Agent一覧（AgentList）から選択された復帰先。agentIdだけでなく、選択時点の
  // targetRepoIdもペアで保持する（RootLayout側でrepoIdが遷移後の値に追いつくまで
  // 復帰を開始させないためのガードに使う。詳細はRootLayoutのコメント参照）。
  const [resumeAgent, setResumeAgent] = useState<{ repoId: string; agentId: string } | null>(null);

  const handleRepoChange = useCallback((newRepoId: string) => {
    setResumeSessionId(null);
    setResumeAgent(null);
    setNewChatNonce((n) => n + 1);
    navigate(chatPath(newRepoId));
  }, [navigate]);

  const handleNewChat = useCallback(() => {
    setResumeSessionId(null);
    setResumeAgent(null);
    setNewChatNonce((n) => n + 1);
    if (repoId) {
      navigate(chatPath(repoId));
    } else {
      navigate("/");
    }
  }, [navigate, repoId]);

  const handleResumeSession = useCallback((sessionId: string) => {
    if (repoId) {
      setResumeSessionId(sessionId);
      setResumeAgent(null);
      navigate(chatSessionPath(repoId, sessionId));
    }
  }, [navigate, repoId]);

  // AgentList から実行中Agentを選んだときの復帰処理。
  // 該当リポジトリの /chat へ遷移し、resumeAgent（{repoId, agentId}）をセットして
  // RootLayout 側の useChat に自動復帰（reconnect）させる。resumeSessionId とは排他
  // （履歴復帰と衝突しない）。newChatNonceも併せてインクリメントする。RootLayoutの
  // chatKeyはresumeAgent.agentIdとnewChatNonceの両方を含めるため、同じagentIdを
  // 続けて選び直した場合でも（agentId自体は変化しなくても）確実にChatが再マウントされ、
  // useChat内の自動復帰effectが毎回起動する。
  //
  // 別リポジトリのAgentを選んだ場合、この時点ではまだnavigate前でURLは旧リポジトリの
  // ままだが、targetRepoIdをresumeAgentに含めて渡すことで、RootLayout側は
  // useParams()の repoId が navigate 後の値に追いつくまで、この復帰要求を
  // 「自分宛て」として扱わずに待てるようになる（マウントタイミングの問題を解消）。
  const handleResumeAgent = useCallback((targetRepoId: string, agentId: string) => {
    setResumeSessionId(null);
    setResumeAgent({ repoId: targetRepoId, agentId });
    setNewChatNonce((n) => n + 1);
    navigate(chatPath(targetRepoId));
  }, [navigate]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Header
        repoId={repoId}
        onRepoChange={handleRepoChange}
        onNewChat={handleNewChat}
        onResumeSession={handleResumeSession}
        onResumeAgent={handleResumeAgent}
      />
      <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <Outlet context={{ newChatNonce, resumeSessionId, resumeAgent }} />
      </Box>
    </ThemeProvider>
  );
}
