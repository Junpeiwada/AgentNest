import { Box, Typography } from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import RepoSelector from "./RepoSelector";
import SessionHistory from "./SessionHistory";

interface Props {
  repoId: string;
  onRepoChange: (id: string) => void;
  onNewChat: () => void;
  onResumeSession: (sessionId: string) => void;
  sessionId?: string | null;
}

export default function Header({ repoId, onRepoChange, onNewChat, onResumeSession }: Props) {
  return (
    <Box
      sx={(theme) => ({
        display: "flex",
        alignItems: "center",
        gap: { xs: 0.75, sm: 1.5 },
        px: { xs: 1.5, sm: 3 },
        py: 1.5,
        borderBottom: `1px solid ${theme.palette.border}`,
        bgcolor: "background.paper",
        flexShrink: 0,
      })}
    >
      {/* Logo / Title */}
      <Box
        onClick={onNewChat}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          userSelect: "none",
          borderRadius: "var(--radius-sm)",
          px: 0.5,
          mx: -0.5,
          transition: "opacity 0.15s ease",
          "@media (hover: hover)": {
            "&:hover": { opacity: 0.7 },
          },
        }}
      >
        <Box
          component="img"
          src="/favicon-32x32.png"
          alt="AgentNest"
          sx={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-sm)",
            flexShrink: 0,
          }}
        />
        <Typography
          sx={{
            fontSize: "15px",
            fontWeight: 600,
            color: "text.primary",
            letterSpacing: "-0.01em",
            display: { xs: "none", sm: "block" },
          }}
        >
          AgentNest
        </Typography>
      </Box>

      <Box sx={{ flex: 1 }} />

      {/* Repo Selector */}
      <RepoSelector value={repoId} onChange={onRepoChange} />

      {/* Session History */}
      {repoId && (
        <SessionHistory repoId={repoId} onSelect={onResumeSession} />
      )}

      {/* New Chat Button */}
      <Box
        onClick={onNewChat}
        sx={(theme) => ({
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          color: theme.palette.text.secondary,
          border: `1px solid ${theme.palette.border}`,
          borderRadius: "var(--radius-sm)",
          height: 34,
          px: 1.2,
          cursor: "pointer",
          transition: "all 0.15s ease",
          userSelect: "none",
          "&:hover": {
            bgcolor: theme.palette.accent.soft,
            borderColor: theme.palette.accent.main,
            color: theme.palette.accent.main,
          },
        })}
      >
        <AddRoundedIcon sx={{ fontSize: 18 }} />
        <Typography
          sx={{
            fontSize: "13px",
            fontWeight: 500,
            lineHeight: 1,
            display: { xs: "none", sm: "block" },
          }}
        >
          New
        </Typography>
      </Box>

    </Box>
  );
}
