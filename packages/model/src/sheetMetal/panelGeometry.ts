/** 板金パネルの安定境界と接線座標。OCCTの面番号や表示メッシュへ依存しない。 */
import { curveEnd, curveStart } from '../sketch/intersectionMath.js';
import { sampleSpline } from '../sketch/splineMath.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import { addVec3, crossVec3, distanceVec3, dotVec3, lengthVec3, normalizeVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetPanelId } from './featureInputs.js';

export interface SheetPanelGeometry {
  readonly id: string;
  readonly normal: Vec3;
  /** 板厚方向の始点となる面。曲線は元の厳密な種類と式から解決した座標を保つ。 */
  readonly outer: readonly ResolvedCurve[];
  readonly holes: readonly (readonly ResolvedCurve[])[];
}
export interface SheetBoundaryEdge {
  readonly id: string;
  /** panel.normalから見た外周の反時計回り。 */
  readonly from: Vec3; readonly to: Vec3;
}
export interface SheetTangentFrame {
  readonly origin: Vec3; readonly xAxis: Vec3; readonly yAxis: Vec3; readonly normal: Vec3;
}
export type SheetGeometryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };
const TOLERANCE_MM = 1e-7;

function validFrame(frame: SheetTangentFrame): boolean {
  const { xAxis: x, yAxis: y, normal: n } = frame;
  return [...frame.origin, ...x, ...y, ...n].every(Number.isFinite)
    && [x, y, n].every((axis) => Math.abs(lengthVec3(axis) - 1) <= 1e-10)
    && Math.abs(dotVec3(x, y)) <= 1e-10 && Math.abs(dotVec3(x, n)) <= 1e-10 && Math.abs(dotVec3(y, n)) <= 1e-10
    && Math.abs(dotVec3(crossVec3(x, y), n) - 1) <= 1e-10;
}

function reverseCurve(curve: ResolvedCurve): ResolvedCurve {
  switch (curve.kind) {
    case 'segment': return { ...curve, from: curve.to, to: curve.from };
    case 'arc': case 'ellipse': return { ...curve, startAngle: curve.endAngle, endAngle: curve.startAngle };
    case 'spline': return { ...curve, points: [...curve.points].reverse() };
  }
}

/** 元の配列順は閉ループ順。各線の入力方向だけを接続に合わせ、曖昧な枝を選ばない。 */
function orientedLoop(curves: readonly ResolvedCurve[]): readonly ResolvedCurve[] | null {
  if (curves.length === 0) return null;
  const attempts = [curves[0], reverseCurve(curves[0])];
  for (const first of attempts) {
    const result = [first];
    for (const curve of curves.slice(1)) {
      const end = curveEnd(result[result.length - 1]);
      if (distanceVec3(end, curveStart(curve)) <= TOLERANCE_MM) result.push(curve);
      else if (distanceVec3(end, curveEnd(curve)) <= TOLERANCE_MM) result.push(reverseCurve(curve));
      else break;
    }
    if (result.length === curves.length && distanceVec3(curveStart(result[0]), curveEnd(result[result.length - 1])) <= TOLERANCE_MM) return result;
  }
  return null;
}

/** 面積ベクトルの2倍。円弧・楕円は線積分し、向きを決めるために多角形へ置き換えない。 */
function areaVector(curve: ResolvedCurve, origin: Vec3): Vec3 {
  const from = subVec3(curveStart(curve), origin), to = subVec3(curveEnd(curve), origin);
  switch (curve.kind) {
    case 'segment': return crossVec3(from, to);
    case 'arc': case 'ellipse': {
      const radiusProduct = curve.kind === 'arc' ? curve.radius ** 2 : curve.majorRadius * curve.minorRadius;
      return addVec3(crossVec3(subVec3(curve.center, origin), subVec3(to, from)),
        scaleVec3(curve.normal, radiusProduct * (curve.endAngle - curve.startAngle)));
    }
    case 'spline': {
      // 面の向きだけを判定。保存・形状・展開には元のスプラインを維持する。
      const points = sampleSpline(curve, 32);
      let sum: Vec3 = [0, 0, 0];
      for (let i = 1; i < points.length; i++) sum = addVec3(sum, crossVec3(subVec3(points[i - 1], origin), subVec3(points[i], origin)));
      return sum;
    }
  }
}

/** 穴と外周を切断しても、同じ面積・向きの規則で分類する。単位はmm²。 */
export function sheetLoopSignedArea(curves: readonly ResolvedCurve[], normal: Vec3): number {
  if (curves.length === 0) return 0;
  const origin = curveStart(curves[0]);
  let area: Vec3 = [0, 0, 0];
  for (const curve of curves) area = addVec3(area, areaVector(curve, origin));
  return dotVec3(area, normal) / 2;
}
export function orientSheetLoop(curves: readonly ResolvedCurve[], normal: Vec3, clockwise = false): readonly ResolvedCurve[] | null {
  const loop = orientedLoop(curves); if (loop === null) return null;
  const area = sheetLoopSignedArea(loop, normal);
  if (!Number.isFinite(area) || Math.abs(area) <= TOLERANCE_MM ** 2) return null;
  return (area < 0) === clockwise ? loop : [...loop].reverse().map(reverseCurve);
}

