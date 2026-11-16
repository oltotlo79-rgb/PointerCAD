/** Fit the rotated XYZ box in CSS pixels, preserving room for axis names and point buttons. */
import type { Vec3 } from '@pointercad/model';

/** Candidate buttons occupy the drawing area; axis callouts have their own right-hand strip. */
export function createFunctionPointPreviewProjection(minimum: Vec3, maximum: Vec3,
  rotation: { readonly yaw: number; readonly pitch: number }) {
  const project = createFunctionPreviewProjection(minimum, maximum, rotation);
  return (point: Vec3, width: number, height: number): readonly [number, number] =>
    project(point, Math.max(1, width - 40), height);
}

/** 軸の名前の帯の位置(FunctionPointPreview の引き出し線の先と同じ)。帯は図の右端から 30px、段の高さは図の高さの 1/4 ずつ。 */
const AXIS_STRIP_INSET = 30;
const AXIS_SLOT_PERMUTATIONS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;

/** X・Y・Z の軸の端の角(最小の角から各軸の向きへ伸ばした角)。引き出し線の元。 */
export function functionAxisEnds(minimum: Vec3, maximum: Vec3): readonly [Vec3, Vec3, Vec3] {
  return [[maximum[0], minimum[1], minimum[2]], [minimum[0], maximum[1], minimum[2]], [minimum[0], minimum[1], maximum[2]]];
}

function side(p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number {
  return Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
}

function segmentsCross(a: readonly [readonly [number, number], readonly [number, number]],
  b: readonly [readonly [number, number], readonly [number, number]]): boolean {
  return side(a[0], a[1], b[0]) * side(a[0], a[1], b[1]) < 0 && side(b[0], b[1], a[0]) * side(b[0], b[1], a[1]) < 0;
}

/**
 * 軸の名前を右の帯に縦に並べる時の、X・Y・Z の段(0〜2、上から)。引き出し線(軸の端の角 → 帯の段)どうしの交差が
 * 最も少ない並びを選び、同じ数なら角の高さの順に近い並びにする(UI の点検の指摘 35。固定の X・Y・Z の順では線が交差した)。
 */
export function axisLabelSlots(ends: readonly (readonly [number, number])[], width: number, height: number): readonly number[] {
  const order = [0, 1, 2].sort((a, b) => (ends[a]?.[1] ?? 0) - (ends[b]?.[1] ?? 0) || a - b);
  const byHeight = [0, 0, 0];
  order.forEach((axis, slot) => { byHeight[axis] = slot; });
  const score = (slots: readonly number[]): readonly [number, number] => {
    const lines = [0, 1, 2].map(axis => [ends[axis] ?? [0, 0], [width - AXIS_STRIP_INSET, height * ((slots[axis] ?? 0) + 1) / 4]] as const);
    const crossings = Number(segmentsCross(lines[0], lines[1])) + Number(segmentsCross(lines[0], lines[2])) + Number(segmentsCross(lines[1], lines[2]));
    return [crossings, slots.reduce((sum, slot, axis) => sum + Math.abs(slot - (byHeight[axis] ?? 0)), 0)];
  };
  let best: readonly number[] = byHeight, bestScore = score(byHeight);
  for (const slots of AXIS_SLOT_PERMUTATIONS) {
    const candidate = score(slots);
    if (candidate[0] < bestScore[0] || (candidate[0] === bestScore[0] && candidate[1] < bestScore[1])) {
      best = slots; bestScore = candidate;
    }
  }
  return best;
}

export function createFunctionPreviewProjection(minimum: Vec3, maximum: Vec3,
  rotation: { readonly yaw: number; readonly pitch: number }) {
  const spans = maximum.map((value, axis) => value - minimum[axis]);
  const span = Math.max(...spans, Number.MIN_VALUE);
  const center = minimum.map((value, axis) => value + spans[axis] / 2);
  const cy = Math.cos(rotation.yaw), sy = Math.sin(rotation.yaw);
  const cp = Math.cos(rotation.pitch), sp = Math.sin(rotation.pitch);
  // Normalize before summing: 2 * span may overflow even when every XYZ extent is finite.
  // This also retains the rotated proportions of very small representable boxes.
  const normalizedSpans = spans.map(value => value / span);
  const horizontalRadius = (Math.abs(cy) * normalizedSpans[0] + Math.abs(sy) * normalizedSpans[1]) / 2;
  const verticalRadius = (Math.abs(sp * sy) * normalizedSpans[0] + Math.abs(sp * cy) * normalizedSpans[1]
    + Math.abs(cp) * normalizedSpans[2]) / 2;

  return (point: Vec3, width: number, height: number): readonly [number, number] => {
    const margin = Math.min(24, Math.min(width, height) / 2);
    const horizontalScale = horizontalRadius > 0 ? (width / 2 - margin) / horizontalRadius : Infinity;
    const verticalScale = verticalRadius > 0 ? (height / 2 - margin) / verticalRadius : Infinity;
    const candidate = Math.min(horizontalScale, verticalScale);
    const scale = Number.isFinite(candidate) ? Math.max(0, candidate) : 0;
    const [x, y, z] = point.map((value, axis) => (value - center[axis]) / span);
    return [width / 2 + (cy * x - sy * y) * scale,
      height / 2 - (cp * z - sp * (sy * x + cy * y)) * scale];
  };
}
