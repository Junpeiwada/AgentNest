import { useState, useEffect, lazy, Suspense } from "react";
import { apiFilePath, apiRawPath } from "../utils/paths";
import { Box, Typography, IconButton, CircularProgress, Tooltip } from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MDEditor = lazy(() => import("@uiw/react-md-editor"));

interface FileContent {
  type: "markdown" | "code" | "image" | "binary";
  content: string | null;
  language?: string;
  message?: string;
}

interface Props {
  repoId: string;
  filePath: string;
  onClose: () => void;
}

function resolveImageSrc(src: string, repoId: string, filePath: string): string {
  // 絶対URL・data URIはそのまま
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  // ファイルの親ディレクトリを基準に相対パスを解決
  const dir = filePath.split("/").slice(0, -1).join("/");
  const parts = (dir ? dir + "/" + src : src).split("/");
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") resolved.pop();
    else resolved.push(p);
  }
  return apiRawPath(repoId, resolved.join("/"));
}

export default function FileViewer({ repoId, filePath, onClose }: Props) {
  const [data, setData] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [fetchTarget, setFetchTarget] = useState({ repoId, filePath });
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // deps変更時にeffect外でリセット（lint-safe）
  if (fetchTarget.repoId !== repoId || fetchTarget.filePath !== filePath) {
    setFetchTarget({ repoId, filePath });
    setData(null);
    setLoading(true);
    setEditing(false);
  }

  const fileName = filePath.split("/").pop() || filePath;

  useEffect(() => {
    let cancelled = false;
    fetch(apiFilePath(repoId, filePath))
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((result) => { if (!cancelled) { setData(result); setFetchError(false); } })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setFetchError(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoId, filePath]);

  const handleCopy = () => {
    if (data?.content && data.type !== "image") {
      navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleEdit = () => {
    if (data?.content) {
      setEditContent(data.content);
      setEditing(true);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setEditContent("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        apiFilePath(repoId, filePath),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        }
      );
      if (!res.ok) throw new Error();
      setData({ ...data!, content: editContent });
      setEditing(false);
    } catch {
      alert("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Header bar */}
      <Box
        sx={(theme) => ({
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: { xs: 0.5, sm: 1 },
          py: 0.5,
          borderBottom: `1px solid ${theme.palette.border}`,
          bgcolor: "background.paper",
          flexShrink: 0,
        })}
      >
        <IconButton onClick={onClose} size="small" sx={{ color: "text.secondary" }}>
          <ArrowBackRoundedIcon fontSize="small" />
        </IconButton>
        <Typography
          sx={{
            flex: 1,
            fontSize: "13px",
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            color: "text.primary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileName}
        </Typography>
        {editing ? (
          <>
            <Tooltip title="保存">
              <span>
                <IconButton onClick={handleSave} size="small" disabled={saving} sx={{ color: "success.main" }}>
                  {saving ? <CircularProgress size={16} /> : <SaveRoundedIcon sx={{ fontSize: 16 }} />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="キャンセル">
              <IconButton onClick={handleCancel} size="small" sx={{ color: "text.secondary" }}>
                <CloseRoundedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <>
            {data?.type === "markdown" && data.content && (
              <Tooltip title="編集">
                <IconButton onClick={handleEdit} size="small" sx={{ color: "text.secondary" }}>
                  <EditRoundedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {data?.content && data.type !== "image" && (
              <Tooltip title={copied ? "コピーしました" : "コピー"}>
                <IconButton onClick={handleCopy} size="small" sx={{ color: "text.secondary" }}>
                  <ContentCopyRoundedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </>
        )}
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", position: "relative" }}>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} sx={(theme) => ({ color: theme.palette.accent.main })} />
          </Box>
        ) : !data ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4, color: "text.secondary" }}>
            <Typography sx={{ fontSize: "13px" }}>
              {fetchError ? "サーバーに接続できません" : "ファイルを読み込めませんでした"}
            </Typography>
          </Box>
        ) : data.type === "binary" ? (
          <Box sx={(theme) => ({ display: "flex", justifyContent: "center", py: 4, color: theme.palette.textTertiary })}>
            <Typography sx={{ fontSize: "13px" }}>{data.message || "バイナリファイルは表示できません"}</Typography>
          </Box>
        ) : data.type === "image" ? (
          <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", p: 2, minHeight: 200 }}>
            <img
              src={data.content!}
              alt={fileName}
              style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: 8 }}
            />
          </Box>
        ) : data.type === "markdown" && editing ? (
          <Suspense fallback={<Box sx={{ display: "flex", justifyContent: "center", py: 4 }}><CircularProgress size={28} /></Box>}>
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }} data-color-mode="dark">
              <MDEditor
                value={editContent}
                onChange={(v) => setEditContent(v || "")}
                preview="edit"
                height="100%"
                visibleDragbar={false}
                style={{ flex: 1 }}
              />
            </Box>
          </Suspense>
        ) : data.type === "markdown" ? (
          <Box
            className="markdown-viewer"
            sx={(theme) => ({
              px: { xs: 2, sm: 3 },
              py: 2,
              fontSize: "14px",
              lineHeight: 1.7,
              "& h1": { fontSize: "1.5em", fontWeight: 700, mt: 2, mb: 1, borderBottom: `1px solid ${theme.palette.border}`, pb: 0.5 },
              "& h2": { fontSize: "1.25em", fontWeight: 600, mt: 2, mb: 0.5 },
              "& h3": { fontSize: "1.1em", fontWeight: 600, mt: 1.5, mb: 0.5 },
              "& p": { my: 0.75 },
              "& a": { color: theme.palette.accent.main },
              "& img": { maxWidth: "100%", borderRadius: 1 },
              "& pre": {
                bgcolor: theme.palette.codeBg,
                p: 1.5,
                borderRadius: "var(--radius-sm)",
                overflow: "auto",
                fontSize: "13px",
                fontFamily: "var(--font-mono)",
                my: 1,
              },
              "& code": {
                bgcolor: theme.palette.codeBg,
                px: 0.5,
                py: 0.125,
                borderRadius: "4px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.9em",
              },
              "& pre code": { bgcolor: "transparent", p: 0 },
              "& ul, & ol": { pl: 2.5 },
              "& li": { my: 0.25 },
              "& blockquote": {
                borderLeft: `3px solid ${theme.palette.accent.main}`,
                ml: 0,
                pl: 2,
                color: theme.palette.text.secondary,
              },
              "& table": {
                borderCollapse: "collapse",
                width: "100%",
                my: 1,
              },
              "& th, & td": {
                border: `1px solid ${theme.palette.border}`,
                px: 1,
                py: 0.5,
                fontSize: "13px",
              },
              "& th": { bgcolor: theme.palette.bgSecondary, fontWeight: 600 },
            })}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ src, alt, ...props }) => (
                  <img
                    {...props}
                    src={src ? resolveImageSrc(src, repoId, filePath) : undefined}
                    alt={alt || ""}
                    style={{ maxWidth: "100%", borderRadius: 4 }}
                  />
                ),
              }}
            >
              {data.content!}
            </ReactMarkdown>
          </Box>
        ) : (
          /* Code / Text */
          <Box
            sx={{
              px: { xs: 1, sm: 2 },
              py: 1,
              overflow: "auto",
            }}
          >
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: "13px",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {data.content}
            </pre>
          </Box>
        )}

      </Box>
    </Box>
  );
}
