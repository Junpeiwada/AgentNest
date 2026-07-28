// モデル選択 UI 用の型・定数・正規化ロジック（仕様: Docs/仕様-モデル選択.md）
//
// SDK 0.3.220 の supportedModels() は先頭に value:"default"（displayName:"Default (recommended)"）を
// 含めて返す。本実装はこの default エントリをそのまま「おまかせ」として扱い、他モデルと同様に
// model:"default" を明示送信する（特別扱いの分岐を持たない）。

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  value: string;
  /**
   * エイリアスが解決された実体のモデルID（SDK 0.3.220 で追加、例: "default" → "claude-opus-5[1m]"）。
   * 「おまかせ」の実体名併記に使う。古いSDK/CLIでは返らないため optional。
   */
  resolvedModel?: string;
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
 * 「おまかせ」が実際にどのモデルへ解決されるかを人間可読な名前で返す。
 *
 * `default` エントリの resolvedModel（例 "claude-opus-5[1m]"）を、同じ実体を指す
 * 別エントリ（例 value:"opus[1m]"）の displayName（例 "Opus (1M context)"）に突合する。
 *
 * - 突合は resolvedModel 同士 → value との一致、の順に試す（SDK が将来 resolvedModel を
 *   ワイヤIDではなくエイリアス名で返しても拾えるようにする保険）。
 * - `default` エントリ自身は突合対象から除外する。含めると自分自身に一致して
 *   "Default (recommended)" が返り、併記の意味がなくなるため。
 * - 同じ実体を指すエントリが複数ある場合は **SDK の返却順で最初の1件** を採る
 *   （SDK は代表的なエイリアスを先に返すため、その順序を優先度とみなす）。
 * - 突合先が無ければ生のID文字列をそのまま返す（表示が消えるよりはIDでも出す）。
 * - resolvedModel 自体が無い（古いSDK/CLI）場合のみ null を返し、呼び出し側は併記を省く。
 */
export function resolveDefaultModelLabel(models: ModelInfo[]): string | null {
  const resolved = findModel(models, DEFAULT_MODEL_VALUE)?.resolvedModel;
  if (!resolved) return null;
  const others = models.filter((m) => m.value !== DEFAULT_MODEL_VALUE);
  const match =
    others.find((m) => m.resolvedModel === resolved) ??
    others.find((m) => m.value === resolved);
  return match?.displayName ?? resolved;
}

/**
 * モデルが effort に対応しているかを判定する（唯一の判定基準）。
 *
 * SDK は effort 非対応モデル（例 haiku）で `supportsEffort` / `supportedEffortLevels` を
 * **フィールドごと省略**して返す。`supportsEffort !== false` だけで判定すると undefined が
 * 通ってしまうため、対応段階が実在することまで確認する。
 * effort 行の表示・値の正規化・トグルバー併記のすべてがこの関数を通ることで、
 * 判定のズレ（表示されるのに選ぶと null になる等）を防ぐ。
 */
export function supportsEffortFor(model: ModelInfo | null): boolean {
  if (!model || model.supportsEffort === false) return false;
  return (model.supportedEffortLevels ?? []).length > 0;
}

/**
 * 選択モデルに対して effort を正規化する。
 * - effort 非対応（supportsEffortFor が false）→ null
 * - 対応段階に含まれない値 → 先頭の対応段階
 * モデル切替時と起動時の復元直後の両方で同じロジックを通す。
 */
export function normalizeEffort(
  model: ModelInfo | null,
  effort: EffortLevel | null
): EffortLevel | null {
  if (!supportsEffortFor(model)) return null;
  const levels = model!.supportedEffortLevels ?? [];
  if (effort && levels.includes(effort)) return effort;
  return levels[0] ?? null;
}

/**
 * トグルバー（閉時）の表示テキストを組み立てる。
 * `{displayName}` を先頭に、該当する要素だけを中黒（ · ）で連結する。
 * - 実体: 「おまかせ」選択時、かつ実体が解決できた場合のみ
 * - effort: モデルが effort 対応で、値が選択されている場合のみ
 *
 * SDK の `default` エントリは `supportsEffort: true` を返すため、「おまかせ」でも
 * effort は選択され得る。実体と effort は排他ではなく両方併記する。
 *
 * 例:
 * - `Default (recommended) · 実体: Opus (1M context) · effort: 低/low`
 * - `Sonnet · effort: 高/high`
 * - `Haiku`（effort 非対応）
 * - `おまかせ / Default`（一覧未取得の縮退時）
 *
 * displayName 自体が "Opus (1M context)" のように括弧を含むため、括弧で囲わず
 * すべて中黒区切りに揃える。
 */
export function buildToggleBarLabel(
  models: ModelInfo[],
  selectedModel: string,
  selectedEffort: EffortLevel | null
): string {
  const model = findModel(models, selectedModel);
  if (!model) return "おまかせ / Default";

  const parts = [model.displayName];
  if (model.value === DEFAULT_MODEL_VALUE) {
    const resolved = resolveDefaultModelLabel(models);
    if (resolved) parts.push(`実体: ${resolved}`);
  }
  if (selectedEffort && supportsEffortFor(model)) {
    const l = EFFORT_LABELS[selectedEffort];
    parts.push(`effort: ${l.ja}/${l.en}`);
  }
  return parts.join(" · ");
}
