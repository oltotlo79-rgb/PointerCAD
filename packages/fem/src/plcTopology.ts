/** Exact predicates on the supplied binary64 coordinates. These are not a CAD
 * tolerance or a curved-surface certificate: this module validates a planar PLC. */
export interface PlcShell {
  readonly role: 'outer' | 'cavity';
  readonly triangles: readonly number[];
}

type I3 = readonly [bigint, bigint, bigint];
type I2 = readonly [bigint, bigint];
interface Fraction { readonly n: bigint; readonly d: bigint }
type Triangle = readonly [number, number, number];

function requirePlc(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`tetra-mesh: ${reason}`);
}
const sub = (a: I3, b: I3): I3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: I3, b: I3): I3 => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: I3, b: I3): bigint => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sign = (n: bigint): number => n > 0n ? 1 : n < 0n ? -1 : 0;
const orient2 = (a: I2, b: I2, c: I2): bigint =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const between = (n: bigint, a: bigint, b: bigint): boolean => a <= b ? a <= n && n <= b : b <= n && n <= a;
const onSegment = (p: I2, a: I2, b: I2): boolean => orient2(a, b, p) === 0n
  && between(p[0], a[0], b[0]) && between(p[1], a[1], b[1]);
const fraction = (n: bigint, d = 1n): Fraction => d < 0n ? { n: -n, d: -d } : { n, d };
const compare = (a: Fraction, b: Fraction): number => sign(a.n * b.d - b.n * a.d);

/** Use one common power-of-two scale, without rounding, decimal conversion or
 * assuming a bounded exponent. Zero and subnormal values have exact handling. */
function exactPoints(coordinates: readonly number[]): readonly I3[] {
  const view = new DataView(new ArrayBuffer(8));
  const parts: { mantissa: bigint; exponent: number }[] = [];
  let minimumExponent = 0;
  for (const coordinate of coordinates) {
    requirePlc(Number.isFinite(coordinate), 'nonfinite exact coordinate');
    view.setFloat64(0, coordinate, false);
    const bits = view.getBigUint64(0, false);
    const exponentBits = Number((bits >> 52n) & 2047n);
    let mantissa = bits & ((1n << 52n) - 1n);
    const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    if (exponentBits !== 0) mantissa += 1n << 52n;
    if ((bits >> 63n) !== 0n) mantissa = -mantissa;
    if (mantissa !== 0n) minimumExponent = Math.min(minimumExponent, exponent);
    parts.push({ mantissa, exponent });
  }
  const integers = parts.map(({ mantissa, exponent }) => mantissa === 0n ? 0n
    : mantissa << BigInt(exponent - minimumExponent));
  return Array.from({ length: coordinates.length / 3 }, (_, i): I3 =>
    [integers[3 * i], integers[3 * i + 1], integers[3 * i + 2]]);
}

/** Reuse conversion across all native elements. The floating magnitude limit is
 * still checked by the decoder; this separate sign cannot be rounded positive. */
export function exactTetrahedronOrientation(coordinates: readonly number[]):
  (a: number, b: number, c: number, d: number) => number {
  const points = exactPoints(coordinates);
  return (a, b, c, d) => sign(dot(sub(points[b], points[a]),
    cross(sub(points[c], points[a]), sub(points[d], points[a]))));
}

function planeSection(points: readonly I3[], distances: readonly bigint[], axis: number): Fraction[] {
  const section: Fraction[] = [];
  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    if (distances[i] === 0n) section.push(fraction(points[i][axis]));
    if (sign(distances[i]) * sign(distances[j]) < 0) {
      section.push(fraction(points[i][axis] * distances[j] - points[j][axis] * distances[i],
        distances[j] - distances[i]));
    }
  }
  return section.sort(compare);
}

function coplanarContactAllowed(a: readonly I2[], b: readonly I2[], common: readonly I2[]): boolean {
  const allowed = (p: I2): boolean => common.length === 1
    ? p[0] === common[0][0] && p[1] === common[0][1]
    : common.length === 2 && onSegment(p, common[0], common[1]);
  const inside = (p: I2, t: readonly I2[]): boolean => {
    const signs = [orient2(t[0], t[1], p), orient2(t[1], t[2], p), orient2(t[2], t[0], p)];
    return signs.every(n => n >= 0n) || signs.every(n => n <= 0n);
  };
  // Containment and all segment contacts characterize the complete intersection
  // of two convex triangles, including collinear edge intervals.
  for (const p of a) if (inside(p, b) && !allowed(p)) return false;
  for (const p of b) if (inside(p, a) && !allowed(p)) return false;
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const p = a[i], q = a[(i + 1) % 3], r = b[j], s = b[(j + 1) % 3];
    const rSide = orient2(p, q, r), sSide = orient2(p, q, s);
    const pSide = orient2(r, s, p), qSide = orient2(r, s, q);
    if (sign(rSide) * sign(sSide) < 0 && sign(pSide) * sign(qSide) < 0) {
      // Proper crossings cannot be at an existing endpoint. When there is a
      // shared edge, a proper crossing on it is impossible for nondegenerate
      // triangle edges: each other edge meets it only at a shared endpoint.
      return false;
    }
    for (const endpoint of [p, q]) if (onSegment(endpoint, r, s) && !allowed(endpoint)) return false;
    for (const endpoint of [r, s]) if (onSegment(endpoint, p, q) && !allowed(endpoint)) return false;
  }
  return true;
}

