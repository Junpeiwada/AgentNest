import { Box, Button, TextField } from "@mui/material";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";

interface Props {
  message: string;
  onMessageChange: (msg: string) => void;
  onCommit: () => void;
  onUndoCommit: () => void;
  stagedCount: number;
  ahead: number;
  loading: boolean;
}

export default function GitCommitBox({ message, onMessageChange, onCommit, onUndoCommit, stagedCount, ahead, loading }: Props) {
  const disabled = loading || stagedCount === 0 || !message.trim();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !disabled) {
      onCommit();
    }
  };

  return (
    <Box
      sx={(theme) => ({
        display: "flex",
        flexDirection: "column",
        gap: 1,
        p: 1.5,
        borderTop: `1px solid ${theme.palette.border}`,
        flexShrink: 0,
      })}
    >
      <TextField
        size="small"
        placeholder="コミットメッセージを入力"
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        fullWidth
        sx={{
          "& .MuiOutlinedInput-root": {
            fontSize: 12,
          },
        }}
      />
      <Button
        variant="contained"
        size="small"
        disabled={disabled}
        onClick={onCommit}
        fullWidth
        sx={(theme) => ({
          textTransform: "none",
          fontSize: 12,
          fontWeight: 600,
          bgcolor: theme.palette.accent.main,
          "&:hover": {
            bgcolor: theme.palette.accent.hover,
          },
          "&.Mui-disabled": {
            bgcolor: theme.palette.bgSecondary,
          },
        })}
      >
        {stagedCount > 0 ? `コミット (${stagedCount} files)` : "コミット"}
      </Button>

      {/* unpushedコミットがある場合のみ表示 */}
      {ahead > 0 && (
        <Button
          size="small"
          disabled={loading}
          onClick={onUndoCommit}
          fullWidth
          startIcon={<UndoRoundedIcon sx={{ fontSize: 14 }} />}
          sx={(theme) => ({
            textTransform: "none",
            fontSize: 11,
            fontWeight: 500,
            color: theme.palette.text.secondary,
            "&:hover": {
              bgcolor: theme.palette.bgSecondary,
            },
          })}
        >
          直前のコミットを取り消す
        </Button>
      )}
    </Box>
  );
}
