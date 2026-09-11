import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { resolveHoleCenters, type ResolvedPartSketch } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import { crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';

export interface HoleSchedulePlane {
  readonly origin: Vec3;
  readonly normal: Vec3;
}
export interface HoleScheduleFrame {
  readonly datum: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
}
export interface HoleScheduleRow {
  readonly id: string;
  readonly symbol: string;
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
  readonly depth: number | null;
  /** 穴表と引出線の対応に使う、実際に穴をあけた面上の中心。 */
  readonly center: Vec3;
  readonly featureIds: readonly string[];
}
export interface HoleScheduleContext {
  readonly sketches: readonly ResolvedPartSketch[];
  /** 対象を加工する直前の実形状で面を解決する。保存済みの古い指紋で代用しない。 */
  readonly resolvePlane: (targetFeatureId: string, face: SubShapeRef) => HoleSchedulePlane | null;
  readonly frame: HoleScheduleFrame;
}
export type HoleScheduleResult =
  | { readonly ok: true; readonly rows: readonly HoleScheduleRow[] }
  | { readonly ok: false; readonly reason: 'invalidFrame' | 'missingFace' | 'missingCenter' | 'invalidValue' | 'conflictingDepth'; readonly featureId?: string };

const POSITION_TOLERANCE_MM = 1e-7;
const finite = (vector: Vec3): boolean => vector.every(Number.isFinite);
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

export function isValidHoleScheduleFrame(frame: HoleScheduleFrame): boolean {
  return finite(frame.datum) && finite(frame.x) && finite(frame.y)
    && Math.abs(lengthVec3(frame.x) - 1) < 1e-10
    && Math.abs(lengthVec3(frame.y) - 1) < 1e-10
    && Math.abs(dotVec3(frame.x, frame.y)) < 1e-10
    && lengthVec3(crossVec3(frame.x, frame.y)) > 1 - 1e-10;
}

function diameterLabel(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

/** 投影の円や可視性に依存せず、穴・ねじ穴フィーチャーから実寸の行を作る(FR-729)。 */
export function buildHoleSchedule(document: PartDocument, context: HoleScheduleContext): HoleScheduleResult {
  if (!isValidHoleScheduleFrame(context.frame)) return { ok: false, reason: 'invalidFrame' };
  const candidates: HoleScheduleCandidate[] = [];
  for (const feature of document.solids) {
    if (feature.suppressed || (feature.kind !== 'hole' && feature.kind !== 'threadHole')) continue;
    const diameter = feature.kind === 'hole' ? feature.diameter.value : feature.drillDiameter.value;
    const depth = feature.depth.kind === 'through' ? null : feature.depth.depth.value;
    if (!positive(diameter) || (depth !== null && !positive(depth))) return { ok: false, reason: 'invalidValue', featureId: feature.id };
    const plane = context.resolvePlane(feature.targetFeatureId, feature.face);
    if (plane === null || !finite(plane.origin) || !finite(plane.normal) || !positive(lengthVec3(plane.normal))) {
      return { ok: false, reason: 'missingFace', featureId: feature.id };
    }
    const normal = scaleVec3(plane.normal, 1 / lengthVec3(plane.normal));
    if (feature.centers.length === 0) return { ok: false, reason: 'missingCenter', featureId: feature.id };
    const centers: Vec3[] = [];
    for (const reference of feature.centers) {
      const resolved = resolveHoleCenters(feature.id, [reference], context.sketches);
      if (!resolved.ok) return { ok: false, reason: 'missingCenter', featureId: feature.id };
      centers.push(...resolved.centers);
    }
    for (let index = 0; index < centers.length; index += 1) {
      const input = centers[index];
      const center = subVec3(input, scaleVec3(normal, dotVec3(subVec3(input, plane.origin), normal)));
      const relative = subVec3(center, context.frame.datum);
      const x = dotVec3(relative, context.frame.x);
      const y = dotVec3(relative, context.frame.y);
      if (!finite(center) || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'invalidValue', featureId: feature.id };
      candidates.push({ id: `${feature.id}:hole:${String(index)}`, center, x: x === 0 ? 0 : x,
        y: y === 0 ? 0 : y, diameter, depth, featureIds: [feature.id] });
    }
  }
  return labelHoleScheduleRows(candidates);
}

export type HoleScheduleCandidate = Omit<HoleScheduleRow, 'symbol'>;
/** 通常穴と展開穴で径グループ・重複・符号の規則を共用する。 */
export function labelHoleScheduleRows(rows: readonly HoleScheduleCandidate[]): HoleScheduleResult {
  const candidates = [...rows];
  candidates.sort((a, b) => a.diameter - b.diameter || a.x - b.x || a.y - b.y
    || a.center[0] - b.center[0] || a.center[1] - b.center[1] || a.center[2] - b.center[2]
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unique: HoleScheduleCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = unique.findIndex((row) => row.diameter === candidate.diameter
      && lengthVec3(subVec3(row.center, candidate.center)) <= POSITION_TOLERANCE_MM);
    if (duplicate < 0) { unique.push(candidate); continue; }
    const row = unique[duplicate];
    if (row.depth !== candidate.depth) return { ok: false, reason: 'conflictingDepth', featureId: candidate.featureIds[0] };
    unique[duplicate] = { ...row, featureIds: [...new Set([...row.featureIds, ...candidate.featureIds])] };
  }
  let previousDiameter: number | null = null;
  let group = -1;
  let serial = 0;
  return { ok: true, rows: unique.map((row) => {
    if (row.diameter !== previousDiameter) { previousDiameter = row.diameter; group += 1; serial = 0; }
    serial += 1;
    return { ...row, symbol: `${diameterLabel(group)}${String(serial)}` };
  }) };
}
