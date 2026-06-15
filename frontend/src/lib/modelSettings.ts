// モデル選択 UI 用の型・定数・正規化ロジック（仕様: Docs/仕様-モデル選択.md）
//
// SDK 0.3.177 の supportedModels() は先頭に value:"default"（displayName:"Default (recommended)"）を
// 含めて返す。本実装はこの default エントリをそのまま「おまかせ」として扱い、他モデルと同様に
// model:"default" を明示送信する（特別扱いの分岐を持たない）。

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

// SDKが返す既定モデルの value。初期選択にも使う。
export const DEFAULT_MODEL_VALUE = "default";

// effort の日英併記ラベル
export const EFFORT_LABELS: Record<EffortLevel, { ja: string; en: string }> = {
  low: { ja: "低", en: "low" },
  medium: { ja: "中", en: "medium" },
  high: { ja: "高", en: "high" },
  xhigh: { ja: "最高", en: "xhigh" },
  max: { ja: "最大", en: "max" },
};

// localStorage キー
export const LS_MODEL_KEY = "agentnest.model";
export const LS_EFFORT_KEY = "agentnest.effort";

/** value から ModelInfo を引く。一覧に無ければ null。 */
export function findModel(models: ModelInfo[], value: string | null): ModelInfo | null {
  if (!value) return null;
  return models.find((m) => m.value === value) ?? null;
}

/**
 * 選択モデルに対して effort を正規化する。
 * - supportsEffort=false / 対応段階なし → null
 * - 対応段階に含まれない値 → 先頭の対応段階
 * モデル切替時と起動時の復元直後の両方で同じロジックを通す。
 */
export function normalizeEffort(
  model: ModelInfo | null,
  effort: EffortLevel | null
): EffortLevel | null {
  if (!model || model.supportsEffort === false) return null;
  const levels = model.supportedEffortLevels ?? [];
  if (levels.length === 0) return null;
  if (effort && levels.includes(effort)) return effort;
  return levels[0] ?? null;
}

/**
 * トグルバー（閉時）の表示テキストを組み立てる。
 * - effortあり: {displayName} · effort: {日}/{英}
 * - effort非対応: {displayName}
 * - 一覧未取得（縮退）: おまかせ / Default
 */
export function buildToggleBarLabel(
  models: ModelInfo[],
  selectedModel: string,
  selectedEffort: EffortLevel | null
): string {
  const model = findModel(models, selectedModel);
  if (!model) return "おまかせ / Default";
  if (selectedEffort && model.supportsEffort !== false) {
    const l = EFFORT_LABELS[selectedEffort];
    return `${model.displayName} · effort: ${l.ja}/${l.en}`;
  }
  return model.displayName;
}
