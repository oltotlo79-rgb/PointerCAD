import type { Vector3 } from '@pointercad/drawing';

interface Line { readonly from: Vector3; readonly to: Vector3 }
const delta = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const positive = (direction: Vector3): 1 | -1 => (direction.find((value) => Math.abs(value) > 1e-12) ?? 1) < 0 ? -1 : 1;

/** 辺の内部へ向かう半直線を使い、OCCTの辺の格納順で45°が135°へ変わるのを防ぐ。 */
export function dimensionAngleDirections(first: Line, second: Line): {
  readonly first: Vector3; readonly second: Vector3; readonly firstSign: 1 | -1; readonly secondSign: 1 | -1;
} | null {
  const a = delta(first.to, first.from), b = delta(second.to, second.from), offset = delta(second.from, first.from);
  const aa = dot(a, a), ab = dot(a, b), bb = dot(b, b), denominator = aa * bb - ab * ab;
  if (![aa, ab, bb, denominator].every(Number.isFinite) || aa <= 0 || bb <= 0 || denominator <= aa * bb * 1e-14) return null;
  const t = (dot(offset, a) * bb - dot(offset, b) * ab) / denominator;
  const s = (dot(offset, a) * ab - dot(offset, b) * aa) / denominator;
  const pa: Vector3 = [first.from[0] + t * a[0], first.from[1] + t * a[1], first.from[2] + t * a[2]];
  const pb: Vector3 = [second.from[0] + s * b[0], second.from[1] + s * b[1], second.from[2] + s * b[2]];
  if (Math.hypot(...delta(pa, pb)) > 1e-7) return null;
  const sign = (parameter: number, direction: Vector3): 1 | -1 => Math.abs(parameter - 0.5) <= 1e-12 ? positive(direction) : parameter < 0.5 ? 1 : -1;
  const firstSign = sign(t, a), secondSign = sign(s, b);
  return { first: [a[0] * firstSign, a[1] * firstSign, a[2] * firstSign], second: [b[0] * secondSign, b[1] * secondSign, b[2] * secondSign], firstSign, secondSign };
}
