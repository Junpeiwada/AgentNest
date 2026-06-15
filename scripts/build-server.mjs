/**
 * サーバーコードをesbuildでバンドルし、dist-server/ に出力する。
 * @anthropic-ai/claude-agent-sdk はネイティブバイナリを含むため external にし、
 * node_modules ごとコピーする。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "src-tauri", "dist-server");

// クリーン
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true });
}
mkdirSync(outDir, { recursive: true });

// 1. esbuild でサーバーコードをバンドル
await build({
  entryPoints: [resolve(root, "server/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: resolve(outDir, "index.js"),
  external: ["@anthropic-ai/claude-agent-sdk"],
  // CJS依存（dotenv等）がrequire()を使えるようにする
  // package.jsonに"type":"module"があるのでこのバナーはESMとして解釈される
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

// nodeがESMとして読めるようにpackage.jsonを出力
import { writeFileSync } from "fs";
writeFileSync(resolve(outDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));

// 2. @anthropic-ai/claude-agent-sdk をnode_modulesごとコピー
const srcModules = resolve(root, "node_modules");
const destModules = resolve(outDir, "node_modules");

// SDK本体のみ同梱する。
// 実行時に必要な Claude Code CLI（ネイティブ `claude` バイナリ）は Anthropic の
// プロプライエタリ素材のため再頒布せず、アプリには同梱しない。
// 代わりにユーザー環境にインストール済みの Claude Code CLI を
// server/config.ts の resolveClaudeCliPath() で探索し、pathToClaudeCodeExecutable 経由で利用する。
// これによりアプリ側はアーキ（x64/arm64）に依存しない。
const packagesToCopy = [
  "@anthropic-ai/claude-agent-sdk",
];

for (const pkg of packagesToCopy) {
  const src = resolve(srcModules, pkg);
  const dest = resolve(destModules, pkg);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`  コピー: ${pkg}`);
  } else {
    console.log(`  スキップ（未インストール）: ${pkg}`);
  }
}

// 3. フロントエンドビルド成果物をdist-server/frontend/dist/にコピー
// （Tauriバンドル内でサーバーがフロントエンドを配信できるようにする）
const frontendDist = resolve(root, "frontend/dist");
const destFrontend = resolve(outDir, "frontend/dist");
if (existsSync(frontendDist)) {
  cpSync(frontendDist, destFrontend, { recursive: true });
  console.log("  コピー: frontend/dist → dist-server/frontend/dist");
} else {
  console.warn("  警告: frontend/dist が存在しません。先にビルド:フロントエンドを実行してください");
}

console.log("サーバービルド完了 → dist-server/");
