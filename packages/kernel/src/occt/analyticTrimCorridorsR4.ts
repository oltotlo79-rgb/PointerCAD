/**
 * Trim corridors (AUTHOR-ONLY, UNEXECUTED; renewal-4 scope). Each trim chord (one native polygon interval of a native
 * edge use, outer or hole) has a UV corridor of half-width w = M * L^2 / 8 around its chord: M is a CONSERVATIVE native
 * bound on |pcurve''| over the complete interval (caller-supplied from the analytic pcurve, never sampled) and L is the
 * interval length in curve parameter (Peano kernel, as boundary-06 trimChordDeviationBound). Every rounded operation is
 * pushed outward. Requirements:
 *  - non-adjacent chords (no shared endpoint node): inflated axis boxes are exactly disjoint (conservative);
 *  - adjacent chords (exactly one shared node v): their corridors may overlap only inside the endpoint disk of radius
 *    rho = w_i + w_j (obtuse/right outgoing angle) or (w_i + w_j) / sin(phi) (acute), and rho must not exceed half of
 *    either chord, so the overlap stays inside the region the boundary-06 endpoint cone at v must cover; rho is returned
 *    per node as an explicit obligation for that cone, not discharged here;
 *  - collinear same-direction adjacent chords (sin(phi) = 0 with acute angle) refuse.
 * R2: the adjacent-angle branch is exact (BigInt dot, cross and squared lengths; the only rounded quantity is the
 * outward S = w_i + w_j, itself an upper bound). The reported endpoint radius is the proven bound min chord / 2.
 * This proves no coverage by itself; it is an input condition for the ribbon/cone accounting. Native tolerance tubes
 * must lie inside these corridors (caller obligation, unchanged). Flags elsewhere remain false.
 */

export interface TrimChord {
  readonly occurrence: number;
  readonly interval: number;
  readonly from: number; // chart node index
  readonly to: number;
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  readonly secondDerivativeBound: number; // M >= 0, conservative native bound on |d2 pcurve/dt2| over the interval
  readonly parameterLength: number; // L > 0
}

function exactParts(value: number): { m: bigint; e: number } {
  if (!Number.isFinite(value)) throw new Error('trim-corridor: nonfinite');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const m = biased === 0 ? fraction : fraction | (1n << 52n);
  return { m: (bits >> 63n) === 1n ? -m : m, e: (biased === 0 ? 1 : biased) - 1075 };
}
function scaledExact(values: readonly number[]): bigint[] {
  const parts = values.map(exactParts);
  const base = Math.min(...parts.map(p => p.e));
  return parts.map(p => p.m << BigInt(p.e - base));
}

function nextUp(value: number): number {
  if (!Number.isFinite(value)) throw new Error('trim-corridor: nonfinite');
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}
const nextDown = (value: number): number => -nextUp(-value);
const up = (value: number): number => nextUp(value);
const down = (value: number): number => nextDown(value);

export function corridorHalfWidth(chord: TrimChord): number {
  const { secondDerivativeBound: m, parameterLength: l } = chord;
  if (!Number.isFinite(m) || m < 0) throw new Error('trim-corridor: invalid second-derivative bound');
  if (!Number.isFinite(l) || !(l > 0)) throw new Error('trim-corridor: invalid parameter length');
  return up(up(m * up(l * l)) / 8);
}

function lengthUpper(p: readonly [number, number], q: readonly [number, number]): number {
  const dx = up(Math.abs(q[0] - p[0])), dy = up(Math.abs(q[1] - p[1]));
  return up(Math.sqrt(up(up(dx * dx) + up(dy * dy))));
}

