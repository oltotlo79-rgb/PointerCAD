import type { Point2 } from '../types.js';

export interface HatchSegment { readonly from: Point2; readonly to: Point2 }
export interface HatchAreaInput {
  /** 最初が外周、以後は穴。偶奇判定なので向きには依存しない。 */
  readonly loops: readonly (readonly Point2[])[];
  readonly angleRad: number;
  readonly pitchMm: number;
  readonly deflectionMm?: number;
}

const EPSILON = 1e-9;
export const MAX_HATCH_POINTS = 65_536;
const MAX_HATCH_LINES = 16_384;
const MAX_HATCH_SEGMENTS = 65_536;
const MAX_HATCH_EDGE_CHECKS = 10_000_000;
export type HatchAreaResult = { readonly ok: true; readonly segments: readonly HatchSegment[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'budget' };

function dot(point: Point2, axis: Point2): number { return point[0] * axis[0] + point[1] * axis[1]; }

/** 平行線と全輪郭の交点を半開区間で数え、頂点を二重計上せず偶奇で中を選ぶ。 */
export function hatchArea(input: HatchAreaInput): readonly HatchSegment[] {
  const result = checkedHatchArea(input);
  return result.ok ? result.segments : [];
}

/** 資源超過を空の切り口と混同せず、部分的なハッチも返さない。 */
export function checkedHatchArea(input: HatchAreaInput): HatchAreaResult {
  if (!Number.isFinite(input.angleRad) || !Number.isFinite(input.pitchMm) || input.pitchMm <= 0) return { ok: false, reason: 'invalid' };
  if (input.loops.length === 0) return { ok: true, segments: [] };
  if (input.loops.length > MAX_HATCH_POINTS / 3) return { ok: false, reason: 'budget' };
  let pointCount = 0, minimum = Infinity, maximum = -Infinity;
  const direction: Point2 = [Math.cos(input.angleRad), Math.sin(input.angleRad)];
  const normal: Point2 = [-direction[1], direction[0]];
  for (const loop of input.loops) {
    pointCount += loop.length;
    if (pointCount > MAX_HATCH_POINTS) return { ok: false, reason: 'budget' };
    if (loop.length < 3) return { ok: false, reason: 'invalid' };
    for (const point of loop) {
      const offset = dot(point, normal), along = dot(point, direction);
      if (!point.every(Number.isFinite) || !Number.isFinite(offset) || !Number.isFinite(along)) return { ok: false, reason: 'invalid' };
      minimum = Math.min(minimum, offset); maximum = Math.max(maximum, offset);
    }
  }
  // 輪郭の中心を通る線を基準にする。45°と135°の鏡像で位相がずれて本数が変わるのを防ぐ。
  const phase = minimum / 2 + maximum / 2;
  const first = Math.ceil((minimum - phase - EPSILON) / input.pitchMm);
  const last = Math.floor((maximum - phase + EPSILON) / input.pitchMm);
  const lineCount = last - first + 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !Number.isSafeInteger(lineCount)
      || lineCount > MAX_HATCH_LINES || lineCount * pointCount > MAX_HATCH_EDGE_CHECKS) return { ok: false, reason: 'budget' };
  const result: HatchSegment[] = [];

  for (let lineIndex = first; lineIndex <= last; lineIndex += 1) {
    const offset = phase + lineIndex * input.pitchMm;
    const intersections: number[] = [];
    for (const loop of input.loops) {
      for (let index = 0; index < loop.length; index += 1) {
        const a = loop[index];
        const b = loop[(index + 1) % loop.length];
        if (a === undefined || b === undefined) continue;
        const sideA = dot(a, normal) - offset;
        const sideB = dot(b, normal) - offset;
        // 一端を含み他端を含まない半開規則。直線が頂点を通っても交点は1回だけになる。
        if (!((sideA <= EPSILON && sideB > EPSILON) || (sideB <= EPSILON && sideA > EPSILON))) continue;
        const divisor = sideA - sideB;
        if (!Number.isFinite(divisor)) return { ok: false, reason: 'invalid' };
        const ratio = sideA / divisor;
        const along = dot(a, direction) * (1 - ratio) + dot(b, direction) * ratio;
        if (!Number.isFinite(along)) return { ok: false, reason: 'invalid' };
        intersections.push(along);
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const from = intersections[index];
      const to = intersections[index + 1];
      if (from === undefined || to === undefined || to - from <= EPSILON) continue;
      if (result.length >= MAX_HATCH_SEGMENTS) return { ok: false, reason: 'budget' };
      const segment: HatchSegment = {
        from: [direction[0] * from + normal[0] * offset, direction[1] * from + normal[1] * offset],
        to: [direction[0] * to + normal[0] * offset, direction[1] * to + normal[1] * offset],
      };
      if (!segment.from.every(Number.isFinite) || !segment.to.every(Number.isFinite)) return { ok: false, reason: 'invalid' };
      result.push(segment);
    }
  }
  return { ok: true, segments: result };
}
