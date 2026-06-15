import { useState } from "react";
import { Box, Popover, Typography } from "@mui/material";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import ChecklistRtlRoundedIcon from "@mui/icons-material/ChecklistRtlRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import type { SvgIconComponent } from "@mui/icons-material";
import {
  MODE_LABELS,
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from "../lib/permissionMode";

interface Props {
  mode: PermissionMode;
  onSelectMode: (mode: PermissionMode) => void;
}

const MODE_ICONS: Record<PermissionMode, SvgIconComponent> = {
  acceptEdits: BoltRoundedIcon,
  default: RuleRoundedIcon,
  auto: AutoAwesomeRoundedIcon,
  plan: ChecklistRtlRoundedIcon,
};

export default function ModeSelector({ mode, onSelectMode }: Props) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);
  const CurrentIcon = MODE_ICONS[mode];

  return (
    <>
      {/* モードボタン（閉時）: 現在のモードを「アイコン＋英語ラベル」で1行表示 */}
      <Box
        component="button"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={(theme) => ({
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          minHeight: 36,
          px: 1.25,
          py: 0.5,
          flexShrink: 0,
          bgcolor: "background.paper",
          border: `1px solid ${theme.palette.border}`,
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          color: theme.palette.text.secondary,
          transition: "background-color 0.15s ease, border-color 0.15s ease",
          "&:hover": { bgcolor: theme.palette.bgSecondary },
        })}
      >
        <CurrentIcon sx={{ fontSize: 16, flexShrink: 0 }} />
        <Typography
          sx={{
            fontSize: "12.5px",
            fontWeight: 500,
            whiteSpace: "nowrap",
            // 狭幅ではラベルを隠してアイコンのみに
            display: { xs: "none", sm: "block" },
          }}
        >
          {MODE_LABELS[mode].en}
        </Typography>
        <KeyboardArrowUpRoundedIcon sx={{ fontSize: 18, flexShrink: 0 }} />
      </Box>

      {/* ポップオーバー（開時）: ボタン直上にモード一覧 */}
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: (theme) => ({
              mt: -0.75,
              bgcolor: "background.paper",
              border: `1px solid ${theme.palette.border}`,
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-sm)",
              p: 0.75,
              minWidth: 220,
            }),
          },
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
          {PERMISSION_MODE_ORDER.map((m) => {
            const Icon = MODE_ICONS[m];
            const label = MODE_LABELS[m];
            const selected = m === mode;
            return (
              <Box
                key={m}
                component="button"
                onClick={() => {
                  onSelectMode(m);
                  setAnchorEl(null);
                }}
                sx={(theme) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  width: "100%",
                  textAlign: "left",
                  minHeight: 44, // タップ領域確保
                  px: 1,
                  py: 0.75,
                  border: `1px solid ${selected ? theme.palette.accent.main : "transparent"}`,
                  borderRadius: "var(--radius-sm)",
                  bgcolor: selected ? theme.palette.accent.soft : "transparent",
                  cursor: "pointer",
                  transition: "background-color 0.15s ease, border-color 0.15s ease",
                  "&:hover": {
                    bgcolor: selected
                      ? theme.palette.accent.soft
                      : theme.palette.bgSecondary,
                  },
                })}
              >
                <Box
                  sx={(theme) => ({
                    flexShrink: 0,
                    width: 18,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: selected ? theme.palette.accent.main : "transparent",
                  })}
                >
                  <CheckRoundedIcon sx={{ fontSize: 18 }} />
                </Box>
                <Icon
                  sx={(theme) => ({
                    fontSize: 18,
                    flexShrink: 0,
                    color: selected
                      ? theme.palette.accent.main
                      : theme.palette.textTertiary,
                  })}
                />
                <Box sx={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 0.75 }}>
                  <Typography
                    sx={(theme) => ({
                      fontSize: "14px",
                      fontWeight: 600,
                      color: theme.palette.text.primary,
                      whiteSpace: "nowrap",
                    })}
                  >
                    {label.ja}
                  </Typography>
                  <Typography
                    sx={(theme) => ({
                      fontSize: "12px",
                      color: theme.palette.text.secondary,
                      whiteSpace: "nowrap",
                    })}
                  >
                    {label.en}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Popover>
    </>
  );
}
