import { useState, useCallback, useRef, useEffect } from "react";
import { apiGitBase, apiGitShowPath } from "../utils/paths";

export interface GitCommitSummary {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitCommitFile {
  path: string;
  status: string;
}

export interface GitCommitDetail {
  hash: string;
  message: string;
  author: string;
  date: string;
  files: GitCommitFile[];
  diff: string;
}

interface UseGitHistoryReturn {
  commits: GitCommitSummary[];
  hasMore: boolean;
  loading: boolean;
  loadMoreLoading: boolean;
  error: string | null;
  selectedCommit: GitCommitDetail | null;
  selectedHash: string | null;
  detailLoading: boolean;
  loadHistory: () => Promise<void>;
  loadMore: () => Promise<void>;
  selectCommit: (hash: string) => Promise<void>;
  reset: () => void;
}

const PER_PAGE = 100;

export function useGitHistory(repoId: string): UseGitHistoryReturn {
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadMoreLoading, setLoadMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitDetail | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const base = apiGitBase(repoId);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 5000);
  }, []);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.fetch(`${base}/log?page=1&perPage=${PER_PAGE}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "履歴取得に失敗しました。");
      }
      const data = await res.json();
      setCommits(data.commits);
      setHasMore(data.hasMore);
      setPage(1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
    } finally {
      setLoading(false);
    }
  }, [base, showError]);

  const loadMore = useCallback(async () => {
    const nextPage = page + 1;
    setLoadMoreLoading(true);
    try {
      const res = await window.fetch(`${base}/log?page=${nextPage}&perPage=${PER_PAGE}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "履歴取得に失敗しました。");
      }
      const data = await res.json();
      setCommits((prev) => [...prev, ...data.commits]);
      setHasMore(data.hasMore);
      setPage(nextPage);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
    } finally {
      setLoadMoreLoading(false);
    }
  }, [base, page, showError]);

  const selectCommit = useCallback(async (hash: string) => {
    setSelectedHash(hash);
    setDetailLoading(true);
    try {
      const res = await window.fetch(apiGitShowPath(repoId, hash));
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "コミット詳細取得に失敗しました。");
      }
      const data: GitCommitDetail = await res.json();
      setSelectedCommit(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
      setSelectedCommit(null);
    } finally {
      setDetailLoading(false);
    }
  }, [repoId, showError]);

  const reset = useCallback(() => {
    setCommits([]);
    setHasMore(false);
    setPage(1);
    setSelectedCommit(null);
    setSelectedHash(null);
  }, []);

  return {
    commits,
    hasMore,
    loading,
    loadMoreLoading,
    error,
    selectedCommit,
    selectedHash,
    detailLoading,
    loadHistory,
    loadMore,
    selectCommit,
    reset,
  };
}
