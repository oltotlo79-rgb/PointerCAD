import type { Point2, Vector3 } from '../types.js';
import type { ViewDirection } from '../layout/thirdAngle.js';
import { DIMENSION_LINE_SPACING_MM } from '../style/jisStyle.js';
import { createArrowTriangle, type ArrowTriangle } from './arrow.js';
import { createLinearDimensionGeometry, type DimensionLineSegment, type LinearDimensionGeometry } from './geometry.js';

export interface DrawingViewBasis {
  readonly x: Vector3;
  readonly y: Vector3;
  readonly normal: Vector3;
}
function dot(a: Vector3, b: Vector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function unit(value: Vector3): Vector3 | null {
  const length = Math.hypot(...value);
  return length > 0 && Number.isFinite(length) ? [value[0] / length, value[1] / length, value[2] / length] : null;
}
/** 投影と同じ右手系。normalは見る向きなので紙面YはX×normalになる。 */
export function drawingViewBasis(view: ViewDirection): DrawingViewBasis | null {
  const normal = unit(view.normal);
  if (normal === null || !view.xDir.every(Number.isFinite)) return null;
  const projection = dot(view.xDir, normal);
  const x = unit([view.xDir[0] - projection * normal[0], view.xDir[1] - projection * normal[1], view.xDir[2] - projection * normal[2]]);
  if (x === null) return null;
  const y = unit([x[1] * normal[2] - x[2] * normal[1], x[2] * normal[0] - x[0] * normal[2], x[0] * normal[1] - x[1] * normal[0]]);
  return y === null ? null : { x, y, normal };
}

export interface DimensionSeriesPoint {
  readonly id: string;
  readonly modelPoint: Vector3;
  /** 配置・縮尺適用後の紙上位置。寸法値として使わない。 */
  readonly paperPoint: Point2;
}
export interface DimensionSeriesInput {
  readonly kind: 'chain' | 'parallel' | 'coordinate' | 'progressive';
  readonly points: readonly DimensionSeriesPoint[];
  readonly view: ViewDirection;
  readonly axis?: 'x' | 'y';
  readonly baseIndex?: number;
  readonly commonNormalCoordinate: number;
  /** 実字体から求めた幅。省略時は文字衝突の判定を呼出側で行う。 */
  readonly textWidth?: (value: number) => number | null;
}
export interface SeriesDimension {
  readonly fromId: string;
  readonly toId: string;
  /** 解決時の一時結果。Dimensionの保存形へ数値をコピーしない。 */
  readonly value: number;
  readonly commonNormalCoordinate: number;
  readonly geometry: LinearDimensionGeometry;
}
export interface CoordinateDimensionRow {
  readonly pointId: string;
  readonly x: number;
  readonly y: number;
  readonly position: Point2;
}
export interface ProgressiveDimensionTick {
  readonly pointId: string;
  readonly value: number;
  readonly line: DimensionLineSegment;
  readonly arrow: ArrowTriangle | null;
  readonly textPosition: Point2;
}
export type DimensionSeriesResult =
  | { readonly ok: false; readonly reason: 'points' | 'input' | 'view' | 'projection' | 'text'; readonly message: string }
  | { readonly ok: true; readonly kind: 'chain' | 'parallel'; readonly dimensions: readonly SeriesDimension[] }
  | { readonly ok: true; readonly kind: 'coordinate'; readonly rows: readonly CoordinateDimensionRow[]; readonly basePointId: string }
  | { readonly ok: true; readonly kind: 'progressive'; readonly line: DimensionLineSegment; readonly ticks: readonly ProgressiveDimensionTick[]; readonly basePointId: string };

function failure(reason: 'points' | 'input' | 'view' | 'projection' | 'text'): DimensionSeriesResult {
  const messages = { points: '2 点以上を選んでください。', input: '寸法列の入力を確認してください。',
    view: '図の向きを確認してください。', projection: 'この向きでは寸法線の両端が重なります。', text: '寸法の文字を読み込んでください。' };
  return { ok: false, reason, message: messages[reason] };
}

/** 図の基底で測り、紙上の共通法線座標hで並べる(P8-29)。 */
export function dimensionSeries(input: DimensionSeriesInput): DimensionSeriesResult {
  if (input.points.length < 2) return failure('points');
  const baseIndex = input.baseIndex ?? 0;
  if (!Number.isInteger(baseIndex) || baseIndex < 0 || baseIndex >= input.points.length
    || !Number.isFinite(input.commonNormalCoordinate)
    || !['chain', 'parallel', 'coordinate', 'progressive'].includes(input.kind)
    || (input.axis !== undefined && input.axis !== 'x' && input.axis !== 'y')
    || input.points.some((point) => point.id.length === 0 || ![...point.modelPoint, ...point.paperPoint].every(Number.isFinite))
    || new Set(input.points.map((point) => point.id)).size !== input.points.length) return failure('input');
  const basis = drawingViewBasis(input.view);
  if (basis === null) return failure('view');
  const base = input.points[baseIndex];
  // 大きい原点でも小さい差を失いにくいよう、先に3D点どうしの差を取る。
  const rows = input.points.map((point): CoordinateDimensionRow => {
    const delta: Vector3 = [point.modelPoint[0] - base.modelPoint[0], point.modelPoint[1] - base.modelPoint[1], point.modelPoint[2] - base.modelPoint[2]];
    return { pointId: point.id, x: dot(delta, basis.x), y: dot(delta, basis.y), position: point.paperPoint };
  });
  if (rows.some((row) => !Number.isFinite(row.x) || !Number.isFinite(row.y))) return failure('input');
  if (input.kind === 'coordinate') return { ok: true, kind: 'coordinate', rows, basePointId: base.id };
  const axis = input.axis ?? 'x';
  const axisIndex = axis === 'x' ? 0 : 1;
  const direction: Point2 = axis === 'x' ? [1, 0] : [0, 1];
  const normal: Point2 = [-direction[1], direction[0]];
  const at = (coordinate: number, h: number): Point2 => [direction[0] * coordinate + normal[0] * h, direction[1] * coordinate + normal[1] * h];
  if (input.kind === 'progressive') {
    const h = input.commonNormalCoordinate;
    const coordinates = input.points.map((point) => point.paperPoint[axisIndex]);
    const low = Math.min(...coordinates);
    const high = Math.max(...coordinates);
    if (low === high) return failure('projection');
    const ticks = input.points.map((point, index): ProgressiveDimensionTick => {
      const position = at(coordinates[index], h);
      const sign = Math.sign(coordinates[index] - coordinates[baseIndex]);
      return { pointId: point.id, value: rows[index][axis], line: { from: at(coordinates[index], h - 1), to: at(coordinates[index], h + 1) },
        arrow: sign === 0 ? null : createArrowTriangle(position, [direction[0] * sign, direction[1] * sign]), textPosition: at(coordinates[index], h + 2) };
    });
    return { ok: true, kind: 'progressive', line: { from: at(low, h), to: at(high, h) }, ticks, basePointId: base.id };
  }
  const dimensions: SeriesDimension[] = [];
  for (let i = 0; i < input.points.length; i += 1) {
    if ((input.kind === 'chain' && i === 0) || (input.kind === 'parallel' && i === baseIndex)) continue;
    const firstIndex = input.kind === 'chain' ? i - 1 : baseIndex;
    const value = Math.abs(rows[i][axis] - rows[firstIndex][axis]);
    const width = input.textWidth?.(value) ?? (input.textWidth === undefined ? 0 : null);
    if (width === null || !Number.isFinite(width) || width < 0) return failure('text');
    const h = input.commonNormalCoordinate + (input.kind === 'parallel' ? dimensions.length * DIMENSION_LINE_SPACING_MM : 0);
    const geometry = createLinearDimensionGeometry({ first: input.points[firstIndex].paperPoint, second: input.points[i].paperPoint,
      direction, commonNormalCoordinate: h, textWidth: width });
    if (geometry === null) return failure('projection');
    dimensions.push({ fromId: input.points[firstIndex].id, toId: input.points[i].id, value, commonNormalCoordinate: h,
      geometry: { ...geometry, value } });
  }
  return { ok: true, kind: input.kind, dimensions };
}
