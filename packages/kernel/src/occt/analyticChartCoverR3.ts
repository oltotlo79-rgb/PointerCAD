/**
 * P3/P4 successor (AUTHOR-ONLY, UNEXECUTED; feedback-r2 obligations 2 and 3). Replaces the whole-face strict span test of
 * analyticChartInjectivity.ts for periodic charts: a LIFTED chart (one UV lift per triangle corner, boundary-08 binding
 * keeps per-corner lifts) is an injective degree-1 cover of its trimmed face when ALL of the following hold exactly:
 *  (a) every chart triangle is positively oriented and internal edges cancel (K validateAnalyticUvComplex, unchanged);
 *  (b) every boundary edge of the lifted complex is classified by the caller from native data as exactly one of
 *      trim (a wire occurrence chord, outer or hole), seam (one lift of a native seam edge) or pole (a collapsed edge
 *      bound to the native degenerate edge/vertex); unclassified or doubly classified edges refuse;
 *  (c) seam edges pair 1:1 by native seam edge id, the two lifts differ by EXACTLY (+-uPeriod, 0) or (0, +-vPeriod)
 *      and have opposite orientation; a missing, extra or offset-mismatched lift refuses;
 *  (d) the lifted boundary loops are simple and pairwise non-crossing (exact orientation predicates): with (a) the
 *      lifted degree is the boundary winding number, so it is 1 on the chart and 0 outside (no multiple cover);
 *  (e) the lifted chart lies in ONE period box: u-extent <= uPeriod (and v-extent <= vPeriod for torus), with the
 *      native period itself <= double(2*pi) < 2*pi. A standard full cylinder has extent exactly uPeriod and passes;
 *      a chart spanning more than one period refuses (conservative, not a widened bound);
 *  (f) pole edges lie exactly on the pole parameter line (sphere v = +-double(pi/2)) and no pole value occurs at a
 *      non-pole boundary edge or in the interior.
 * (d)+(e) give interior injectivity of S on the lifted chart; (b)+(c) identify exactly the seam; the trim edges then
 * form the face's wire chain, and trim corridors (assertDisjointTrimCorridors) cover chord-to-pcurve bands once.
 * Topology/ambient isotopy is NOT claimed by any of this.
 *
 * R2 (Astra findings): (d) alone is NOT sufficient. Nested positive loops (outer (0,0),(4,0),(0,4) with an inner
 * positive triangle (1,1),(2,1),(1,2)) do not cross yet have degree 2. R2 therefore (d2) extracts every boundary loop
 * and requires the exact degree on the material side of each loop to be 1. It is a PRECONDITION, not replaced, that
 * boundary-08 validateAnalyticUvComplex has accepted the identical chart and wires first; no independent sufficiency
 * is claimed. Trim edges are native polygon INTERVALS of one native edge use: per occurrence the intervals must tile
 * the native parameter range exactly (no gap, overlap or duplicate), in traversal order.
 */

export type ExactUv = readonly [number, number];
export type CoverBoundaryClass =
  /** One native polygon interval [start, end] (traversal order) of a native trim edge use. */
  | { readonly kind: 'trim'; readonly occurrence: number; readonly interval: readonly [number, number] }
  /** One native seam polygon segment (edge id + segment index along the native PolygonOnTriangulation). */
  | { readonly kind: 'seam'; readonly seamEdge: number; readonly segment: number }
  | { readonly kind: 'pole'; readonly poleVertex: number };

export interface LiftedChart {
  readonly surface: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus';
  readonly nodes: readonly ExactUv[];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly uPeriod: number | null;
  readonly vPeriod: number | null;
  /** Key "from:to" of a directed boundary edge (as oriented by its triangle) to its native classification. */
  readonly boundary: ReadonlyMap<string, CoverBoundaryClass>;
}

const TWO_PI_BELOW = 6.283185307179586;
const HALF_PI_BELOW = 1.5707963267948966;

