/**
 * stringifyToolResultContent / imagePlaceholder / imagePathFromToolInput の単体チェック
 *
 * server/claude/toolResultContent.ts は、tool_result の content を表示用文字列へ変換する。
 * Claude が画像ファイルを Read すると SDK は content を
 *   [{ type: "image", source: { type: "base64", data: "...(数MB)..." } }]
 * で返す。これを素朴に JSON.stringify すると base64 がテキストとしてフロントへ流れ、
 * 長い会話で履歴が数十MB（実測48.7MB）に膨張し描画/入力が重くなる回帰があった。
 * 画像ブロックを base64 ごとプレースホルダへ置換するのがこの関数の肝なので、
 * 「base64 が出力に残らない」「混在配列で text は保持される」等を回帰固定する。
 *
 * 実行: npx tsx tests/tool-result-content.check.ts
 */

import {
  stringifyToolResultContent,
  imagePlaceholder,
  imagePathFromToolInput,
} from "../server/claude/toolResultContent.js";

let failures = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}（expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}）`);
    failures++;
  }
}

const bigBase64 = "iVBORw0KGgo" + "A".repeat(2_000_000);
const imgBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: bigBase64 } };
const textBlock = { type: "text", text: "ファイルの中身です" };

function main() {
  // === 画像ブロック: base64 を捨ててプレースホルダ化（回帰の核心） ===
  console.log("--- 画像ブロックの置換 ---");
  const img = stringifyToolResultContent([imgBlock], "/Users/x/compare/animagine.png");
  assertEqual(img.includes("iVBORw0KGgo"), false, "base64 が出力に残らない");
  assertEqual(img, "🖼️ 画像を読み込み: animagine.png", "ファイル名付きプレースホルダ");
  assertEqual(stringifyToolResultContent([imgBlock]), "🖼️ 画像を読み込み", "パス未指定はファイル名なしに縮退");

  // === text と image の混在: text は保持、image だけ置換 ===
  console.log("\n--- 混在配列 ---");
  assertEqual(
    stringifyToolResultContent([textBlock, imgBlock], "/a/b/foo.png"),
    "ファイルの中身です\n🖼️ 画像を読み込み: foo.png",
    "text 保持 + image 置換"
  );

  // === 非画像の経路は従来どおり ===
  console.log("\n--- 非画像の経路 ---");
  assertEqual(stringifyToolResultContent("$ ls\nfile.txt"), "$ ls\nfile.txt", "文字列 content はそのまま");
  assertEqual(stringifyToolResultContent(["line1", "line2"]), "line1\nline2", "配列内の素の文字列");
  assertEqual(stringifyToolResultContent(null), "", "null → 空文字");
  assertEqual(stringifyToolResultContent(undefined), "", "undefined → 空文字");
  assertEqual(stringifyToolResultContent({ a: 1 }), JSON.stringify({ a: 1 }, null, 2), "非配列オブジェクト → JSON");

  // === imagePlaceholder: basename 縮約 ===
  console.log("\n--- imagePlaceholder ---");
  assertEqual(imagePlaceholder("/a/b/img.png"), "🖼️ 画像を読み込み: img.png", "フルパス → basename");
  assertEqual(imagePlaceholder("/a/b/"), "🖼️ 画像を読み込み: b", "末尾スラッシュも basename で縮約");
  assertEqual(imagePlaceholder("img.png"), "🖼️ 画像を読み込み: img.png", "スラッシュ無しはそのまま");
  assertEqual(imagePlaceholder(""), "🖼️ 画像を読み込み", "空文字 → フォールバック");
  assertEqual(imagePlaceholder(undefined), "🖼️ 画像を読み込み", "undefined → フォールバック");

  // === imagePathFromToolInput: 候補キーの探索 ===
  console.log("\n--- imagePathFromToolInput ---");
  assertEqual(imagePathFromToolInput({ file_path: "/x/a.png" }), "/x/a.png", "Read: file_path");
  assertEqual(imagePathFromToolInput({ notebook_path: "/x/n.ipynb" }), "/x/n.ipynb", "NotebookRead: notebook_path");
  assertEqual(imagePathFromToolInput({ path: "/x/p.png" }), "/x/p.png", "汎用: path");
  assertEqual(imagePathFromToolInput({ path: "/x/p", file_path: "/x/f" }), "/x/f", "file_path を優先");
  assertEqual(imagePathFromToolInput({ file_path: "", path: "/x/p" }), "/x/p", "空文字キーは無視して次候補");
  assertEqual(imagePathFromToolInput({ command: "ls" }), undefined, "該当キーなし → undefined");
  assertEqual(imagePathFromToolInput(undefined), undefined, "input undefined → undefined");

  // === 結果 ===
  console.log(`\n=== 結果: ${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
