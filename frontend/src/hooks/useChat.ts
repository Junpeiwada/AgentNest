import { useState, useCallback, useRef, useEffect } from "react";
import {
  DEFAULT_MODEL_VALUE,
  LS_MODEL_KEY,
  LS_EFFORT_KEY,
  findModel,
  normalizeEffort,
  type EffortLevel,
  type ModelInfo,
} from "../lib/modelSettings";
import {
  LS_PERMISSION_MODE_KEY,
  LS_LEGACY_AUTO_EDIT_KEYS,
  normalizePermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import { useConnectionId } from "./useConnectionId";

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface AssistantPart {
  type: "text" | "tool_result";
  content: string;
  toolName?: string;
  filePath?: string;
  structuredPatch?: StructuredPatchHunk[];
  toolInput?: Record<string, unknown>;
}

export interface AssistantError {
  kind: "generic" | "limit";
  message: string;
}

export interface ImageAttachment {
  data: string;      // base64 (no data URL prefix)
  mediaType: string; // e.g. "image/png"
  preview: string;   // data URL for display
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  images?: ImageAttachment[];
  parts?: AssistantPart[];
  error?: AssistantError | null;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  requestId: string;
  questions: QuestionItem[];
}

export type SessionState = "idle" | "running" | "requires_action";

export interface ToolProgress {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE events have dynamic shapes
type SSEEvent = Record<string, any>;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1500;
const KEEPALIVE_TIMEOUT_MS = 45_000; // サーバーkeepalive(15s)の3倍

function normalizeAssistantMessage(message: Message): Message {
  if (message.role !== "assistant") return message;
  if (message.parts) return message;
  return {
    ...message,
    parts: message.content ? [{ type: "text", content: message.content }] : [],
    error: message.error ?? null,
  };
}

function updateLastAssistant(
  messages: Message[],
  updater: (message: Message) => Message
): Message[] {
  const updated = [...messages];
  const last = updated[updated.length - 1];
  if (last?.role !== "assistant") return updated;
  updated[updated.length - 1] = updater(normalizeAssistantMessage(last));
  return updated;
}

function appendAssistantText(message: Message, content: string): Message {
  if (message.role !== "assistant") return message;
  const parts = [...(message.parts ?? [])];
  const lastPart = parts[parts.length - 1];
  if (lastPart?.type === "text") {
    parts[parts.length - 1] = {
      ...lastPart,
      content: lastPart.content + content,
    };
  } else {
    parts.push({ type: "text", content });
  }
  return {
    ...message,
    content: message.content + content,
    parts,
  };
}

function appendToolResult(
  message: Message,
  toolName: string,
  content: string,
  filePath?: string,
  structuredPatch?: StructuredPatchHunk[],
  toolInput?: Record<string, unknown>
): Message {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    parts: [...(message.parts ?? []), { type: "tool_result", toolName, content, filePath, structuredPatch, toolInput }],
  };
}

function setAssistantError(message: Message, error: AssistantError): Message {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    error,
  };
}

