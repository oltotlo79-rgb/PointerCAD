import type { Point2 } from '../types.js';
import { clipCurves, type ClipCurve } from './clipRegion.js';
import { formatDrawingScale } from '../paper/titleBlock.js';

export interface DetailCurve { readonly curve: ClipCurve; readonly lineWidth: number }
export interface DetailViewInput {
  readonly curves: readonly DetailCurve[];
  readonly sourceCenter: Point2;
  readonly sourceRadius: number;
  readonly destinationCenter: Point2;
  readonly scale: number;
  readonly label: string;
  readonly textHeight: number;
}
export type DetailViewResult = { readonly ok: true; readonly curves: readonly DetailCurve[]; readonly title: string; readonly textHeight: number }
  | { readonly ok: false; readonly message: string };

function transformPoint(point: Point2, input: DetailViewInput): Point2 {
  return [input.destinationCenter[0] + (point[0] - input.sourceCenter[0]) * input.scale,
    input.destinationCenter[1] + (point[1] - input.sourceCenter[1]) * input.scale];
}
function transformCurve(curve: ClipCurve, input: DetailViewInput): ClipCurve {
  if (curve.kind === 'segment') return { kind: 'segment', from: transformPoint(curve.from, input), to: transformPoint(curve.to, input) };
  if (curve.kind === 'polyline') return { ...curve, points: curve.points.map((point) => transformPoint(point, input)) };
  return { ...curve, center: transformPoint(curve.center, input), radius: curve.radius * input.scale };
}

/** 元図を円で切り、幾何だけを拡大する。線幅と文字高さは用紙上の値を保つ(FR-714)。 */
export function createDetailView(input: DetailViewInput): DetailViewResult {
  const region = { kind: 'circle' as const, center: input.sourceCenter, radius: input.sourceRadius };
  const clipped = input.curves.flatMap((item) => clipCurves([item.curve], region).map((curve) => ({ ...item, curve })));
  if (clipped.length === 0) return { ok: false, message: 'この円は図の外にあります。図の上に置いてください。' };
  return { ok: true, curves: clipped.map((item) => ({ ...item, curve: transformCurve(item.curve, input) })),
    title: `${input.label} (${formatDrawingScale(input.scale)})`, textHeight: input.textHeight };
}
