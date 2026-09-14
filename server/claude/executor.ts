import { query, USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKMessage, SDKUserMessage, PermissionResult, ModelInfo, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import { appendFile, readdir, unlink, rename } from "fs/promises";
import { join } from "path";
import { BASE_DIR, CLAUDE_CLI_PATH } from "../config.js";
import { stringifyToolResultContent, imagePathFromToolInput } from "./toolResultContent.js";

const LOG_DIR = join(import.meta.dirname, "../../logs");
const LOG_RETENTION_DAYS = 10;

let currentLogDate = "";
let currentLogFile = "";

function getLogFile(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (today !== currentLogDate) {
    currentLogDate = today;
    currentLogFile = join(LOG_DIR, `${today}.log`);
    cleanOldLogs().catch(() => {});
  }
  return currentLogFile;
}

async function cleanOldLogs(): Promise<void> {
  const files = await readdir(LOG_DIR).catch(() => [] as string[]);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  for (const file of files) {
    if (file.endsWith(".log") && file.slice(0, 10) < cutoffStr) {
      await unlink(join(LOG_DIR, file)).catch(() => {});
    }
  }
}

export function log(label: string, data: unknown): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${label}: ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`;
  appendFile(getLogFile(), line).catch(() => {});
}

// モデル一覧キャッシュ（サーバ起動時に1回だけ取得し、GET /api/models はこれを返すだけにする）
let cachedModels: ModelInfo[] = [];
let modelsPrefetched = false;

/** キャッシュ済みモデル一覧を返す。未取得・取得失敗時は空配列。 */
export function getCachedModels(): ModelInfo[] {
  return cachedModels;
}

/**
 * モデル一覧をプリフェッチしてメモリにキャッシュする。
 * 使い捨ての query() を起動し supportedModels() を呼ぶ（チャット用の sessions Map には触れない）。
 * supportedModels() はサブプロセス初期化時のメタ情報取得であり、空プロンプトでもLLM推論は発火しない。
 * 成功するまでは modelsPrefetched を立てないため、起動時にCLI未準備でも GET /api/models 経由で自動回復できる。
 * 失敗してもサーバは正常動作させる（空配列のまま縮退）。
 */
export async function prefetchModels(): Promise<void> {
  if (modelsPrefetched) return;
  // 非ストリーミング入力では interrupt() が効かないため、AbortController で確実に停止する
  const ac = new AbortController();
  try {
    const probe = query({
      // 空プロンプトでサブプロセスを起動し、メタ情報だけ取得して即破棄する
      prompt: "",
      options: {
        cwd: BASE_DIR,
        abortController: ac,
        permissionMode: "default",
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        // ユーザー環境の Claude Code CLI を使う（SDK同梱バイナリは非同梱）
        ...(CLAUDE_CLI_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CLI_PATH } : {}),
      },
    });
    const models = await probe.supportedModels();
    cachedModels = Array.isArray(models) ? models : [];
    modelsPrefetched = true; // 成功時のみ確定。失敗時は未取得のまま再試行を許す
    log("MODELS_PREFETCH", { count: cachedModels.length, values: cachedModels.map((m) => m.value) });
  } catch (err: any) {
    cachedModels = [];
    log("MODELS_PREFETCH_ERROR", { name: err?.name, message: err?.message });
  } finally {
    ac.abort(); // サブプロセスを確実に終了させる
  }
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

export interface SessionEvent {
  type: string;
  [key: string]: unknown;
}

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

export interface AssistantMessageState {
  role: "assistant";
  content: string;
  parts: AssistantPart[];
  error: AssistantError | null;
}

export interface Session {
  // agentId/clientId分離対応: サーバが発行する実行1本ごとのID。sessions Map のキーと同値を保持する。
  agentId: string;
  // このAgentの所有者（ブラウザ単位）。クライアント発行のIDで、他clientIdからの操作を弾く照合に使う。
  clientId: string;
  repoId: string;
  repoPath: string;
  sessionId: string | null;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  abortController: AbortController;
  // SDKが公開する Query 型をそのまま使う（interrupt() 等のシグネチャ変更に追従するため、
  // 構造的型を手書きしない）。runQuery内でquery()呼び出し後に設定される。
  stream: Query | null;
  // 生成時刻（Agent一覧のソート・表示に使用）。
  createdAt: number;
  // 最終アクティブ時刻（GC判定に使用）。イベント発火のたびに更新する。
  lastActiveAt: number;
  // このセッションに属する canUseTool の Promise resolver。
  // セッションごとに分離することで、他セッションの requestId を誤って解決できないようにする。
  permissionResolvers: Map<string, { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }>;
  questionResolvers: Map<string, { resolve: (result: PermissionResult) => void; questions: QuestionItem[] }>;
  // Reconnection support
  assistantMessage: AssistantMessageState;
  // 自動復帰（P4-2）で「何を尋ねたのか」を画面に復元するためのユーザー発言テキスト。
  // 画像添付があってもテキスト部分のみ保持する（画像データは重く、復帰表示にも不要なため）。
  // 長さは MAX_LAST_USER_MESSAGE_LENGTH で切り詰める（下の定数コメント参照）。
  lastUserMessage: string | null;
  listeners: Set<(data: SessionEvent) => void>;
  completed: boolean;
  leadingTextBuffer: string;
  leadingTextPending: boolean;
}

function notifyListeners(session: Session, event: SessionEvent): void {
  session.lastActiveAt = Date.now();
  for (const listener of session.listeners) {
    try { listener(event); } catch {}
  }
}

export function subscribeToSession(agentId: string): {
  session: Session;
  unsubscribe: () => void;
  addListener: (fn: (data: SessionEvent) => void) => void;
} | null {
  const session = sessions.get(agentId);
  if (!session) return null;
  const listeners = new Set<(data: SessionEvent) => void>();
  return {
    session,
    addListener: (fn) => {
      listeners.add(fn);
      session.listeners.add(fn);
    },
    unsubscribe: () => {
      for (const fn of listeners) {
        session.listeners.delete(fn);
      }
    },
  };
}

function formatToolActivity(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return `Reading ${input.file_path ?? "file"}...`;
    case "Write":
      return `Writing ${input.file_path ?? "file"}...`;
    case "Edit":
      return `Editing ${input.file_path ?? "file"}...`;
    case "Bash":
      return `Running command...`;
    case "Glob":
      return `Searching files...`;
    case "Grep":
      return `Searching content...`;
    case "Agent":
      return `Thinking deeper...`;
    default:
      return `Using ${toolName}...`;
  }
}

// 自動復帰時に画面へ復元するユーザー発言の長さ上限。
// ログ（REQUESTイベント）は調査用途で200文字に切り詰めているが、こちらは画面表示用であり
// 復帰後にユーザーが「自分が何を尋ねたか」を読めることが目的のため、もう少し長く確保する。
// 2000文字あれば通常の質問文・長めの指示文もほぼ全文残る一方、極端に長いメッセージ
// （大きなコード貼り付け等）でセッションのメモリ使用量が際限なく膨らむのは避ける。
const MAX_LAST_USER_MESSAGE_LENGTH = 2000;

// agentId（サーバ発行・実行1本ごとのUUID）をキーにセッションを分離する。
// 旧来の connectionId（接続=タブ・端末ごとのUUID）は廃止。1つの clientId から複数の agentId を
// 同時に持てるようにし、実行中Agentをタブを閉じた後も一覧から選んで復帰できるようにする。
const sessions = new Map<string, Session>();

// 同時保持セッション数の「全体」上限。clientId単位の上限（CLIENT_MAX_AGENTS）とは別枠の歯止め。
// 通常運用では clientId 単位の上限（1人あたり最大 CLIENT_MAX_AGENTS 本）が先に効くため、
// この全体上限に達するのは「多人数が同時に使っている」ケースのみを想定している
// （例: CLIENT_MAX_AGENTS=8 のとき、3人以上が上限いっぱいまで積むとここに到達する）。
// サーバ1プロセスがSDK子プロセスを何本も抱えるとメモリ・CPUを食うため、人数が増えても
// 際限なく増殖しないための最終防波堤として残す。値は旧来からの実績値をそのまま踏襲。
// 超過時はまず完了済みの古いものから、それでも足りなければ実行中の最も古いものを中断して破棄する
// （この全体上限の超過処理は他clientIdも区別せず対象にする。clientId単位の上限とは異なり、
// 「誰か特定の人のAgentだけを守る」機能ではなく、サーバ全体を守るための最終手段のため）。
// なお gcSessions() は新規セッションを登録する「前」に走るため、実際の同時保持数は最大 21 になる。
const SESSION_MAX_COUNT = 20;

// clientId（ブラウザ単位）ごとの同時保持Agent数の上限。
// agentIdキー化により1つのclientIdから何本でもAgentを起こせるようになったため、
// 全体上限だけでは「1人のユーザが20本起こすと他人のAgentが押し出されて破棄される」
// 問題を防げない。この上限は必ず「同一clientId内」でのみ破棄対象を選び、
// 他clientIdのAgentには一切触れない（P5-2の核心制約）。
// 値の根拠: 1タブから複数リポジトリを並行実行する運用（フェーズ4で実現）を想定しても、
// 人が同時に気にかけて追える実行本数は現実的に数本程度。ブラウザの複数タブ・複数端末
// （PC+iPhone等）から同じclientIdで数本ずつ積むケースを見込んでも8本あれば十分な余裕があり、
// かつ誤操作やリトライの多重送信で無制限に積み上がる事故を防げる水準として8とする。
const CLIENT_MAX_AGENTS = 8;

// 実行中(completed=false)のまま無音が続くセッションを強制終了するまでの時間。
// 権限ダイアログを出したまま answering されず切断されると canUseTool の Promise が未解決のまま
// セッションもCLI子プロセスも生き続けるため、ハード寿命を設ける。
//
// この定数は SESSION_GC_TTL_MS（完了済みセッションの保持時間）から参照されている。
// 「完了済みの保持期間が実行中の放置許容時間より長い」という直感に反する非対称を防ぐため、
// 意図的に同じ値にしている。値を変更する場合は SESSION_GC_TTL_MS 側のコメントも合わせて
// 見直し、非対称にして良いのかどうかを必ず確認すること。
const RUNNING_SESSION_MAX_IDLE_MS = 2 * 60 * 60 * 1000; // 2時間

// 完了済み・購読者なしのセッションを最終アクティブからこの時間経過で破棄する。
// フェーズ4で GET /api/agents による一覧復帰導線ができたため、10分は短すぎると判断し2時間に延長する。
// 判断根拠:
//   - iPhoneからTailscale経由で使い、外出先で少し放置してから結果を見に戻る運用がある
//     （席を外して10分強で戻ったら一覧から消えていた、という体験の悪さを避けたい）
//   - 完了済みセッションは assistantMessage.parts に全出力を保持したままメモリに残るため、
//     際限なく延ばすとメモリを食う
//   - CLIENT_MAX_AGENTS による clientId 単位の上限が別途あるため、長く保持しても
//     同一clientId内で古いものから優先的に押し出される歯止めが効く
//
// 値は RUNNING_SESSION_MAX_IDLE_MS（実行中セッションの強制終了までの猶予）から導出している。
// 独立した定数として2箇所に「2時間」を書くと、片方だけ変更されて意図せず非対称に戻る事故が
// 起きうるため、依存関係をコードで明示する。同じ値にしたい意図自体を変更する場合のみ、
// この行を独立した定数に戻すこと。
const SESSION_GC_TTL_MS = RUNNING_SESSION_MAX_IDLE_MS; // 2時間

/**
 * セッションのガベージコレクション。
 * setIntervalは使わず（タイマーを増やさないため）、既存の呼び出しタイミングに乗せる形で実行する。
 * 呼び出し元は以下の2箇所:
 *   - executeChat（新規セッション作成のタイミング）
 *   - GET /api/agents（一覧取得のタイミング。フロントが6秒ポーリングで定期的に叩くため、
 *     「大量のAgentが完了した後、誰も新規Agentを起こさない」放置期間でも掃除が回る。
 *     SESSION_GC_TTL_MS を10分→2時間に延長した際、新規Agent作成がない限り掃除されない
 *     期間が長くなる問題とセットの措置。副作用のない読み取り経路なのでGCを載せても安全）
 * 1. 完了済み(completed=true)かつ購読者(listeners)が空のセッションを、最終アクティブから
 *    SESSION_GC_TTL_MS 経過で破棄
 * 2. 実行中のまま RUNNING_SESSION_MAX_IDLE_MS 無音のセッションを abort して破棄
 *    （権限待ちの放置などで永久に残るのを防ぐ）
 * 3. clientId単位の同時保持数が CLIENT_MAX_AGENTS を超えている場合、「その clientId の中でのみ」
 *    完了済みの最古から破棄する。それでも超過するなら「その clientId の中で」実行中の最古を
 *    abort して破棄する。他clientIdのAgentには一切触れない（P5-2の核心制約）。
 * 4. 全体の同時保持数が SESSION_MAX_COUNT を超えている場合、全clientIdを横断して
 *    完了済みの最古から破棄する。それでも超過するなら実行中の最古を abort して破棄する
 *    （子プロセスが際限なく増えるのを防ぐ最終防波堤。3のclientId単位上限より広い最後の砦）
 *
 * 処理コストについて: 現状 SESSION_MAX_COUNT=20 程度の規模であり、本体処理は
 * 全セッションを高々数回走査するだけの O(セッション数) の軽量な処理。GET /api/agents は
 * 6秒間隔のポーリングで叩かれるが、この規模であれば都度実行しても無視できるコストと判断できる。
 */
export function gcSessions(): void {
  const now = Date.now();
  for (const [agentId, session] of sessions) {
    if (session.completed && session.listeners.size === 0 && now - session.lastActiveAt > SESSION_GC_TTL_MS) {
      sessions.delete(agentId);
      log("SESSION_GC_EXPIRED", { agentId, clientId: session.clientId, sessionId: session.sessionId });
      continue;
    }
    if (!session.completed && now - session.lastActiveAt > RUNNING_SESSION_MAX_IDLE_MS) {
      log("SESSION_GC_STALE_RUNNING", {
        agentId,
        clientId: session.clientId,
        sessionId: session.sessionId,
        idleMs: now - session.lastActiveAt,
      });
      session.abortController.abort(); // CLI子プロセスを確実に落とす
      sessions.delete(agentId);
    }
  }

  // --- clientId単位の上限（P5-2）: 破棄対象の選定を同一clientId内に閉じる ---
  // clientIdごとにグルーピングしてから各グループを独立に判定する。他clientIdのグループには
  // 一切触れないため、ここでの削除件数がどれだけ多くても他人のAgentが巻き込まれることはない。
  const byClient = new Map<string, Session[]>();
  for (const session of sessions.values()) {
    const list = byClient.get(session.clientId);
    if (list) {
      list.push(session);
    } else {
      byClient.set(session.clientId, [session]);
    }
  }
  for (const clientSessions of byClient.values()) {
    if (clientSessions.length <= CLIENT_MAX_AGENTS) continue;
    // 「完了済みを古い順」→「実行中を古い順」の優先度で、このclientIdの分だけを落とす。
    const byPriority = [...clientSessions].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? -1 : 1;
      return a.lastActiveAt - b.lastActiveAt;
    });
    let remaining = clientSessions.length;
    for (const session of byPriority) {
      if (remaining <= CLIENT_MAX_AGENTS) break;
      if (session.completed) {
        log("SESSION_GC_CLIENT_OVERFLOW", { agentId: session.agentId, clientId: session.clientId, sessionId: session.sessionId });
      } else {
        // 実行中を落とすのは最後の手段。子プロセスを止めてから消す。
        session.abortController.abort();
        log("SESSION_GC_CLIENT_OVERFLOW_RUNNING", { agentId: session.agentId, clientId: session.clientId, sessionId: session.sessionId });
      }
      sessions.delete(session.agentId);
      remaining--;
    }
  }

  // --- 全体上限（P5-3）: clientId単位の上限とは別枠。全clientIdを横断して見る最終防波堤 ---
  if (sessions.size > SESSION_MAX_COUNT) {
    // 「完了済みを古い順」→「実行中を古い順」の優先度で落とす。
    const byPriority = [...sessions.entries()].sort((a, b) => {
      if (a[1].completed !== b[1].completed) return a[1].completed ? -1 : 1;
      return a[1].lastActiveAt - b[1].lastActiveAt;
    });
    for (const [agentId, session] of byPriority) {
      if (sessions.size <= SESSION_MAX_COUNT) break;
      if (session.completed) {
        log("SESSION_GC_OVERFLOW", { agentId, clientId: session.clientId, sessionId: session.sessionId });
      } else {
        // 実行中を落とすのは最後の手段。子プロセスを止めてから消す。
        session.abortController.abort();
        log("SESSION_GC_OVERFLOW_RUNNING", { agentId, clientId: session.clientId, sessionId: session.sessionId });
      }
      sessions.delete(agentId);
    }
  }
}

/**
 * 外部入力（HTTPヘッダ `X-Client-Id` / `X-Agent-Id`）をサーバ側の信頼境界で検証する。
 * UUID形式（8-4-4-4-12の16進、大文字小文字問わず）のみ許可し、それ以外は null を返す。
 * ルーティング層はこれを使い、必須ヘッダで null であれば 400 を返す
 * （`X-Agent-Id` は省略可能なので、欠落を400にするかは呼び出し側のエンドポイントが判断する）。
 * clientId・agentId どちらの検証にも使う（形式はどちらもクライアント/サーバ発行のUUID）。
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sanitizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return ID_PATTERN.test(value) ? value : null;
}

export function getSession(agentId: string): Session | null {
  return sessions.get(agentId) ?? null;
}

/**
 * 指定 clientId が所有する Agent（Session）を返す。ソートは行わない（責務は呼び出し元に一本化）。
 * 現在は `listAgents`（`GET /api/agents` が使う）からのみ呼ばれている。
 */
export function findAgentsByClient(clientId: string): Session[] {
  return [...sessions.values()].filter((s) => s.clientId === clientId);
}

/** `GET /api/agents` が返す1件分の要約。一覧用途のため必要最小限のフィールドのみ持つ。 */
export interface AgentSummary {
  agentId: string;
  repoId: string;
  sessionId: string | null;
  completed: boolean;
  createdAt: number;
  lastActiveAt: number;
  // pendingPermission / pendingQuestion の中身（ツール名・入力、質問文）は一覧に含めない。
  // 「権限承認待ちがあるか」「質問回答待ちがあるか」だけを別々に渡す（フェーズ4のUIでアイコン・
  // 文言を出し分けられるようにするため、1つのbooleanに畳まない）。
  // 詳細が必要なら該当Agentへ /api/reconnect や /api/status で個別に取得させる。
  hasPendingPermission: boolean;
  hasPendingQuestion: boolean;
}

function toAgentSummary(session: Session): AgentSummary {
  return {
    agentId: session.agentId,
    repoId: session.repoId,
    sessionId: session.sessionId,
    completed: session.completed,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    hasPendingPermission: session.pendingPermission !== null,
    hasPendingQuestion: session.pendingQuestion !== null,
  };
}

/**
 * 指定 clientId が所有する Agent の一覧を要約形式で返す。
 * ソート順は「実行中(completed=false)を先に、その中で createdAt 降順」。
 * 一覧の主目的は「今動いているAgentに戻る」ことなので実行中を優先表示し、
 * 完了済みはその後ろに新しい順で並べる。ソートはここで一度だけ行う
 * （findAgentsByClient はソート済みを保証しないので、安定ソート依存の二段構えにしない）。
 */
export function listAgents(clientId: string): AgentSummary[] {
  return findAgentsByClient(clientId)
    .sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return b.createdAt - a.createdAt;
    })
    .map(toAgentSummary);
}

/**
 * 指定 agentId のセッションのみを中断する。他 agentId のセッションには一切触れない
 * （これがマルチセッション対応の核心。他タブ・他端末・他Agentの実行を巻き込んで止めてはならない）。
 *
 * なお Map からエントリは削除しない。executeChat から呼ばれる経路では、直後に
 * sessions.set() で同じキーを上書きする前提のため。別の用途からこれを単体で呼ぶ場合は、
 * abort済みの死んだセッションが /api/status に active:true で見えてしまう点に注意すること。
 * （なお `deleteOwnedAgent` はこの前提の外にある別実装で、abortSession を経由せず
 * `session.abortController.abort()` を直接呼んだ直後に自分で sessions.delete() まで行う。
 * 「唯一の呼び出し元」ではない点を見誤らないこと。）
 */
export function abortSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    log("SESSION_ABORT_CALLED", {
      agentId,
      clientId: session.clientId,
      sessionId: session.sessionId,
      repoId: session.repoId,
      completed: session.completed,
      partsCount: session.assistantMessage.parts.length,
    });
    session.abortController.abort();
  }
}

export interface InterruptResult {
  /** 実行中セッションがあり interrupt を発行できたか */
  interrupted: boolean;
  /**
   * 割り込み後も残る非同期メッセージの uuid（SDK 0.3.220 の interrupt_receipt_v1）。
   * 非空なら「停止しきれていない」ことを意味する。旧CLIは受領票を返さないため常に空配列。
   */
  stillQueued: string[];
}

/**
 * 指定 agentId のセッションに割り込む。
 *
 * Query.interrupt() は必須メソッドなので存在チェックは不要で、session.stream の null 判定のみ行う。
 * 戻り値の受領票は握り潰さず still_queued をそのまま返す（キューに残る処理があるのに
 * 「停止した」と報告してしまうのを避けるため）。
 */
export async function interruptSession(agentId: string): Promise<InterruptResult> {
  const session = sessions.get(agentId);
  // 完了済みセッションは再接続のため最長10分Mapに残る。その stream に interrupt() を投げると
  // 子プロセスが既に終了していて制御応答が返らず、Promise が解決しないまま
  // /api/interrupt がレスポンスを返せなくなる（フロント側の停止ボタンが消えなくなる）。
  if (!session || !session.stream || session.completed) {
    return { interrupted: false, stillQueued: [] };
  }
  try {
    const receipt = await session.stream.interrupt(); // 旧CLIでは undefined
    const stillQueued = receipt?.still_queued ?? [];
    if (stillQueued.length > 0) {
      log("INTERRUPT_STILL_QUEUED", { agentId, stillQueued });
    }
    return { interrupted: true, stillQueued };
  } catch (err: any) {
    // 子プロセスが既に落ちている等。停止できなかったことを返し、リクエストは必ず完了させる。
    log("INTERRUPT_ERROR", { agentId, name: err?.name, message: err?.message });
    return { interrupted: false, stillQueued: [] };
  }
}

/** 指定 agentId のセッションに属する requestId のみ解決する。他セッションのものは解決できない。 */
export function resolvePermission(agentId: string, requestId: string, approved: boolean): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  const entry = session.permissionResolvers.get(requestId);
  if (!entry) return false;

  if (approved) {
    entry.resolve({ behavior: "allow", updatedInput: entry.input });
  } else {
    entry.resolve({ behavior: "deny", message: "User denied this action", interrupt: true });
  }

  session.permissionResolvers.delete(requestId);
  session.pendingPermission = null;
  return true;
}

/** 指定 agentId のセッションに属する requestId のみ解決する。他セッションのものは解決できない。 */
export function resolveQuestion(
  agentId: string,
  requestId: string,
  answers: Record<string, string>,
  annotations?: Record<string, { notes?: string }>,
  deny?: boolean
): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  const entry = session.questionResolvers.get(requestId);
  if (!entry) return false;

  if (deny) {
    entry.resolve({ behavior: "deny", message: "User skipped this question", interrupt: true });
  } else {
    const updatedInput: Record<string, unknown> = { questions: entry.questions, answers };
    if (annotations) updatedInput.annotations = annotations;
    entry.resolve({ behavior: "allow", updatedInput });
  }

  session.questionResolvers.delete(requestId);
  if (session.pendingQuestion?.requestId === requestId) {
    session.pendingQuestion = null;
  }
  return true;
}

/**
 * 以下は clientId 照合を行うラッパー群。agentId だけでなく所有者（clientId）が一致することも
 * 確認したうえで委譲する。フェーズ2で `X-Client-Id` + `X-Agent-Id` が本採用されたときに
 * ルート側から直接使う入口となる（他 clientId の agentId を名指しされても404相当で弾ける）。
 * 存在しない・所有者不一致のときは「見えない」ことにする（null / false を返す。理由は返さない）。
 */

/** clientId が所有する agentId のセッションのみ返す。所有者不一致・不存在は null。 */
export function getOwnedSession(clientId: string, agentId: string): Session | null {
  const session = sessions.get(agentId);
  if (!session || session.clientId !== clientId) return null;
  return session;
}

/** clientId 照合つきの abortSession。他 clientId の Agent には一切触れない。 */
export function abortOwnedSession(clientId: string, agentId: string): void {
  if (getOwnedSession(clientId, agentId)) {
    abortSession(agentId);
  }
}

/**
 * `DELETE /api/agents/:agentId` 用。所有者の Agent を中断したうえで Map からも削除する。
 *
 * abortSession は「呼び出し元の executeChat が直後に sessions.set() で同じキーを上書きする」
 * 前提で Map からエントリを消さない（コメント参照）。だがこの削除APIには上書きする後続処理が無いため、
 * abortSession をそのまま流用すると abort 済みの死んだ Agent が Map に残り続け、
 * 一覧（listAgents）や /api/status に「存在する」ものとして出てきてしまう。
 * そのためここでは abort に加えて明示的に sessions.delete() まで行う専用関数にする。
 *
 * 戻り値は「実際に削除できたか」（= 所有していたか）。他 clientId の agentId・存在しない agentId は
 * false を返すのみで、理由は返さない（存在を秘匿する。ルート側はこれを404として扱う）。
 *
 * 注意（非同期abortとの時間差）: abortController.abort() は同期的に呼ぶが、実際にAgentの実行が
 * 止まる（runQuery が AbortError で抜けて onDone が呼ばれる）のは非同期。そのため、この関数が
 * true を返して DELETE のレスポンスが返った時点では既に listAgents 一覧から消えているが、
 * そのAgentを購読している他タブ・他端末のSSE購読者には onDone 発火まで数百ms〜数秒イベントが
 * 流れ続けることがある（session.listeners はここでは掃除しない。sessions.delete() 後も
 * listener 自体は生きたクロージャとして残り、onDone 到達時に自然に呼ばれて終わる）。
 * フェーズ4のAgent一覧UIを実装する際は、この時間差を踏まえて実挙動を見てから
 * 表示更新のタイミングを判断すること（現時点では実装を変えず、挙動の記録のみ残す）。
 */
export function deleteOwnedAgent(clientId: string, agentId: string): boolean {
  const session = getOwnedSession(clientId, agentId);
  if (!session) return false;
  session.abortController.abort();
  sessions.delete(agentId);
  log("AGENT_DELETE", { agentId, clientId, sessionId: session.sessionId, completed: session.completed });
  return true;
}

/**
 * 継続対象として指定された agentId が「存在しない」または「他 clientId の所有」であることを表すエラー。
 * 実在チェックと所有者チェックを区別せず同じエラーにする（存在有無を返すと他人のAgentIdの
 * 実在を推測できてしまうため、ルート層はこれを一律404として扱い理由を秘匿する）。
 */
export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found or not owned by this client: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

/** clientId 照合つきの interruptSession。所有者不一致・不存在は「実行中セッションなし」として扱う。 */
export async function interruptOwnedSession(clientId: string, agentId: string): Promise<InterruptResult> {
  if (!getOwnedSession(clientId, agentId)) {
    return { interrupted: false, stillQueued: [] };
  }
  return interruptSession(agentId);
}

/** clientId 照合つきの resolvePermission。所有者不一致・不存在は false（他人のrequestIdは解決できない）。 */
export function resolveOwnedPermission(clientId: string, agentId: string, requestId: string, approved: boolean): boolean {
  if (!getOwnedSession(clientId, agentId)) return false;
  return resolvePermission(agentId, requestId, approved);
}

/** clientId 照合つきの resolveQuestion。所有者不一致・不存在は false（他人のrequestIdは解決できない）。 */
export function resolveOwnedQuestion(
  clientId: string,
  agentId: string,
  requestId: string,
  answers: Record<string, string>,
  annotations?: Record<string, { notes?: string }>,
  deny?: boolean
): boolean {
  if (!getOwnedSession(clientId, agentId)) return false;
  return resolveQuestion(agentId, requestId, answers, annotations, deny);
}

/** clientId 照合つきの subscribeToSession。所有者不一致・不存在は null（存在を秘匿する）。 */
export function subscribeOwnedSession(clientId: string, agentId: string): {
  session: Session;
  unsubscribe: () => void;
  addListener: (fn: (data: SessionEvent) => void) => void;
} | null {
  if (!getOwnedSession(clientId, agentId)) return null;
  return subscribeToSession(agentId);
}

export interface ToolResult {
  toolName: string;
  content: string;
  filePath?: string;
  structuredPatch?: StructuredPatchHunk[];
  toolInput?: Record<string, unknown>;
}

export interface ImageData {
  data: string;      // base64 encoded
  mediaType: string; // e.g. "image/png"
}

export interface ToolProgress {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}

export interface ChatCallbacks {
  // agentId/clientId分離対応: セッション生成直後、他のどのコールバックよりも先に一度だけ呼ばれる。
  // ルート側はこれを使って SSE 冒頭に agent_id イベントを流し、フロントが以降のリクエストで
  // このAgentを名指し（X-Agent-Id）できるようにする。
  onAgentId: (agentId: string) => void;
  onText: (content: string) => void;
  onActivity: (activity: string) => void;
  onToolResult: (result: ToolResult) => void;
  onLimitError: (error: string) => void;
  onSessionId: (sessionId: string) => void;
  onPermission: (permission: PendingPermission) => void;
  onQuestion: (question: PendingQuestion) => void;
  onSessionState: (state: "idle" | "running" | "requires_action") => void;
  onToolProgress: (progress: ToolProgress) => void;
  onDone: (sessionId: string | null) => void;
  onError: (error: string) => void;
}

export interface ModelOptions {
  // 「おまかせ」は supportedModels() が先頭に返す value:"default" を指す。
  // SDKはこの "default" を有効なモデル識別子として受理するため、特別扱いせず明示送信する。
  // 一覧に無い未知値のときのみ undefined（CLI既定に委譲）。
  model?: string;
  effort?: EffortLevel; // model非対応・対応段階外のときは undefined
}

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// UIに載せる実行モード（SDK PermissionModeのサブセット）。
// bypassPermissions / dontAsk は事故リスクのため受理しない。
export type PermissionMode = "default" | "acceptEdits" | "auto" | "plan";
const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "auto", "plan"];
const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

/**
 * 外部入力の permissionMode をサーバ側の信頼境界で検証・正規化する。
 * 対象4モード外（bypassPermissions等を含む未知値）は既定の acceptEdits へ。
 */
export function sanitizePermissionMode(input: unknown): PermissionMode {
  if (typeof input === "string" && PERMISSION_MODES.includes(input as PermissionMode)) {
    return input as PermissionMode;
  }
  return DEFAULT_PERMISSION_MODE;
}

/**
 * 外部入力（リクエストボディ）の model/effort をサーバ側の信頼境界で検証・正規化する。
 * - model: キャッシュ済み一覧に存在しない値は捨てる（CLI既定に委譲）。
 *   "default" も一覧に含まれる正規エントリなので、そのまま通して明示送信する。
 * - effort: そのモデルが対応する段階に含まれなければ捨てる（モデル能力との不整合を防ぐ）
 * フロントの正規化はUX用であり、ここが最終的な防御線。
 */
export function sanitizeModelOptions(input: unknown): ModelOptions {
  if (!input || typeof input !== "object") return {};
  const { model, effort } = input as { model?: unknown; effort?: unknown };

  const known = getCachedModels();
  const matched =
    typeof model === "string" ? known.find((m) => m.value === model) : undefined;
  if (!matched) return {}; // 未知モデル（一覧未取得含む）はCLI既定へ委譲

  const result: ModelOptions = { model: matched.value };

  if (typeof effort === "string" && EFFORT_LEVELS.includes(effort as EffortLevel)) {
    const levels = matched.supportedEffortLevels ?? [];
    if (matched.supportsEffort !== false && levels.includes(effort as EffortLevel)) {
      result.effort = effort as EffortLevel;
    }
  }
  return result;
}

/**
 * チャットを1本実行し、発行した agentId を返す。
 *
 * agentId/clientId分離対応: `continueAgentId` を明示的に指定したときだけ、その agentId の
 * セッションを中断して同じ agentId を引き継ぐ（継続実行）。未指定（null）なら新規 agentId を
 * 発行するだけで、既存の他Agentには一切触れない。
 * 「同一 clientId なら無条件で前の実行を止める」という旧来の後勝ちabortは、このコア関数の中では
 * 廃止している——他Agentを巻き込んで止めてはならない、というマルチセッション対応の核心を維持するため。
 * ただし、この関数単体で「後勝ちabortが無くなった」と早合点しないこと。呼び出し側の
 * `server/routes/chat.ts` の `defaultExecuteChat` アダプタは、フェーズ1のAPI契約を維持するため
 * `continueAgentId` に常にその clientId の最新Agentを渡しており、結果としてアダプタ経由では
 * 旧来の後勝ちabort挙動が意図的に再現されている。実際の挙動を知るにはこのJSDocだけでなく
 * アダプタ側のコメントも合わせて読むこと。
 *
 * `continueAgentId` 指定時は所有権を必ず検証する（`getOwnedSession`）。存在しない・他clientId所有の
 * どちらであっても `AgentNotFoundError` を throw する（他人のAgentIdを body に指定して継続を試みる
 * "セッション乗っ取り" を防ぐため。存在有無で応答を変えないのは、他人のagentIdの実在を推測されない
 * ようにするため——呼び出し元はこれを一律404として扱うこと）。
 */
export async function executeChat(
  clientId: string,
  continueAgentId: string | null,
  message: string,
  repoId: string,
  repoPath: string,
  resumeSessionId: string | null,
  permissionMode: PermissionMode,
  callbacks: ChatCallbacks,
  images?: ImageData[],
  modelOptions?: ModelOptions
): Promise<string> {
  // 継続指定された agentId のセッションだけを中断する。それ以外の agentId（他タブ・他端末・
  // 同一clientId内の他Agent含む）には絶対に触れない — これがマルチセッション対応の核心。
  // 所有権チェックは必ず先に行い、通った場合のみ abort する。チェック結果を無視して
  // そのまま agentId をキーに使うと、他人のAgentIdを指定するだけで
  // （1）相手のセッションが中断されず孤児プロセスとして残り、
  // （2）sessions.set() で相手のSessionが上書きされ本人がアクセス不能になり、
  // （3）以後 getOwnedSession(自分のclientId, その agentId) が通ってしまう
  // という認可バグになる（乗っ取り）。検証失敗時は新規発行にフォールバックせず、
  // 呼び出し元がエラーとして検知できるよう例外を投げる。
  if (continueAgentId) {
    if (!getOwnedSession(clientId, continueAgentId)) {
      throw new AgentNotFoundError(continueAgentId);
    }
    abortSession(continueAgentId);
  }
  // 新規セッション作成のタイミングでGCを行う（setIntervalによるタイマーは増やさない）。
  // もう1箇所の呼び出し元は GET /api/agents（server/routes/agents.ts）。詳細は gcSessions の doc comment 参照。
  gcSessions();

  const agentId = continueAgentId ?? randomUUID();
  const abortController = new AbortController();
  const now = Date.now();
  const session: Session = {
    agentId,
    clientId,
    repoId,
    repoPath,
    sessionId: resumeSessionId,
    pendingPermission: null,
    pendingQuestion: null,
    abortController,
    stream: null,
    createdAt: now,
    lastActiveAt: now,
    permissionResolvers: new Map(),
    questionResolvers: new Map(),
    assistantMessage: {
      role: "assistant",
      content: "",
      parts: [],
      error: null,
    },
    lastUserMessage: message
      ? message.slice(0, MAX_LAST_USER_MESSAGE_LENGTH)
      : null,
    listeners: new Set(),
    completed: false,
    leadingTextBuffer: "",
    leadingTextPending: true,
  };
  sessions.set(agentId, session);
  const stderrBuffer: string[] = [];

  // 他のどのコールバックよりも先に、確定した agentId を通知する。
  // ルート側はこれを SSE の agent_id イベントとして流す（フロントが以降のリクエストで
  // このAgentを名指しできるようにするため必須）。
  callbacks.onAgentId(agentId);

  log("SESSION_CREATE", { agentId, clientId, repoId, repoPath, resumeSessionId, sessionRef: "active" });
  log("REQUEST", { agentId, clientId, message: message.slice(0, 200), repoId, repoPath, resumeSessionId });

  // Wrap callbacks to also accumulate state and notify reconnect listeners
  const wrappedCallbacks: ChatCallbacks = {
    // 呼び出し元（callbacks.onAgentId）へは既に上で直接通知済み。onAgentId はセッション生成直後の
    // 一度きりの通知であり、以降 runQuery 内から再度呼ばれることはないため、ここでは
    // 型を満たすためだけの委譲にとどめる（再度呼ばれても副作用はない）。
    onAgentId: (agentId) => {
      callbacks.onAgentId(agentId);
    },
    onText: (content) => {
      appendAssistantText(session, content);
      notifyListeners(session, { type: "text", content });
      callbacks.onText(content);
    },
    onActivity: (activity) => {
      flushLeadingTextBuffer(session, wrappedCallbacks);
      notifyListeners(session, { type: "activity", activity });
      callbacks.onActivity(activity);
    },
    onToolResult: (result) => {
      flushLeadingTextBuffer(session, wrappedCallbacks);
      session.assistantMessage.parts.push({
        type: "tool_result",
        toolName: result.toolName,
        content: result.content,
        filePath: result.filePath,
        structuredPatch: result.structuredPatch,
        toolInput: result.toolInput,
      });
      notifyListeners(session, { type: "tool_result", toolName: result.toolName, content: result.content, filePath: result.filePath, structuredPatch: result.structuredPatch, toolInput: result.toolInput });
      callbacks.onToolResult(result);
    },
    onLimitError: (error) => {
      session.leadingTextBuffer = "";
      session.leadingTextPending = false;
      session.assistantMessage.error = { kind: "limit", message: error };
      notifyListeners(session, { type: "limit_error", error });
      callbacks.onLimitError(error);
    },
    onSessionId: (sessionId) => {
      notifyListeners(session, { type: "session_id", sessionId });
      callbacks.onSessionId(sessionId);
    },
    onPermission: (permission) => {
      notifyListeners(session, { type: "permission", ...permission });
      callbacks.onPermission(permission);
    },
    onQuestion: (q) => {
      notifyListeners(session, { type: "question", ...q });
      callbacks.onQuestion(q);
    },
    onSessionState: (state) => {
      notifyListeners(session, { type: "session_state", state });
      callbacks.onSessionState(state);
    },
    onToolProgress: (progress) => {
      notifyListeners(session, { type: "tool_progress", ...progress });
      callbacks.onToolProgress(progress);
    },
    onDone: (sid) => {
      flushLeadingTextBuffer(session, wrappedCallbacks);
      session.completed = true;
      notifyListeners(session, { type: "done", sessionId: sid });
      callbacks.onDone(sid);
    },
    onError: (error) => {
      session.completed = true;
      if (session.assistantMessage.error?.kind === "limit") {
        return;
      }
      if (session.leadingTextBuffer && isLimitErrorText(session.leadingTextBuffer)) {
        wrappedCallbacks.onLimitError(session.leadingTextBuffer.trim());
        return;
      }
      flushLeadingTextBuffer(session, wrappedCallbacks);
      session.assistantMessage.error = { kind: "generic", message: error };
      notifyListeners(session, { type: "error", error });
      callbacks.onError(error);
    },
  };

  try {
    await runQuery(message, repoPath, abortController, resumeSessionId, permissionMode, session, wrappedCallbacks, stderrBuffer, images, modelOptions);
    log("SESSION_COMPLETE", { agentId, clientId, sessionId: session.sessionId, repoId, partsCount: session.assistantMessage.parts.length });
    wrappedCallbacks.onDone(session.sessionId);
  } catch (err: any) {
    if (err.name === "AbortError" || abortController.signal.aborted) {
      log("SESSION_ABORTED", { agentId, clientId, sessionId: session.sessionId, repoId });
      wrappedCallbacks.onDone(session.sessionId);
      return agentId;
    }

    // resume失敗時はsessionIdなしでリトライ
    if (resumeSessionId && String(err.message).includes("exited with code 1")) {
      log("RETRY", { agentId, clientId, message: "resume failed, retrying without sessionId" });
      session.sessionId = null;
      try {
        stderrBuffer.length = 0;
        await runQuery(message, repoPath, abortController, null, permissionMode, session, wrappedCallbacks, stderrBuffer, images, modelOptions);
        log("SESSION_COMPLETE", { agentId, clientId, sessionId: session.sessionId, repoId, partsCount: session.assistantMessage.parts.length, retried: true });
        wrappedCallbacks.onDone(session.sessionId);
        return agentId;
      } catch (retryErr: any) {
        if (retryErr.name === "AbortError" || abortController.signal.aborted) {
          log("SESSION_ABORTED", { agentId, clientId, sessionId: session.sessionId, repoId, retried: true });
          wrappedCallbacks.onDone(session.sessionId);
          return agentId;
        }
        log("SESSION_ERROR", { agentId, clientId, name: retryErr.name, message: retryErr.message, stack: retryErr.stack, retried: true });
        wrappedCallbacks.onError(normalizeChatError(retryErr, stderrBuffer));
        return agentId;
      }
    }

    log("SESSION_ERROR", { agentId, clientId, name: err.name, message: err.message, stack: err.stack });
    wrappedCallbacks.onError(normalizeChatError(err, stderrBuffer));
  }
  return agentId;
}

function appendAssistantText(session: Session, content: string): void {
  const message = session.assistantMessage;
  message.content += content;
  const lastPart = message.parts[message.parts.length - 1];
  if (lastPart?.type === "text") {
    lastPart.content += content;
  } else {
    message.parts.push({ type: "text", content });
  }
}

/**
 * 使用量上限のメッセージかどうかを判定する。
 *
 * SDK が公開する USAGE_LIMIT_ERROR_PREFIXES を第一の判定基準にする（"You're out of usage credits"
 * や "Fable 5 requires usage credits" など、手書き正規表現では拾えない文言を網羅するため）。
 * SDK 側の文言は前方一致で与えられるが、CLI は先頭に記号や空白を伴って出すことがあるので includes で見る。
 * 既存の正規表現は SDK 定数に無い言い回し（"spending cap reached" や "resets 5pm" 形式）を
 * 拾い続けるために OR で残す。
 */
export function isLimitErrorText(content: string): boolean {
  if (USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => content.includes(prefix))) {
    return true;
  }
  return /spending cap reached|you'?ve hit your limit/i.test(content)
    || (/resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(content) && /limit|cap/i.test(content));
}

function flushLeadingTextBuffer(session: Session, callbacks: ChatCallbacks): void {
  if (!session.leadingTextBuffer) {
    session.leadingTextPending = false;
    return;
  }
  const buffered = session.leadingTextBuffer;
  session.leadingTextBuffer = "";
  session.leadingTextPending = false;
  callbacks.onText(buffered);
}

function normalizeChatError(error: unknown, stderrBuffer: string[]): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const stderrMessage = extractRelevantStderr(stderrBuffer);

  if (stderrMessage) {
    return stderrMessage;
  }

  if (/exited with code 1/i.test(rawMessage)) {
    return "Claude Code process exited with code 1. Check usage limits or authentication state.";
  }

  return rawMessage;
}

function extractRelevantStderr(stderrBuffer: string[]): string | null {
  const lines = stderrBuffer
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Spawning Claude Code process:"))
    .filter((line) => !line.startsWith("Claude Code process exited with code"))
    .filter((line) => !line.startsWith("Claude Code stderr:"));

  if (lines.length === 0) {
    return null;
  }

  const joined = lines.join("\n");
  const limitLine = lines.find((line) => /you'?ve hit your limit|usage limit|rate limit|quota/i.test(line));
  if (limitLine) {
    return limitLine;
  }

  if (/you'?ve hit your limit|usage limit|rate limit|quota/i.test(joined)) {
    return joined;
  }

  return lines.slice(-3).join("\n");
}

async function* createImagePrompt(
  message: string,
  images: ImageData[]
): AsyncIterable<SDKUserMessage> {
  const content: any[] = [];
  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }
  content.push({ type: "text", text: message });

  yield {
    type: "user",
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

async function runQuery(
  message: string,
  repoPath: string,
  abortController: AbortController,
  resumeSessionId: string | null,
  permissionMode: PermissionMode,
  session: Session,
  callbacks: ChatCallbacks,
  stderrBuffer: string[],
  images?: ImageData[],
  modelOptions?: ModelOptions
): Promise<void> {
  // VSCodeデバッガ関連の環境変数を子プロセスに継承させない
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.NODE_DEBUG_OPTION;
  delete cleanEnv.VSCODE_INSPECTOR_OPTIONS;

  const prompt = images?.length
    ? createImagePrompt(message, images)
    : message;

  const stream = query({
    prompt,
    options: {
      cwd: repoPath,
      abortController,
      env: cleanEnv,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // モデル/effortは独立オプション。sanitizeModelOptionsを通過した値のみ届く。
      // 「おまかせ」は model:"default"（一覧の正規エントリ）として明示送信される。
      // 未知値は sanitize 段階で落ちて undefined になり、キーごと付けずCLI既定に委譲する。
      ...(modelOptions?.model ? { model: modelOptions.model } : {}),
      ...(modelOptions?.effort ? { effort: modelOptions.effort } : {}),
      includePartialMessages: true,
      permissionMode,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      // ユーザー環境の Claude Code CLI を使う（SDK同梱バイナリは非同梱）
      ...(CLAUDE_CLI_PATH ? { pathToClaudeCodeExecutable: CLAUDE_CLI_PATH } : {}),
      stderr: (data: string) => {
        log("STDERR", { agentId: session.agentId, data });
        stderrBuffer.push(data);
      },
      canUseTool: async (toolName, input, { signal }) => {
        log("TOOL", { agentId: session.agentId, toolName, permissionMode, inputKeys: Object.keys(input) });

        // AskUserQuestion: 質問ダイアログを表示してユーザーの回答を待つ
        if (toolName === "AskUserQuestion") {
          const questions = Array.isArray(input.questions) ? (input.questions as QuestionItem[]) : [];
          if (questions.length === 0) {
            log("ASK_USER_QUESTION_EMPTY", { agentId: session.agentId, toolName });
            return { behavior: "allow" as const, updatedInput: { questions: [], answers: {} } };
          }
          return new Promise<PermissionResult>((resolve) => {
            const requestId = randomUUID();
            const pendingQ: PendingQuestion = { requestId, questions };
            session.pendingQuestion = pendingQ;
            session.questionResolvers.set(requestId, { resolve, questions });
            callbacks.onQuestion(pendingQ);

            signal.addEventListener("abort", () => {
              if (session.questionResolvers.has(requestId)) {
                session.questionResolvers.delete(requestId);
                resolve({ behavior: "deny", message: "Session aborted" });
              }
            });
          });
        }

        // acceptEdits（編集自動）時はEdit/Writeを自動承認。
        // SDKのpermissionModeにも同値を渡しているが、canUseTool到達時の保険として残す。
        if (permissionMode === "acceptEdits") {
          const autoApproveTools = ["Edit", "Write", "MultiEdit"];
          if (autoApproveTools.includes(toolName)) {
            log("AUTO_APPROVE", { agentId: session.agentId, toolName });
            return { behavior: "allow" as const, updatedInput: input };
          }
        }

        return new Promise<PermissionResult>((resolve) => {
          const requestId = randomUUID();
          const permission: PendingPermission = {
            requestId,
            toolName,
            toolInput: input,
          };
          session.pendingPermission = permission;
          session.permissionResolvers.set(requestId, { resolve, input });
          callbacks.onPermission(permission);

          signal.addEventListener("abort", () => {
            if (session.permissionResolvers.has(requestId)) {
              session.permissionResolvers.delete(requestId);
              resolve({ behavior: "deny", message: "Session aborted" });
            }
          });
        });
      },
    },
  });
  session.stream = stream;

  const toolUseNames = new Map<string, string>();
  const toolUseInputs = new Map<string, Record<string, unknown>>();
  let receivedTextDelta = false;

  for await (const msg of stream) {
    if (abortController.signal.aborted) break;

    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      session.sessionId = msg.session_id;
      callbacks.onSessionId(msg.session_id);
    }

    if (msg.type === "system" && "subtype" in msg && msg.subtype === "session_state_changed") {
      callbacks.onSessionState((msg as any).state);
    }

    if (msg.type === "tool_progress") {
      const m = msg as any;
      callbacks.onToolProgress({
        toolUseId: m.tool_use_id,
        toolName: m.tool_name,
        elapsedSeconds: m.elapsed_time_seconds,
      });
    }

    // ストリーミングイベント（トークン単位のリアルタイム配信）
    if (msg.type === "stream_event") {
      const event = (msg as any).event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        receivedTextDelta = true;
        const chunk = event.delta.text;
        if (
          session.leadingTextPending &&
          session.assistantMessage.parts.length === 0 &&
          !session.assistantMessage.error
        ) {
          session.leadingTextBuffer += chunk;
          if (isLimitErrorText(session.leadingTextBuffer)) {
            callbacks.onLimitError(session.leadingTextBuffer.trim());
          } else if (
            session.leadingTextBuffer.length >= 120 ||
            /\n/.test(session.leadingTextBuffer)
          ) {
            flushLeadingTextBuffer(session, callbacks);
          }
        } else {
          callbacks.onText(chunk);
        }
      }
      continue;
    }

    if (msg.type === "assistant") {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ("type" in block && block.type === "tool_use") {
            const toolBlock = block as { id?: string; name: string; input: Record<string, unknown> };
            if (typeof toolBlock.id === "string") {
              toolUseNames.set(toolBlock.id, toolBlock.name);
              toolUseInputs.set(toolBlock.id, toolBlock.input);
            }
            const label = formatToolActivity(toolBlock.name, toolBlock.input);
            callbacks.onActivity(label);
          }
        }
      }
    }

    // ツール結果（user メッセージ内の tool_result）
    if (msg.type === "user") {
      const content = (msg as any).message?.content;
      const toolUseResult = (msg as any).tool_use_result;
      if (Array.isArray(content)) {
        // structuredPatch は1メッセージ=1ツール結果に対応
        const toolResultBlocks = content.filter((b: any) => b.type === "tool_result");
        for (const block of toolResultBlocks) {
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          // tool_use_result は1件のみ存在し、ブロックが1つの場合のみマッチング
          let filePath: string | undefined;
          let structuredPatch: StructuredPatchHunk[] | undefined;
          if (toolResultBlocks.length === 1 && toolUseResult && typeof toolUseResult === "object") {
            const r = toolUseResult as any;
            if (typeof r.filePath === "string") filePath = r.filePath;
            if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
              structuredPatch = r.structuredPatch;
            }
          }
          const toolInput = toolUseInputs.get(toolUseId);
          // 画像プレースホルダ用のファイルパス（tool_use_resultのfilePath優先、無ければtool_inputから推測）
          const imageFilePath = filePath ?? imagePathFromToolInput(toolInput);
          callbacks.onToolResult({
            toolName: toolUseNames.get(toolUseId) ?? "Tool",
            content: stringifyToolResultContent(block.content, imageFilePath),
            filePath,
            structuredPatch,
            toolInput,
          });
        }
      }
    }

    if (msg.type === "result" && "result" in msg && msg.result && !receivedTextDelta) {
      if (
        session.leadingTextPending &&
        session.assistantMessage.parts.length === 0 &&
        !session.assistantMessage.error &&
        isLimitErrorText(msg.result)
      ) {
        callbacks.onLimitError(msg.result.trim());
      } else {
        flushLeadingTextBuffer(session, callbacks);
        callbacks.onText(msg.result);
      }
    }
  }
  // クエリ終了後は stream 参照を落とす。完了済みセッションは再接続のためMapに残るため、
  // 死んだ stream を interrupt() してしまわないようにする。
  session.stream = null;
}
