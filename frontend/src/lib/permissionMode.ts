// 実行モード（permissionMode）選択 UI 用の型・定数・正規化ロジック
// 仕様: Docs/仕様-実行モード選択.md
//
// SDK の PermissionMode のうち、UIに載せるのは4モードのみ
// （bypassPermissions / dontAsk は事故リスクのため除外）。
// 英語ラベルは Claude Code 本体の表記に揃える。

export type PermissionMode = "acceptEdits" | "default" | "auto" | "plan";

// localStorage キー
export const LS_PERMISSION_MODE_KEY = "agentnest.permissionMode";

// 旧「Auto Edit」トグルの localStorage キー（permissionMode へ移行済み）。
// 誰も読まなくなった死にデータのため、マウント時に一度だけ掃除する。
export const LS_LEGACY_AUTO_EDIT_KEYS = [
  "agent-nest-auto-edit",
  "claudeweb-auto-edit",
];

// 初期値: 既存ユーザーの体験を変えないため acceptEdits（現 Auto ON 相当）
export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

// 表示順（編集自動 → 都度確認 → 自動判断 → プランのみ）
export const PERMISSION_MODE_ORDER: PermissionMode[] = [
  "acceptEdits",
  "default",
  "auto",
  "plan",
];

// 日英ラベル（英語は Claude Code 準拠）
export const MODE_LABELS: Record<PermissionMode, { ja: string; en: string }> = {
  acceptEdits: { ja: "編集自動", en: "Edit Automatically" },
  default: { ja: "都度確認", en: "Ask before edits" },
  auto: { ja: "自動判断", en: "Auto mode" },
  plan: { ja: "プランのみ", en: "Plan mode" },
};

/** 保存値・外部入力を対象4モードに正規化する。範囲外は既定モードへ。 */
export function normalizePermissionMode(
  value: string | null | undefined
): PermissionMode {
  if (value && PERMISSION_MODE_ORDER.includes(value as PermissionMode)) {
    return value as PermissionMode;
  }
  return DEFAULT_PERMISSION_MODE;
}
