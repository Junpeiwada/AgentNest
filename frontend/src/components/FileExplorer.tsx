import { useState, useEffect, useLayoutEffect, useCallback, useRef, useSyncExternalStore } from "react";
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

/** 取得結果。key は `${repoId}:${currentPath}` で、どのパスに対する結果かを示す。 */
type FetchResult =
  | { key: string; mode: "directory"; entries: FileEntry[] }
  | { key: string; mode: "file" }
  | { key: string; mode: "error" };

/** entries の派生値で使う空配列。毎レンダー新しい配列を作ると依存が変わってしまうため定数にする。 */
const EMPTY_ENTRIES: FileEntry[] = [];

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
    notifyLastTaps();
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
    notifyLastTaps();
    return path;
  } catch {
    return null;
  }
}

// sessionStorage上のタップ記録をReactから購読するための小さなストア。
// useSyncExternalStoreのgetSnapshotは内容が同じなら同一参照を返す必要があるため、
// 生JSONをキャッシュし、変化したときだけパースし直す。
const tapListeners = new Set<() => void>();
let tapCache: { raw: string | null; parsed: Record<string, string> } = { raw: null, parsed: {} };

function subscribeLastTaps(listener: () => void): () => void {
  tapListeners.add(listener);
  return () => {
    tapListeners.delete(listener);
  };
}

function getLastTapsSnapshot(): Record<string, string> {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(LAST_TAP_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== tapCache.raw) {
    let parsed: Record<string, string> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
    }
    tapCache = { raw, parsed };
  }
  return tapCache.parsed;
}

function notifyLastTaps(): void {
  for (const listener of tapListeners) listener();
}

export default function FileExplorer({ repoId, currentPath, onNavigate }: Props) {
  const theme = useTheme();
  const [result, setResult] = useState<FetchResult | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `${repoId}:${currentPath}`;
  // 取得結果からの派生値。scrollKeyと一致する結果だけを「確定」とみなすため、
  // パス切り替え直後は自動的に loading 扱いになり、前のディレクトリの内容は見えない。
  const settled = result?.key === scrollKey ? result : null;
  const loading = settled === null;
  const viewMode: ViewMode = settled ? settled.mode : "loading";
  const entries = settled?.mode === "directory" ? settled.entries : EMPTY_ENTRIES;
  const fetchError = settled?.mode === "error";
  // スクロール中はメモリに最新値を保持し、sessionStorageへの書き込みはデバウンスする
  const pendingScroll = useRef<{ key: string; top: number } | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 戻ってきたときにiOS風ハイライト→フェードさせる対象のentry path。
  // 対象セルに@keyframesアニメ（最初から色が載っていてフェードアウトするだけ）を当てる。
  // sessionStorage上のタップ記録を購読し、そこからの純粋な導出で対象を決める。
  // 記録の消費はセルのonAnimationEndで行うため、解除用のstateもタイマーも持たない。
  const lastTaps = useSyncExternalStore(subscribeLastTaps, getLastTapsSnapshot);
  const tappedPath = settled?.mode === "directory" ? lastTaps[scrollKey] ?? null : null;
  const highlightPath =
    tappedPath && entries.some((e) => e.path === tappedPath) ? tappedPath : null;

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

  // currentPathがディレクトリかファイルかを判定しつつデータを取得する。
  // 取得結果は「どのキーに対する結果か」を持たせて1つのstateへ集約し、
  // loading/viewMode/entries/fetchError はそこからの派生値にする。
  // 取得開始時に同期でsetStateしないことで、effect起点の連鎖レンダーを避ける。
  useEffect(() => {
    if (!repoId) return;
    let cancelled = false;
    const key = `${repoId}:${currentPath}`;
    (async (): Promise<FetchResult> => {
      try {
        const res = await fetch(apiFilesPath(repoId, currentPath));
        if (res.ok) {
          const data: FileEntry[] = await res.json();
          return { key, mode: "directory", entries: data };
        }
        const errorBody = await res.json().catch(() => null);
        // ディレクトリでなければファイルとみなす
        if (res.status === 400 && errorBody?.error === "Not a directory") {
          return { key, mode: "file" };
        }
        return { key, mode: "error" };
      } catch {
        return { key, mode: "error" };
      }
    })().then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => { cancelled = true; };
  }, [repoId, currentPath]);

  // ディレクトリ表示が確定したら、描画反映前（レイアウト確定時）にスクロール位置を復元する。
  // scrollKey単位で復元するため依存はscrollKey/viewMode/loadingに絞る（entriesでの再復元を避ける）。
  useLayoutEffect(() => {
    if (viewMode !== "directory" || loading) return;
    const el = listScrollRef.current;
    if (!el) return;
    const saved = loadScrollPositions()[scrollKey];
    if (saved != null) el.scrollTop = saved;
  }, [viewMode, loading, scrollKey]);

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
        <Typography sx={{ fontSize: "14px" }}>リポジトリを選択してください</Typography>
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
            <Typography sx={{ fontSize: "13px" }}>
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
                // ハイライトの消費（記録の削除）はアニメーション終了時に行う。
                // これで解除用のタイマーを持たずに済み、CSS側の長さと必ず一致する。
                onAnimationEnd={isHighlighted ? () => consumeLastTap(scrollKey) : undefined}
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
                  slotProps={{ primary: { sx: {
                    fontSize: { xs: "14px", sm: "13px" },
                    fontWeight: 400,
                    fontFamily: "var(--font-mono)",
                    color: "text.primary",
                  } } }}
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