export function useChat(
  initialMessages?: Message[],
  initialSessionId?: string | null,
) {
  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [isLoading, setIsLoading] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const [pendingQuestion, setPendingQuestion] =
    useState<PendingQuestion | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const forceFreshSessionRef = useRef(initialSessionId == null);
  // タブ単位のconnectionId。サーバー側のセッション分離のため全チャット系APIに付与する。
  const connectionId = useConnectionId();

  // --- モデル / Thinking effort 選択（Docs/仕様-モデル選択.md）---
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string>(
    () => localStorage.getItem(LS_MODEL_KEY) ?? DEFAULT_MODEL_VALUE
  );
  const [selectedEffort, setSelectedEffortState] = useState<EffortLevel | null>(
    () => (localStorage.getItem(LS_EFFORT_KEY) as EffortLevel | null) ?? null
  );
  // 実行モード（permissionMode）。保存値を正規化して復元。
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
    () => normalizePermissionMode(localStorage.getItem(LS_PERMISSION_MODE_KEY))
  );
  // 最新値を sendMessage / setSelectedModel から参照するための ref
  const selectedModelRef = useRef(selectedModel);
  const selectedEffortRef = useRef(selectedEffort);
  const permissionModeRef = useRef(permissionMode);
  const modelsRef = useRef(models);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { selectedEffortRef.current = selectedEffort; }, [selectedEffort]);
  useEffect(() => { permissionModeRef.current = permissionMode; }, [permissionMode]);
  useEffect(() => { modelsRef.current = models; }, [models]);

  // 旧「Auto Edit」トグルの localStorage キーを掃除（permissionMode へ移行済みの死にデータ）
  useEffect(() => {
    for (const key of LS_LEGACY_AUTO_EDIT_KEYS) localStorage.removeItem(key);
  }, []);

  // モデル一覧を取得し、保存済み選択値を検証・正規化する。
  // サーバ起動直後は prefetch 未完了で空配列が返るため、空なら有限回リトライする。
  useEffect(() => {
    let cancelled = false;
    const RETRY_DELAYS_MS = [1000, 2000, 4000]; // 空一覧だった場合の再試行間隔

    // 一覧取得を1回試みる。成功（非空）したら true、空なら false。
    const fetchOnce = async (): Promise<boolean> => {
      const res = await fetch("/api/models");
      if (!res.ok) return false;
      const data = await res.json();
      const list: ModelInfo[] = Array.isArray(data.models) ? data.models : [];
      if (cancelled) return true; // 中断時はリトライ不要
      if (list.length === 0) return false; // prefetch未完了 → リトライ対象
      setModels(list);
      // 復元値の検証: 実モデルが現一覧に無ければ「おまかせ」へフォールバック
      const restored = localStorage.getItem(LS_MODEL_KEY) ?? DEFAULT_MODEL_VALUE;
      const model = findModel(list, restored);
      const nextModel = model ? restored : DEFAULT_MODEL_VALUE;
      const nextModelInfo = model ?? findModel(list, DEFAULT_MODEL_VALUE);
      const restoredEffort = (localStorage.getItem(LS_EFFORT_KEY) as EffortLevel | null) ?? null;
      const nextEffort = normalizeEffort(nextModelInfo, restoredEffort); // 起動時復元直後も正規化
      setSelectedModelState(nextModel);
      setSelectedEffortState(nextEffort);
      localStorage.setItem(LS_MODEL_KEY, nextModel);
      if (nextEffort) localStorage.setItem(LS_EFFORT_KEY, nextEffort);
      else localStorage.removeItem(LS_EFFORT_KEY);
      return true;
    };

    (async () => {
      try {
        if (await fetchOnce()) return;
        for (const delay of RETRY_DELAYS_MS) {
          await new Promise((r) => setTimeout(r, delay));
          if (cancelled) return;
          if (await fetchOnce()) return;
        }
      } catch { /* 取得失敗時は空一覧のまま縮退（おまかせのみ） */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // モデル選択（切替時に effort を正規化して永続化）
  // models は ref 経由で常に最新を参照する（クロージャに古い空配列を閉じ込めない）
  const setSelectedModel = useCallback((value: string) => {
    setSelectedModelState(value);
    localStorage.setItem(LS_MODEL_KEY, value);
    setSelectedEffortState((prevEffort) => {
      const model = findModel(modelsRef.current, value);
      const next = normalizeEffort(model, prevEffort);
      if (next) localStorage.setItem(LS_EFFORT_KEY, next);
      else localStorage.removeItem(LS_EFFORT_KEY);
      return next;
    });
  }, []);

  // effort選択（永続化）
  const setSelectedEffort = useCallback((effort: EffortLevel) => {
    setSelectedEffortState(effort);
    localStorage.setItem(LS_EFFORT_KEY, effort);
  }, []);

  // 実行モード選択（永続化）
  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setPermissionModeState(mode);
    localStorage.setItem(LS_PERMISSION_MODE_KEY, mode);
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // アンマウント時に進行中のSSE接続を後始末する。
  // 会話の切り替え（新規会話・セッション復帰・リポジトリ変更）は RootLayout の
  // <Chat key={chatKey}> による再マウントで状態が初期化されるため、ここでリセットはしない。
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /** Parse SSE lines from a ReadableStream, calling handler for each event.
   *  onRawData is called on every reader.read() return (including keepalive). */
  const processSSEStream = useCallback(
    async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      signal: AbortSignal,
      handler: (data: SSEEvent) => void,
      onRawData?: () => void
    ) => {
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        onRawData?.();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (signal.aborted) break;
          if (!line.startsWith("data: ")) continue;
          try {
            handler(JSON.parse(line.slice(6)));
          } catch { /* skip malformed SSE lines */ }
        }
      }
    },
    []
  );

  /** Handle a single SSE event (shared between initial connection and reconnect) */
  const handleSSEEvent = useCallback(
    (data: SSEEvent) => {
      if (data.type === "session_id") {
        setSessionId(data.sessionId);
      } else if (data.type === "activity") {
        setActivity(data.activity);
      } else if (data.type === "text") {
        setActivity(null);
        setMessages((prev) =>
          updateLastAssistant(prev, (last) => appendAssistantText(last, data.content))
        );
      } else if (data.type === "tool_result") {
        setActivity(null);
        setMessages((prev) =>
          updateLastAssistant(prev, (last) =>
            appendToolResult(last, data.toolName ?? "Tool", data.content, data.filePath, data.structuredPatch, data.toolInput)
          )
        );
      } else if (data.type === "limit_error") {
        setActivity(null);
        setMessages((prev) =>
          updateLastAssistant(prev, (last) =>
            setAssistantError(last, { kind: "limit", message: data.error })
          )
        );
      } else if (data.type === "permission") {
        console.log("[PERMISSION_RECEIVED]", data.toolName, data.requestId);
        setPendingPermission({
          requestId: data.requestId,
          toolName: data.toolName,
          toolInput: data.toolInput,
        });
      } else if (data.type === "question") {
        console.log("[QUESTION_RECEIVED]", data.requestId);
        setPendingQuestion({
          requestId: data.requestId,
          questions: data.questions,
        });
      } else if (data.type === "session_state") {
        setSessionState(data.state);
        if (data.state === "idle") setToolProgress(null);
      } else if (data.type === "tool_progress") {
        setToolProgress({
          toolUseId: data.toolUseId,
          toolName: data.toolName,
          elapsedSeconds: data.elapsedSeconds,
        });
      } else if (data.type === "done") {
        setActivity(null);
        setSessionState(null);
        setToolProgress(null);
        if (data.sessionId) setSessionId(data.sessionId);
      } else if (data.type === "error") {
        setMessages((prev) =>
          updateLastAssistant(prev, (last) =>
            setAssistantError(last, { kind: "generic", message: data.error })
          )
        );
      }
    },
    []
  );

  /** Attempt to reconnect to an active session via /api/reconnect */
  const attemptReconnect = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      try {
        const res = await fetch("/api/reconnect", {
          signal,
          headers: { "X-Connection-Id": connectionId },
        });
        if (!res.ok) return false;

        const reader = res.body?.getReader();
        if (!reader) return false;

        let receivedTerminalEvent = false;
        let sessionCompleted = false;

        await processSSEStream(reader, signal, (data) => {
          if (data.type === "reconnect_state") {
            // Restore accumulated state from the server snapshot
            if (data.sessionId) setSessionId(data.sessionId);
            setPendingPermission(data.pendingPermission ?? null);
            setPendingQuestion(data.pendingQuestion ?? null);
            if (data.assistantMessage) {
              setMessages((prev) =>
                updateLastAssistant(prev, () => normalizeAssistantMessage(data.assistantMessage))
              );
            } else if (typeof data.responseText === "string") {
              setMessages((prev) =>
                updateLastAssistant(prev, (last) => ({
                  ...normalizeAssistantMessage(last),
                  content: data.responseText,
                  parts: data.responseText
                    ? [{ type: "text", content: data.responseText }]
                    : [],
                }))
              );
            }
            if (data.completed) {
              sessionCompleted = true;
            }
          } else {
            // Normal SSE events after reconnection
            if (data.type === "done" || data.type === "error" || data.type === "limit_error") {
              receivedTerminalEvent = true;
            }
            handleSSEEvent(data);
          }
        });

        return sessionCompleted || receivedTerminalEvent;
      } catch {
        return false;
      }
    },
    [processSSEStream, handleSSEEvent, connectionId]
  );

  /** Reconnect with retries */
  const reconnectWithRetries = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
        if (signal.aborted) return false;
        if (i > 0) {
          await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        }
        if (signal.aborted) return false;
        const ok = await attemptReconnect(signal);
        if (ok) return true;
      }
      return false;
    },
    [attemptReconnect]
  );

  const sendMessage = useCallback(
    async (
      message: string,
      repoId: string,
      images?: ImageAttachment[],
      sessionIdOverride?: string | null,
    ) => {
      // Abort any existing connection (follow-up during loading)
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }

      const userMsg: Message = { role: "user", content: message };
      if (images?.length) userMsg.images = images;
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setActivity(null);

      // Add empty assistant message that we'll stream into
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const controller = new AbortController();
      abortRef.current = controller;

      // Prepare API images (strip preview for smaller payload)
      const apiImages = images?.length
        ? images.map(({ data, mediaType }) => ({ data, mediaType }))
        : undefined;
      const requestSessionId = sessionIdOverride !== undefined
        ? sessionIdOverride
        : forceFreshSessionRef.current
          ? null
          : sessionIdRef.current;
      forceFreshSessionRef.current = false;

      // モデル/effort: default も含めて常に明示送信（案2）
      const apiModel = selectedModelRef.current;
      const apiEffort = selectedEffortRef.current ?? undefined;
      // 実行モード（permissionMode）も常に明示送信
      const apiPermissionMode = permissionModeRef.current;

      let receivedDone = false;
      let receivedError = false;
      let lastDataTime = Date.now();
      let keepaliveTimedOut = false;

      // Keepaliveタイムアウト監視: サーバーから45秒以上データが来なければ接続断と判断
      const keepaliveMonitor = setInterval(() => {
        const elapsed = Date.now() - lastDataTime;
        if (elapsed > KEEPALIVE_TIMEOUT_MS) {
          console.log(`[KEEPALIVE] タイムアウト検知: ${Math.round(elapsed / 1000)}秒データなし`);
          keepaliveTimedOut = true;
          controller.abort();
        }
      }, 5_000);

      // iOS Safari: ページが非表示→復帰したときのログ
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          const elapsed = Date.now() - lastDataTime;
          console.log(`[VISIBILITY] ページ復帰: 最終データから${Math.round(elapsed / 1000)}秒経過, receivedDone=${receivedDone}, receivedError=${receivedError}`);
        } else {
          console.log("[VISIBILITY] ページ非表示化");
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      const doReconnect = async () => {
        console.log("[RECONNECT] 再接続開始");
        const reconnectController = new AbortController();
        abortRef.current = reconnectController;
        setIsReconnecting(true);
        setActivity("再接続中...");
        const reconnected = await reconnectWithRetries(reconnectController.signal);
        setIsReconnecting(false);
        console.log("[RECONNECT]", reconnected ? "成功" : "全リトライ失敗");
        if (!reconnected) {
          setMessages((prev) =>
            updateLastAssistant(prev, (last) =>
              setAssistantError(last, {
                kind: "generic",
                message: "サーバーに接続できません。サーバーが起動しているか確認してください。",
              })
            )
          );
        }
        // まだ自分のcontrollerなら解放 → finallyでisLoadingがクリアされる
        // 新しいsendMessageが別controllerをセット済みなら上書きしない
        if (abortRef.current === reconnectController) {
          abortRef.current = null;
        }
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Connection-Id": connectionId },
          body: JSON.stringify({ message, repoId, sessionId: requestSessionId, permissionMode: apiPermissionMode, images: apiImages, model: apiModel, effort: apiEffort }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let errorMessage = `サーバーエラー (${res.status})`;
          try {
            const body = await res.text();
            if (body) errorMessage += `\n${body}`;
          } catch { /* ignore */ }
          setMessages((prev) =>
            updateLastAssistant(prev, (last) =>
              setAssistantError(last, { kind: "generic", message: errorMessage })
            )
          );
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        await processSSEStream(
          reader,
          controller.signal,
          (data) => {
            if (data.type === "done") receivedDone = true;
            if (data.type === "error" || data.type === "limit_error") receivedError = true;
            handleSSEEvent(data);
          },
          () => { lastDataTime = Date.now(); }
        );

        // ストリームが正常終了したがdone/errorイベントが来ていない → 接続断の可能性
        if (!receivedDone && !receivedError && (!controller.signal.aborted || keepaliveTimedOut)) {
          console.log("[RECONNECT] ストリーム終了（done/errorなし）→ 再接続を試行");
          await doReconnect();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          if (keepaliveTimedOut) {
            console.log("[RECONNECT] keepaliveタイムアウト → 再接続を試行");
            await doReconnect();
          }
          // else: ユーザーキャンセルまたは新しいsendMessageによる中断 → 再接続しない
        } else {
          console.log("[RECONNECT] 接続エラー → 再接続を試行", err);
          await doReconnect();
        }
      } finally {
        clearInterval(keepaliveMonitor);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        // Only cleanup if this is still the active controller
        // (a newer sendMessage call may have replaced it)
        if (abortRef.current === controller || abortRef.current === null) {
          console.log("[RECONNECT] クリーンアップ: isLoading解除");
          setIsLoading(false);
          setActivity(null);
          setSessionState(null);
          setToolProgress(null);
          setIsReconnecting(false);
          abortRef.current = null;
        } else {
          console.log("[RECONNECT] クリーンアップスキップ（別のsendMessageがアクティブ）");
        }
      }
    },
    [processSSEStream, handleSSEEvent, reconnectWithRetries, connectionId]
  );

  const respondPermission = useCallback(
    async (requestId: string, approved: boolean) => {
      setPendingPermission(null);
      await fetch("/api/permission", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Connection-Id": connectionId },
        body: JSON.stringify({ requestId, approved }),
      });
    },
    [connectionId]
  );

  const respondQuestion = useCallback(
    async (
      requestId: string,
      answers: Record<string, string> | null,
      annotations?: Record<string, { notes?: string }>
    ) => {
      setPendingQuestion(null);
      await fetch("/api/permission", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Connection-Id": connectionId },
        body: JSON.stringify({ requestId, answers: answers ?? {}, annotations }),
      });
    },
    [connectionId]
  );

  /** 現在の生成を停止する（UIの脱出口） */
  const stopGeneration = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // サーバー側のClaude Codeプロセスもinterrupt
    try {
      await fetch("/api/interrupt", {
        method: "POST",
        headers: { "X-Connection-Id": connectionId },
      });
    } catch { /* サーバー到達不能でも無視 */ }
    setIsLoading(false);
    setActivity(null);
    setSessionState(null);
    setToolProgress(null);
    setPendingPermission(null);
    setPendingQuestion(null);
  }, [connectionId]);

  const resetSession = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    sessionIdRef.current = null;
    forceFreshSessionRef.current = true;
    setIsLoading(false);
    setActivity(null);
    setSessionState(null);
    setToolProgress(null);
    setPendingPermission(null);
    setPendingQuestion(null);
    setIsReconnecting(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  return {
    messages,
    isLoading,
    activity,
    sessionState,
    toolProgress,
    sessionId,
    pendingPermission,
    pendingQuestion,
    isReconnecting,
    sendMessage,
    respondPermission,
    respondQuestion,
    resetSession,
    stopGeneration,
    // モデル / Thinking effort 選択
    models,
    selectedModel,
    selectedEffort,
    setSelectedModel,
    setSelectedEffort,
    // 実行モード（permissionMode）選択
    permissionMode,
    setPermissionMode,
  };
}
