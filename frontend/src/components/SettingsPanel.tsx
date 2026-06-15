import { Box, Typography } from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import {
  EFFORT_LABELS,
  type EffortLevel,
  type ModelInfo,
} from "../lib/modelSettings";

interface Props {
  models: ModelInfo[];
  selectedModel: string; // ModelInfo.value（SDKの "default" を含む）
  selectedEffort: EffortLevel | null;
  onSelectModel: (value: string) => void;
  onSelectEffort: (effort: EffortLevel) => void;
}

const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export default function SettingsPanel({
  models,
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
}: Props) {
  const activeModel = models.find((m) => m.value === selectedModel) ?? null;

  // supportsEffort=false・対応段階なしのときは effort 行を非表示
  const effortLevels =
    activeModel && activeModel.supportsEffort !== false
      ? (activeModel.supportedEffortLevels ?? []).filter((l) =>
          EFFORT_ORDER.includes(l)
        )
      : [];
  const showEffort = effortLevels.length > 0;

  return (
    <Box
      sx={(theme) => ({
        bgcolor: "background.paper",
        border: `1px solid ${theme.palette.border}`,
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-sm)",
        p: 1.5,
        mb: 0.75,
        display: "flex",
        flexDirection: "column",
        gap: 1.25,
        // モバイル: パネルが入力欄やキーボードを覆い隠さないよう最大高さ＋縦スクロール
        maxHeight: "min(50vh, 410px)",
        overflowY: "auto",
      })}
    >
      {/* モデル: 縦リスト */}
      <Box>
        <SectionLabel>モデル / Model</SectionLabel>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 0.75 }}>
          {/* SDK由来の一覧（先頭の "default" がおまかせ相当）をそのまま表示 */}
          {models.map((m) => (
            <ModelRow
              key={m.value}
              displayName={m.displayName}
              description={m.description}
              selected={selectedModel === m.value}
              onClick={() => onSelectModel(m.value)}
            />
          ))}
        </Box>
      </Box>

      {/* Thinking effort: 横セグメント（対応段階のみ表示） */}
      {showEffort && (
        <Box>
          <SectionLabel>思考の深さ / Thinking effort</SectionLabel>
          <Box
            sx={{
              mt: 0.75,
              // iPhone幅に収まらない場合は横スクロール（折り返さない）
              overflowX: "auto",
              "&::-webkit-scrollbar": { display: "none" },
            }}
          >
            <Box
              sx={(theme) => ({
                display: "inline-flex",
                border: `1px solid ${theme.palette.border}`,
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                minWidth: "100%",
              })}
            >
              {effortLevels.map((level, i) => {
                const selected = selectedEffort === level;
                const label = EFFORT_LABELS[level];
                return (
                  <Box
                    key={level}
                    component="button"
                    onClick={() => onSelectEffort(level)}
                    sx={(theme) => ({
                      flex: 1,
                      minWidth: 56,
                      minHeight: 44, // タップ領域確保
                      px: 1.5,
                      border: "none",
                      borderLeft:
                        i === 0 ? "none" : `1px solid ${theme.palette.border}`,
                      cursor: "pointer",
                      bgcolor: selected
                        ? theme.palette.accent.main
                        : "transparent",
                      color: selected
                        ? theme.palette.onAccent
                        : theme.palette.text.secondary,
                      transition: "background-color 0.15s ease, color 0.15s ease",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1.2,
                      "&:hover": {
                        bgcolor: selected
                          ? theme.palette.accent.hover
                          : theme.palette.bgSecondary,
                      },
                    })}
                  >
                    <Typography sx={{ fontSize: "13px", fontWeight: 600 }}>
                      {label.ja}
                    </Typography>
                    <Typography sx={{ fontSize: "10px", opacity: 0.8 }}>
                      {label.en}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={(theme) => ({
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: theme.palette.textTertiary,
      })}
    >
      {children}
    </Typography>
  );
}

function ModelRow({
  displayName,
  description,
  selected,
  onClick,
}: {
  displayName: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={(theme) => ({
        display: "flex",
        alignItems: "flex-start",
        gap: 1,
        width: "100%",
        textAlign: "left",
        minHeight: 44, // タップ領域確保
        px: 1.25,
        py: 1,
        border: `1px solid ${selected ? theme.palette.accent.main : "transparent"}`,
        borderRadius: "var(--radius-sm)",
        bgcolor: selected ? theme.palette.accent.soft : "transparent",
        cursor: "pointer",
        transition: "background-color 0.15s ease, border-color 0.15s ease",
        "&:hover": {
          bgcolor: selected ? theme.palette.accent.soft : theme.palette.bgSecondary,
        },
      })}
    >
      <Box
        sx={(theme) => ({
          flexShrink: 0,
          width: 18,
          height: 18,
          mt: "1px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: selected ? theme.palette.accent.main : "transparent",
        })}
      >
        <CheckRoundedIcon sx={{ fontSize: 18 }} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          sx={(theme) => ({
            fontSize: "14px",
            fontWeight: 600,
            color: theme.palette.text.primary,
          })}
        >
          {displayName}
        </Typography>
        {description && (
          <Typography
            sx={(theme) => ({
              fontSize: "12px",
              color: theme.palette.text.secondary,
              mt: 0.25,
            })}
          >
            {description}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
