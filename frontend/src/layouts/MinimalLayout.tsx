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

  const handleRepoChange = useCallback((newRepoId: string) => {
    setResumeSessionId(null);
    setNewChatNonce((n) => n + 1);
    navigate(chatPath(newRepoId));
  }, [navigate]);

  const handleNewChat = useCallback(() => {
    setResumeSessionId(null);
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
      navigate(chatSessionPath(repoId, sessionId));
    }
  }, [navigate, repoId]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Header
        repoId={repoId}
        onRepoChange={handleRepoChange}
        onNewChat={handleNewChat}
        onResumeSession={handleResumeSession}
      />
      <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <Outlet context={{ newChatNonce, resumeSessionId }} />
      </Box>
    </ThemeProvider>
  );
}
