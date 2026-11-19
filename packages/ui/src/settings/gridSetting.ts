/**
 * 方眼の幅と数(配置の補助 P-C。統括の決定 2026-11-19 04:39: 利用者ごとの表示の設定に持つ)。
 * - 自動('auto'、既定): 今までどおり、カメラの距離から 1・2・5 の並びで幅を決める(gridMath.ts の gridSpacing)。
 * - 固定('fixed'): 幅(mm)と、原点から片側の線の数を利用者が決める。広がりは 幅 × 数。スケッチの方眼への吸着と、一筆書きの点・部品のドラッグ
 *   (鋼材・機械要素の配置)の方眼への吸着が同じ幅を使う(placementGridSnap.ts)。
 * 保存の値の読み取りと既定だけを持つ(画面・ストアは持たない)。
 */
export const GRID_MODES = ['auto', 'fixed'] as const;
export type GridMode = (typeof GRID_MODES)[number];

export interface GridSetting {
  readonly mode: GridMode;
  /** 固定の時の幅(mm)。 */
  readonly stepMm: number;
  /** 固定の時の、原点から片側の線の数(広がり = 幅 × 数)。 */
  readonly count: number;
}

/** 幅の範囲(mm)。 */
const GRID_STEP_MIN_MM = 0.1;
const GRID_STEP_MAX_MM = 10_000;
/**
 * 片側の線の数の範囲。上限 50 は、方眼の線分の数(薄める色を線分ごとに持つ)を自動の時(片側 20)の約 6 倍までに抑える値
 * (視点の操作の速さ〔NFR-PF-1〕を落とさない)。
 */
const GRID_COUNT_MIN = 1;
const GRID_COUNT_MAX = 50;

/** 既定は自動。固定へ切り替えた時の初めの値は 10 mm × 20 本(自動の時の片側 20 本に合わせる)。 */
export const DEFAULT_GRID_SETTING: GridSetting = Object.freeze({ mode: 'auto', stepMm: 10, count: 20 });

/** 幅として受けられる数か(有限で範囲の中)。 */
export function validGridStep(value: number): boolean {
  return Number.isFinite(value) && value >= GRID_STEP_MIN_MM && value <= GRID_STEP_MAX_MM;
}

/** 片側の線の数として受けられる数か(整数で範囲の中)。 */
export function validGridCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= GRID_COUNT_MIN && value <= GRID_COUNT_MAX;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 保存の値を読む。形・範囲の違う値は null(呼ぶ側が既定を使う)。 */
export function gridSettingOf(raw: unknown): GridSetting | null {
  if (!isRecord(raw)) return null;
  const mode = GRID_MODES.find(item => item === raw.mode);
  const { stepMm, count } = raw;
  if (mode === undefined || typeof stepMm !== 'number' || typeof count !== 'number') return null;
  return validGridStep(stepMm) && validGridCount(count) ? { mode, stepMm, count } : null;
}

/**
 * 設定から読む入口。無い・読めない時は既定(自動)。読める時は保存の値そのもの(同じ参照)を返す: 画面の useAppStore の選び出しが毎回
 * 新しい物を返すと、描き直しが止まらない(React の更新の深さの上限。画面検査 RUN 20261119-070120 の「Minified React error #185」)。
 */
export function currentGridSetting(settings: { readonly grid?: GridSetting } | undefined): GridSetting {
  const stored = settings?.grid;
  return stored !== undefined && gridSettingOf(stored) !== null ? stored : DEFAULT_GRID_SETTING;
}
