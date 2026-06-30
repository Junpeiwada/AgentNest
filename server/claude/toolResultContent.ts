import { basename } from "path";

/**
 * ツール結果（tool_result）の content を、フロントエンド表示用の文字列へ変換する。
 *
 * 【なぜ専用処理が必要か】
 * Claude が画像ファイルを Read すると、SDK は tool_result の content を
 *   [{ type: "image", source: { type: "base64", media_type: "image/png", data: "...(数MB)..." } }]
 * という画像ブロックの配列で返す。これを素朴に JSON.stringify するとフロントエンドへ
 * base64 がテキストとして丸ごと流れ込む。1枚あたり約2MB（200万文字）にもなり、
 * 長い会話では履歴全体で数十MBに膨張する。その結果 DOM とヒープが肥大化し、
 * 入力のたびの強制リフローやタブ切替が重くなる（しかも展開してもゴミ文字列が見えるだけ）。
 *
 * そこで画像ブロックは base64 を捨て、ファイル名付きの短いプレースホルダへ置換する。
 * 履歴ロード（routes/sessions.ts）とライブ実行（claude/executor.ts）の両経路で共用する。
 */

/** 画像ブロック用のプレースホルダ文字列。ファイルパスが分かればベース名を添える。 */
export function imagePlaceholder(filePath?: string): string {
  const base = filePath ? basename(filePath) : "";
  return base ? `🖼️ 画像を読み込み: ${base}` : "🖼️ 画像を読み込み";
}

/**
 * tool_input から画像のファイルパスをベストエフォートで推測する。
 * Read は file_path、NotebookRead は notebook_path 等とキーが異なるため複数候補を見る。
 * 見つからなければ undefined（プレースホルダはファイル名なしに縮退する）。
 */
export function imagePathFromToolInput(
  input: Record<string, unknown> | undefined
): string | undefined {
  if (!input) return undefined;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * tool_result の content を表示用文字列に変換する。
 * - 文字列はそのまま
 * - 配列は各要素を変換して改行連結（text ブロックは text、画像ブロックはプレースホルダ）
 * - それ以外は JSON 文字列化
 *
 * @param imageFilePath 画像ブロックに添えるファイルパス（あれば）。
 *   1回の tool_result に画像が複数含まれる場合（通常 Read は1ファイル1画像なので稀）は、
 *   全画像ブロックに同じパスが使われる点に注意。
 */
export function stringifyToolResultContent(content: unknown, imageFilePath?: string): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if ((item as { type?: unknown }).type === "image") return imagePlaceholder(imageFilePath);
          if ("text" in item && typeof (item as { text?: unknown }).text === "string") {
            return (item as { text: string }).text;
          }
        }
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}
