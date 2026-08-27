import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Box, Snackbar, Alert, CircularProgress, useMediaQuery, useTheme } from "@mui/material";
import { useGitStatus } from "../hooks/useGitStatus";
import { useGitHistory } from "../hooks/useGitHistory";
import GitHeader from "../components/git/GitHeader";
import GitSubTabs, { type GitViewMode } from "../components/git/GitSubTabs";
import GitFileList from "../components/git/GitFileList";
import GitDiffView from "../components/git/GitDiffView";
import GitCommitBox from "../components/git/GitCommitBox";
import GitCommitList from "../components/git/GitCommitList";
import GitCommitDetail from "../components/git/GitCommitDetail";

export default function GitPage() {
  const { repo } = useParams<{ repo: string }>();
  const repoId = repo ?? "";
  const git = useGitStatus(repoId);
  const history = useGitHistory(repoId);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [mobileDiffOpen, setMobileDiffOpen] = useState(false);
  const [viewMode, setViewMode] = useState<GitViewMode>("changes");

  // マウント時にステータス取得
  useEffect(() => {
    git.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // ステータス取得後、未選択なら先頭ファイルを自動選択
  useEffect(() => {
    if (git.status && git.status.files.length > 0 && !git.selectedFile) {
      git.selectFile(git.status.files[0].path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.status]);

  // Historyタブに切り替えた時に履歴をロード
  useEffect(() => {
    if (viewMode === "history" && history.commits.length === 0) {
      history.loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // モバイルでファイル選択時にDiff画面へ切り替え
  const handleSelectFile = (file: string) => {
    git.selectFile(file);
    if (isMobile) {
      setMobileDiffOpen(true);
    }
  };

  // モバイルでコミット選択時に詳細画面へ切り替え
  const handleSelectCommit = (hash: string) => {
    history.selectCommit(hash);
    if (isMobile) {
      setMobileDiffOpen(true);
    }
  };

  const stagedCount = git.status?.files.filter((f) => f.staged).length ?? 0;
  const error = git.error || history.error;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const snackbarOpen = !!error && error !== dismissedError;

  if (git.loading && !git.status) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* ヘッダー: ブランチ + Fetch/Pull/Push */}
      <GitHeader
        status={git.status}
        loading={git.loading}
        operationLoading={git.operationLoading}
        onFetch={git.fetch}
        onPull={git.pull}
        onPush={git.push}
      />

      {/* サブタブ: Changes / History */}
      <GitSubTabs mode={viewMode} onChange={setViewMode} />

      {/* メインエリア */}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        {viewMode === "changes" ? (
          <>
            {/* Changes: 左ペイン（ファイル一覧+コミット） */}
            <Box
              sx={(theme) => ({
                display: isMobile && mobileDiffOpen ? "none" : "flex",
                flexDirection: "column",
                width: { xs: "100%", md: "30%" },
                minWidth: { md: 240 },
                maxWidth: { md: 400 },
                borderRight: { md: `1px solid ${theme.palette.border}` },
              })}
            >
              <GitFileList
                files={git.status?.files ?? []}
                selectedFile={git.selectedFile}
                onSelectFile={handleSelectFile}
                onStage={git.stageFiles}
                onUnstage={git.unstageFiles}
              />
              <GitCommitBox
                message={git.commitMessage}
                onMessageChange={git.setCommitMessage}
                onCommit={git.commit}
                onUndoCommit={git.undoCommit}
                stagedCount={stagedCount}
                ahead={git.status?.ahead ?? 0}
                loading={git.operationLoading}
              />
            </Box>

            {/* Changes: 右ペイン（Diff） */}
            <Box
              sx={{
                display: isMobile && !mobileDiffOpen ? "none" : "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <GitDiffView
                diff={git.diff}
                loading={git.diffLoading}
                selectedFile={git.selectedFile}
                onBack={isMobile ? () => setMobileDiffOpen(false) : undefined}
              />
            </Box>
          </>
        ) : (
          <>
            {/* History: 左ペイン（コミットリスト） */}
            <Box
              sx={(theme) => ({
                display: isMobile && mobileDiffOpen ? "none" : "flex",
                flexDirection: "column",
                width: { xs: "100%", md: "30%" },
                minWidth: { md: 240 },
                maxWidth: { md: 400 },
                borderRight: { md: `1px solid ${theme.palette.border}` },
              })}
            >
              <GitCommitList
                commits={history.commits}
                selectedHash={history.selectedHash}
                hasMore={history.hasMore}
                loading={history.loading}
                loadMoreLoading={history.loadMoreLoading}
                onSelect={handleSelectCommit}
                onLoadMore={history.loadMore}
              />
            </Box>

            {/* History: 右ペイン（コミット詳細+diff） */}
            <Box
              sx={{
                display: isMobile && !mobileDiffOpen ? "none" : "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <GitCommitDetail
                commit={history.selectedCommit}
                loading={history.detailLoading}
                selectedHash={history.selectedHash}
                onBack={isMobile ? () => setMobileDiffOpen(false) : undefined}
              />
            </Box>
          </>
        )}
      </Box>

      {/* エラー Snackbar */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={5000}
        onClose={() => setDismissedError(error)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert severity="error" variant="filled" sx={{ width: "100%" }}>
          {error}
        </Alert>
      </Snackbar>
    </Box>
  );
}
