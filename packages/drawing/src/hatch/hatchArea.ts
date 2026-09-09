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

function dot(point: Point2, axis: Point2): number { return point[0] * axis[0] + point[1] * axis[1]; }

/** 平行線と全輪郭の交点を半開区間で数え、頂点を二重計上せず偶奇で中を選ぶ。 */
export function hatchArea(input: HatchAreaInput): readonly HatchSegment[] {
  if (!Number.isFinite(input.angleRad) || !Number.isFinite(input.pitchMm) || input.pitchMm <= 0) return [];
  const points = input.loops.flat();
  if (points.length < 3) return [];
  const direction: Point2 = [Math.cos(input.angleRad), Math.sin(input.angleRad)];
  const normal: Point2 = [-direction[1], direction[0]];
  const offsets = points.map((point) => dot(point, normal));
  const minimum = Math.min(...offsets);
  const maximum = Math.max(...offsets);
  // 輪郭の中心を通る線を基準にする。45°と135°の鏡像で位相がずれて本数が変わるのを防ぐ。
  const phase = (minimum + maximum) / 2;
  const first = Math.ceil((minimum - phase - EPSILON) / input.pitchMm);
  const last = Math.floor((maximum - phase + EPSILON) / input.pitchMm);
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
        const ratio = sideA / (sideA - sideB);
        const point: Point2 = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
        intersections.push(dot(point, direction));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const from = intersections[index];
      const to = intersections[index + 1];
      if (from === undefined || to === undefined || to - from <= EPSILON) continue;
      result.push({
        from: [direction[0] * from + normal[0] * offset, direction[1] * from + normal[1] * offset],
        to: [direction[0] * to + normal[0] * offset, direction[1] * to + normal[1] * offset],
      });
    }
  }
  return result;
}
