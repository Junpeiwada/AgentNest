/**
 * isLimitErrorText の単体チェック（使用量上限メッセージの判定）
 *
 * server/claude/executor.ts の isLimitErrorText は、Claude からの応答テキストが
 * 「使用量上限に達した」旨のメッセージかを判定し、専用の limit_error イベントへ振り分ける。
 * 判定を外すと上限エラーが汎用エラー表示になり、ユーザーに理由が伝わらない。
 *
 * SDK が公開する USAGE_LIMIT_ERROR_PREFIXES を第一の判定基準とするため、
 * SDK 更新で文言が増えても自動追随することを確認する（手書き正規表現だけでは
 * "You're out of usage credits" や "Fable 5 requires usage credits" を取りこぼしていた）。
 *
 * 実行: npx tsx tests/limit-error-text.check.ts
 */

import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { isLimitErrorText } from "../server/claude/executor.js";

let failures = 0;

function assertTrue(actual: boolean, label: string) {
  if (actual) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}（true を期待したが false）`);
    failures++;
  }
}

function assertFalse(actual: boolean, label: string) {
  if (!actual) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}（false を期待したが true）`);
    failures++;
  }
}

function main() {
  // === SDK 公開定数の全文言を拾えること（SDK更新への自動追随） ===
  console.log("--- SDK の USAGE_LIMIT_ERROR_PREFIXES を網羅 ---");
  for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
    assertTrue(isLimitErrorText(prefix), `"${prefix}"`);
  }

  // === 前後に文字が付いていても拾えること（CLIは記号や続き文を伴って出す） ===
  console.log("\n--- 前後に文字が付くケース ---");
  assertTrue(
    isLimitErrorText("⚠ You're out of usage credits · add funds to continue"),
    "先頭に記号が付いていても拾える"
  );
  assertTrue(
    isLimitErrorText("Fable 5 requires usage credits to run."),
    "末尾に続き文があっても拾える"
  );

  // === 既存の言い回し（SDK定数に無い）を引き続き拾えること（後方互換） ===
  console.log("\n--- 後方互換: SDK定数に無い既存の言い回し ---");
  assertTrue(
    isLimitErrorText("Your spending cap reached for this month"),
    '"spending cap reached"'
  );
  assertTrue(
    isLimitErrorText("Your limit resets 5pm"),
    '"limit" ＋ "resets 5pm" 形式'
  );
  assertTrue(
    isLimitErrorText("Cap resets 10:30am"),
    '"cap" ＋ "resets 10:30am" 形式'
  );

  // === 誤検出しないこと ===
  console.log("\n--- 誤検出しない ---");
  assertFalse(isLimitErrorText(""), "空文字");
  assertFalse(isLimitErrorText("Hello, how can I help?"), "通常の応答");
  assertFalse(isLimitErrorText("The file has been updated."), "ツール実行の報告");
  assertFalse(
    isLimitErrorText("The build resets 5pm tomorrow"),
    '"resets 5pm" だけで limit/cap を含まない文'
  );

  // === 結果 ===
  console.log(`\n=== 結果: ${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
