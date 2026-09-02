import { MIN_DISTANCE } from './cameraMath.js';

/** 画面に入れたい方眼のおよその本数。 */
export const TARGET_GRID_LINE_COUNT = 10;

/** 方眼の間隔として使う数列(1, 2, 5 の並び)。 */
const SPACING_SERIES = [1, 2, 5] as const;

/**
 * カメラ距離に応じた方眼の間隔(mm)を返す(FR-104)。
 * 1 → 2 → 5 → 10 → 20 → 50 … の順に切り替わる。
 */
export function gridSpacing(cameraDistance: number): number {
  const raw = Math.max(cameraDistance, MIN_DISTANCE) / TARGET_GRID_LINE_COUNT;
  const exponent = Math.floor(Math.log10(raw));
  for (const factor of SPACING_SERIES) {
    const candidate = factor * Math.pow(10, exponent);
    if (candidate >= raw - 1e-12) {
      return candidate;
    }
  }
  return Math.pow(10, exponent + 1);
}

/** 方眼の広がり(片側の長さ、mm)。間隔の 20 倍を目安に、遠景で描きすぎないようにする。 */
export function gridExtent(spacing: number): number {
  return spacing * 20;
}

/** XYZ 軸を描く長さ(mm)。方眼と同じ広がりに揃える。 */
export function axisLength(spacing: number): number {
  return gridExtent(spacing);
}
