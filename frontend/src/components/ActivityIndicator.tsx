import { Box, Typography } from "@mui/material";
import type { SessionState, ToolProgress } from "../hooks/useChat";

interface Props {
  activity: string | null;
  isLoading?: boolean;
  sessionState?: SessionState | null;
  toolProgress?: ToolProgress | null;
}

export default function ActivityIndicator({ activity, isLoading, sessionState, toolProgress }: Props) {
  const isWaiting = sessionState === "requires_action";

  let label: string | null;
  if (toolProgress) {
    const base = activity ?? `Using ${toolProgress.toolName}...`;
    label = `${base} (${toolProgress.elapsedSeconds}s)`;
  } else {
    label = activity ?? (isLoading ? "Using Tool..." : null);
  }

  if (!label) return null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1,
        py: 0.75,
        animation: "fade-in-up 0.2s ease",
      }}
    >
      {isWaiting ? (
        <Box
          sx={(theme) => ({
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: theme.palette.warning.main,
            flexShrink: 0,
          })}
        />
      ) : (
        <Box
          sx={{
            display: "flex",
            gap: "3px",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {[0, 1, 2].map((i) => (
            <Box
              key={i}
              sx={(theme) => ({
                width: 5,
                height: 5,
                borderRadius: "50%",
                bgcolor: theme.palette.accent.main,
                animation: "pulse-dot 1.4s ease-in-out infinite",
                animationDelay: `${i * 0.2}s`,
              })}
            />
          ))}
        </Box>
      )}
      <Typography
        sx={{
          fontSize: "12.5px",
          color: isWaiting ? "warning.main" : "text.secondary",
          fontStyle: "italic",
          letterSpacing: "-0.01em",
          /* Grepのパターン等、空白を含まない長いラベルで横に伸びるのを防ぐ */
          minWidth: 0,
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {label}
      </Typography>
    </Box>
  );
}