function contactAllowed(points: readonly I3[], a: Triangle, b: Triangle): boolean {
  const pa = a.map(i => points[i]), pb = b.map(i => points[i]);
  const na = cross(sub(pa[1], pa[0]), sub(pa[2], pa[0]));
  const nb = cross(sub(pb[1], pb[0]), sub(pb[2], pb[0]));
  const da = pa.map(p => dot(nb, sub(p, pb[0])));
  const db = pb.map(p => dot(na, sub(p, pa[0])));
  const separated = (ds: readonly bigint[]): boolean => ds.every(d => d > 0n) || ds.every(d => d < 0n);
  if (separated(da) || separated(db)) return true;
  const common = a.filter(i => b.includes(i));
  const direction = cross(na, nb);
  const axis = direction.findIndex(n => n !== 0n);
  if (axis < 0) {
    if (db.some(n => n !== 0n)) return true;
    const drop = na.findIndex(n => n !== 0n);
    const axes = [0, 1, 2].filter(i => i !== drop);
    const project = (p: I3): I2 => [p[axes[0]], p[axes[1]]];
    return coplanarContactAllowed(pa.map(project), pb.map(project), common.map(i => project(points[i])));
  }
  const sa = planeSection(pa, da, axis), sb = planeSection(pb, db, axis);
  if (sa.length === 0 || sb.length === 0) return true;
  const lower = compare(sa[0], sb[0]) >= 0 ? sa[0] : sb[0];
  const upper = compare(sa[sa.length - 1], sb[sb.length - 1]) <= 0 ? sa[sa.length - 1] : sb[sb.length - 1];
  if (compare(lower, upper) > 0) return true;
  if (common.length === 0) return false;
  const expected = common.map(i => fraction(points[i][axis])).sort(compare);
  return compare(lower, expected[0]) >= 0 && compare(upper, expected[expected.length - 1]) <= 0;
}

function insideShell(origin: I3, shell: readonly number[], triangles: readonly Triangle[], points: readonly I3[]): boolean {
  // Directions (1,t,t^2) avoid every finite collection of bad face/edge planes.
  // Each plane excludes at most two t values. At most four planes per triangle
  // (face plus its three origin/edge planes) gives the explicit finite bound.
  // A boundary contact was already rejected by the complete intersection test.
  for (let attempt = 1; attempt <= 8 * shell.length + 1; attempt += 1) {
    const t = BigInt(attempt), direction: I3 = [1n, t, t * t];
    let hits = 0, ambiguous = false;
    for (const index of shell) {
      const [ia, ib, ic] = triangles[index], a = points[ia];
      const e1 = sub(points[ib], a), e2 = sub(points[ic], a), s = sub(origin, a);
      const h = cross(direction, e2), determinant = dot(e1, h);
      if (determinant === 0n) {
        if (dot(cross(e1, e2), s) === 0n) { ambiguous = true; break; }
        continue;
      }
      const factor = determinant > 0n ? 1n : -1n, denominator = determinant * factor;
      const q = cross(s, e1), u = dot(s, h) * factor;
      const v = dot(direction, q) * factor, distance = dot(e2, q) * factor;
      if (distance <= 0n || u < 0n || v < 0n || u + v > denominator) continue;
      if (u === 0n || v === 0n || u + v === denominator) { ambiguous = true; break; }
      hits += 1;
    }
    if (!ambiguous) return hits % 2 === 1;
  }
  throw new Error('tetra-mesh: shell containment direction unresolved');
}

/** Validate the supplied partition against geometry, not against metadata alone.
 * An embedded oriented closed 2-manifold with one outer and disjoint contained
 * cavity shells has winding degree exactly 1 in material and 0 elsewhere. */
