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

/** 主線(濃い線)を入れる間隔。原点から数えて 5 本ごとに 1 本を主線にする(FR-104)。 */
export const MAJOR_GRID_INTERVAL = 5;

/** 原点から数えて index 本目(負は反対側)の方眼線が主線かどうか。 */
export function isMajorGridLine(index: number): boolean {
  return index % MAJOR_GRID_INTERVAL === 0;
}

/** 方眼が薄まらずに見える範囲。広がり(gridExtent)に対する比で表す。 */
export const GRID_FADE_START_RATIO = 0.35;

/**
 * 遠くの方眼を薄くするための不透明度(0 〜 1)。
 *
 * 原点から `extent * GRID_FADE_START_RATIO` までは 1 のままで、そこから外へ向かって
 * 一次関数で減り、広がりの端(`extent`)で 0 になる。端が四角く切れて見えないよう、
 * 距離は軸ごとではなく原点からの直線距離で測る。
 */
export function gridFadeOpacity(distanceFromOrigin: number, extent: number): number {
  if (extent <= 0) {
    return 0;
  }
  const ratio = distanceFromOrigin / extent;
  if (ratio <= GRID_FADE_START_RATIO) {
    return 1;
  }
  const faded = (1 - ratio) / (1 - GRID_FADE_START_RATIO);
  return Math.min(Math.max(faded, 0), 1);
}
