/**
 * sanitizePermissionMode の単体チェック（信頼境界の検証）
 *
 * server/claude/executor.ts の sanitizePermissionMode は、外部入力（/api/chat の
 * リクエストボディ）の permissionMode をサーバ側で検証・正規化する防御線。
 * - 対象4モード（default / acceptEdits / auto / plan）はそのまま受理
 * - 除外モード（bypassPermissions / dontAsk）・未知値・非文字列は acceptEdits へフォールバック
 *
 * 実行: npx tsx tests/sanitize-permission-mode.check.ts
 */

import { sanitizePermissionMode } from "../server/claude/executor.js";

let failures = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}（expected=${String(expected)}, actual=${String(actual)}）`);
    failures++;
  }
}

function main() {
  // === 受理: 対象4モードはそのまま返る ===
  console.log("--- 受理: 対象4モード ---");
  assertEqual(sanitizePermissionMode("default"), "default", '"default" はそのまま');
  assertEqual(sanitizePermissionMode("acceptEdits"), "acceptEdits", '"acceptEdits" はそのまま');
  assertEqual(sanitizePermissionMode("auto"), "auto", '"auto" はそのまま');
  assertEqual(sanitizePermissionMode("plan"), "plan", '"plan" はそのまま');

  // === フォールバック: 除外モードは acceptEdits へ ===
  console.log("\n--- フォールバック: 除外モード ---");
  assertEqual(sanitizePermissionMode("bypassPermissions"), "acceptEdits", '"bypassPermissions" → acceptEdits');
  assertEqual(sanitizePermissionMode("dontAsk"), "acceptEdits", '"dontAsk" → acceptEdits');

  // === フォールバック: 未知文字列・空文字 ===
  console.log("\n--- フォールバック: 未知文字列 ---");
  assertEqual(sanitizePermissionMode("unknown"), "acceptEdits", '未知文字列 → acceptEdits');
  assertEqual(sanitizePermissionMode(""), "acceptEdits", '空文字 → acceptEdits');
  assertEqual(sanitizePermissionMode("Default"), "acceptEdits", '大文字違い "Default" → acceptEdits');

  // === フォールバック: 非文字列 ===
  console.log("\n--- フォールバック: 非文字列 ---");
  assertEqual(sanitizePermissionMode(undefined), "acceptEdits", "undefined → acceptEdits");
  assertEqual(sanitizePermissionMode(null), "acceptEdits", "null → acceptEdits");
  assertEqual(sanitizePermissionMode(123), "acceptEdits", "数値 → acceptEdits");
  assertEqual(sanitizePermissionMode({ mode: "auto" }), "acceptEdits", "オブジェクト → acceptEdits");
  assertEqual(sanitizePermissionMode(["plan"]), "acceptEdits", "配列 → acceptEdits");

  // === 結果 ===
  console.log(`\n=== 結果: ${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
