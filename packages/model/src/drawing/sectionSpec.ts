import type { Point2 } from '@pointercad/drawing';

import type { PlaneSpec } from '../geometry/planeSpec.js';

/** 断面図の切り方。面の解決契約は作業平面と共有する(FR-713)。 */
export interface SectionSpec {
  readonly kind: 'full' | 'half' | 'local' | 'revolved' | 'stepped';
  readonly plane: PlaneSpec;
  readonly keepSide: 'positive' | 'negative';
  readonly boundary?: readonly Point2[];
}

export interface CuttingLineSegment {
  readonly from: Point2;
  readonly to: Point2;
  readonly style: 'thin-chain' | 'thick-solid';
}

export interface CuttingLineArrow {
  readonly at: Point2;
  readonly direction: Point2;
}

export interface CuttingLineGeometry {
  readonly chain: readonly CuttingLineSegment[];
  readonly heavyMarks: readonly CuttingLineSegment[];
  readonly arrows: readonly [CuttingLineArrow, CuttingLineArrow];
  readonly label: string;
  readonly title: string;
}

const MARK_LENGTH_MM = 5;

function normalized(from: Point2, to: Point2): Point2 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  return length > 0 ? [dx / length, dy / length] : [1, 0];
}

function markAt(point: Point2, direction: Point2): CuttingLineSegment {
  const half = MARK_LENGTH_MM / 2;
  return {
    from: [point[0] - direction[0] * half, point[1] - direction[1] * half],
    to: [point[0] + direction[0] * half, point[1] + direction[1] * half],
    style: 'thick-solid',
  };
}

/** 0=A、25=Z、26=AA の決定的な断面符号。 */
export function sectionLetter(index: number): string {
  let remaining = Math.max(0, Math.floor(index));
  let result = '';
  do {
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return result;
}

/** 細い一点鎖線、端・屈折部の太線、見る側を示す2矢印を一度に作る。 */
export function createCuttingLine(
  points: readonly Point2[],
  labelIndex: number,
  viewSide: 'left' | 'right' = 'right',
): CuttingLineGeometry | null {
  if (points.length < 2 || points.some((point) => !point.every(Number.isFinite))) return null;
  const chain = points.slice(0, -1).flatMap((from, index): CuttingLineSegment[] => {
    const to = points[index + 1];
    return to === undefined ? [] : [{ from, to, style: 'thin-chain' }];
  });
  if (chain.some((line) => line.from[0] === line.to[0] && line.from[1] === line.to[1])) return null;

  const heavyMarks = points.map((point, index) => {
    const before = points[Math.max(0, index - 1)] ?? point;
    const after = points[Math.min(points.length - 1, index + 1)] ?? point;
    return markAt(point, normalized(before, after));
  });
  const first = points[0];
  const last = points[points.length - 1];
  const firstAlong = normalized(first, points[1]);
  const lastAlong = normalized(points[points.length - 2], last);
  const sign = viewSide === 'right' ? 1 : -1;
  const arrows: readonly [CuttingLineArrow, CuttingLineArrow] = [
    { at: first, direction: [-firstAlong[1] * sign, firstAlong[0] * sign] },
    { at: last, direction: [-lastAlong[1] * sign, lastAlong[0] * sign] },
  ];
  const label = sectionLetter(labelIndex);
  return { chain, heavyMarks, arrows, label, title: `${label}–${label}` };
}

/** Must の3種に必要な境界指定を検査する。 */
export function validateSectionSpec(spec: SectionSpec): string | null {
  if (spec.kind === 'full' || spec.kind === 'revolved') return null;
  if (spec.boundary?.some((point) => !point.every(Number.isFinite)) ||
      (spec.kind === 'half' && spec.boundary?.length !== 2)) return '断面の範囲を指定してください。';
  const minimum = spec.kind === 'local' ? 3 : 2;
  return (spec.boundary?.length ?? 0) >= minimum
    ? null
    : spec.kind === 'local'
      ? '部分断面の閉じた輪郭を指定してください。'
      : '断面の範囲を指定してください。';
}
