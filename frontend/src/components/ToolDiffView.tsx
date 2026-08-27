import { Box, Typography } from "@mui/material";
import type { StructuredPatchHunk } from "../hooks/useChat";

interface Props {
  toolName: string;
  filePath?: string;
  structuredPatch?: StructuredPatchHunk[];
  content: string;
  toolInput?: Record<string, unknown>;
}

function formatSummary(toolName: string, toolInput?: Record<string, unknown>, filePath?: string): string {
  switch (toolName) {
    case "Bash": {
      const cmd = typeof toolInput?.command === "string" ? toolInput.command : "";
      const truncated = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
      return truncated ? `$ ${truncated}` : "Bash";
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const fp = filePath ?? (typeof toolInput?.file_path === "string" ? toolInput.file_path : "");
      const shortPath = fp.includes("/") ? fp.split("/").slice(-2).join("/") : fp;
      return shortPath ? `${toolName}  ${shortPath}` : toolName;
    }
    case "Glob": {
      const pattern = typeof toolInput?.pattern === "string" ? toolInput.pattern : "";
      return pattern ? `Glob  ${pattern}` : "Glob";
    }
    case "Grep": {
      const pattern = typeof toolInput?.pattern === "string" ? toolInput.pattern : "";
      return pattern ? `Grep  ${pattern}` : "Grep";
    }
    default:
      return `${toolName} Result`;
  }
}

export default function ToolDiffView({ toolName, filePath, structuredPatch, content, toolInput }: Props) {
  const hasDiff = structuredPatch && structuredPatch.length > 0;
  const summary = formatSummary(toolName, toolInput, filePath);

  if (!hasDiff) {
    return (
      <details className="tool-result">
        <summary>{summary}</summary>
        <Box component="div">
          <Box component="pre" sx={{ mb: 0, mt: 0.5 }}>
            <code>{content}</code>
          </Box>
        </Box>
      </details>
    );
  }

  const displayPath = filePath ?? "";
  const shortPath = displayPath.includes("/")
    ? displayPath.split("/").slice(-2).join("/")
    : displayPath;

  return (
    <details className="tool-result" open>
      <summary>
        {toolName}
        {shortPath && (
          <Box
            component="span"
            sx={{ ml: 0.75, fontSize: "0.85em", opacity: 0.75, fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace" }}
          >
            {shortPath}
          </Box>
        )}
      </summary>
      <Box
        sx={{
          mt: 0.5,
          borderRadius: "var(--radius-sm, 4px)",
          overflow: "hidden",
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        {shortPath !== displayPath && displayPath && (
          <Box
            sx={(theme) => ({
              px: 1.5,
              py: 0.5,
              bgcolor: theme.palette.mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
              borderBottom: "1px solid",
              borderColor: "divider",
            })}
          >
            <Typography
              sx={{
                fontSize: 11,
                fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
                color: "text.secondary",
                wordBreak: "break-all",
              }}
            >
              {displayPath}
            </Typography>
          </Box>
        )}
        {/* diffは折り返すと +/- の桁とインデントが崩れて読めなくなるため、
            各行は white-space:pre のままこのコンテナ内で横スクロールさせる */}
        <Box
          sx={{
            fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
            fontSize: 12,
            lineHeight: 1.6,
            overflow: "auto",
          }}
        >
          {structuredPatch.map((hunk, hunkIndex) => {
            const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
            return (
              <Box key={hunkIndex}>
                <Box
                  sx={{
                    px: 1.5,
                    bgcolor: "rgba(25, 118, 210, 0.08)",
                    color: "#1976D2",
                    whiteSpace: "pre",
                    minHeight: "1.6em",
                    userSelect: "text",
                  }}
                >
                  {header}
                </Box>
                {hunk.lines.map((line, lineIndex) => {
                  let bgcolor = "transparent";
                  let color = "text.primary";

                  if (line.startsWith("+")) {
                    bgcolor = "rgba(46, 125, 50, 0.08)";
                    color = "#2E7D32";
                  } else if (line.startsWith("-")) {
                    bgcolor = "rgba(211, 47, 47, 0.08)";
                    color = "#D32F2F";
                  }

                  return (
                    <Box
                      key={lineIndex}
                      sx={{
                        px: 1.5,
                        bgcolor,
                        color,
                        whiteSpace: "pre",
                        minHeight: "1.6em",
                        userSelect: "text",
                      }}
                    >
                      {line || " "}
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </Box>
      </Box>
    </details>
  );
}
