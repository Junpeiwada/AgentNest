import { Router } from "express";
import { readFile } from "fs/promises";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import { homedir } from "os";
import { BASE_DIR } from "../config.js";
import { stringifyToolResultContent, imagePathFromToolInput } from "../claude/toolResultContent.js";

const router = Router();
const CLAUDE_DIR = join(homedir(), ".claude", "projects");

/**
 * リポジトリのパスを Claude Code の履歴フォルダ名に変換する。
 * Claude Code は英数字以外（"/" "_" "." 日本語など）をすべて "-" に置き換える。
 * 例: /path/to/PID_AIRDEPOT → -path-to-PID-AIRDEPOT
 */
function encodeProjectPath(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9]/g, "-");
}

interface SessionInfo {
  sessionId: string;
  title: string;
  firstMessage: string;
  /** 最終更新時刻（ISO 8601）。一覧はこの新しい順に並ぶ */
  timestamp: string;
}

/**
 * GET /api/sessions/:repoId — list sessions for a repo
 *
 * SDK の listSessions に任せる。各 JSONL の先頭と末尾だけを読むので、会話が大きくても速い。
 * フォルダ名の変換・タイトルの決定・最終更新順の並べ替えも SDK 側で行われる。
 * VSCode・CLI・AgentNest（SDK）のどれで作った会話も含まれる。
 */
router.get("/api/sessions/:repoId", async (req, res) => {
  const { repoId } = req.params;
  const repoPath = `${BASE_DIR}/${repoId}`;

  try {
    // worktree 側の会話は cwd が違い AgentNest から引き継げないので含めない
    const list = await listSessions({ dir: repoPath, includeWorktrees: false });

    const sessions: SessionInfo[] = list.map((s) => {
      const firstMessage = (s.firstPrompt ?? "").slice(0, 120);
      const title = s.customTitle ?? s.summary ?? "";
      return {
        sessionId: s.sessionId,
        // タイトルが最初の発言そのものなら 2 行に同じ文が並ぶので、タイトルは空にする
        title: title === s.firstPrompt ? "" : title,
        firstMessage,
        timestamp: new Date(s.lastModified).toISOString(),
      };
    });

    res.json(sessions);
  } catch {
    res.json([]);
  }
});

interface AssistantPart {
  type: "text" | "tool_result";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  filePath?: string;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  parts?: AssistantPart[];
}

/** GET /api/sessions/:repoId/:sessionId/messages — load conversation history */
router.get("/api/sessions/:repoId/:sessionId/messages", async (req, res) => {
  const { repoId, sessionId } = req.params;
  const repoPath = `${BASE_DIR}/${repoId}`;
  const projectDir = join(CLAUDE_DIR, encodeProjectPath(repoPath));
  const filePath = join(projectDir, `${sessionId}.jsonl`);

  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");

    const messages: HistoryMessage[] = [];
    // tool_use id → { name, input } のマップ（tool_resultと対応づけるため）
    const toolUseMap = new Map<string, { name: string; input: Record<string, unknown> }>();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        if (obj.type === "user") {
          const blocks = obj.message?.content;
          if (Array.isArray(blocks)) {
            // tool_result ブロックがある場合は直前のassistantメッセージに追加
            const toolResultBlocks = blocks.filter((b: any) => b.type === "tool_result");
            if (toolResultBlocks.length > 0) {
              const last = messages[messages.length - 1];
              if (last?.role === "assistant") {
                if (!last.parts) last.parts = [];
                for (const block of toolResultBlocks) {
                  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
                  const toolInfo = toolUseMap.get(toolUseId);
                  const rawContent = block.content;
                  // 画像ブロックは base64 を捨ててプレースホルダ化（巨大化の主因）。executor.ts と共通処理。
                  const imageFilePath = imagePathFromToolInput(toolInfo?.input);
                  const text = stringifyToolResultContent(rawContent, imageFilePath);
                  last.parts.push({
                    type: "tool_result",
                    toolName: toolInfo?.name ?? "Tool",
                    toolInput: toolInfo?.input,
                    content: text,
                  });
                }
              }
              // 直前が assistant でない場合（破損・手動編集等）は tool_result をスキップ
            } else {
              // 通常のユーザーメッセージ
              const texts = blocks
                .filter((b: any) => b.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text as string)
                .filter((t: string) => !t.startsWith("<ide_") && !t.startsWith("<system-reminder>"));
              const text = texts.join("\n").trim();
              if (text) {
                messages.push({ role: "user", content: text });
              }
            }
          }
        }

        if (obj.type === "assistant") {
          const blocks = obj.message?.content;
          if (Array.isArray(blocks)) {
            const parts: AssistantPart[] = [];
            let textContent = "";
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string") {
                textContent += block.text;
                parts.push({ type: "text", content: block.text });
              } else if (block.type === "tool_use") {
                const name = block.name ?? "Tool";
                const input = block.input ?? {};
                if (typeof block.id === "string") {
                  toolUseMap.set(block.id, { name, input });
                }
                // tool_useブロック自体はpartsに追加しない（tool_resultで後から追加）
              }
            }
            if (parts.length > 0 || textContent.trim()) {
              // Merge consecutive assistant messages
              const last = messages[messages.length - 1];
              if (last?.role === "assistant") {
                last.content += "\n\n" + textContent;
                if (!last.parts) last.parts = [];
                last.parts.push(...parts);
              } else {
                messages.push({ role: "assistant", content: textContent, parts });
              }
            }
          }
        }
      } catch {}
    }

    res.json(messages);
  } catch {
    res.status(404).json({ error: "Session not found" });
  }
});

export default router;
