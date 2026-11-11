/**
 * Endpoint-neighbourhood discharge (AUTHOR-ONLY, UNEXECUTED; go-r11 local obligation). PARTIAL: it discharges only the
 * corridor R4 endpoint-disk obligation that two ADJACENT trim pcurves meet nowhere but their common canonical node.
 *
 * Lemma (independent of production): let c be a C2 pcurve on a complete parameter interval of actual length L with a
 * conservative native bound |c''| <= M, starting at node o with chord D = c(L) - o (|D| > 0). Taylor with remainder gives
 * |c'(0) - D/L| <= M L / 2 and c(t) - o = t c'(0) + R(t), |R(t)| <= M t^2 / 2, so for 0 <= t <= L
 *   |c(t) - o - t D/L| <= M t L,
 * i.e. c([0, L]) lies in the closed cone with apex o, axis D and half-angle alpha, sin(alpha) = s := M L^2 / |D| (needs
 * s < 1). Since arcsin(s) <= (pi/2) s, alpha <= (pi/2) s. Two adjacent pcurves with chord directions at angle phi meet
 * only at o if (pi/2)(s1 + s2) < phi. Sufficient checks (outward rounded, exact BigInt for dot/cross):
 *   dot <= 0 (phi >= pi/2):  s1 + s2 < 1;
 *   dot > 0:                 (pi/2)(s1 + s2) < |cross| / (|u||v|) <= sin(phi) <= phi.
 * Data: M is the producer's native secondDerivativeBoundUv, L the native parameter length, endpoints from the ONE canonical
 * chart.uvNodes table (the R4 canonical-node guard runs first). Nothing here asserts native-gap closure, whole-face coverage,
 * material, topology or a certificate.
 */
import type { TrimChord } from './analyticTrimCorridorsR4.js';

function bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}
function fromBits(value: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, value);
  return view.getFloat64(0);
}
function up(value: number): number {
  if (!Number.isFinite(value)) throw new Error('endpoint-discharge: nonfinite');
  if (value === 0) return Number.MIN_VALUE;
  return fromBits(value > 0 ? bits(value) + 1n : bits(value) - 1n);
}
const down = (value: number): number => -up(-value);

function exactParts(value: number): { m: bigint; e: number } {
  if (!Number.isFinite(value)) throw new Error('endpoint-discharge: nonfinite coordinate');
  const raw = bits(value);
  const biased = Number((raw >> 52n) & 0x7ffn);
  const fraction = raw & ((1n << 52n) - 1n);
  const m = biased === 0 ? fraction : fraction | (1n << 52n);
  return { m: (raw >> 63n) === 1n ? -m : m, e: (biased === 0 ? 1 : biased) - 1075 };
}
/** BigInt scaled exactly to 2^base; returns the integers and base so values can be converted back one-sidedly. */
function scaled(values: readonly number[]): { ints: bigint[]; base: number } {
  const parts = values.map(exactParts);
  // Zero mantissas carry no exponent information; using their -1074 would underflow 2^(2*base) in toDouble.
  const nonzero = parts.filter(p => p.m !== 0n);
  const base = nonzero.length === 0 ? 0 : Math.min(...nonzero.map(p => p.e));
  return { ints: parts.map(p => (p.m === 0n ? 0n : p.m << BigInt(p.e - base))), base };
}
/** One-sided conversion of a nonnegative exact integer times 2^exp to a double bound. */
function toDouble(value: bigint, exponent: number, direction: 'down' | 'up'): number {
  if (value < 0n) throw new Error('endpoint-discharge: negative magnitude');
  const approx = Number(value) * 2 ** exponent;
  if (!Number.isFinite(approx)) throw new Error('endpoint-discharge: magnitude overflow');
  return direction === 'down' ? Math.max(0, down(down(approx))) : up(up(approx));
}

const PI_UPPER = up(Math.PI);

export interface EndpointDischarge {
  /** Canonical node -> discharged (adjacent pcurves meet only at this node). Partial local fact only. */
  readonly discharged: ReadonlySet<number>;
  readonly partial: true;
  readonly nativeGapsClosed: false;
  readonly certificateEmitted: false;
}

export function dischargeEndpointNeighbourhoods(chords: readonly TrimChord[], checkpoint: () => void,
  budget: { take(cells: number): void }): EndpointDischarge {
  budget.take(chords.length);
  const discharged = new Set<number>();
  let pairs = 0;
  for (let i = 0; i < chords.length; i += 1) {
    for (let j = i + 1; j < chords.length; j += 1) {
      pairs += 1;
      if (pairs % 256 === 0) checkpoint();
      const p = chords[i], q = chords[j];
      const shared = [p.from, p.to].filter(n => n === q.from || n === q.to);
      if (shared.length !== 1) continue;
      const node = shared[0];
      const at = (c: TrimChord): readonly [number, number] => (c.from === node ? c.a : c.b);
      const away = (c: TrimChord): readonly [number, number] => (c.from === node ? c.b : c.a);
      const o = at(p);
      if (at(q)[0] !== o[0] || at(q)[1] !== o[1]) throw new Error('endpoint-discharge: shared node with unequal coordinates');
      const { ints: [ox, oy, px, py, qx, qy], base } = scaled([o[0], o[1], away(p)[0], away(p)[1], away(q)[0], away(q)[1]]);
      const ux = px - ox, uy = py - oy, vx = qx - ox, vy = qy - oy;
      const lu2 = ux * ux + uy * uy, lv2 = vx * vx + vy * vy;
      if (lu2 === 0n || lv2 === 0n) throw new Error('endpoint-discharge: zero chord');
      const dot = ux * vx + uy * vy, cross = ux * vy - uy * vx;
      const exp2 = 2 * base;
      const luLow = down(Math.sqrt(toDouble(lu2, exp2, 'down'))), lvLow = down(Math.sqrt(toDouble(lv2, exp2, 'down')));
      const luUp = up(Math.sqrt(toDouble(lu2, exp2, 'up'))), lvUp = up(Math.sqrt(toDouble(lv2, exp2, 'up')));
      const cone = (c: TrimChord, chordLow: number): number => {
        const m = c.secondDerivativeBound, l = c.parameterLength;
        if (!Number.isFinite(m) || m < 0 || !Number.isFinite(l) || !(l > 0)) throw new Error('endpoint-discharge: invalid native bound');
        if (!(chordLow > 0)) throw new Error('endpoint-discharge: unresolved chord length');
        return up(up(m * up(l * l)) / chordLow);
      };
      const s1 = cone(p, luLow), s2 = cone(q, lvLow);
      const sum = up(s1 + s2);
      if (!(s1 < 1) || !(s2 < 1)) throw new Error('endpoint-discharge: pcurve tangent cone not resolved (M L^2 >= |chord|)');
      if (dot <= 0n) {
        if (!(sum < 1)) throw new Error('endpoint-discharge: tangent cones may overlap at an obtuse junction');
      } else {
        const crossAbs = cross < 0n ? -cross : cross;
        const sinLow = down(toDouble(crossAbs, exp2, 'down') / up(luUp * lvUp));
        if (!(up(up(PI_UPPER / 2) * sum) < sinLow)) throw new Error('endpoint-discharge: tangent cones may overlap at an acute junction');
      }
      discharged.add(node);
    }
  }
  return { discharged, partial: true, nativeGapsClosed: false, certificateEmitted: false };
}
