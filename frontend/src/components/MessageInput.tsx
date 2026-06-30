import { memo, useState, useRef, useCallback, useEffect } from "react";
import { Box, IconButton, InputBase, Typography } from "@mui/material";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import KeyboardArrowUpRoundedIcon from "@mui/icons-material/KeyboardArrowUpRounded";
import type { ImageAttachment } from "../hooks/useChat";
import SettingsPanel from "./SettingsPanel";
import ModeSelector from "./ModeSelector";
import {
  buildToggleBarLabel,
  type EffortLevel,
  type ModelInfo,
} from "../lib/modelSettings";
import type { PermissionMode } from "../lib/permissionMode";

interface Props {
  onSend: (message: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  disabled: boolean;
  isLoading: boolean;
  visible?: boolean;
  // モデル / Thinking effort 選択
  models: ModelInfo[];
  selectedModel: string;
  selectedEffort: EffortLevel | null;
  onSelectModel: (value: string) => void;
  onSelectEffort: (effort: EffortLevel) => void;
  // 実行モード（permissionMode）選択
  permissionMode: PermissionMode;
  onSelectMode: (mode: PermissionMode) => void;
}

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseDataUrl(dataUrl: string): { data: string; mediaType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL");
  return { mediaType: match[1], data: match[2] };
}

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function MessageInput({
  onSend,
  onStop,
  disabled,
  isLoading,
  visible,
  models,
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
  permissionMode,
  onSelectMode,
}: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleBarLabel = buildToggleBarLabel(
    models,
    selectedModel,
    selectedEffort
  );

  // チャットタブが表示されたときにテキストボックスにフォーカス
  useEffect(() => {
    if (visible && !disabled) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [visible, disabled]);

  // visualViewportを使用したキーボード検出とセーフエリア調整
  useEffect(() => {
    const handleViewportChange = () => {
      if (window.visualViewport && isInputFocused) {
        const keyboardHeight = window.innerHeight - window.visualViewport.height;
        const hasKeyboard = keyboardHeight > 50; // 50px以上の差があればキーボード表示と判定

        // CSS変数を設定してキーボード表示状態を通知
        document.documentElement.style.setProperty(
          '--keyboard-visible',
          hasKeyboard ? '1' : '0'
        );
      }
    };

    if (isInputFocused) {
      window.visualViewport?.addEventListener('resize', handleViewportChange);
      handleViewportChange(); // 初回実行
    }

    return () => {
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      if (!isInputFocused) {
        document.documentElement.style.setProperty('--keyboard-visible', '0');
      }
    };
  }, [isInputFocused]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(
      (f) => ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_FILE_SIZE
    );
    if (fileArray.length === 0) return;

    const newImages: ImageAttachment[] = [];
    for (const file of fileArray) {
      const dataUrl = await readFileAsDataUrl(file);
      const { data, mediaType } = parseDataUrl(dataUrl);
      newImages.push({ data, mediaType, preview: dataUrl });
    }
    setImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    onSend(trimmed || "(画像を送信)", images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles]
  );

  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;

  return (
    <Box>
      {/* 設定パネル（トグルで開閉） */}
      {panelOpen && (
        <SettingsPanel
          models={models}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          onSelectModel={onSelectModel}
          onSelectEffort={onSelectEffort}
        />
      )}

      {/* ツールバー行: 左=モデル/effortトグルバー（伸縮）, 右=実行モードボタン */}
      <Box sx={{ display: "flex", alignItems: "stretch", gap: 0.75, mb: 0.75 }}>
        {/* トグルバー（常時表示）: 現在の選択値を1行表示し、タップでパネル開閉 */}
        <Box
          component="button"
          onClick={() => setPanelOpen((v) => !v)}
          sx={(theme) => ({
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            flex: 1,
            minWidth: 0,
            minHeight: 36,
            px: 1.25,
            py: 0.5,
            bgcolor: "background.paper",
            border: `1px solid ${theme.palette.border}`,
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            color: theme.palette.text.secondary,
            transition: "background-color 0.15s ease, border-color 0.15s ease",
            "&:hover": { bgcolor: theme.palette.bgSecondary },
          })}
        >
          <TuneRoundedIcon sx={{ fontSize: 16, flexShrink: 0 }} />
          <Typography
            sx={{
              fontSize: "12.5px",
              fontWeight: 500,
              flex: 1,
              minWidth: 0,
              textAlign: "left",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {toggleBarLabel}
          </Typography>
          <KeyboardArrowUpRoundedIcon
            sx={{
              fontSize: 18,
              flexShrink: 0,
              transition: "transform 0.2s ease",
              transform: panelOpen ? "rotate(0deg)" : "rotate(180deg)",
            }}
          />
        </Box>

        {/* 実行モードボタン（ポップオーバーで一覧表示） */}
        <ModeSelector mode={permissionMode} onSelectMode={onSelectMode} />
      </Box>

      {/* Image previews */}
      {images.length > 0 && (
        <Box
          sx={{
            display: "flex",
            gap: 1,
            px: 1.5,
            pt: 1,
            pb: 0.5,
            overflowX: "auto",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {images.map((img, i) => (
            <Box
              key={i}
              sx={(theme) => ({
                position: "relative",
                flexShrink: 0,
                width: 64,
                height: 64,
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                border: `1px solid ${theme.palette.border}`,
              })}
            >
              <img
                src={img.preview}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
              <IconButton
                size="small"
                onClick={() => removeImage(i)}
                sx={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  width: 20,
                  height: 20,
                  bgcolor: "rgba(0,0,0,0.55)",
                  color: "#fff",
                  "&:hover": { bgcolor: "rgba(0,0,0,0.75)" },
                }}
              >
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}

      {/* Input row */}
      <Box
        sx={(theme) => ({
          display: "flex",
          alignItems: "flex-end",
          gap: 0.75,
          p: 1,
          pl: 1.5,
          bgcolor: "background.paper",
          border: `1px solid ${theme.palette.border}`,
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-sm)",
          transition: "border-color 0.2s ease, box-shadow 0.2s ease",
          "&:focus-within": {
            borderColor: theme.palette.accent.main,
            boxShadow: `0 0 0 2px ${theme.palette.accent.soft}`,
          },
        })}
      >
        {/* Image attach button */}
        <IconButton
          size="small"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled && !isLoading}
          sx={(theme) => ({
            width: 32,
            height: 32,
            color: theme.palette.textTertiary,
            flexShrink: 0,
            "&:hover": { color: theme.palette.text.secondary },
          })}
        >
          <ImageRoundedIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <InputBase
          inputRef={inputRef}
          fullWidth
          placeholder={disabled && !isLoading ? "リポジトリを選択してください" : "Message AgentNest..."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && isLoading) {
              onStop();
              return;
            }
            if (e.nativeEvent.isComposing) return;
            if (isMobile) {
              // iOS/Android: Enterは改行（送信はボタンのみ）
            } else {
              // Mac/PC: Command+Enter (Mac) または Ctrl+Enter (Windows) で送信
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }
          }}
          onPaste={handlePaste}
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => setIsInputFocused(false)}
          disabled={disabled}
          multiline
          maxRows={6}
          inputProps={{
            autoComplete: 'off',
            autoCorrect: 'off',
            autoCapitalize: 'off',
            spellCheck: false,
            'data-form-type': 'other',
          }}
          sx={(theme) => ({
            fontSize: "14.5px",
            lineHeight: 1.5,
            py: 0.5,
            "& textarea": {
              "&::placeholder": {
                color: theme.palette.textTertiary,
                opacity: 1,
              },
            },
          })}
        />
        {isLoading && !canSend ? (
          <IconButton
            onClick={onStop}
            size="small"
            sx={(theme) => ({
              width: 32,
              height: 32,
              borderRadius: "var(--radius-sm)",
              bgcolor: theme.palette.text.secondary,
              color: theme.palette.onAccent,
              flexShrink: 0,
              transition: "all 0.15s ease",
              "&:hover": {
                bgcolor: theme.palette.text.primary,
              },
            })}
          >
            <StopRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        ) : (
          <IconButton
            onClick={handleSend}
            disabled={!canSend}
            size="small"
            sx={(theme) => ({
              width: 32,
              height: 32,
              borderRadius: "var(--radius-sm)",
              bgcolor: canSend ? theme.palette.accent.main : theme.palette.bgSecondary,
              color: canSend ? theme.palette.onAccent : theme.palette.textTertiary,
              flexShrink: 0,
              transition: "all 0.15s ease",
              "&:hover": {
                bgcolor: canSend ? theme.palette.accent.hover : theme.palette.bgSecondary,
              },
              "&.Mui-disabled": {
                bgcolor: theme.palette.bgSecondary,
                color: theme.palette.textTertiary,
              },
            })}
          >
            <ArrowUpwardRoundedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        )}
      </Box>
    </Box>
  );
}

export default memo(MessageInput);
