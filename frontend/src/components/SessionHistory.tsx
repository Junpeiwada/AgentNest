import { useState, useEffect, useRef } from "react";
import { apiSessionsPath } from "../utils/paths";
import { Box, Typography, Collapse, InputBase } from "@mui/material";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";

interface SessionInfo {
  sessionId: string;
  title: string;
  firstMessage: string;
  timestamp: string;
}

interface Props {
  repoId: string;
  onSelect: (sessionId: string) => void;
}

function formatRelativeTime(timestamp: string): string {
  if (!timestamp) return "";
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export default function SessionHistory({ repoId, onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [fetchError, setFetchError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!repoId || !open) return;
    fetch(apiSessionsPath(repoId))
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data) => { setSessions(data); setFetchError(false); })
      .catch(() => { setSessions([]); setFetchError(true); });
  }, [repoId, open]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtered = search
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(search.toLowerCase()) ||
          s.firstMessage.toLowerCase().includes(search.toLowerCase())
      )
    : sessions;

  return (
    <Box ref={ref} sx={{ position: "relative" }}>
      {/* Trigger button */}
      <Box
        onClick={() => setOpen(!open)}
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
        <HistoryRoundedIcon sx={{ fontSize: 18 }} />
        <Typography
          sx={{
            fontSize: "13px",
            fontWeight: 500,
            lineHeight: 1,
            display: { xs: "none", sm: "block" },
          }}
        >
          History
        </Typography>
      </Box>

      {/* Dropdown panel */}
      <Collapse in={open}>
        <Box
          sx={(theme) => ({
            position: { xs: "fixed", sm: "absolute" },
            top: { xs: "56px", sm: "calc(100% + 4px)" },
            left: { xs: 8, sm: "auto" },
            right: { xs: 8, sm: 0 },
            width: { xs: "auto", sm: 380 },
            maxWidth: { xs: "calc(100% - 16px)", sm: 420 },
            maxHeight: { xs: "70vh", sm: "auto" },
            bgcolor: "background.paper",
            border: `1px solid ${theme.palette.border}`,
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 1000,
            overflow: "hidden",
          })}
        >
          {/* Search */}
          <Box sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
            <InputBase
              fullWidth
              placeholder="Search sessions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              sx={(theme) => ({
                fontSize: "13px",
                px: 1.5,
                py: 0.75,
                bgcolor: theme.palette.bgSecondary,
                borderRadius: "var(--radius-sm)",
                "& input::placeholder": {
                  color: theme.palette.textTertiary,
                  opacity: 1,
                },
              })}
            />
          </Box>

          {/* Session list */}
          <Box sx={{ maxHeight: 360, overflow: "auto", py: 0.5 }}>
            {filtered.length === 0 ? (
              <Typography
                sx={(theme) => ({
                  fontSize: "13px",
                  color: theme.palette.textTertiary,
                  textAlign: "center",
                  py: 3,
                })}
              >
                {fetchError ? "サーバーに接続できません" : sessions.length === 0 ? "No sessions" : "No results"}
              </Typography>
            ) : (
              filtered.map((s) => (
                <Box
                  key={s.sessionId}
                  onClick={() => {
                    onSelect(s.sessionId);
                    setOpen(false);
                    setSearch("");
                  }}
                  sx={(theme) => ({
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 2,
                    py: 1,
                    cursor: "pointer",
                    transition: "background 0.1s ease",
                    "&:hover": {
                      bgcolor: theme.palette.bgSecondary,
                    },
                  })}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      sx={{
                        fontSize: "13px",
                        fontWeight: 500,
                        color: "text.primary",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.title || s.firstMessage || s.sessionId.slice(0, 8)}
                    </Typography>
                    {s.title && s.firstMessage && (
                      <Typography
                        sx={(theme) => ({
                          fontSize: "12px",
                          color: theme.palette.textTertiary,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          mt: 0.25,
                        })}
                      >
                        {s.firstMessage}
                      </Typography>
                    )}
                  </Box>
                  <Typography
                    sx={(theme) => ({
                      fontSize: "12px",
                      color: theme.palette.textTertiary,
                      flexShrink: 0,
                      ml: 1,
                    })}
                  >
                    {formatRelativeTime(s.timestamp)}
                  </Typography>
                </Box>
              ))
            )}
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
}
