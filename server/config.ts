import "dotenv/config";
import { existsSync, accessSync, constants } from "fs";
import { join, delimiter } from "path";
import { homedir } from "os";

// コマンドライン引数を解析（Electron fork時に使用）
function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

const dir = getArg("base-dir") || process.env.BASE_PROJECT_DIR;
if (!dir) {
  console.error("Error: BASE_PROJECT_DIR environment variable is required.");
  console.error("Create a .env file with: BASE_PROJECT_DIR=/path/to/your/projects");
  process.exit(1);
}

export const BASE_DIR: string = dir;

/**
 * ユーザーがインストールした Claude Code CLI の実行ファイルを探索する。
 *
 * SDK同梱のネイティブバイナリは Anthropic のプロプライエタリ素材で再頒布しないため、
 * アプリにはバンドルせず、ユーザー環境にある本物の `claude` を `pathToClaudeCodeExecutable`
 * として SDK に渡す。Tauri等のGUIアプリは shell の PATH を継承せず痩せていることが多いため、
 * PATH探索に加えて公式インストーラの既知パスも直接当たる。
 *
 * 探索順:
 *   1. 環境変数 CLAUDE_CLI_PATH（明示指定・最優先）
 *   2. 公式インストーラの既知パス（~/.local/bin/claude 等）
 *   3. PATH 上の `claude`
 *
 * 見つからなければ undefined（呼び出し側でエラー表示）。
 */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveClaudeCliPath(): string | undefined {
  // 1. 明示指定（最優先）
  const explicit = process.env.CLAUDE_CLI_PATH;
  if (explicit) {
    if (existsSync(explicit) && isExecutable(explicit)) return explicit;
    console.warn(`CLAUDE_CLI_PATH に指定されたパスが実行できません: ${explicit}`);
  }

  const home = homedir();
  // 2. 公式インストーラ等の既知パス
  const knownPaths = [
    join(home, ".local", "bin", "claude"), // 公式インストーラ（新）
    join(home, ".claude", "local", "claude"), // 公式インストーラ（旧/ローカル版）
    "/opt/homebrew/bin/claude", // Homebrew (Apple Silicon)
    "/usr/local/bin/claude", // Homebrew (Intel) / 手動配置
  ];
  for (const p of knownPaths) {
    if (existsSync(p) && isExecutable(p)) return p;
  }

  // 3. PATH 探索
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "claude");
    if (existsSync(candidate) && isExecutable(candidate)) return candidate;
  }

  return undefined;
}

/**
 * SDK に渡す Claude Code CLI の絶対パス。
 * 見つからなければ undefined（SDKは同梱バイナリを探そうとして失敗するため、
 * 呼び出し側で未解決を検知してユーザーに導入案内を出す）。
 */
export const CLAUDE_CLI_PATH: string | undefined = resolveClaudeCliPath();
