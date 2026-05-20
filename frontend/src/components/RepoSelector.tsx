import { useEffect, useState, useRef, useMemo } from "react";
import { Box, Typography, Collapse, InputBase } from "@mui/material";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";

interface Repo {
  id: string;
  name: string;
  path: string;
}

interface Props {
  value: string;
  onChange: (repoId: string) => void;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <Box
        component="span"
        sx={(theme) => ({ color: theme.palette.accent.main, fontWeight: 700 })}
      >
        {text.slice(idx, idx + query.length)}
      </Box>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function RepoSelector({ value, onChange }: Props) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [open, setOpen] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/repos")
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data) => { setRepos(data); setFetchError(false); })
      .catch(() => setFetchError(true));
  }, []);

  const closeDropdown = () => {
    setOpen(false);
    setSearch("");
    setActiveIndex(-1);
  };

  const selectRepo = (repoId: string) => {
    onChange(repoId);
    closeDropdown();
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // アクティブ項目をスクロール内に収める
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll<HTMLElement>("[role='option']");
      items[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const selected = repos.find((r) => r.id === value);

  const filtered = useMemo(
    () =>
      search
        ? repos.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
        : repos,
    [repos, search]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        closeDropdown();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, -1));
        break;
      case "Enter":
        if (activeIndex >= 0 && filtered[activeIndex]) {
          selectRepo(filtered[activeIndex].id);
        } else if (filtered.length === 1) {
          selectRepo(filtered[0].id);
        }
        break;
    }
  };

  const listboxId = "repo-selector-listbox";
  const getOptionId = (idx: number) => `repo-option-${idx}`;

  return (
    <Box ref={ref} sx={{ position: "relative" }}>
      {/* Trigger */}
      <Box
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 ? getOptionId(activeIndex) : undefined}
        tabIndex={0}
        onClick={() => {
          if (!open) setSearch("");
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); }
          if (e.key === "Escape") closeDropdown();
        }}
        sx={(theme) => ({
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 1.5,
          py: 0.75,
          borderRadius: "var(--radius-sm)",
          border: `1px solid ${theme.palette.border}`,
          cursor: "pointer",
          minWidth: { xs: 100, sm: 140 },
          transition: "all 0.15s ease",
          bgcolor: "background.paper",
          "&:hover": { borderColor: theme.palette.textTertiary },
          "&:focus-visible": {
            outline: `2px solid ${theme.palette.accent.main}`,
            outlineOffset: "2px",
          },
        })}
      >
        <FolderRoundedIcon
          sx={(theme) => ({ fontSize: 15, color: theme.palette.textTertiary })}
        />
        <Typography
          sx={(theme) => ({
            fontSize: "13px",
            fontWeight: 500,
            color: selected ? theme.palette.text.primary : theme.palette.textTertiary,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          })}
        >
          {selected?.name ?? "Select repo"}
        </Typography>
        <ExpandMoreRoundedIcon
          sx={(theme) => ({
            fontSize: 16,
            color: theme.palette.textTertiary,
            transition: "transform 0.2s ease",
            transform: open ? "rotate(180deg)" : "none",
          })}
        />
      </Box>

      {/* Dropdown */}
      <Collapse in={open} onEntered={() => searchRef.current?.focus()}>
        <Box
          sx={(theme) => ({
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 200,
            bgcolor: "background.paper",
            border: `1px solid ${theme.palette.border}`,
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            maxHeight: 320,
          })}
        >
          {/* 検索欄（フェッチエラー時は非表示） */}
          {!fetchError && (
            <Box
              sx={(theme) => ({
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.25,
                py: 0.75,
                borderBottom: `1px solid ${theme.palette.border}`,
              })}
            >
              <SearchRoundedIcon
                sx={(theme) => ({ fontSize: 15, color: theme.palette.textTertiary })}
              />
              <InputBase
                inputRef={searchRef}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setActiveIndex(-1); }}
                placeholder="検索..."
                aria-label="リポジトリを検索"
                onKeyDown={handleKeyDown}
                sx={{ fontSize: "13px", flex: 1 }}
              />
            </Box>
          )}

          {/* リスト */}
          <Box
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="リポジトリ一覧"
            sx={{ overflow: "auto", py: 0.5 }}
          >
            {fetchError ? (
              <Box sx={{ px: 1.5, py: 2, textAlign: "center" }}>
                <Typography sx={(theme) => ({ fontSize: "13px", color: theme.palette.textTertiary })}>
                  サーバーに接続できません
                </Typography>
              </Box>
            ) : filtered.length === 0 ? (
              <Box sx={{ px: 1.5, py: 2, textAlign: "center" }}>
                <Typography sx={(theme) => ({ fontSize: "13px", color: theme.palette.textTertiary })}>
                  {repos.length === 0 ? "リポジトリがありません" : "一致なし"}
                </Typography>
              </Box>
            ) : (
              filtered.map((r, idx) => (
                <Box
                  key={r.id}
                  id={getOptionId(idx)}
                  role="option"
                  aria-selected={r.id === value}
                  onClick={() => selectRepo(r.id)}
                  sx={(theme) => ({
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1.5,
                    py: 1,
                    cursor: "pointer",
                    transition: "background 0.1s ease",
                    bgcolor: idx === activeIndex ? theme.palette.bgSecondary : "transparent",
                    "&:hover": { bgcolor: theme.palette.bgSecondary },
                  })}
                >
                  <FolderRoundedIcon
                    sx={(theme) => ({ fontSize: 15, color: theme.palette.textTertiary })}
                  />
                  <Typography
                    sx={{
                      fontSize: "13px",
                      fontWeight: r.id === value ? 600 : 400,
                      color: "text.primary",
                      flex: 1,
                    }}
                  >
                    <HighlightedText text={r.name} query={search} />
                  </Typography>
                  {r.id === value && (
                    <CheckRoundedIcon
                      sx={(theme) => ({ fontSize: 15, color: theme.palette.accent.main })}
                    />
                  )}
                </Box>
              ))
            )}
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
}
