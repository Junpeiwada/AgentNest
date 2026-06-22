import { useState, useRef, useEffect } from "react";
import { Box, Typography, IconButton, Chip, TextField, Button } from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import type { PendingQuestion, QuestionItem } from "../hooks/useChat";

const OTHER_LABEL = "Other";

interface QuestionState {
  selected: string[];
  otherText: string;
}

interface Props {
  question: PendingQuestion;
  onRespond: (
    requestId: string,
    answers: Record<string, string> | null,
    annotations?: Record<string, { notes?: string }>
  ) => void;
}

function isAnswered(state: QuestionState): boolean {
  if (state.selected.length === 0) return false;
  if (state.selected.includes(OTHER_LABEL) && !state.otherText.trim()) return false;
  return true;
}

function SingleQuestion({
  item,
  state,
  onSelect,
  onOtherText,
  onSubmit,
}: {
  item: QuestionItem;
  state: QuestionState;
  onSelect: (label: string) => void;
  onOtherText: (text: string) => void;
  onSubmit: () => void;
}) {
  const otherInputRef = useRef<HTMLInputElement>(null);
  const isOtherSelected = state.selected.includes(OTHER_LABEL);

  useEffect(() => {
    if (isOtherSelected) otherInputRef.current?.focus();
  }, [isOtherSelected]);

  const allOptions = [...item.options, { label: OTHER_LABEL, description: "その他（自由入力）" }];

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
        <Chip
          label={item.header}
          size="small"
          sx={(theme) => ({
            height: 20,
            fontSize: "11px",
            fontWeight: 600,
            bgcolor: theme.palette.accent.main,
            color: theme.palette.onAccent,
            borderRadius: "4px",
          })}
        />
        {item.multiSelect && (
          <Typography sx={{ fontSize: "11px", color: "text.secondary" }}>複数選択可</Typography>
        )}
      </Box>
      <Typography
        sx={{ fontSize: "14px", lineHeight: 1.65, color: "text.primary", mb: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        {item.question}
      </Typography>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        {allOptions.map((opt) => {
          const isOther = opt.label === OTHER_LABEL;
          const isSelected = state.selected.includes(opt.label);
          return (
            <Box key={opt.label}>
              <Box
                onClick={() => onSelect(opt.label)}
                sx={(theme) => ({
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 1.5,
                  px: 1.5,
                  py: 1.25,
                  borderRadius: isOther && isSelected ? "var(--radius-sm) var(--radius-sm) 0 0" : "var(--radius-sm)",
                  border: `1px solid ${isSelected ? theme.palette.accent.main : theme.palette.border}`,
                  borderBottom: isOther && isSelected ? "none" : undefined,
                  bgcolor: isSelected ? `${theme.palette.accent.main}14` : "transparent",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  "&:hover": {
                    borderColor: theme.palette.accent.main,
                    bgcolor: `${theme.palette.accent.main}0a`,
                  },
                })}
              >
                <Box
                  sx={(theme) => ({
                    flexShrink: 0,
                    width: 18,
                    height: 18,
                    mt: "1px",
                    borderRadius: item.multiSelect ? "4px" : "50%",
                    border: `2px solid ${isSelected ? theme.palette.accent.main : theme.palette.border}`,
                    bgcolor: isSelected ? theme.palette.accent.main : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "all 0.15s ease",
                  })}
                >
                  {isSelected && <CheckRoundedIcon sx={{ fontSize: 12, color: "white" }} />}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: "13px", fontWeight: 500, color: "text.primary", lineHeight: 1.4 }}>
                    {isOther ? "その他" : opt.label}
                  </Typography>
                  {opt.description && !isOther && (
                    <Typography sx={{ fontSize: "12px", color: "text.secondary", mt: 0.25, lineHeight: 1.5 }}>
                      {opt.description}
                    </Typography>
                  )}
                </Box>
              </Box>

              {isOther && isSelected && (
                <Box
                  sx={(theme) => ({
                    border: `1px solid ${theme.palette.accent.main}`,
                    borderTop: "none",
                    borderRadius: "0 0 var(--radius-sm) var(--radius-sm)",
                    px: 1.5,
                    pb: 1.5,
                    pt: 1,
                    bgcolor: `${theme.palette.accent.main}14`,
                  })}
                >
                  <TextField
                    inputRef={otherInputRef}
                    value={state.otherText}
                    onChange={(e) => onOtherText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onSubmit();
                      }
                    }}
                    placeholder="自由に入力してください..."
                    multiline
                    maxRows={3}
                    fullWidth
                    size="small"
                    onClick={(e) => e.stopPropagation()}
                    sx={(theme) => ({
                      "& .MuiOutlinedInput-root": {
                        fontSize: "13px",
                        borderRadius: "var(--radius-sm)",
                        bgcolor: theme.palette.background.paper,
                        "& fieldset": { borderColor: theme.palette.border },
                        "&:hover fieldset": { borderColor: theme.palette.accent.main },
                        "&.Mui-focused fieldset": { borderColor: theme.palette.accent.main },
                      },
                    })}
                  />
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export default function QuestionDialog({ question, onRespond }: Props) {
  const total = question.questions.length;
  const [currentTab, setCurrentTab] = useState(0);
  const [states, setStates] = useState<Record<string, QuestionState>>(() =>
    Object.fromEntries(
      question.questions.map((q) => [q.question, { selected: [], otherText: "" }])
    )
  );

  const currentItem = question.questions[currentTab];
  const currentState = states[currentItem.question] ?? { selected: [], otherText: "" };
  const currentAnswered = isAnswered(currentState);
  const isLastTab = currentTab === total - 1;
  const allAnswered = question.questions.every((q) => isAnswered(states[q.question] ?? { selected: [], otherText: "" }));

  const handleSelect = (questionText: string, label: string, multiSelect: boolean) => {
    setStates((prev) => {
      const cur = prev[questionText] ?? { selected: [], otherText: "" };
      let selected: string[];
      if (multiSelect) {
        selected = cur.selected.includes(label)
          ? cur.selected.filter((l) => l !== label)
          : [...cur.selected, label];
      } else {
        selected = [label];
      }
      return { ...prev, [questionText]: { ...cur, selected } };
    });

    // 単一選択の場合は自動で次のタブへ
    if (!multiSelect && label !== OTHER_LABEL && !isLastTab) {
      setTimeout(() => setCurrentTab((t) => t + 1), 180);
    }
  };

  const handleOtherText = (questionText: string, text: string) => {
    setStates((prev) => ({
      ...prev,
      [questionText]: { ...prev[questionText], otherText: text },
    }));
  };

  const handleNext = () => {
    if (!currentAnswered) return;
    if (isLastTab) {
      handleSubmit();
    } else {
      setCurrentTab((t) => t + 1);
    }
  };

  const handleDeny = () => {
    onRespond(question.requestId, null);
  };

  const handleSubmit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string }> = {};

    for (const q of question.questions) {
      const s = states[q.question] ?? { selected: [], otherText: "" };
      if (s.selected.includes(OTHER_LABEL)) {
        const others = s.selected.filter((l) => l !== OTHER_LABEL);
        const parts = others.length > 0 ? [...others, s.otherText.trim()] : [s.otherText.trim()];
        answers[q.question] = parts.join(", ");
        annotations[q.question] = { notes: s.otherText.trim() };
      } else {
        answers[q.question] = s.selected.join(", ");
      }
    }

    const hasAnnotations = Object.keys(annotations).length > 0;
    onRespond(question.requestId, answers, hasAnnotations ? annotations : undefined);
  };

  return (
    <>
      {/* Backdrop */}
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          bgcolor: "rgba(0, 0, 0, 0.15)",
          backdropFilter: "blur(2px)",
          zIndex: 1200,
          animation: "fade-in-up 0.2s ease",
        }}
      />

      {/* Dialog */}
      <Box
        sx={(theme) => ({
          position: "fixed",
          bottom: { xs: 16, sm: "auto" },
          top: { xs: "auto", sm: "50%" },
          left: { xs: 16, sm: "50%" },
          right: { xs: 16, sm: "auto" },
          transform: { sm: "translate(-50%, -50%)" },
          width: { sm: 480 },
          maxHeight: "80dvh",
          bgcolor: "background.paper",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          border: `1px solid ${theme.palette.border}`,
          overflow: "hidden",
          zIndex: 1300,
          animation: "fade-in-up 0.25s ease",
          display: "flex",
          flexDirection: "column",
        })}
      >
        {/* Header */}
        <Box
          sx={(theme) => ({
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2.5,
            py: 1.5,
            borderBottom: `1px solid ${theme.palette.border}`,
            flexShrink: 0,
          })}
        >
          <Box
            sx={(theme) => ({
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: theme.palette.accent.main,
              flexShrink: 0,
            })}
          />
          <Typography sx={{ fontSize: "13px", fontWeight: 600, color: "text.secondary", flex: 1 }}>
            Claude からの質問
          </Typography>
          <Button
            size="small"
            onClick={handleDeny}
            sx={(theme) => ({
              fontSize: "12px",
              color: "text.secondary",
              minWidth: 0,
              px: 1,
              py: 0.5,
              "&:hover": { color: theme.palette.error?.main ?? "#D32F2F" },
            })}
          >
            答えない
          </Button>
        </Box>

        {/* Tab indicators (複数質問のときのみ) */}
        {total > 1 && (
          <Box
            sx={(theme) => ({
              display: "flex",
              gap: 0.75,
              px: 2,
              py: 1.25,
              borderBottom: `1px solid ${theme.palette.border}`,
              flexShrink: 0,
            })}
          >
            {question.questions.map((q, i) => {
              const answered = isAnswered(states[q.question] ?? { selected: [], otherText: "" });
              const isCurrent = i === currentTab;
              const clickable = i <= currentTab || answered;
              return (
                <Box
                  key={i}
                  onClick={() => { if (clickable) setCurrentTab(i); }}
                  sx={(theme) => ({
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 0.5,
                    py: 0.75,
                    px: 0.5,
                    borderRadius: "var(--radius-sm)",
                    cursor: clickable ? "pointer" : "default",
                    border: "1px solid",
                    borderColor: isCurrent
                      ? theme.palette.accent.main
                      : answered
                        ? `${theme.palette.accent.main}60`
                        : theme.palette.border,
                    bgcolor: isCurrent
                      ? `${theme.palette.accent.main}14`
                      : "transparent",
                    transition: "all 0.15s ease",
                    "&:hover": clickable && !isCurrent ? {
                      borderColor: theme.palette.accent.main,
                      bgcolor: `${theme.palette.accent.main}0a`,
                    } : {},
                  })}
                >
                  {answered && !isCurrent ? (
                    <CheckRoundedIcon sx={(theme) => ({ fontSize: 12, color: theme.palette.accent.main })} />
                  ) : (
                    <Typography
                      sx={(theme) => ({
                        fontSize: "11px",
                        fontWeight: 600,
                        lineHeight: 1,
                        color: isCurrent ? theme.palette.accent.main : "text.secondary",
                      })}
                    >
                      {i + 1}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {/* Question */}
        <Box sx={{ px: 2.5, py: 2, overflowY: "auto", flex: 1 }}>
          <SingleQuestion
            key={currentItem.question}
            item={currentItem}
            state={currentState}
            onSelect={(label) => handleSelect(currentItem.question, label, currentItem.multiSelect)}
            onOtherText={(text) => handleOtherText(currentItem.question, text)}
            onSubmit={handleNext}
          />
        </Box>

        {/* Footer: 次へ / 送信 */}
        <Box
          sx={(theme) => ({
            px: 2.5,
            py: 2,
            borderTop: `1px solid ${theme.palette.border}`,
            flexShrink: 0,
          })}
        >
          <IconButton
            onClick={handleNext}
            disabled={!currentAnswered}
            sx={(theme) => ({
              width: "100%",
              borderRadius: "var(--radius-sm)",
              py: 1,
              bgcolor: currentAnswered ? theme.palette.accent.main : undefined,
              color: currentAnswered ? theme.palette.onAccent : theme.palette.text.disabled,
              fontSize: "13px",
              fontWeight: 500,
              gap: 0.75,
              transition: "all 0.15s ease",
              "&:hover": {
                bgcolor: currentAnswered ? theme.palette.accent.hover : undefined,
              },
            })}
          >
            {isLastTab ? (
              <>
                <CheckRoundedIcon sx={{ fontSize: 16 }} />
                <span>回答を送信</span>
              </>
            ) : (
              <>
                <ArrowForwardRoundedIcon sx={{ fontSize: 16 }} />
                <span>次へ</span>
              </>
            )}
          </IconButton>
        </Box>
      </Box>
    </>
  );
}