/** 一つの図形（矩形など）が複数の辺を生む場合だけ、その図形内の順番をIDに含める。 */
export function sheetBoundaryEdges(panel: SheetPanelGeometry): SheetGeometryResult<readonly SheetBoundaryEdge[]> {
  const loop = orientedLoop(panel.outer);
  if (loop === null) return { ok: false, message: '板金の外周が閉じていません。輪郭を確認してください。' };
  const origin = curveStart(loop[0]);
  let area: Vec3 = [0, 0, 0];
  for (const curve of loop) area = addVec3(area, areaVector(curve, origin));
  const signed = dotVec3(area, panel.normal);
  if (!Number.isFinite(signed) || Math.abs(signed) <= TOLERANCE_MM ** 2) return { ok: false, message: '板金の面の向きを決められません。外周を確認してください。' };
  const seen = new Map<string, number>(), edges: SheetBoundaryEdge[] = [];
  for (const curve of loop) {
    const occurrence = seen.get(curve.featureId) ?? 0; seen.set(curve.featureId, occurrence + 1);
    if (curve.kind !== 'segment') continue;
    const id = JSON.stringify(['sheet-edge', curve.featureId, occurrence]);
    edges.push({ id, from: signed > 0 ? curve.from : curve.to, to: signed > 0 ? curve.to : curve.from });
  }
  return { ok: true, value: edges };
}

/** 境界端からの切詰めを適用する。長さを拡縮せず、開始端/終了端を別々に残す。 */
export function sheetTangentFrame(panel: SheetPanelGeometry, edgeId: string, startOffset: number, endOffset: number):
  SheetGeometryResult<{ readonly frame: SheetTangentFrame; readonly width: number; readonly edge: SheetBoundaryEdge }> {
  const edges = sheetBoundaryEdges(panel); if (!edges.ok) return edges;
  const edge = edges.value.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) return { ok: false, message: 'フランジの元の直線縁が見つかりません。縁を選び直してください。' };
  const width = distanceVec3(edge.from, edge.to) - startOffset - endOffset;
  if (![width, startOffset, endOffset, ...panel.normal].every(Number.isFinite) || Math.abs(lengthVec3(panel.normal) - 1) > 1e-10
    || Math.min(startOffset, endOffset) < 0 || width <= TOLERANCE_MM)
    return { ok: false, message: '端の距離を小さくし、フランジの幅を残してください。' };
  const xAxis = normalizeVec3(subVec3(edge.from, edge.to)), yAxis = crossVec3(panel.normal, xAxis);
  const frame: SheetTangentFrame = { origin: addVec3(edge.to, scaleVec3(xAxis, startOffset)), xAxis, yAxis, normal: panel.normal };
  if (!validFrame(frame)) return { ok: false, message: '選んだ縁が板金パネルの平面にありません。縁を選び直してください。' };
  return { ok: true, value: { frame, width, edge } };
}

export interface RectangularFlangeGeometry {
  readonly panel: SheetPanelGeometry;
  readonly tangentFrame: SheetTangentFrame;
  readonly endFrame: SheetTangentFrame;
  readonly width: number;
}

/** 正負の曲げで異なる板厚の始点を求める。矩形と任意輪郭で同じ接線面を使う。 */
export function flangeEndFrame(frame: SheetTangentFrame, thickness: number, radius: number, angle: number): SheetGeometryResult<SheetTangentFrame> {
  if (!validFrame(frame) || ![thickness, radius, angle].every(Number.isFinite) || Math.min(thickness, radius) <= TOLERANCE_MM || Math.abs(angle) >= 180)
    return { ok: false, message: 'フランジの板厚・内半径・曲げ角を確認してください。' };
  const theta = Math.abs(angle) * Math.PI / 180, sign = angle < 0 ? -1 : 1;
  const bottomRadius = angle < 0 ? radius : radius + thickness;
  const c = Math.cos(theta), s = Math.sin(theta);
  const origin = addVec3(frame.origin, addVec3(scaleVec3(frame.yAxis, bottomRadius * s), scaleVec3(frame.normal, sign * bottomRadius * (1 - c))));
  const along = addVec3(scaleVec3(frame.yAxis, c), scaleVec3(frame.normal, sign * s));
  const normal = addVec3(scaleVec3(frame.yAxis, -sign * s), scaleVec3(frame.normal, c));
  const endFrame: SheetTangentFrame = { origin, xAxis: frame.xAxis, yAxis: along, normal };
  if (!validFrame(endFrame)) return { ok: false, message: 'フランジの座標が扱える範囲を超えています。' };
  return { ok: true, value: endFrame };
}

export function rectangularFlangePanel(featureId: string, boundaryId: string, frame: SheetTangentFrame,
  width: number, length: number, thickness: number, radius: number, angle: number): SheetGeometryResult<RectangularFlangeGeometry> {
  if (![width, length].every(Number.isFinite) || Math.min(width, length) <= TOLERANCE_MM)
    return { ok: false, message: 'フランジの長さ・幅を確認してください。' };
  const end = flangeEndFrame(frame, thickness, radius, angle); if (!end.ok) return end;
  const endFrame = end.value;
  const point = (x: number, y: number): Vec3 => addVec3(endFrame.origin, addVec3(scaleVec3(endFrame.xAxis, x), scaleVec3(endFrame.yAxis, y)));
  const points = [point(0, 0), point(width, 0), point(width, length), point(0, length)];
  if (!points.flat().every(Number.isFinite)) return { ok: false, message: 'フランジの座標が扱える範囲を超えています。' };
  const id = sheetPanelId(featureId, boundaryId);
  const outer: ResolvedSegment[] = points.map((from, index) => ({ kind: 'segment', featureId: JSON.stringify([id, 'side', index]), from, to: points[(index + 1) % 4] }));
  return { ok: true, value: { panel: { id, normal: endFrame.normal, outer, holes: [] }, tangentFrame: frame, endFrame, width } };
}
