import { memo, useCallback, useEffect, useRef } from "react";
import { Box, Typography } from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../hooks/useChat";
import ToolDiffView from "./ToolDiffView";

interface Props {
  messages: Message[];
  isLoading: boolean;
  repoId?: string;
}

const AUTO_SCROLL_THRESHOLD = 80;

export default function MessageList({ messages, isLoading, repoId }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
  }, []);

  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          pb: 6,
          px: 3,
        }}
      >
        <Box
          component="img"
          src="/icon-96.png"
          alt="AgentNest"
          sx={{
            width: 48,
            height: 48,
            borderRadius: "var(--radius-md)",
            mb: 2.5,
          }}
        />
        <Typography
          sx={{
            fontSize: "15px",
            color: "text.secondary",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          {repoId ? "何かお手伝いできますか？" : "リポジトリを選択してください"}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={scrollRef}
      onScroll={handleScroll}
      sx={{
        flex: 1,
        overflow: "auto",
        minHeight: 0,
        overscrollBehavior: "contain",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <Box
        sx={{
          width: "100%",
          maxWidth: "var(--max-width)",
          mx: "auto",
          px: { xs: 2, sm: 3 },
          py: 3,
          display: "flex",
          flexDirection: "column",
          gap: 2.5,
          minHeight: "100%",
          justifyContent: "flex-end",
        }}
      >
        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <UserMessage key={`u-${i}`} content={msg.content} images={msg.images} />
          ) : (
            <AssistantMessage
              key={`a-${i}`}
              message={msg}
              isStreaming={isLoading && i === messages.length - 1}
            />
          )
        )}
      </Box>
    </Box>
  );
}

const UserMessage = memo(function UserMessage({ content, images }: { content: string; images?: Message["images"] }) {
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "flex-end",
        animation: "fade-in-up 0.25s ease",
      }}
    >
      <Box
        sx={(theme) => ({
          maxWidth: "85%",
          bgcolor: theme.palette.userBubble,
          color: "text.primary",
          px: 2,
          py: 1.25,
          borderRadius: "var(--radius-lg)",
          borderBottomRightRadius: "var(--radius-sm)",
          fontSize: "14.5px",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        })}
      >
        {images && images.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mb: content ? 1 : 0 }}>
            {images.map((img, i) => (
              <Box
                key={i}
                sx={{
                  width: 120,
                  height: 120,
                  borderRadius: "var(--radius-sm)",
                  overflow: "hidden",
                }}
              >
                <img
                  src={img.preview}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              </Box>
            ))}
          </Box>
        )}
        {content}
      </Box>
    </Box>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming: boolean;
}) {
  const parts = message.role === "assistant" ? message.parts ?? [] : [];
  const fallbackContent = message.content;
  const error = message.role === "assistant" ? message.error : null;

  if (parts.length === 0 && !fallbackContent && !error && isStreaming) {
    return (
      <Box sx={{ display: "flex", gap: "4px", py: 1, animation: "fade-in-up 0.25s ease" }}>
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            sx={(theme) => ({
              width: 6,
              height: 6,
              borderRadius: "50%",
              bgcolor: theme.palette.textTertiary,
              animation: "pulse-dot 1.4s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            })}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box
      sx={(theme) => ({
        animation: "fade-in-up 0.25s ease",
        fontSize: "14.5px",
        lineHeight: 1.7,
        color: "text.primary",
        /* Markdown styles */
        "& p": {
          m: 0,
        },
        "& p + p": {
          mt: 1.5,
        },
        "& ul, & ol": {
          mt: 0.75,
          mb: 0.75,
          pl: 2.5,
        },
        "& li": {
          mb: 0.25,
        },
        "& code": {
          fontFamily: "var(--font-mono)",
          fontSize: "13px",
          bgcolor: theme.palette.codeBg,
          px: 0.75,
          py: 0.25,
          borderRadius: "var(--radius-sm)",
          fontWeight: 500,
        },
        "& pre": {
          bgcolor: theme.palette.codeBg,
          p: 2,
          borderRadius: "var(--radius-md)",
          overflow: "auto",
          my: 1.5,
          border: `1px solid ${theme.palette.border}`,
        },
        "& pre code": {
          bgcolor: "transparent",
          px: 0,
          py: 0,
          fontSize: "13px",
          lineHeight: 1.6,
        },
        "& a": {
          color: theme.palette.accent.main,
          textDecoration: "none",
          borderBottom: "1px solid transparent",
          transition: "border-color 0.15s ease",
          "&:hover": {
            borderBottomColor: theme.palette.accent.main,
          },
        },
        "& h1, & h2, & h3, & h4": {
          mt: 2,
          mb: 0.75,
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: "-0.02em",
        },
        "& h1": { fontSize: "20px" },
        "& h2": { fontSize: "17px" },
        "& h3": { fontSize: "15px" },
        "& blockquote": {
          borderLeft: `3px solid ${theme.palette.accent.main}`,
          m: 0,
          my: 1,
          pl: 2,
          color: theme.palette.text.secondary,
        },
        "& hr": {
          border: "none",
          borderTop: `1px solid ${theme.palette.border}`,
          my: 2,
        },
        "& table": {
          width: "100%",
          borderCollapse: "collapse",
          my: 1.5,
          fontSize: "13.5px",
        },
        "& th, & td": {
          border: `1px solid ${theme.palette.border}`,
          px: 1.5,
          py: 0.75,
          textAlign: "left",
        },
        "& th": {
          bgcolor: theme.palette.bgSecondary,
          fontWeight: 600,
        },
        "& .tool-result": {
          my: 1.5,
          border: `1px solid ${theme.palette.border}`,
          borderRadius: "var(--radius-md)",
          bgcolor: theme.palette.bgSecondary,
          overflow: "hidden",
        },
        "& .tool-result summary": {
          cursor: "pointer",
          px: 1.5,
          py: 1,
          fontSize: "13px",
          fontWeight: 600,
          color: theme.palette.text.secondary,
          userSelect: "none",
        },
        "& .tool-result > div": {
          px: 1.5,
          pb: 1.5,
        },
      })}
    >
      {parts.length > 0 ? (
        parts.map((part, index) =>
          part.type === "text" ? (
            part.content.trim() ? (
              <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>
                {part.content}
              </ReactMarkdown>
            ) : null
          ) : (
            <ToolDiffView
              key={index}
              toolName={part.toolName ?? "Tool"}
              filePath={part.filePath}
              structuredPatch={part.structuredPatch}
              content={part.content}
              toolInput={part.toolInput}
            />
          )
        )
      ) : fallbackContent.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fallbackContent}</ReactMarkdown>
      ) : null}
      {error ? (
        <Box
          sx={(theme) => ({
            mt: 1.5,
            px: 1.5,
            py: 1.25,
            borderRadius: "var(--radius-md)",
            border: "1px solid",
            borderColor:
              error.kind === "limit" ? theme.palette.accent.soft : theme.palette.error2.light,
            bgcolor:
              error.kind === "limit" ? theme.palette.accent.soft : "rgba(180, 87, 87, 0.08)",
          })}
        >
          <Typography
            sx={(theme) => ({
              fontSize: "13px",
              fontWeight: 600,
              color: error.kind === "limit" ? theme.palette.accent.main : theme.palette.error2.main,
              mb: 0.25,
            })}
          >
            {error.kind === "limit" ? "Usage limit reached" : "Request failed"}
          </Typography>
          <Typography
            sx={{
              fontSize: "13.5px",
              lineHeight: 1.6,
              color: "text.secondary",
              whiteSpace: "pre-wrap",
            }}
          >
            {error.message}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
});