export function assertDisjointTrimCorridors(chords: readonly TrimChord[], checkpoint: () => void,
  budget: { take(cells: number): void }): ReadonlyMap<number, number> {
  if (chords.length === 0 || chords.length > 6144) throw new Error('trim-corridor: budget');
  budget.take(chords.length);
  const widths = chords.map(corridorHalfWidth);
  const boxes = chords.map((c, i) => ({
    minU: down(Math.min(c.a[0], c.b[0]) - widths[i]), maxU: up(Math.max(c.a[0], c.b[0]) + widths[i]),
    minV: down(Math.min(c.a[1], c.b[1]) - widths[i]), maxV: up(Math.max(c.a[1], c.b[1]) + widths[i]),
  }));
  const keys = new Set<string>();
  for (const c of chords) {
    const key = `${c.occurrence}:${c.interval}`;
    if (keys.has(key)) throw new Error('trim-corridor: duplicate chord interval');
    keys.add(key);
    if (c.from === c.to) throw new Error('trim-corridor: degenerate chord');
  }
  // R4: one immutable canonical coordinate per node id; inconsistent duplicated fields are refused, never welded.
  const nodeAt = new Map<number, readonly [number, number]>();
  for (const c of chords) {
    for (const [node, point] of [[c.from, c.a], [c.to, c.b]] as const) {
      const seen = nodeAt.get(node);
      if (seen === undefined) nodeAt.set(node, point);
      else if (seen[0] !== point[0] || seen[1] !== point[1]) {
        throw new Error('trim-corridor: node id ' + node + ' carries unequal exact coordinates');
      }
    }
  }
  const cone = new Map<number, number>();
  let pairs = 0;
  for (let i = 0; i < chords.length; i += 1) {
    if (i % 64 === 0) checkpoint();
    for (let j = i + 1; j < chords.length; j += 1) {
      pairs += 1;
      if (pairs % 256 === 0) checkpoint(); // cancellation observable inside the pair loop
      const p = chords[i], q = chords[j];
      const shared = [p.from, p.to].filter(n => n === q.from || n === q.to);
      if (shared.length === 2) throw new Error('trim-corridor: two chords on the same node pair');
      if (shared.length === 0) {
        const disjoint = boxes[i].maxU < boxes[j].minU || boxes[j].maxU < boxes[i].minU
          || boxes[i].maxV < boxes[j].minV || boxes[j].maxV < boxes[i].minV;
        if (!disjoint) throw new Error('trim-corridor: non-adjacent corridors may overlap');
        continue;
      }
      const v = shared[0];
      const at = (c: TrimChord): readonly [number, number] => (c.from === v ? c.a : c.b);
      const away = (c: TrimChord): readonly [number, number] => (c.from === v ? c.b : c.a);
      const o = at(p), pi = away(p), qi = away(q);
      // Exact: all coordinates and S = up(w_i + w_j) scaled to one binary exponent (BigInt), no rounded subtraction.
      const sum = up(widths[i] + widths[j]);
      const [ox, oy, px, py, qx, qy, sS] = scaledExact([o[0], o[1], pi[0], pi[1], qi[0], qi[1], sum]);
      const ux = px - ox, uy = py - oy, vx = qx - ox, vy = qy - oy;
      const dot = ux * vx + uy * vy, cross = ux * vy - uy * vx;
      const lu2 = ux * ux + uy * uy, lv2 = vx * vx + vy * vy;
      const longer2 = lu2 > lv2 ? lu2 : lv2;
      // Overlap radius rho: obtuse/right (dot <= 0) -> S; acute -> S / sin(phi), sin(phi) = |cross| / (|u||v|).
      // Requirement rho <= min(|u|,|v|)/2, squared exactly:
      //   obtuse: 4 S^2 <= min(|u|^2,|v|^2);  acute: cross^2 >= 4 S^2 max(|u|^2,|v|^2) (cross = 0 refuses).
      const fourS2 = 4n * sS * sS;
      if (dot <= 0n) {
        if (fourS2 > lu2 || fourS2 > lv2) throw new Error('trim-corridor: adjacent overlap exceeds the endpoint disk');
      } else {
        if (cross === 0n) throw new Error('trim-corridor: collinear adjacent chords overlap along their length');
        if (cross * cross < fourS2 * longer2) throw new Error('trim-corridor: adjacent overlap exceeds the endpoint disk');
      }
      // Proven rho <= min chord / 2; report that conservative outward value as the endpoint-cone obligation.
      const rho = up(Math.min(lengthUpper(o, pi), lengthUpper(o, qi)) / 2);
      cone.set(v, Math.max(cone.get(v) ?? 0, rho));
    }
  }
  return cone;
}
