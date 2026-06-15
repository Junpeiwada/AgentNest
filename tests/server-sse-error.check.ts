/**
 * Bug 2: executeChat().catch() が SSE を閉じない問題の再現テスト
 *
 * server/routes/chat.ts (line 96) で executeChat().catch() が例外をログするだけで、
 * clearInterval(keepalive), send({ type: "error" }), res.end() をしていない。
 * そのため keepalive が送信され続け、フロント側の 45秒タイムアウトも発火せず、
 * ユーザーには「生成中」のまま見え続ける。
 *
 * 実行: npx tsx tests/server-sse-error.test.ts
 */

import express from "express";
import type { Server } from "http";
import { createChatRouter } from "../server/routes/chat.js";
import type { ExecuteChatFn, ExpandSlashCommandFn } from "../server/routes/chat.js";

// ---------------------------------------------------------------------------
// テスト用モック
// ---------------------------------------------------------------------------

/** expandSlashCommand のモック — 何もせずそのまま返す */
const mockExpand: ExpandSlashCommandFn = async (message) => ({
  prompt: message,
});

/** executeChat が想定外例外を投げるモック */
const throwingExecuteChat: ExecuteChatFn = async (
  _message, _repoId, _repoPath, _sessionId, _permissionMode, callbacks,
) => {
  // onText で少しだけデータを送った後に例外
  callbacks.onText("Hello");
  throw new Error("Simulated unhandled crash in executeChat");
};

/** executeChat が正常に完了するモック */
const normalExecuteChat: ExecuteChatFn = async (
  _message, _repoId, _repoPath, _sessionId, _permissionMode, callbacks,
) => {
  callbacks.onSessionId("test-session");
  callbacks.onText("Hello");
  callbacks.onDone("test-session");
};

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function startServer(executeChatFn: ExecuteChatFn): Promise<Server> {
  const app = express();
  app.use(express.json());
  app.use(createChatRouter(executeChatFn, mockExpand));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

interface SSEResult {
  connectionClosed: boolean;
  hasErrorEvent: boolean;
  hasDoneEvent: boolean;
  hasTextEvent: boolean;
  keepaliveCount: number;
  fullText: string;
}

async function requestChat(server: Server, timeoutMs = 2000): Promise<SSEResult> {
  const addr = server.address() as { port: number };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(`http://localhost:${addr.port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "test", repoId: "test" }),
    signal: controller.signal,
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let connectionClosed = false;
  let keepaliveCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        connectionClosed = true;
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      keepaliveCount += (chunk.match(/: keepalive/g) || []).length;
    }
  } catch {
    // AbortSignal timeout → SSE接続が閉じなかった
  }

  clearTimeout(timeout);

  return {
    connectionClosed,
    hasErrorEvent: fullText.includes('"type":"error"'),
    hasDoneEvent: fullText.includes('"type":"done"'),
    hasTextEvent: fullText.includes('"type":"text"'),
    keepaliveCount,
    fullText,
  };
}

// ---------------------------------------------------------------------------
// テスト実行
// ---------------------------------------------------------------------------

let failures = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

async function main() {
  // === Test 1: 正常系（リファクタで壊れていないことを確認） ===
  console.log("--- Test 1: 正常系 ---");
  const normalServer = await startServer(normalExecuteChat);
  const normalResult = await requestChat(normalServer);
  normalServer.close();

  assert(normalResult.connectionClosed, "SSE接続が閉じた");
  assert(normalResult.hasTextEvent, "textイベントを受信");
  assert(normalResult.hasDoneEvent, "doneイベントを受信");

  // === Test 2: executeChat が例外を投げた場合 ===
  console.log("\n--- Test 2: executeChat が例外を投げた場合（Bug 2 再現） ---");
  const errorServer = await startServer(throwingExecuteChat);
  const errorResult = await requestChat(errorServer);
  errorServer.close();

  assert(errorResult.hasTextEvent, "例外前のtextイベントを受信");

  // Bug 2 の検証: 以下が満たされないのがバグ
  // 修正後は両方 true になるべき
  const sseClosedOnError = errorResult.connectionClosed;
  const errorEventSent = errorResult.hasErrorEvent;

  if (!sseClosedOnError) {
    console.log(`  ❌ BUG: SSE接続が開いたまま（keepalive ${errorResult.keepaliveCount} 回受信）`);
    failures++;
  } else {
    console.log("  ✅ SSE接続が閉じた");
  }

  if (!errorEventSent) {
    console.log("  ❌ BUG: errorイベントが送信されていない");
    failures++;
  } else {
    console.log("  ✅ errorイベントを受信");
  }

  // === 結果 ===
  console.log(`\n=== 結果: ${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