export function validatePlcTopology(coordinates: readonly number[], indices: readonly number[], shells: readonly PlcShell[]): void {
  const points = exactPoints(coordinates);
  const triangles: Triangle[] = [];
  const directed = new Map<string, number>(), faces = new Set<string>();
  const vertexLinks = new Map<number, Map<number, Set<number>>>();
  const used = new Set<number>();
  for (let index = 0; index < indices.length; index += 3) {
    const triangle: Triangle = [indices[index], indices[index + 1], indices[index + 2]];
    const [a, b, c] = triangle;
    requirePlc(triangle.every(i => Number.isSafeInteger(i) && i >= 0 && i < points.length)
      && new Set(triangle).size === 3, 'invalid PLC triangle');
    const key = [...triangle].sort((u, v) => u - v).join(',');
    requirePlc(!faces.has(key), 'duplicate PLC triangle'); faces.add(key);
    requirePlc(cross(sub(points[b], points[a]), sub(points[c], points[a])).some(n => n !== 0n), 'exact degenerate triangle');
    for (let side = 0; side < 3; side += 1) {
      const u = triangle[side], v = triangle[(side + 1) % 3], w = triangle[(side + 2) % 3];
      used.add(u);
      const edge = `${u},${v}`;
      requirePlc(!directed.has(edge), 'nonmanifold or inconsistent PLC edge');
      directed.set(edge, triangles.length);
      const link = vertexLinks.get(u) ?? new Map<number, Set<number>>();
      const forward = link.get(v) ?? new Set<number>(), backward = link.get(w) ?? new Set<number>();
      forward.add(w); backward.add(v); link.set(v, forward); link.set(w, backward); vertexLinks.set(u, link);
    }
    triangles.push(triangle);
  }
  requirePlc(used.size === points.length, 'unused PLC point');
  const adjacency = triangles.map(() => new Set<number>());
  for (const [edge, index] of directed) {
    const [u, v] = edge.split(',');
    const reverse = directed.get(`${v},${u}`);
    requirePlc(reverse !== undefined, 'open PLC boundary'); adjacency[index].add(reverse);
  }
  for (const link of vertexLinks.values()) {
    for (const neighbors of link.values()) requirePlc(neighbors.size === 2, 'nonmanifold vertex link');
    const first = link.keys().next().value;
    requirePlc(first !== undefined, 'empty vertex link');
    const reached = new Set([first]), queue = [first];
    for (let i = 0; i < queue.length; i += 1) for (const next of link.get(queue[i]) ?? []) {
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
    requirePlc(reached.size === link.size, 'disconnected vertex link');
  }
  const components: number[][] = [], visited = new Set<number>();
  for (let first = 0; first < triangles.length; first += 1) {
    if (visited.has(first)) continue;
    const queue = [first]; visited.add(first);
    for (let i = 0; i < queue.length; i += 1) for (const next of adjacency[queue[i]]) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    components.push(queue.sort((a, b) => a - b));
  }
  requirePlc(shells.length === components.length && shells.filter(shell => shell.role === 'outer').length === 1,
    'single material domain requires one outer shell');
  for (let i = 0; i < components.length; i += 1) {
    requirePlc(shells[i].triangles.length === components[i].length
      && components[i].every((triangle, j) => triangle === shells[i].triangles[j]), 'shell membership differs from edge components');
    const anchor = points[triangles[components[i][0]][0]];
    let signedSixVolume = 0n;
    for (const triangle of components[i]) {
      const [a, b, c] = triangles[triangle];
      signedSixVolume += dot(sub(points[a], anchor), cross(sub(points[b], anchor), sub(points[c], anchor)));
    }
    requirePlc(shells[i].role === 'outer' ? signedSixVolume > 0n : signedSixVolume < 0n, 'shell orientation contradicts material role');
  }
  const boxes = triangles.map(triangle => [0, 1, 2].map(axis => {
    const values = triangle.map(i => coordinates[3 * i + axis]);
    return [Math.min(...values), Math.max(...values)] as const;
  }));
  for (let i = 0; i < triangles.length; i += 1) for (let j = i + 1; j < triangles.length; j += 1) {
    if (boxes[i].some((range, axis) => range[1] < boxes[j][axis][0] || boxes[j][axis][1] < range[0])) continue;
    requirePlc(contactAllowed(points, triangles[i], triangles[j]), 'PLC triangles intersect outside their shared simplex');
  }
  const outer = shells.findIndex(shell => shell.role === 'outer');
  for (let i = 0; i < shells.length; i += 1) for (let j = 0; j < shells.length; j += 1) {
    if (i === j) continue;
    const origin = points[triangles[components[i][0]][0]];
    requirePlc(insideShell(origin, components[j], triangles, points) === (j === outer),
      'shell nesting does not describe one material domain');
  }
}
