/**
 * 吸着の幅(配置の補助 P-D。統括の決定 2026-11-19 04:39: 小・中・大を 6・12・20 画素)。点を置く道具の吸着(点・向き・球の格子)と、
 * 部品の頂点に吸い付く配置(一筆書きの点。鋼材・機械要素の配置で頂点・面を拾う道具も同じ入口を使う)の判定の半径を決める。
 * 既定は 'medium'(今までと同じ半径)。保存・設定ファイルの値の読み取りと、半径の表だけを持つ(画面・ストアは持たない)。
 */
export const SNAP_RADIUS_CHOICES = ['small', 'medium', 'large'] as const;
export type SnapRadiusChoice = (typeof SNAP_RADIUS_CHOICES)[number];
export const DEFAULT_SNAP_RADIUS: SnapRadiusChoice = 'medium';

/** 点を置く道具の吸着の半径(画素)。中は今までの SNAP_RADIUS_PIXELS(12)。 */
const POINT_SNAP_PIXELS: Readonly<Record<SnapRadiusChoice, number>> = { small: 6, medium: 12, large: 20 };
/**
 * 部品の頂点に吸い付く半径(画素)。中は今までの部分形状の当たりの半径(6)で、既定のままなら今の動きを変えない。
 * 小・大は点の吸着と同じ比(半分・5/3 倍)。
 */
const VERTEX_SNAP_PIXELS: Readonly<Record<SnapRadiusChoice, number>> = { small: 3, medium: 6, large: 10 };

/** 保存・設定ファイルの値を読む。知らない値・形の違う値は null(呼ぶ側が既定か今の値を使う)。 */
export function snapRadiusChoiceOf(raw: unknown): SnapRadiusChoice | null {
  return SNAP_RADIUS_CHOICES.find(item => item === raw) ?? null;
}

/** 設定から読む入口。無い・読めない時は既定('medium')。 */
export function currentSnapRadius(settings: { readonly snapRadius?: SnapRadiusChoice } | undefined): SnapRadiusChoice {
  return snapRadiusChoiceOf(settings?.snapRadius) ?? DEFAULT_SNAP_RADIUS;
}

/** 点を置く道具の吸着の半径(画素)。 */
export function pointSnapRadiusPixels(settings: { readonly snapRadius?: SnapRadiusChoice } | undefined): number {
  return POINT_SNAP_PIXELS[currentSnapRadius(settings)];
}

/** 部品の頂点に吸い付く半径(画素)。 */
export function vertexSnapRadiusPixels(settings: { readonly snapRadius?: SnapRadiusChoice } | undefined): number {
  return VERTEX_SNAP_PIXELS[currentSnapRadius(settings)];
}
