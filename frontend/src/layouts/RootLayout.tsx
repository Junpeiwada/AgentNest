import { useEffect, useRef, useState, useMemo } from "react";
import { Outlet, useNavigate, useLocation, useParams, useOutletContext } from "react-router-dom";
import { Box } from "@mui/material";
import ChatRoundedIcon from "@mui/icons-material/ChatRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import CallSplitRoundedIcon from "@mui/icons-material/CallSplitRounded";
import Chat from "../components/Chat";
import type { Message } from "../hooks/useChat";
import { chatPath, chatSessionPath, filesPath, gitPath, repoNavPrefix, apiSessionMessagesPath } from "../utils/paths";

interface ParentContext {
  newChatNonce: number;
  resumeSessionId: string | null;
  // Agent一覧から選択された復帰先。{repoId, agentId}のペアで受け取り、
  // このrepoIdが自分（useParamsのrepoId）と一致するまではresumeAgentIdとして
  // 有効化しない（下記のバグ修正コメント参照）。
  resumeAgent: { repoId: string; agentId: string } | null;
}

interface FetchedSession {
  sessionId: string;
  messages: Message[];
}

export default function RootLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { repo } = useParams<{ repo: string }>();
  const repoId = repo ?? "";
  const { newChatNonce, resumeSessionId, resumeAgent } = useOutletContext<ParentContext>();

  // バグ修正: Header の Agent一覧から「現在表示中とは別のリポジトリ」のAgentを選んで
  // 復帰しようとすると、静かに失敗していた。
  //
  // 原因: MinimalLayout.handleResumeAgent は同一イベント内で resumeAgentId のセットと
  // navigate(chatPath(targetRepoId)) を呼ぶが、resumeAgentId は useOutletContext 経由
  // （MinimalLayoutのstate、同期的に反映）で届く一方、この repoId は useParams()
  // （React Routerのルート一致、navigate後の再レンダーまで古い値のまま）から取れるため、
  // 両者の反映タイミングがずれる。その結果、下のchatKeyがresumeAgentId基準で先に変化して
  // Chatが再マウントされる瞬間の repoId がまだ遷移前（古いリポジトリ）のままになり、
  // useChat.ts の自動復帰effectが古いrepoIdをexpectedRepoIdとして/api/reconnectを呼び、
  // サーバが返すreconnect_state.repoId（新リポジトリ）と食い違って「repoId不一致」の
  // ガードに自分で引っかかり、復帰が握りつぶされていた
  // （そのガード自体は「別リポジトリのAgentと混線しない」ための正しい挙動であり、
  // 問題はマウントのタイミング側にあった）。
  //
  // 対策: resumeAgentをそのまま使わず、resumeAgent.repoIdが現在のrepoId（useParams由来、
  // navigate後に追いつく値）と一致する場合のみ有効なresumeAgentIdとして扱う。
  // 不一致の間はresumeAgentIdをnullのまま維持するため、chatKeyもagentId基準に
  // 切り替わらず、古いrepoIdのままChatが再マウントされることがない。
  // repoIdが追いついた次のレンダーで一致し、そこで初めてresumeAgentIdが有効になり
  // Chatが正しいrepoId・agentIdの組で再マウントされる。
  const resumeAgentId = resumeAgent && resumeAgent.repoId === repoId ? resumeAgent.agentId : null;

  const isFilesTab = location.pathname.includes("/files");
  const isGitTab = location.pathname.includes("/git");
  const activeTab = isGitTab ? "git" : isFilesTab ? "files" : "chat";

  // ファイルタブの最後のパスを記憶（タブ切替時にルートに戻らないようにする）
  const lastFilesPath = useRef(filesPath(repoId));
  useEffect(() => {
    if (isFilesTab) {
      lastFilesPath.current = location.pathname;
    }
  }, [location.pathname, isFilesTab]);

  // --- Chat state（常にマウント）---
  const [fetchedSession, setFetchedSession] = useState<FetchedSession | null>(null);

  // セッション復帰: resumeSessionId（stateで管理）が変わった場合のみメッセージ履歴をfetch
  useEffect(() => {
    if (!resumeSessionId) return;

    let cancelled = false;
    fetch(apiSessionMessagesPath(repoId, resumeSessionId))
      .then((r) => (r.ok ? r.json() : []))
      .then((messages: Message[]) => {
        if (!cancelled) {
          setFetchedSession({ sessionId: resumeSessionId, messages });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedSession({ sessionId: resumeSessionId, messages: [] });
        }
      });

    return () => { cancelled = true; };
  }, [resumeSessionId, repoId]);

  // useMemoで参照を安定させる（毎レンダーで新しい[]を生成するとuseChat内のeffectが誤発火してSSE接続が切断される）
  // fetchedSessionが現在のresumeSessionIdと一致する場合のみメッセージを返す（staleデータ防止）
  const initialMessages = useMemo(
    () => {
      if (!resumeSessionId) return [];
      if (fetchedSession?.sessionId === resumeSessionId) return fetchedSession.messages;
      return [];
    },
    [resumeSessionId, fetchedSession]
  );
  const initialSessionId = resumeSessionId ?? null;
  const chatReady = !resumeSessionId || fetchedSession?.sessionId === resumeSessionId;
  // chatKey: resumeSessionId自体を使い、fetchの完了/未完了でキーが変わらないようにする
  // （"loading" → 実IDへの変化でChatが再マウントされSSE接続が切断されるのを防ぐ）
  // resumeAgentId（上でrepoId一致確認済みの復帰先。上のコメント参照）が指定された
  // 場合もキーに含め、同じリポジトリ内での選択であっても確実にChatを再マウントして
  // useChatの自動復帰effect（マウント時に一度だけ動く）を起動させる。
  // resumeAgentIdはrepoIdと一致した場合のみ非nullになるため、ここで改めてrepoIdを
  // キーに含めなくても、有効化された時点のrepoIdは常に現在のものと一致している。
  // newChatNonceも併せて含める: MinimalLayoutのhandleResumeAgentは選択のたびに
  // newChatNonceもインクリメントするため、同じagentIdを続けて選び直した場合でも
  // （resumeAgentId自体は変わらなくても）chatKeyが変わり確実に再マウントされる。
  const chatKey = resumeSessionId
    ? `session:${resumeSessionId}`
    : resumeAgentId
      ? `agent:${resumeAgentId}:${newChatNonce}`
      : `new:${repoId}:${newChatNonce}`;

  // --- Tabs ---
  const tabs = [
    { key: "chat" as const, label: "チャット", icon: <ChatRoundedIcon sx={{ fontSize: 18 }} /> },
    { key: "files" as const, label: "ファイル", icon: <FolderRoundedIcon sx={{ fontSize: 18 }} /> },
    { key: "git" as const, label: "Git", icon: <CallSplitRoundedIcon sx={{ fontSize: 18 }} /> },
  ];

  const handleTabClick = (tabKey: "chat" | "files" | "git") => {
    if (tabKey === "files") {
      const prefix = repoNavPrefix(repoId);
      const target = lastFilesPath.current.startsWith(prefix)
        ? lastFilesPath.current
        : filesPath(repoId);
      navigate(target);
    } else if (tabKey === "git") {
      navigate(gitPath(repoId));
    } else {
      // チャットタブ: 現在のチャット状態を維持したままURLだけ戻す（再マウントしない）
      navigate(resumeSessionId ? chatSessionPath(repoId, resumeSessionId) : chatPath(repoId));
    }
  };

  return (
    <>
      {/* Tab Bar */}
      <Box
        sx={(theme) => ({
          display: "flex",
          borderBottom: `1px solid ${theme.palette.border}`,
          bgcolor: "background.paper",
          flexShrink: 0,
          px: { xs: 1, sm: 2 },
        })}
      >
        {tabs.map((tab) => (
          <Box
            key={tab.key}
            onClick={() => handleTabClick(tab.key)}
            sx={(theme) => ({
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              px: { xs: 1.5, sm: 2 },
              py: 1,
              cursor: "pointer",
              userSelect: "none",
              fontSize: "13px",
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? theme.palette.accent.main : theme.palette.text.secondary,
              borderBottom: "2px solid",
              borderColor: activeTab === tab.key ? theme.palette.accent.main : "transparent",
              transition: "all 0.15s ease",
              "&:hover": {
                color: theme.palette.accent.main,
              },
            })}
          >
            {tab.icon}
            {tab.label}
          </Box>
        ))}
      </Box>

      {/* Chat（常にマウント、display で切り替え） */}
      <Box sx={{ display: activeTab === "chat" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
        {chatReady && (
          <Chat
            key={chatKey}
            repoId={repoId}
            visible={activeTab === "chat"}
            onSessionIdChange={(sessionId) => {
              // URL同期: replaceStateでReact Routerの再レンダリングを起こさない
              if (sessionId) {
                const newUrl = chatSessionPath(repoId, sessionId);
                window.history.replaceState(null, "", newUrl);
              }
            }}
            initialMessages={initialMessages}
            initialSessionId={initialSessionId}
            initialAgentId={resumeAgentId}
          />
        )}
      </Box>

      {/* Files / Git（Outlet 経由、display で切り替え） */}
      <Box sx={{ display: activeTab !== "chat" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <Outlet />
      </Box>
    </>
  );
}
