import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  CircularProgress,
  Breadcrumbs,
  Link,
} from "@mui/material";
import { useTheme, keyframes } from "@mui/material/styles";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import InsertDriveFileRoundedIcon from "@mui/icons-material/InsertDriveFileRounded";
import ImageRoundedIcon from "@mui/icons-material/ImageRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import FileViewer from "./FileViewer";
import { apiFilesPath } from "../utils/paths";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
}

interface Props {
  repoId: string;
  currentPath: string;
  onNavigate: (path: string) => void;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".cpp", ".c", ".rs", ".go", ".rb", ".swift", ".html", ".css", ".scss", ".json", ".yaml", ".yml", ".toml", ".sh"]);
const DOC_EXT = new Set([".md", ".txt", ".doc", ".rst"]);

function getFileIcon(entry: FileEntry, palette: import("@mui/material").Theme["palette"]) {
  if (entry.type === "directory") return <FolderRoundedIcon sx={{ color: palette.fileIcon.folder }} />;
  const ext = entry.extension || "";
  if (IMAGE_EXT.has(ext)) return <ImageRoundedIcon sx={{ color: palette.fileIcon.image }} />;
  if (CODE_EXT.has(ext)) return <CodeRoundedIcon sx={{ color: palette.fileIcon.code }} />;
  if (DOC_EXT.has(ext)) return <DescriptionRoundedIcon sx={{ color: palette.fileIcon.doc }} />;
  return <InsertDriveFileRoundedIcon sx={{ color: palette.textTertiary }} />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ViewMode = "directory" | "file" | "loading" | "error";

// パスごとのスクロール位置をセッション中保持する（タブを閉じるまで有効）
const SCROLL_STORAGE_KEY = "fileExplorerScroll";
// 保持するエントリ数の上限。超えたら古いものから破棄しsessionStorageの肥大化を防ぐ
const SCROLL_MAX_ENTRIES = 50;

function loadScrollPositions(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveScrollPosition(key: string, top: number) {
  try {
    const positions = loadScrollPositions();
    // 既存キーを末尾（最新）に詰め直すため一度削除してから入れ直す
    delete positions[key];
    positions[key] = top;
    const keys = Object.keys(positions);
    if (keys.length > SCROLL_MAX_ENTRIES) {
      delete positions[keys[0]]; // 最も古いエントリを破棄（挿入順=LRU）
    }
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* sessionStorageが使えない環境・容量超過時は無視 */
  }
}

// 各ディレクトリで最後にタップしたエントリのpathを保持する。
// 戻ってきたときにそのセルをiOS風にハイライト→フェードアウトさせるために使う。
const LAST_TAP_STORAGE_KEY = "fileExplorerLastTap";

function loadLastTaps(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(LAST_TAP_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLastTap(key: string, path: string) {
  try {
    const taps = loadLastTaps();
    delete taps[key];
    taps[key] = path;
    const keys = Object.keys(taps);
    if (keys.length > SCROLL_MAX_ENTRIES) {
      delete taps[keys[0]];
    }
    sessionStorage.setItem(LAST_TAP_STORAGE_KEY, JSON.stringify(taps));
  } catch {
    /* 無視 */
  }
}

// 一度ハイライトに使ったら消費してクリアする（再表示で繰り返さない）
function consumeLastTap(key: string): string | null {
  try {
    const taps = loadLastTaps();
    const path = taps[key];
    if (path == null) return null;
    delete taps[key];
    sessionStorage.setItem(LAST_TAP_STORAGE_KEY, JSON.stringify(taps));
    return path;
  } catch {
    return null;
  }
}

export default function FileExplorer({ repoId, currentPath, onNavigate }: Props) {
  const theme = useTheme();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("loading");
  const [fetchError, setFetchError] = useState(false);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `${repoId}:${currentPath}`;
  // スクロール中はメモリに最新値を保持し、sessionStorageへの書き込みはデバウンスする
  const pendingScroll = useRef<{ key: string; top: number } | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 戻ってきたときにiOS風ハイライト→フェードさせる対象のentry path。
  // 対象セルに@keyframesアニメ（最初から色が載っていてフェードアウトするだけ）を当てる。
  const [highlightPath, setHighlightPath] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 保留中のスクロール位置を即座にsessionStorageへ書き出す
  const flushScroll = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const pending = pendingScroll.current;
    if (pending) {
      saveScrollPosition(pending.key, pending.top);
      pendingScroll.current = null;
    }
  }, []);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      pendingScroll.current = { key: scrollKey, top: e.currentTarget.scrollTop };
      if (flushTimer.current) return;
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        flushScroll();
      }, 200);
    },
    [scrollKey, flushScroll],
  );

  // アンマウント時に保留分を書き出す
  useEffect(() => () => flushScroll(), [flushScroll]);

  // currentPathがディレクトリかファイルかを判定しつつデータを取得
  const fetchPath = useCallback(async (pathStr: string) => {
    if (!repoId) return;
    setLoading(true);
    setFetchError(false);

    try {
      const res = await fetch(apiFilesPath(repoId, pathStr));

      if (res.ok) {
        const data: FileEntry[] = await res.json();
        setEntries(data);
        setViewMode("directory");
      } else {
        const errorBody = await res.json().catch(() => null);
        if (res.status === 400 && errorBody?.error === "Not a directory") {
          // ディレクトリでなければファイルとみなす
          setViewMode("file");
        } else {
          setEntries([]);
          setFetchError(true);
          setViewMode("error");
        }
      }
    } catch {
      setEntries([]);
      setFetchError(true);
      setViewMode("error");
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    setViewMode("loading");
    if (repoId) fetchPath(currentPath);
  }, [repoId, currentPath, fetchPath]);

  // ディレクトリ表示が確定したら、描画反映前（レイアウト確定時）にスクロール位置を復元する。
  // scrollKey単位で復元するため依存はscrollKey/viewMode/loadingに絞る（entriesでの再復元を避ける）。
  useLayoutEffect(() => {
    if (viewMode !== "directory" || loading) return;
    const el = listScrollRef.current;
    if (!el) return;
    const saved = loadScrollPositions()[scrollKey];
    if (saved != null) el.scrollTop = saved;
  }, [viewMode, loading, scrollKey]);

  // 戻ってきてこのディレクトリの一覧が出揃ったら、最後にタップしたセルを
  // iOS風に一瞬ハイライトしてフェードアウトさせる（消費したら記録はクリア）。
  // 「いま表示しているディレクトリ（currentPath）」を基準に発火する。子へ進む際に
  // 記録するキーは"進む前のディレクトリ"なので、子表示中にそのキーを覗いても一致せず、
  // 親へ戻ったときに初めて一致して発火する。
  useEffect(() => {
    // ディレクトリの中身が確定したタイミングでのみ判定する。
    // entriesに対象pathが含まれること=「いま表示中のディレクトリの中身」である保証になり、
    // 子へ進む途中の中間レンダー（entriesがまだ親/未確定）では消費されない。
    if (viewMode !== "directory" || loading) return;
    const tapped = loadLastTaps()[scrollKey];
    if (tapped == null || !entries.some((e) => e.path === tapped)) return;
    // ここで初めて消費（削除）する。発火が確定した瞬間だけなので早期消費は起きない。
    consumeLastTap(scrollKey);
    setHighlightPath(tapped);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    // アニメ完了後に対象を片付ける（再描画でanimationが再発火しないように）
    highlightTimer.current = setTimeout(() => {
      setHighlightPath(null);
      highlightTimer.current = null;
    }, 1100);
  }, [viewMode, loading, scrollKey, entries]);

  // アンマウント時にハイライト用タイマーを掃除する
  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  const handleEntryClick = (entry: FileEntry) => {
    // 移動前に現在のスクロール位置を確実に書き出しておく
    const el = listScrollRef.current;
    if (el) pendingScroll.current = { key: scrollKey, top: el.scrollTop };
    flushScroll();
    // 戻ってきたときのハイライト用にタップ位置を記録する（ディレクトリ・ファイルどちらも）
    saveLastTap(scrollKey, entry.path);
    onNavigate(entry.path);
  };

  // パンくずリスト用のパス分解
  const pathParts = currentPath ? currentPath.split("/") : [];

  if (!repoId) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "text.secondary" }}>
        <Typography fontSize="14px">リポジトリを選択してください</Typography>
      </Box>
    );
  }

  // ファイルビューワー
  if (viewMode === "file") {
    return (
      <FileViewer
        repoId={repoId}
        filePath={currentPath}
        onClose={() => {
          // 親ディレクトリに戻る
          const parentDir = currentPath.includes("/")
            ? currentPath.split("/").slice(0, -1).join("/")
            : "";
          onNavigate(parentDir);
        }}
      />
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Breadcrumbs */}
      <Box
        sx={(t) => ({
          display: "flex",
          alignItems: "center",
          px: { xs: 1.5, sm: 2 },
          py: 1,
          borderBottom: `1px solid ${t.palette.border}`,
          bgcolor: "background.paper",
          flexShrink: 0,
          overflow: "auto",
          whiteSpace: "nowrap",
        })}
      >
        <Breadcrumbs
          separator={<ChevronRightRoundedIcon sx={{ fontSize: 16, color: theme.palette.textTertiary }} />}
          sx={{ "& .MuiBreadcrumbs-separator": { mx: 0.25 } }}
        >
          <Link
            component="button"
            underline="hover"
            onClick={() => onNavigate("")}
            sx={{ fontSize: "13px", color: pathParts.length === 0 ? "text.primary" : "text.secondary", fontWeight: pathParts.length === 0 ? 600 : 400 }}
          >
            {repoId}
          </Link>
          {pathParts.map((part, i) => {
            const partPath = pathParts.slice(0, i + 1).join("/");
            const isLast = i === pathParts.length - 1;
            return (
              <Link
                key={partPath}
                component="button"
                underline="hover"
                onClick={() => onNavigate(partPath)}
                sx={{ fontSize: "13px", color: isLast ? "text.primary" : "text.secondary", fontWeight: isLast ? 600 : 400 }}
              >
                {part}
              </Link>
            );
          })}
        </Breadcrumbs>
      </Box>

      {/* File List */}
      <Box
        ref={listScrollRef}
        onScroll={handleScroll}
        sx={{ flex: 1, overflow: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
      >
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} sx={{ color: theme.palette.accent.main }} />
          </Box>
        ) : entries.length === 0 ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4, color: theme.palette.textTertiary }}>
            <Typography fontSize="13px">
              {fetchError ? "サーバーに接続できません" : "空のディレクトリです"}
            </Typography>
          </Box>
        ) : (
          <List disablePadding>
            {entries.map((entry) => {
              const isHighlighted = highlightPath === entry.path;
              return (
              <ListItemButton
                key={entry.path}
                onClick={() => handleEntryClick(entry)}
                sx={(t) => ({
                  py: { xs: 1.25, sm: 0.75 },
                  px: { xs: 1.5, sm: 2 },
                  borderBottom: `1px solid ${t.palette.border}`,
                  // 戻ってきた直後の対象セルだけ、最初からaccent色が載った状態でフェードアウトする
                  // （keyframesなのでフェードインせず、iOSのタップ解除のように消えていく）
                  ...(isHighlighted && {
                    animation: `${keyframes`
                      from { background-color: ${t.palette.accent.soft}; }
                      to { background-color: transparent; }
                    `} 1000ms ease-out forwards`,
                  }),
                  "&:hover": { bgcolor: t.palette.accent.soft },
                  "&:active": { bgcolor: t.palette.bgSecondary },
                })}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  {getFileIcon(entry, theme.palette)}
                </ListItemIcon>
                <ListItemText
                  primary={entry.name}
                  primaryTypographyProps={{
                    fontSize: { xs: "14px", sm: "13px" },
                    fontWeight: 400,
                    fontFamily: "var(--font-mono)",
                    color: "text.primary",
                  }}
                />
                {entry.type === "file" && entry.size != null && (
                  <Typography sx={{ fontSize: "11px", color: theme.palette.textTertiary, ml: 1, flexShrink: 0 }}>
                    {formatSize(entry.size)}
                  </Typography>
                )}
                {entry.type === "directory" && (
                  <ChevronRightRoundedIcon sx={{ fontSize: 18, color: theme.palette.textTertiary }} />
                )}
              </ListItemButton>
              );
            })}
          </List>
        )}
      </Box>
    </Box>
  );
}
