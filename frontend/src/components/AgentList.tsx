import { useState } from "react";
import {
  Box,
  Typography,
  Popover,
  Badge,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Tooltip,
} from "@mui/material";
import SmartToyRoundedIcon from "@mui/icons-material/SmartToyRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import LockClockRoundedIcon from "@mui/icons-material/LockClockRounded";
import HelpOutlineRoundedIcon from "@mui/icons-material/HelpOutlineRounded";
import CircleRoundedIcon from "@mui/icons-material/CircleRounded";
import { useAgents, type AgentSummary } from "../hooks/useAgents";

interface Props {
  onResumeAgent: (repoId: string, agentId: string) => void;
}

/** createdAt(ms epoch)からの経過時間を短い表記にする（SessionHistoryのformatRelativeTimeと同系統） */
function formatElapsed(createdAt: number): string {
  const diff = Date.now() - createdAt;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

export default function AgentList({ onResumeAgent }: Props) {
  const { agents, runningCount, refresh, deleteAgent } = useAgents();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentSummary | null>(null);
  const open = Boolean(anchorEl);

  const handleOpen = (e: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(e.currentTarget);
    refresh(); // 開いた瞬間に最新化する（ポーリング間隔を待たせない）
  };

  const handleSelect = (agent: AgentSummary) => {
    setAnchorEl(null);
    onResumeAgent(agent.repoId, agent.agentId);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteAgent(pendingDelete.agentId);
    setPendingDelete(null);
  };

  return (
    <>
      {/* バッジ付きトリガーボタン: 実行中Agentが0件のときは控えめ（バッジ非表示）にする */}
      <Tooltip title="実行中のAgent">
        <IconButton
          onClick={handleOpen}
          size="small"
          aria-label="実行中のAgent"
          sx={(theme) => ({
            color: open ? theme.palette.accent.main : theme.palette.text.secondary,
            border: `1px solid ${open ? theme.palette.accent.main : theme.palette.border}`,
            borderRadius: "var(--radius-sm)",
            width: 34,
            height: 34,
            "&:hover": {
              bgcolor: theme.palette.accent.soft,
              borderColor: theme.palette.accent.main,
              color: theme.palette.accent.main,
            },
          })}
        >
          <Badge
            badgeContent={runningCount}
            color="primary"
            sx={{
              "& .MuiBadge-badge": {
                fontSize: "10px",
                height: 15,
                minWidth: 15,
                px: 0.4,
              },
            }}
          >
            <SmartToyRoundedIcon sx={{ fontSize: 18 }} />
          </Badge>
        </IconButton>
      </Tooltip>

      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: (theme) => ({
              mt: 0.75,
              bgcolor: "background.paper",
              border: `1px solid ${theme.palette.border}`,
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-sm)",
              p: 0.75,
              width: 320,
              maxWidth: "calc(100vw - 32px)",
              maxHeight: 420,
              overflowY: "auto",
            }),
          },
        }}
      >
        {agents.length === 0 ? (
          <Typography
            sx={(theme) => ({
              fontSize: "13px",
              color: theme.palette.textTertiary,
              textAlign: "center",
              py: 3,
            })}
          >
            実行中のAgentはありません
          </Typography>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
            {agents.map((agent) => (
              <Box
                key={agent.agentId}
                sx={(theme) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  px: 1,
                  py: 0.75,
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  transition: "background-color 0.15s ease",
                  "&:hover": { bgcolor: theme.palette.bgSecondary },
                })}
                onClick={() => handleSelect(agent)}
              >
                {/* 実行中/完了の状態ドット */}
                <CircleRoundedIcon
                  sx={(theme) => ({
                    fontSize: 8,
                    flexShrink: 0,
                    color: agent.completed ? theme.palette.textTertiary : theme.palette.success.main,
                  })}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "text.primary",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.repoId}
                  </Typography>
                  <Typography
                    sx={(theme) => ({
                      fontSize: "12px",
                      color: theme.palette.textTertiary,
                    })}
                  >
                    {agent.completed ? "完了" : "実行中"} ・ {formatElapsed(agent.createdAt)}
                  </Typography>
                </Box>

                {/* 権限待ち/質問待ちアイコン */}
                {agent.hasPendingPermission && (
                  <Tooltip title="権限承認待ち">
                    <LockClockRoundedIcon sx={(theme) => ({ fontSize: 16, color: theme.palette.warning.main })} />
                  </Tooltip>
                )}
                {agent.hasPendingQuestion && (
                  <Tooltip title="回答待ち">
                    <HelpOutlineRoundedIcon sx={(theme) => ({ fontSize: 16, color: theme.palette.warning.main })} />
                  </Tooltip>
                )}

                {/* 破棄ボタン */}
                <Tooltip title="このAgentを破棄">
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      // レビュー指摘#7: 確認ダイアログを出す際、背後にPopoverが開いたまま
                      // 残らないよう先に閉じる（モーダルの背後にPopoverが残るのを防ぐ）。
                      setAnchorEl(null);
                      setPendingDelete(agent);
                    }}
                    sx={(theme) => ({
                      color: theme.palette.textTertiary,
                      "&:hover": { color: theme.palette.error.main },
                    })}
                  >
                    <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Box>
        )}
      </Popover>

      {/* 破棄確認ダイアログ */}
      <Dialog open={Boolean(pendingDelete)} onClose={() => setPendingDelete(null)}>
        <DialogTitle sx={{ fontSize: "16px" }}>Agentを破棄しますか？</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: "13px", color: "text.secondary" }}>
            {pendingDelete?.repoId} のAgentを破棄します。実行中の場合は処理が中断され、元に戻せません。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)} size="small">
            キャンセル
          </Button>
          <Button onClick={handleConfirmDelete} size="small" color="error" variant="contained">
            破棄する
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
