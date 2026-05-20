import { useState, useCallback } from "react";
import { apiGitBase, apiGitDiffPath } from "../utils/paths";

export interface GitFile {
  path: string;
  status: string; // M, A, D, R, ?
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

interface UseGitStatusReturn {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  selectedFile: string | null;
  diff: string | null;
  diffLoading: boolean;
  commitMessage: string;
  operationLoading: boolean;
  refresh: () => Promise<void>;
  selectFile: (file: string) => Promise<void>;
  setCommitMessage: (msg: string) => void;
  stageFiles: (files: string[]) => Promise<void>;
  unstageFiles: (files: string[]) => Promise<void>;
  commit: () => Promise<void>;
  undoCommit: () => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
}

export function useGitStatus(repoId: string): UseGitStatusReturn {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [operationLoading, setOperationLoading] = useState(false);

  const base = apiGitBase(repoId);

  const showError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.fetch(`${base}/status`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "ステータス取得に失敗しました。");
      }
      const data: GitStatus = await res.json();
      setStatus(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
    } finally {
      setLoading(false);
    }
  }, [base, showError]);

  const selectFile = useCallback(async (file: string) => {
    setSelectedFile(file);
    setDiffLoading(true);
    try {
      const res = await window.fetch(apiGitDiffPath(repoId, file));
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Diff取得に失敗しました。");
      }
      const data = await res.json();
      setDiff(data.diff);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  }, [repoId, showError]);

  const stageFiles = useCallback(async (files: string[]) => {
    try {
      const res = await window.fetch(`${base}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "ステージに失敗しました。");
      }
      await refresh();
      // 選択中ファイルの diff を再取得
      if (selectedFile && files.includes(selectedFile)) {
        await selectFile(selectedFile);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
    }
  }, [base, refresh, selectedFile, selectFile, showError]);

  const unstageFiles = useCallback(async (files: string[]) => {
    try {
      const res = await window.fetch(`${base}/unstage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "アンステージに失敗しました。");
      }
      await refresh();
      if (selectedFile && files.includes(selectedFile)) {
        await selectFile(selectedFile);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
    }
  }, [base, refresh, selectedFile, selectFile, showError]);

  const doOperation = useCallback(async (op: "commit" | "undo-commit" | "fetch" | "pull" | "push", body?: object) => {
    setOperationLoading(true);
    try {
      const res = await window.fetch(`${base}/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `${op}に失敗しました。`);
      }
      await refresh();
      return data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "不明なエラー";
      showError(msg);
      throw err;
    } finally {
      setOperationLoading(false);
    }
  }, [base, refresh, showError]);

  const commitFn = useCallback(async () => {
    await doOperation("commit", { message: commitMessage });
    setCommitMessage("");
    setSelectedFile(null);
    setDiff(null);
  }, [doOperation, commitMessage]);

  const undoCommitFn = useCallback(async () => {
    const data = await doOperation("undo-commit");
    // 取り消したコミットメッセージをフィールドに復元
    if (data?.commitMessage) {
      setCommitMessage(data.commitMessage);
    }
  }, [doOperation]);

  const fetchFn = useCallback(() => doOperation("fetch"), [doOperation]);
  const pullFn = useCallback(() => doOperation("pull"), [doOperation]);
  const pushFn = useCallback(() => doOperation("push"), [doOperation]);

  return {
    status,
    loading,
    error,
    selectedFile,
    diff,
    diffLoading,
    commitMessage,
    operationLoading,
    refresh,
    selectFile,
    setCommitMessage,
    stageFiles,
    unstageFiles,
    commit: commitFn,
    undoCommit: undoCommitFn,
    fetch: fetchFn,
    pull: pullFn,
    push: pushFn,
  };
}
