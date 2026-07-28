/**
 * モデル選択 UI 用の純粋関数の単体チェック（仕様: Docs/仕様-モデル選択.md）
 *
 * frontend/src/lib/modelSettings.ts の以下2関数を検証する。
 * - resolveDefaultModelLabel: 「おまかせ」の解決先モデル名を人間可読な名前に突合する
 * - buildToggleBarLabel: トグルバー（閉時）の1行表示テキストを組み立てる
 *
 * 特に「SDK の default エントリは supportsEffort:true を返すため、おまかせでも
 * effort が選択され得る」という実データの性質を固定する（実体併記と effort 併記が
 * 排他になっていると実体名が表示されなくなる回帰を防ぐ）。
 *
 * 実行: npx tsx tests/model-settings.check.ts
 */

import {
  buildToggleBarLabel,
  resolveDefaultModelLabel,
  type ModelInfo,
} from "../frontend/src/lib/modelSettings.js";

let failures = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}（expected=${String(expected)}, actual=${String(actual)}）`);
    failures++;
  }
}

const ALL_LEVELS: ModelInfo["supportedEffortLevels"] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** SDK 0.3.220 の supportedModels() 実測値に相当するフィクスチャ */
const REAL: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ALL_LEVELS,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ALL_LEVELS,
  },
  {
    value: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
    displayName: "Fable",
    description: "Fable 5 · Most capable",
    supportsEffort: true,
    supportedEffortLevels: ALL_LEVELS,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ALL_LEVELS,
  },
  {
    // haiku は effort 非対応（supportsEffort / supportedEffortLevels ともに無い）
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

function main() {
  // === resolveDefaultModelLabel: 実データ ===
  console.log("--- resolveDefaultModelLabel: 実データ ---");
  assertEqual(
    resolveDefaultModelLabel(REAL),
    "Opus (1M context)",
    "resolvedModel を同じ実体を持つ別エントリの displayName に突合する"
  );

  // === resolveDefaultModelLabel: 突合先が無い ===
  console.log("\n--- resolveDefaultModelLabel: 突合先なし ---");
  assertEqual(
    resolveDefaultModelLabel([
      {
        value: "default",
        resolvedModel: "claude-unknown-9",
        displayName: "Default (recommended)",
        description: "",
      },
    ]),
    "claude-unknown-9",
    "一覧に実体が無ければ生ID文字列をそのまま返す"
  );

  // === resolveDefaultModelLabel: value 一致へのフォールバック ===
  console.log("\n--- resolveDefaultModelLabel: value 一致フォールバック ---");
  assertEqual(
    resolveDefaultModelLabel([
      { value: "default", resolvedModel: "sonnet", displayName: "Default (recommended)", description: "" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "" },
    ]),
    "Sonnet",
    "resolvedModel がエイリアス名でも value 一致で拾える"
  );

  // === resolveDefaultModelLabel: 縮退・境界 ===
  console.log("\n--- resolveDefaultModelLabel: 縮退・境界 ---");
  assertEqual(
    resolveDefaultModelLabel([
      { value: "default", displayName: "Default (recommended)", description: "" },
    ]),
    null,
    "resolvedModel が無い（旧SDK/CLI）→ null で併記を省く"
  );
  assertEqual(resolveDefaultModelLabel([]), null, "空一覧 → null");
  assertEqual(
    resolveDefaultModelLabel([
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "" },
    ]),
    null,
    "default エントリが無い → null"
  );
  assertEqual(
    resolveDefaultModelLabel([
      { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "" },
    ]),
    "claude-opus-5[1m]",
    "default 自身は突合対象から除外する（自己一致で Default が返らない）"
  );
  assertEqual(
    resolveDefaultModelLabel([
      { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "" },
      // resolvedModel を持たないエントリ同士が undefined === undefined で誤一致しないこと
      { value: "legacy", displayName: "Legacy", description: "" },
    ]),
    "claude-opus-5[1m]",
    "resolvedModel を持たないエントリと誤一致しない"
  );

  // === buildToggleBarLabel: おまかせ（実体＋effort の両方併記） ===
  console.log("\n--- buildToggleBarLabel: おまかせ ---");
  assertEqual(
    buildToggleBarLabel(REAL, "default", "low"),
    "Default (recommended) · 実体: Opus (1M context) · effort: 低/low",
    "SDK の default は supportsEffort:true のため実体と effort を両方併記する"
  );
  assertEqual(
    buildToggleBarLabel(REAL, "default", null),
    "Default (recommended) · 実体: Opus (1M context)",
    "effort 未選択なら実体のみ併記"
  );
  assertEqual(
    buildToggleBarLabel(
      [{ value: "default", displayName: "Default (recommended)", description: "" }],
      "default",
      null
    ),
    "Default (recommended)",
    "resolvedModel が無ければ実体併記を省く"
  );

  // === buildToggleBarLabel: 実モデル選択 ===
  console.log("\n--- buildToggleBarLabel: 実モデル選択 ---");
  assertEqual(
    buildToggleBarLabel(REAL, "sonnet", "high"),
    "Sonnet · effort: 高/high",
    "実モデルは effort のみ（実体併記は付かない）"
  );
  assertEqual(
    buildToggleBarLabel(REAL, "opus[1m]", null),
    "Opus (1M context)",
    "実モデルで effort 未選択なら displayName のみ"
  );
  assertEqual(
    buildToggleBarLabel(REAL, "haiku", "low"),
    "Haiku",
    "effort 非対応モデルは effort 値があっても併記しない"
  );

  // === buildToggleBarLabel: 縮退 ===
  console.log("\n--- buildToggleBarLabel: 縮退 ---");
  assertEqual(
    buildToggleBarLabel([], "default", null),
    "おまかせ / Default",
    "一覧未取得 → 固定文言へ縮退"
  );
  assertEqual(
    buildToggleBarLabel(REAL, "no-such-model", "high"),
    "おまかせ / Default",
    "一覧に無い選択値 → 固定文言へ縮退"
  );

  // === 結果 ===
  console.log(`\n=== 結果: ${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