function exact(value: number): { m: bigint; e: number } {
  if (!Number.isFinite(value)) throw new Error('chart-cover: nonfinite coordinate');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const m = biased === 0 ? fraction : fraction | (1n << 52n);
  return { m: (bits >> 63n) === 1n ? -m : m, e: (biased === 0 ? 1 : biased) - 1075 };
}
/** All values scaled to one common binary exponent (exact integers). */
function scaled(values: readonly number[]): bigint[] {
  const parts = values.map(exact);
  const base = Math.min(...parts.map(p => p.e));
  return parts.map(p => p.m << BigInt(p.e - base));
}
function orient(a: ExactUv, b: ExactUv, c: ExactUv): bigint {
  const [ax, ay, bx, by, cx, cy] = scaled([a[0], a[1], b[0], b[1], c[0], c[1]]);
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
const sign = (value: bigint): number => (value > 0n ? 1 : value < 0n ? -1 : 0);

/** Exact proper/improper intersection of closed segments pq and rs. */
function segmentsTouch(p: ExactUv, q: ExactUv, r: ExactUv, s: ExactUv): boolean {
  const d1 = sign(orient(r, s, p)), d2 = sign(orient(r, s, q)), d3 = sign(orient(p, q, r)), d4 = sign(orient(p, q, s));
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  const within = (a: ExactUv, b: ExactUv, c: ExactUv): boolean => {
    const [ax, ay, bx, by, cx, cy] = scaled([a[0], a[1], b[0], b[1], c[0], c[1]]);
    return (cx >= (ax < bx ? ax : bx)) && (cx <= (ax > bx ? ax : bx)) && (cy >= (ay < by ? ay : by)) && (cy <= (ay > by ? ay : by));
  };
  return (d1 === 0 && within(r, s, p)) || (d2 === 0 && within(r, s, q)) || (d3 === 0 && within(p, q, r)) || (d4 === 0 && within(p, q, s));
}

function spanAtMost(low: number, high: number, limit: number): boolean {
  const [h, l, m] = scaled([high, low, limit]);
  return h >= l && h - l <= m;
}

export interface ChartCoverResult {
  readonly trimOccurrences: readonly number[];
  readonly seamPairs: number;
  readonly poleEdges: number;
  readonly degreeOneCover: true;
  readonly topologyCertified: false;
}

/** Native traversal-order parameter range of each trim occurrence (boundary-08 native edge use). */
export type TrimOccurrenceRanges = ReadonlyMap<number, readonly [number, number]>;

export function assertLiftedChartCoverR2(chart: LiftedChart, trimRanges: TrimOccurrenceRanges, checkpoint: () => void,
  budget: { take(cells: number): void }): ChartCoverResult {
  checkpoint();
  const { nodes, triangles } = chart;
  if (nodes.length < 3 || nodes.length > 1024 || triangles.length === 0 || triangles.length > 2048) throw new Error('chart-cover: budget');
  // (a) orientation and internal cancellation (independent restatement of the K precondition).
  const directed = new Map<string, number>();
  for (const t of triangles) {
    if (t.some(i => !Number.isSafeInteger(i) || i < 0 || i >= nodes.length)) throw new Error('chart-cover: invalid index');
    if (orient(nodes[t[0]], nodes[t[1]], nodes[t[2]]) <= 0n) throw new Error('chart-cover: nonpositive lifted triangle');
    for (let k = 0; k < 3; k += 1) {
      const key = `${t[k]}:${t[(k + 1) % 3]}`;
      if (directed.has(key)) throw new Error('chart-cover: repeated directed edge (multiple cover)');
      directed.set(key, 1);
    }
  }
  const boundaryEdges: (readonly [number, number])[] = [];
  for (const key of directed.keys()) {
    const [a, b] = key.split(':').map(Number);
    if (!directed.has(`${b}:${a}`)) boundaryEdges.push([a, b]);
  }
  // (b) complete exclusive classification.
  if (chart.boundary.size !== boundaryEdges.length) throw new Error('chart-cover: boundary classification incomplete or extra');
  const trims: number[] = [], seams = new Map<string, (readonly [number, number])[]>();
  const intervals = new Map<number, (readonly [number, number])[]>();
  let poles = 0;
  for (const [a, b] of boundaryEdges) {
    const cls = chart.boundary.get(`${a}:${b}`);
    if (cls === undefined) throw new Error('chart-cover: unclassified boundary edge');
    if (cls.kind === 'trim') {
      trims.push(cls.occurrence);
      intervals.set(cls.occurrence, [...(intervals.get(cls.occurrence) ?? []), cls.interval]);
    }
    else if (cls.kind === 'seam') {
      if (!Number.isSafeInteger(cls.seamEdge) || !Number.isSafeInteger(cls.segment) || cls.segment < 0) throw new Error('chart-cover: invalid seam segment');
      const key = `${cls.seamEdge}:${cls.segment}`;
      seams.set(key, [...(seams.get(key) ?? []), [a, b]]);
    } else {
      // (f) pole edges exactly on the pole line.
      if (chart.surface !== 'sphere' && chart.surface !== 'cone') throw new Error('chart-cover: pole on a pole-free surface');
      if (chart.surface === 'sphere') {
        const v = nodes[a][1];
        if (!((v === HALF_PI_BELOW || v === -HALF_PI_BELOW) && nodes[b][1] === v)) throw new Error('chart-cover: pole edge off the pole line');
      }
      // Cone apex: a constant-v line; its radius-zero value is checked by assertAnalyticChartInjective (apex binding).
      if (chart.surface === 'cone' && nodes[a][1] !== nodes[b][1]) throw new Error('chart-cover: apex edge is not a constant-v line');
      poles += 1;
    }
  }
  // Per native occurrence: intervals tile the native range exactly, in traversal order, without gap/overlap/duplicate.
  if (intervals.size !== trimRanges.size) throw new Error('chart-cover: trim occurrence set differs from the native edge uses');
  for (const [occurrence, parts] of intervals) {
    const range = trimRanges.get(occurrence);
    if (range === undefined) throw new Error('chart-cover: trim occurrence without native range');
    const forward = range[1] > range[0];
    if (range[1] === range[0] || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) throw new Error('chart-cover: invalid native range');
    const ordered = [...parts].sort((a, b) => (forward ? a[0] - b[0] : b[0] - a[0]));
    let cursor = range[0];
    for (const [start, end] of ordered) {
      if (start !== cursor) throw new Error('chart-cover: trim interval gap, overlap or duplicate');
      if (forward ? !(end > start) : !(end < start)) throw new Error('chart-cover: trim interval against native direction');
      cursor = end;
    }
    if (cursor !== range[1]) throw new Error('chart-cover: trim intervals do not reach the native range end');
  }
  if (chart.surface === 'sphere') {
    for (const [a, b] of boundaryEdges) {
      const cls = chart.boundary.get(`${a}:${b}`);
      if (cls?.kind !== 'pole' && [nodes[a][1], nodes[b][1]].some(v => Math.abs(v) === HALF_PI_BELOW)
        && nodes[a][1] === nodes[b][1]) throw new Error('chart-cover: unbound edge on the pole line');
    }
    if (nodes.some(n => Math.abs(n[1]) > HALF_PI_BELOW)) throw new Error('chart-cover: latitude beyond a pole');
  }
  // (c) seam pairing by exact period translation and opposite orientation.
  for (const [id, lifts] of seams) {
    if (lifts.length !== 2) throw new Error('chart-cover: seam segment ' + id + ' needs exactly two lifts');
    const [[a0, b0], [a1, b1]] = lifts;
    // Opposite orientation by one exact period P: lift 1 is (b0 + P) -> (a0 + P), i.e. a1 = b0 + P and b1 = a0 + P.
    const periods: ExactUv[] = [];
    if (chart.uPeriod !== null) periods.push([chart.uPeriod, 0], [-chart.uPeriod, 0]);
    if (chart.vPeriod !== null) periods.push([0, chart.vPeriod], [0, -chart.vPeriod]);
    const matches = periods.some(period => {
      const [pu, pv, a0u, a0v, b1u, b1v, b0u, b0v, a1u, a1v] = scaled([period[0], period[1], nodes[a0][0], nodes[a0][1],
        nodes[b1][0], nodes[b1][1], nodes[b0][0], nodes[b0][1], nodes[a1][0], nodes[a1][1]]);
      return b1u - a0u === pu && b1v - a0v === pv && a1u - b0u === pu && a1v - b0v === pv;
    });
    if (!matches) throw new Error('chart-cover: seam lifts of edge ' + id + ' are not one exact period apart with opposite orientation');
  }
  // (e) one period box.
  const us = nodes.map(n => n[0]), vs = nodes.map(n => n[1]);
  for (const [period, values, label] of [[chart.uPeriod, us, 'u'], [chart.vPeriod, vs, 'v']] as const) {
    if (period === null) continue;
    if (!spanAtMost(0, period, TWO_PI_BELOW) || !(period > 0)) throw new Error('chart-cover: native ' + label + ' period exceeds 2*pi');
    if (!spanAtMost(Math.min(...values), Math.max(...values), period)) throw new Error('chart-cover: ' + label + ' lift exceeds one period');
  }
  if ((chart.surface === 'cylinder' || chart.surface === 'cone' || chart.surface === 'sphere' || chart.surface === 'torus') && chart.uPeriod === null) {
    throw new Error('chart-cover: periodic surface without native u period');
  }
  if (chart.surface === 'torus' && chart.vPeriod === null) throw new Error('chart-cover: torus without native v period');
  // (d) lifted boundary is a set of simple, pairwise non-crossing loops: only shared endpoints may touch.
  budget.take(boundaryEdges.length);
  const outgoing = new Map<number, number>();
  for (const [a] of boundaryEdges) {
    if (outgoing.has(a)) throw new Error('chart-cover: boundary vertex with two outgoing edges (pinched cover)');
    outgoing.set(a, 1);
  }
  let pairs = 0;
  for (let i = 0; i < boundaryEdges.length; i += 1) {
    if (i % 64 === 0) checkpoint();
    const [a, b] = boundaryEdges[i];
    for (let j = i + 1; j < boundaryEdges.length; j += 1) {
      pairs += 1;
      if (pairs % 256 === 0) checkpoint(); // cancellation observable inside the pair loop
      const [c, d] = boundaryEdges[j];
      const shared = [a, b].filter(x => x === c || x === d).length;
      if (shared === 0 && segmentsTouch(nodes[a], nodes[b], nodes[c], nodes[d])) throw new Error('chart-cover: lifted boundary crosses itself');
      if (shared === 1) {
        // Adjacent edges may only meet at the shared vertex: reject collinear overlap.
        const other = b === c || b === d ? a : b;
        const s = b === c || b === d ? b : a;
        const far = c === s ? d : c;
        if (orient(nodes[other], nodes[s], nodes[far]) === 0n
          && segmentsTouch(nodes[s], nodes[other], nodes[s], nodes[far])
          && Math.sign(nodes[other][0] - nodes[s][0]) === Math.sign(nodes[far][0] - nodes[s][0])
          && Math.sign(nodes[other][1] - nodes[s][1]) === Math.sign(nodes[far][1] - nodes[s][1])) {
          throw new Error('chart-cover: overlapping adjacent boundary edges');
        }
      }
    }
  }
  // (d2) exact degree 1 on the material side of every boundary loop (finding 1).
  const next = new Map<number, number>(boundaryEdges.map(([a, b]) => [a, b]));
  const incoming = new Set<number>();
  for (const [, b] of boundaryEdges) {
    if (incoming.has(b)) throw new Error('chart-cover: boundary vertex with two incoming edges (pinched cover)');
    incoming.add(b);
  }
  const loops: number[][] = [], seen = new Set<number>();
  for (const [start] of boundaryEdges) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    for (let at = start; !seen.has(at); ) {
      seen.add(at); loop.push(at);
      const to = next.get(at);
      if (to === undefined) throw new Error('chart-cover: open boundary chain');
      at = to;
      if (at !== start && seen.has(at)) throw new Error('chart-cover: boundary chain does not close');
    }
    loops.push(loop);
  }
  // Twice-area sign (exact) gives each simple loop's own winding on its left side: CCW -> 1, CW -> 0.
  const ownLeft = loops.map(loop => {
    let twiceArea = 0n;
    for (let i = 0; i < loop.length; i += 1) twiceArea += orient([0, 0], nodes[loop[i]], nodes[loop[(i + 1) % loop.length]]);
    if (twiceArea === 0n) throw new Error('chart-cover: zero-area boundary loop');
    return twiceArea > 0n ? 1 : 0;
  });
  /** Exact winding number of loop L around 2*point (all coordinates doubled so edge midpoints are exact). */
  const winding = (loop: readonly number[], twiceX: bigint, twiceY: bigint, scale: (v: number) => bigint): number => {
    let total = 0;
    for (let i = 0; i < loop.length; i += 1) {
      const p = nodes[loop[i]], q = nodes[loop[(i + 1) % loop.length]];
      const py = 2n * scale(p[1]), qy = 2n * scale(q[1]), px = 2n * scale(p[0]), qx = 2n * scale(q[0]);
      const side = (qx - px) * (twiceY - py) - (qy - py) * (twiceX - px);
      if (py <= twiceY) { if (qy > twiceY && side > 0n) total += 1; } else if (qy <= twiceY && side < 0n) total -= 1;
    }
    return total;
  };
  const allValues = nodes.flatMap(n => [n[0], n[1]]);
  const scaledAll = scaled(allValues);
  const index = new Map<number, bigint>();
  allValues.forEach((value, i) => index.set(value, scaledAll[i]));
  const scale = (v: number): bigint => { const s = index.get(v); if (s === undefined) throw new Error('chart-cover: unscaled value'); return s; };
  for (let l = 0; l < loops.length; l += 1) {
    checkpoint();
    const a = nodes[loops[l][0]], b = nodes[loops[l][1 % loops[l].length]];
    const twiceX = scale(a[0]) + scale(b[0]), twiceY = scale(a[1]) + scale(b[1]);
    let degree = ownLeft[l];
    for (let other = 0; other < loops.length; other += 1) if (other !== l) degree += winding(loops[other], twiceX, twiceY, scale);
    if (degree !== 1) throw new Error('chart-cover: degree ' + degree + ' on the material side of a boundary loop');
  }
  return { trimOccurrences: [...intervals.keys()], seamPairs: seams.size, poleEdges: poles, degreeOneCover: true, topologyCertified: false };
}
