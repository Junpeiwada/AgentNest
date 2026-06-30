/**
 * サーバーコードをesbuildでバンドルし、dist-server/ に出力する。
 * @anthropic-ai/claude-agent-sdk はネイティブバイナリを含むため external にし、
 * node_modules ごとコピーする。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

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

// 4. バンドル内のネイティブバイナリ（darwin Mach-O の .node / .dylib）を署名する。
//
// Apple の公証（notarization）はバンドル内の「全ての Mach-O バイナリ」が
// Developer ID + hardened runtime + セキュアタイムスタンプで署名されていることを要求する。
// sharp / ripgrep / audio-capture などの .node はこの工程で署名しないと公証が必ず失敗する。
//
// Tauri はバンドル外周（.app 本体）しか署名せず、Resources 配下の入れ子 Mach-O は
// 署名対象にしないため、ここで「内→外」順に先に署名しておく必要がある。
// 署名は APPLE_SIGNING_IDENTITY が設定されているとき（= リリース時）のみ実行する。
// 通常の開発ビルドでは未署名のままで問題ない（ローカル実行・TCCは外周署名で足りる）。
function isMachO(file) {
  try {
    const out = execFileSync("file", ["-b", file], { encoding: "utf8" });
    return out.includes("Mach-O");
  } catch {
    return false;
  }
}

function collectFiles(dir, exts, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      collectFiles(p, exts, acc);
    } else if (exts.some((e) => name.endsWith(e))) {
      acc.push(p);
    }
  }
  return acc;
}

function signNativeBinaries(dir, identity) {
  const candidates = collectFiles(dir, [".node", ".dylib"]);
  const machO = candidates.filter(isMachO); // win32(PE)/linux(ELF) は除外
  if (machO.length === 0) {
    console.log("  署名対象のネイティブバイナリなし");
    return;
  }
  console.log(`  ネイティブバイナリ署名（${machO.length}件）: ${identity}`);
  for (const f of machO) {
    execFileSync(
      "codesign",
      ["--force", "--options", "runtime", "--timestamp", "--sign", identity, f],
      { stdio: "inherit" },
    );
  }
}

const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
if (signingIdentity) {
  signNativeBinaries(outDir, signingIdentity);
} else {
  console.log("  ネイティブバイナリ署名スキップ（APPLE_SIGNING_IDENTITY 未設定）");
}

console.log("サーバービルド完了 → dist-server/");
