/** Numerical whole-triangle distance enclosure for finite positive-weight spline charts.
 * C0/periodic charts are partitioned into same-parameter native Bezier pieces before applying C1 bounds.
 * This is separate from OCCT's requested meshing deflection. The native mesh supplies the trimmed topology;
 * this module bounds distance to the underlying chart, not a zero-tolerance proof of a trimmed subset.
 */
import type { BRepAdaptor_Surface, Geom_BezierSurface, OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';
import type { Allocations } from './allocations.js';
import { borrowHandle } from './borrowHandle.js';

type V3 = readonly [number, number, number];
type V2 = readonly [number, number];
type H4 = readonly [number, number, number, number];
/** Read-only native methods only: the caller retains the owning surface handle. */
type BezierPatchReader = Pick<Geom_BezierSurface,
  'UDegree' | 'VDegree' | 'NbUPoles' | 'NbVPoles' | 'Pole' | 'Weight'>;
export interface FreeformDirection {
  readonly degree: number;
  /** Full clamped knot vector, including multiplicities. */
  readonly knots: readonly number[];
}
export interface FreeformCoefficients {
  readonly u: FreeformDirection;
  readonly v: FreeformDirection;
  /** U-major rows, then V. Positive rational weights; all-one weights give a polynomial. */
  readonly poles: readonly V3[];
  readonly weights: readonly number[];
}
export interface FreeformDerivativeBound {
  readonly uu: number;
  readonly uv: number;
  readonly vv: number;
  readonly u: readonly [number, number];
  readonly v: readonly [number, number];
}
interface Net {
  readonly u: FreeformDirection;
  readonly v: FreeformDirection;
  readonly rows: number;
  readonly columns: number;
  readonly values: readonly H4[];
}
const MAX_POLES = 4096;
const MAX_DEGREE = 25;
const finite = (x: number): number => {
  if (!Number.isFinite(x)) throw new Error('freeform-bound: nonfinite arithmetic');
  return x;
};
function direction(value: FreeformDirection): { readonly count: number; readonly normalized: FreeformDirection } {
  const p = value.degree, knots = value.knots;
  if (!Number.isSafeInteger(p) || p < 1 || p > MAX_DEGREE || knots.length > MAX_POLES + MAX_DEGREE + 1) {
    throw new Error('freeform-bound: degree or knot budget');
  }
  const count = knots.length - p - 1, a = knots[0], b = knots[knots.length - 1];
  if (count < p + 1 || count > MAX_POLES || !Number.isFinite(a) || !Number.isFinite(b) || !(b > a)) {
    throw new Error('freeform-bound: invalid chart domain');
  }
  let repeated = 0;
  for (let i = 0; i < knots.length; i += 1) {
    const knot = knots[i];
    if (!Number.isFinite(knot) || (i > 0 && knot < knots[i - 1])) throw new Error('freeform-bound: knot order');
    repeated = i > 0 && knot === knots[i - 1] ? repeated + 1 : 1;
    if (knot !== a && knot !== b && repeated > p - 1) throw new Error('freeform-bound: chart must be C1');
    if ((i <= p && knot !== a) || (i >= count && knot !== b)
      || (i === p + 1 && knot === a) || (i === count - 1 && knot === b)) {
      throw new Error('freeform-bound: clamped chart required');
    }
  }
  const width = finite(b - a);
  return { count, normalized: { degree: p, knots: knots.map(k => finite((k - a) / width)) } };
}
function derivative(net: Net, axis: 'u' | 'v', checkpoint: () => void): Net {
  const d = net[axis];
  if (d.degree === 0) return { ...net, values: net.values.map((): H4 => [0, 0, 0, 0]) };
  const rows = net.rows - (axis === 'u' ? 1 : 0), columns = net.columns - (axis === 'v' ? 1 : 0);
  const values: H4[] = [];
  for (let i = 0; i < rows; i += 1) for (let j = 0; j < columns; j += 1) {
    checkpoint();
    const k = axis === 'u' ? i : j, denominator = d.knots[k + d.degree + 1] - d.knots[k + 1];
    if (!(denominator > 0)) throw new Error('freeform-bound: collapsed derivative support');
    const a = net.values[i * net.columns + j];
    const b = net.values[(i + (axis === 'u' ? 1 : 0)) * net.columns + j + (axis === 'v' ? 1 : 0)];
    const factor = finite(d.degree / denominator);
    values.push([finite((b[0] - a[0]) * factor), finite((b[1] - a[1]) * factor),
      finite((b[2] - a[2]) * factor), finite((b[3] - a[3]) * factor)]);
  }
  return { ...net, [axis]: { degree: d.degree - 1, knots: d.knots.slice(1, -1) }, rows, columns, values };
}
function magnitudes(net: Net): readonly [number, number] {
  let xyz = 0, w = 0;
  for (const p of net.values) {
    xyz = Math.max(xyz, finite(Math.hypot(p[0], p[1], p[2])));
    w = Math.max(w, Math.abs(p[3]));
  }
  return [xyz, finite(w)];
}
/** Convex-hull derivative bounds; normalized UV avoids dependence on knot units. No derivative sampling. */
export function boundFreeformDerivatives(c: FreeformCoefficients, checkpoint: () => void): FreeformDerivativeBound {
  const u = direction(c.u), v = direction(c.v), count = u.count * v.count;
  if (count > MAX_POLES || c.poles.length !== count || c.weights.length !== count) throw new Error('freeform-bound: pole budget');
  let weightMaximum = 0, radius = 0;
  const origin = c.poles[0];
  for (let i = 0; i < count; i += 1) {
    checkpoint();
    const p = c.poles[i], weight = c.weights[i];
    if (p.length !== 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])
      || !Number.isFinite(weight) || !(weight > 0)) throw new Error('freeform-bound: invalid pole or weight');
    radius = Math.max(radius, finite(Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2])));
    weightMaximum = Math.max(weightMaximum, weight);
  }
  let minimum = 1;
  const values = c.poles.map((p, i): H4 => {
    const w = c.weights[i] / weightMaximum;
    if (!(w > 0)) throw new Error('freeform-bound: weight dynamic range');
    minimum = Math.min(minimum, w);
    return [finite((p[0] - origin[0]) * w), finite((p[1] - origin[1]) * w), finite((p[2] - origin[2]) * w), w];
  });
  const net: Net = { u: u.normalized, v: v.normalized, rows: u.count, columns: v.count, values };
  const du = derivative(net, 'u', checkpoint), dv = derivative(net, 'v', checkpoint);
  const [nu, wu] = magnitudes(du), [nv, wv] = magnitudes(dv);
  const [nuu, wuu] = magnitudes(derivative(du, 'u', checkpoint));
  const [nuv, wuv] = magnitudes(derivative(du, 'v', checkpoint));
  const [nvv, wvv] = magnitudes(derivative(dv, 'v', checkpoint));
  const su = finite((nu + radius * wu) / minimum), sv = finite((nv + radius * wv) / minimum);
  return { uu: finite((nuu + radius * wuu + 2 * su * wu) / minimum),
    uv: finite((nuv + radius * wuv + su * wv + sv * wu) / minimum),
    vv: finite((nvv + radius * wvv + 2 * sv * wv) / minimum),
    u: [c.u.knots[0], c.u.knots[c.u.knots.length - 1]], v: [c.v.knots[0], c.v.knots[c.v.knots.length - 1]] };
}
/** Barycentric Taylor remainder: Var(U)<=range(U)^2/4, likewise V and Cauchy-Schwarz covariance. */
export function freeformTriangleDistance(bound: FreeformDerivativeBound, uv: readonly [V2, V2, V2], nodeOffsetMm: number): number {
  if (!Number.isFinite(nodeOffsetMm) || nodeOffsetMm < 0) throw new Error('freeform-bound: node offset');
  const normalized = uv.map(p => p.map((value, axis) => {
    const interval = axis === 0 ? bound.u : bound.v;
    if (!Number.isFinite(value) || value < interval[0] || value > interval[1]) throw new Error('freeform-bound: UV outside chart');
    return finite((value - interval[0]) / (interval[1] - interval[0]));
  }));
  const du = Math.max(...normalized.map(p => p[0])) - Math.min(...normalized.map(p => p[0]));
  const dv = Math.max(...normalized.map(p => p[1])) - Math.min(...normalized.map(p => p[1]));
  return finite(nodeOffsetMm + (bound.uu * du * du + 2 * bound.uv * du * dv + bound.vv * dv * dv) / 8);
}
/** Tensor patch grid on ORIGINAL native parameters. Periodic copies use integer period shifts only. */
export interface FreeformPatchGrid {
  readonly u: readonly number[];
  readonly v: readonly number[];
  readonly uPeriodic: boolean;
  readonly vPeriodic: boolean;
  readonly patches: readonly FreeformDerivativeBound[];
  point(uv: V2): V3;
}

/** Remove redundant INTERIOR vertex stars only inside one proven affine native patch.
 * Every old outer edge and its endpoints survive, including CAD trim, seams and C0 boundaries.
 * This is one bounded, disjoint-star pass; it neither moves points nor changes the native surface.
 * An ineligible fan keeps its original triangles. The producer still applies its original limits. */
export function reduceAffineFreeformFans(grid: FreeformPatchGrid, triangles: readonly (readonly [number, number, number])[],
  parameters: readonly V2[], point: (node: number) => V3, protectedNodes: ReadonlySet<number>,
  maximumTriangles: number, linearDeflection: number, angularDeflection: number,
  checkpoint: () => void): readonly (readonly [number, number, number])[] {
  if (!Number.isSafeInteger(maximumTriangles) || maximumTriangles < 1
    || !Number.isFinite(linearDeflection) || !(linearDeflection > 0)
    || !Number.isFinite(angularDeflection) || !(angularDeflection > 0)) throw new Error('freeform-bound: fan budget');
  if (triangles.length > maximumTriangles) return triangles;
  const adjacent = new Map<number, number[]>();
  triangles.forEach((triangle, index) => {
    checkpoint();
    for (const node of triangle) {
      const list = adjacent.get(node);
      if (list === undefined) adjacent.set(node, [index]); else list.push(index);
    }
  });
  const removed = new Set<number>(), replacements: (readonly [number, number, number])[] = [];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const subtract = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  // Conservative floating-point filter; uncertainty means keep the old fan, not weld UVs.
  // The coordinate sums include subtraction roundoff as well as the two products and sum.
  const side = (a: V2, b: V2, c: V2): number => {
    const scale = (Math.abs(a[0]) + Math.abs(b[0]) + Math.abs(c[0]))
      * (Math.abs(a[1]) + Math.abs(b[1]) + Math.abs(c[1]));
    const determinant = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (!Number.isFinite(scale) || scale < Number.MIN_VALUE / Number.EPSILON
      || !Number.isFinite(determinant) || Math.abs(determinant) <= 16 * Number.EPSILON * scale) return 0;
    return Math.sign(determinant);
  };
  for (const [node, incident] of adjacent) {
    checkpoint();
    if (protectedNodes.has(node) || incident.length < 3 || incident.length > 12 || incident.some(t => removed.has(t))) continue;
    const centre = parameters[node];
    if (centre === undefined) throw new Error('freeform-bound: missing fan UV');
    const patch = grid.patches.find(p => p.uu === 0 && p.uv === 0 && p.vv === 0
      && centre[0] > p.u[0] && centre[0] < p.u[1] && centre[1] > p.v[0] && centre[1] < p.v[1]);
    if (patch === undefined) continue;
    const next = new Map<number, number>();
    let valid = true;
    for (const index of incident) {
      const triangle = triangles[index], corner = triangle.indexOf(node);
      const a = triangle[(corner + 1) % 3], b = triangle[(corner + 2) % 3];
      if (next.has(a) || a === b) { valid = false; break; }
      next.set(a, b);
    }
    if (!valid) continue;
    const first = next.keys().next().value;
    if (first === undefined) continue;
    const ring: number[] = [];
    let current = first;
    while (ring.length < incident.length && !ring.includes(current)) {
      ring.push(current);
      const following = next.get(current);
      if (following === undefined) break;
      current = following;
    }
    if (ring.length !== incident.length || current !== first) continue;
    const uv = ring.map(index => parameters[index]);
    if (uv.some(p => p === undefined || !p.every(Number.isFinite)
      || p[0] < patch.u[0] || p[0] > patch.u[1] || p[1] < patch.v[0] || p[1] > patch.v[1])) continue;
    const sign = side(uv[0], uv[1], centre);
    if (sign === 0) continue;
    // Global convexity, not merely consecutive turns: a self-crossing star must not pass.
    for (let i = 0; i < ring.length && valid; i += 1) {
      const a = uv[i], b = uv[(i + 1) % ring.length];
      if (side(a, b, centre) !== sign) { valid = false; break; }
      for (let j = 0; j < ring.length; j += 1) {
        if (j !== i && j !== (i + 1) % ring.length && side(a, b, uv[j]) !== sign) { valid = false; break; }
      }
    }
    if (!valid) continue;
    const actual = uv.map(p => grid.point(p)), points = ring.map(point), centrePoint = point(node);
    const offset = Math.max(Math.hypot(...subtract(centrePoint, grid.point(centre))),
      ...points.map((p, i) => Math.hypot(...subtract(p, actual[i]))));
    if (!Number.isFinite(offset) || offset > linearDeflection) continue;
    const reference = cross(subtract(actual[1], actual[0]), subtract(actual[2], actual[0]));
    const referenceLength = Math.hypot(...reference);
    if (!(referenceLength > 0) || !Number.isFinite(referenceLength)) continue;
    const referenceUnit: V3 = [reference[0] / referenceLength, reference[1] / referenceLength, reference[2] / referenceLength];
    // Preserve embedding even when shared-edge welding gives points small native offsets.
    // A strictly convex projected ring with the old centre inside has no overlapping fan triangles.
    const drop = Math.abs(reference[0]) >= Math.abs(reference[1]) && Math.abs(reference[0]) >= Math.abs(reference[2])
      ? 0 : Math.abs(reference[1]) >= Math.abs(reference[2]) ? 1 : 2;
    const project = (p: V3): V2 => drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]];
    const projected = points.map(project), projectedCentre = project(centrePoint);
    const projectedSign = side(projected[0], projected[1], projectedCentre);
    if (projectedSign === 0) continue;
    for (let i = 0; i < ring.length && valid; i += 1) {
      const a = projected[i], b = projected[(i + 1) % ring.length];
      if (side(a, b, projectedCentre) !== projectedSign) { valid = false; break; }
      for (let j = 0; j < ring.length; j += 1) {
        if (j !== i && j !== (i + 1) % ring.length && side(a, b, projected[j]) !== projectedSign) { valid = false; break; }
      }
    }
    if (!valid) continue;
    const replacement: (readonly [number, number, number])[] = [];
    for (let i = 1; i + 1 < ring.length; i += 1) {
      const normal = cross(subtract(points[i], points[0]), subtract(points[i + 1], points[0]));
      const normalLength = Math.hypot(...normal);
      if (!(normalLength > 0) || !Number.isFinite(normalLength)) { valid = false; break; }
      const normalUnit: V3 = [normal[0] / normalLength, normal[1] / normalLength, normal[2] / normalLength];
      const dot = normalUnit[0] * referenceUnit[0] + normalUnit[1] * referenceUnit[1] + normalUnit[2] * referenceUnit[2];
      const sine = Math.hypot(...cross(normalUnit, referenceUnit));
      const angle = Math.atan2(sine, dot);
      if (!Number.isFinite(dot) || !Number.isFinite(sine) || !Number.isFinite(angle) || angle > angularDeflection) {
        valid = false; break;
      }
      replacement.push([ring[0], ring[i], ring[i + 1]]);
    }
    if (!valid) continue;
    incident.forEach(index => removed.add(index));
    replacements.push(...replacement);
  }
  return removed.size === 0 ? triangles : [...triangles.filter((_, index) => !removed.has(index)), ...replacements];
}
interface ClipVertex { readonly uv: V2; readonly barycentric: V3 }
function clipAt(polygon: readonly ClipVertex[], axis: 0 | 1, cut: number, lower: boolean): ClipVertex[] {
  const result: ClipVertex[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const insideA = lower ? a.uv[axis] >= cut : a.uv[axis] <= cut;
    const insideB = lower ? b.uv[axis] >= cut : b.uv[axis] <= cut;
    if (insideA) result.push(a);
    if (insideA !== insideB) {
      const t = finite((cut - a.uv[axis]) / (b.uv[axis] - a.uv[axis]));
      if (t < 0 || t > 1) throw new Error('freeform-bound: invalid clip fraction');
      const lerp = (x: number, y: number): number => finite((1 - t) * x + t * y);
      result.push({ uv: axis === 0 ? [cut, lerp(a.uv[1], b.uv[1])] : [lerp(a.uv[0], b.uv[0]), cut],
        barycentric: [lerp(a.barycentric[0], b.barycentric[0]), lerp(a.barycentric[1], b.barycentric[1]),
          lerp(a.barycentric[2], b.barycentric[2])] });
    }
  }
  return result;
}
/** Partition only the bound, never the PLC. Interior split points retain their offset from the ORIGINAL 3D chord. */
export function partitionedFreeformTriangleDistance(grid: FreeformPatchGrid, uv: readonly [V2, V2, V2],
  points: readonly [V3, V3, V3], checkpoint: () => void): { readonly maxNodeOffsetMm: number; readonly maxChordDeviationMm: number } {
  const axes = [grid.u, grid.v] as const;
  const periodic = [grid.uPeriodic, grid.vPeriodic] as const;
  const ranges: { first: number; last: number; period: number }[] = [];
  for (const axis of [0, 1] as const) {
    const knots = axes[axis];
    if (knots.length < 2 || knots.length > MAX_POLES) throw new Error('freeform-bound: patch grid budget');
    for (let i = 0; i < knots.length; i += 1) {
      if (!Number.isFinite(knots[i]) || (i > 0 && !(knots[i] > knots[i - 1]))) throw new Error('freeform-bound: patch grid order');
    }
    for (const p of uv) if (!Number.isFinite(p[axis])) throw new Error('freeform-bound: nonfinite UV');
    const low = Math.min(...uv.map(p => p[axis])), high = Math.max(...uv.map(p => p[axis]));
    const a = knots[0], b = knots[knots.length - 1], period = finite(b - a);
    if (!periodic[axis] && (low < a || high > b)) throw new Error('freeform-bound: UV outside chart');
    const first = periodic[axis] ? Math.floor(finite((low - a) / period)) : 0;
    const last = periodic[axis] ? Math.floor(finite((high - a) / period)) : 0;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first + 1 > MAX_POLES) {
      throw new Error('freeform-bound: periodic copy budget');
    }
    ranges.push({ first, last, period });
  }
  const rows = grid.u.length - 1, columns = grid.v.length - 1;
  const cells = rows * columns * (ranges[0].last - ranges[0].first + 1) * (ranges[1].last - ranges[1].first + 1);
  if (!Number.isSafeInteger(cells) || cells > MAX_POLES || grid.patches.length !== rows * columns) {
    throw new Error('freeform-bound: partition budget');
  }
  for (const p of points) if (p.length !== 3 || p.some(x => !Number.isFinite(x))) throw new Error('freeform-bound: invalid chord point');
  const offsetAt = (p: ClipVertex): number => {
    checkpoint();
    const actual = grid.point(p.uv);
    const chord = [0, 1, 2].map(axis => finite(p.barycentric[0] * points[0][axis]
      + p.barycentric[1] * points[1][axis] + p.barycentric[2] * points[2][axis]));
    return finite(Math.hypot(chord[0] - actual[0], chord[1] - actual[1], chord[2] - actual[2]));
  };
  const original: readonly ClipVertex[] = uv.map((p, i) => ({ uv: p,
    barycentric: i === 0 ? [1, 0, 0] : i === 1 ? [0, 1, 0] : [0, 0, 1] }));
  const maxNodeOffsetMm = Math.max(...original.map(offsetAt));
  let bound = maxNodeOffsetMm, coverage = 0, pieces = 0;
  for (let su = ranges[0].first; su <= ranges[0].last; su += 1) for (let sv = ranges[1].first; sv <= ranges[1].last; sv += 1) {
    const shiftU = finite(su * ranges[0].period), shiftV = finite(sv * ranges[1].period);
    for (let i = 0; i < rows; i += 1) for (let j = 0; j < columns; j += 1) {
      checkpoint();
      const u: [number, number] = [finite(grid.u[i] + shiftU), finite(grid.u[i + 1] + shiftU)];
      const v: [number, number] = [finite(grid.v[j] + shiftV), finite(grid.v[j + 1] + shiftV)];
      // A rank-deficient UV image lying on a knot belongs to one adjacent cell, not twice.
      if (uv.every(p => p[0] === u[1]) && (i + 1 < rows || su < ranges[0].last)) continue;
      if (uv.every(p => p[1] === v[1]) && (j + 1 < columns || sv < ranges[1].last)) continue;
      let polygon = clipAt(original, 0, u[0], true);
      polygon = clipAt(polygon, 0, u[1], false);
      polygon = clipAt(polygon, 1, v[0], true);
      polygon = clipAt(polygon, 1, v[1], false);
      if (polygon.length < 3) continue;
      const patch = grid.patches[i * columns + j];
      if (patch.u[0] !== grid.u[i] || patch.u[1] !== grid.u[i + 1]
        || patch.v[0] !== grid.v[j] || patch.v[1] !== grid.v[j + 1]) throw new Error('freeform-bound: patch parameter mismatch');
      for (let k = 1; k + 1 < polygon.length; k += 1) {
        const a = polygon[0], b = polygon[k], c = polygon[k + 1];
        const area = finite((b.barycentric[1] - a.barycentric[1]) * (c.barycentric[2] - a.barycentric[2])
          - (b.barycentric[2] - a.barycentric[2]) * (c.barycentric[1] - a.barycentric[1]));
        if (area === 0) continue;
        if (area < 0) throw new Error('freeform-bound: partition orientation');
        pieces += 1;
        if (pieces > MAX_POLES) throw new Error('freeform-bound: partition triangle budget');
        coverage = finite(coverage + area);
        bound = Math.max(bound, freeformTriangleDistance({ ...patch, u, v }, [a.uv, b.uv, c.uv],
          Math.max(offsetAt(a), offsetAt(b), offsetAt(c))));
      }
    }
  }
  // Arithmetic coverage check in the original barycentric triangle, even for a collinear UV image.
  if (pieces === 0 || Math.abs(coverage - 1) > 64 * Number.EPSILON * pieces) throw new Error('freeform-bound: incomplete partition');
  return { maxNodeOffsetMm, maxChordDeviationMm: bound };
}
export interface NativeFreeformBound {
  readonly kind: 'bspline' | 'bezier' | 'extrusion';
  readonly derivatives: FreeformDerivativeBound;
  readonly grid?: FreeformPatchGrid;
  point(uv: V2): V3;
}
export interface FreeformFaceDistance {
  readonly faceIndex: number;
  readonly surfaceKind: 'bspline' | 'bezier' | 'extrusion';
  readonly triangles: readonly {
    readonly triangleIndex: number;
    readonly maxNodeOffsetMm: number;
    readonly maxChordDeviationMm: number;
  }[];
}
/** Exact tensor representation of the LOCAL S(U,V)=C(U)+V*D, then the face location once.
 * BRepAdaptor.BasisCurve() transforms its geometry and may change its parameterization under scale;
 * using Surface().BasisCurve() keeps the actual triangulation's U and V instead.
 */
function extrusionCoefficients(oc: OpenCascadeInstance, adaptor: BRepAdaptor_Surface,
  owned: Allocations, checkpoint: () => void): FreeformCoefficients {
  const local = owned.keep(adaptor.Surface()), transform = owned.keep(adaptor.Trsf());
  const handle = owned.keep(local.BasisCurve());
  if (handle.IsNull()) throw new Error('freeform-bound: missing extrusion basis');
  const basis = borrowHandle(handle), type = basis.GetType();
  const spline = type === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve;
  if ((!spline && type !== oc.GeomAbs_CurveType.GeomAbs_BezierCurve) || basis.IsPeriodic()) {
    throw new Error('freeform-bound: unsupported extrusion basis');
  }
  const splineHandle = spline ? owned.keep(basis.BSpline()) : undefined;
  const bezierHandle = spline ? undefined : owned.keep(basis.Bezier());
  if (splineHandle?.IsNull() || bezierHandle?.IsNull()) throw new Error('freeform-bound: missing extrusion curve');
  const curve = splineHandle !== undefined ? borrowHandle(splineHandle)
    : bezierHandle !== undefined ? borrowHandle(bezierHandle) : undefined;
  if (curve === undefined) throw new Error('freeform-bound: missing extrusion curve handle');
  const count = Number(curve.NbPoles()), degree = Number(curve.Degree());
  if (!Number.isSafeInteger(count) || count < 2 || 2 * count > MAX_POLES
    || !Number.isSafeInteger(degree) || degree < 1 || degree > MAX_DEGREE) {
    throw new Error('freeform-bound: extrusion pole or degree budget');
  }
  let knots: number[];
  if (splineHandle !== undefined) {
    const specific = borrowHandle(splineHandle), n = Number(specific.NbKnots());
    if (!Number.isSafeInteger(n) || n < 2 || n > MAX_POLES) throw new Error('freeform-bound: native knot budget');
    knots = [];
    for (let i = 1; i <= n; i += 1) {
      checkpoint();
      const m = Number(specific.Multiplicity(i));
      if (!Number.isSafeInteger(m) || m < 1 || m > MAX_DEGREE + 1 || knots.length + m > MAX_POLES + MAX_DEGREE + 1) {
        throw new Error('freeform-bound: native multiplicity budget');
      }
      for (let j = 0; j < m; j += 1) knots.push(specific.Knot(i));
    }
  } else knots = [...new Array<number>(degree + 1).fill(0), ...new Array<number>(degree + 1).fill(1)];
  const first = Number(adaptor.FirstVParameter()), last = Number(adaptor.LastVParameter());
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(last > first)) throw new Error('freeform-bound: extrusion V interval');
  const direction = owned.keep(local.Direction()), poles: V3[] = [], weights: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    const base = curve.Pole(i);
    try {
      for (const v of [first, last]) {
        checkpoint();
        const point = new oc.gp_Pnt_3(finite(base.X() + v * direction.X()),
          finite(base.Y() + v * direction.Y()), finite(base.Z() + v * direction.Z()));
        try {
          point.Transform(transform);
          poles.push([finite(point.X()), finite(point.Y()), finite(point.Z())]);
        } finally { point.delete(); }
        weights.push(curve.Weight(i));
      }
    } finally { base.delete(); }
  }
  return { u: { degree, knots }, v: { degree: 1, knots: [first, first, last, last] }, poles, weights };
}
/** Reads the same meshed face. BRepAdaptor's spline/Bezier accessors apply its location exactly once. */
export function readNativeFreeformBound(oc: OpenCascadeInstance, face: TopoDS_Face,
  owned: Allocations, checkpoint: () => void): NativeFreeformBound | null {
  const adaptor = owned.keep(new oc.BRepAdaptor_Surface_2(face, true)), kind = adaptor.GetType();
  const spline = kind === oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface;
  const extrusion = kind === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion;
  if (!spline && !extrusion && kind !== oc.GeomAbs_SurfaceType.GeomAbs_BezierSurface) return null;
  const nativePoint = (uv: V2): V3 => {
    checkpoint();
    if (!Number.isFinite(uv[0]) || !Number.isFinite(uv[1])) throw new Error('freeform-bound: nonfinite UV');
    const point = adaptor.Value(uv[0], uv[1]);
    try { return [finite(point.X()), finite(point.Y()), finite(point.Z())]; } finally { point.delete(); }
  };
  const finish = (surfaceKind: NativeFreeformBound['kind'], coefficients: FreeformCoefficients): NativeFreeformBound => {
    const derivatives = boundFreeformDerivatives(coefficients, checkpoint);
    return { kind: surfaceKind, derivatives, point: uv => {
      checkpoint();
      if (!Number.isFinite(uv[0]) || !Number.isFinite(uv[1])
        || uv[0] < derivatives.u[0] || uv[0] > derivatives.u[1]
        || uv[1] < derivatives.v[0] || uv[1] > derivatives.v[1]) throw new Error('freeform-bound: UV outside chart');
      return nativePoint(uv);
    } };
  };
  const c1Knots = (n: number, degree: number, value: (i: number) => number,
    multiplicity: (i: number) => number): number[] | null => {
    if (!Number.isSafeInteger(n) || n < 2 || n > MAX_POLES
      || !Number.isSafeInteger(degree) || degree < 1 || degree > MAX_DEGREE) throw new Error('freeform-bound: native knot budget');
    const result: number[] = [];
    let c1 = true;
    for (let i = 1; i <= n; i += 1) {
      checkpoint();
      const m = Number(multiplicity(i));
      if (!Number.isSafeInteger(m) || m < 1 || m > degree + 1 || result.length + m > MAX_POLES + MAX_DEGREE + 1) {
        throw new Error('freeform-bound: native multiplicity budget');
      }
      if (i > 1 && i < n && m > degree - 1) c1 = false;
      for (let j = 0; j < m; j += 1) result.push(value(i));
    }
    return c1 ? result : null;
  };
  const finishGrid = (surfaceKind: NativeFreeformBound['kind'], u: number[], v: number[],
    coefficients: FreeformCoefficients[]): NativeFreeformBound => {
    const uPeriodic = adaptor.IsUPeriodic(), vPeriodic = adaptor.IsVPeriodic();
    if ((uPeriodic && u[u.length - 1] - u[0] !== adaptor.UPeriod())
      || (vPeriodic && v[v.length - 1] - v[0] !== adaptor.VPeriod())) throw new Error('freeform-bound: native period mismatch');
    const patches = coefficients.map(c => boundFreeformDerivatives(c, checkpoint));
    const grid: FreeformPatchGrid = { u, v, uPeriodic, vPeriodic, patches, point: nativePoint };
    return { kind: surfaceKind, derivatives: patches[0], grid, point: nativePoint };
  };
  const checkedExpansion = (rows: number, columns: number, up: number, vp: number): void => {
    const count = rows * columns * (up + 1) * (vp + 1);
    if (![rows, columns, up, vp].every(Number.isSafeInteger) || rows < 1 || columns < 1
      || up < 1 || vp < 1 || up > MAX_DEGREE || vp > MAX_DEGREE || count > MAX_POLES) {
      throw new Error('freeform-bound: expanded patch pole budget');
    }
  };
  const clamped = (degree: number, a: number, b: number): FreeformDirection => ({ degree,
    knots: [...new Array<number>(degree + 1).fill(a), ...new Array<number>(degree + 1).fill(b)] });
  const patchCoefficients = (patch: BezierPatchReader, u: readonly [number, number],
    v: readonly [number, number]): FreeformCoefficients => {
    const up = Number(patch.UDegree()), vp = Number(patch.VDegree());
    checkedExpansion(1, 1, up, vp);
    const poles: V3[] = [], weights: number[] = [];
    for (let i = 1; i <= patch.NbUPoles(); i += 1) for (let j = 1; j <= patch.NbVPoles(); j += 1) {
      checkpoint();
      const p = patch.Pole(i, j);
      try { poles.push([p.X(), p.Y(), p.Z()]); } finally { p.delete(); }
      weights.push(patch.Weight(i, j));
    }
    return { u: clamped(up, u[0], u[1]), v: clamped(vp, v[0], v[1]), poles, weights };
  };
  if (spline) {
    const handle = owned.keep(adaptor.BSpline());
    if (handle.IsNull()) throw new Error('freeform-bound: missing native surface');
    const specific = borrowHandle(handle);
    // Native integer accessors use the absent Graphic3d_ZLayerId alias in the installed declarations.
    // Normalize at this boundary; c1Knots/checkedExpansion retain integer and allocation caps.
    // Preserve the already supported C1 route and its ORIGINAL pole budget. Expanding every smooth
    // chart would unnecessarily reject a previously admitted net or multiply its native allocation.
    if (!adaptor.IsUPeriodic() && !adaptor.IsVPeriodic()) {
      const uk = c1Knots(Number(specific.NbUKnots()), Number(specific.UDegree()), i => specific.UKnot(i), i => Number(specific.UMultiplicity(i)));
      const vk = c1Knots(Number(specific.NbVKnots()), Number(specific.VDegree()), i => specific.VKnot(i), i => Number(specific.VMultiplicity(i)));
      if (uk !== null && vk !== null) {
        const rows = Number(specific.NbUPoles()), columns = Number(specific.NbVPoles());
        if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 2 || columns < 2 || rows * columns > MAX_POLES) {
          throw new Error('freeform-bound: native pole budget');
        }
        const poles: V3[] = [], weights: number[] = [];
        for (let i = 1; i <= rows; i += 1) for (let j = 1; j <= columns; j += 1) {
          checkpoint();
          const p = specific.Pole(i, j);
          try { poles.push([p.X(), p.Y(), p.Z()]); } finally { p.delete(); }
          weights.push(specific.Weight(i, j));
        }
        return finish('bspline', { u: { degree: Number(specific.UDegree()), knots: uk },
          v: { degree: Number(specific.VDegree()), knots: vk }, poles, weights });
      }
    }
    // The converter copies and inserts knots; bound its expanded net BEFORE native allocation.
    checkedExpansion(Number(specific.NbUKnots()) - 1, Number(specific.NbVKnots()) - 1, Number(specific.UDegree()), Number(specific.VDegree()));
    checkpoint();
    const split = owned.keep(new oc.GeomConvert_BSplineSurfaceToBezierSurface_1(handle));
    const rows = Number(split.NbUPatches()), columns = Number(split.NbVPatches());
    checkedExpansion(rows, columns, Number(specific.UDegree()), Number(specific.VDegree()));
    const uk = owned.keep(new oc.TColStd_Array1OfReal_2(1, rows + 1));
    const vk = owned.keep(new oc.TColStd_Array1OfReal_2(1, columns + 1));
    split.UKnots(uk); split.VKnots(vk);
    const u = Array.from({ length: rows + 1 }, (_, i) => Number(uk.Value(i + 1)));
    const v = Array.from({ length: columns + 1 }, (_, i) => Number(vk.Value(i + 1)));
    const coefficients: FreeformCoefficients[] = [];
    for (let i = 1; i <= rows; i += 1) for (let j = 1; j <= columns; j += 1) {
      checkpoint();
      const patch = split.Patch(i, j);
      try {
        if (patch.IsNull()) throw new Error('freeform-bound: missing Bezier patch');
        coefficients.push(patchCoefficients(borrowHandle(patch), [u[i - 1], u[i]], [v[j - 1], v[j]]));
      } finally { patch.delete(); }
    }
    return finishGrid('bspline', u, v, coefficients);
  }
  if (extrusion) {
    const local = owned.keep(adaptor.Surface()), handle = owned.keep(local.BasisCurve());
    if (handle.IsNull()) throw new Error('freeform-bound: missing extrusion basis');
    const basis = borrowHandle(handle);
    if (basis.GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) {
      const splineHandle = owned.keep(basis.BSpline());
      if (splineHandle.IsNull()) throw new Error('freeform-bound: missing extrusion curve');
      const curve = borrowHandle(splineHandle);
      if (!basis.IsPeriodic() && c1Knots(Number(curve.NbKnots()), Number(curve.Degree()), i => curve.Knot(i), i => Number(curve.Multiplicity(i))) !== null) {
        return finish('extrusion', extrusionCoefficients(oc, adaptor, owned, checkpoint));
      }
      checkedExpansion(Number(curve.NbKnots()) - 1, 1, Number(curve.Degree()), 1);
      checkpoint();
      const split = owned.keep(new oc.GeomConvert_BSplineCurveToBezierCurve_1(splineHandle));
      const count = Number(split.NbArcs());
      checkedExpansion(count, 1, Number(curve.Degree()), 1);
      const uk = owned.keep(new oc.TColStd_Array1OfReal_2(1, count + 1));
      split.Knots(uk);
      const u = Array.from({ length: count + 1 }, (_, i) => Number(uk.Value(i + 1)));
      const v = [Number(adaptor.FirstVParameter()), Number(adaptor.LastVParameter())];
      const direction = owned.keep(local.Direction()), transform = owned.keep(adaptor.Trsf());
      const coefficients: FreeformCoefficients[] = [];
      for (let k = 1; k <= count; k += 1) {
        checkpoint();
        const handle = split.Arc(k);
        try {
          if (handle.IsNull()) throw new Error('freeform-bound: missing extrusion Bezier arc');
          const arc = borrowHandle(handle), poles: V3[] = [], weights: number[] = [];
          for (let i = 1; i <= arc.NbPoles(); i += 1) {
            const base = arc.Pole(i);
            try {
              for (const end of v) {
                checkpoint();
                const p = new oc.gp_Pnt_3(finite(base.X() + end * direction.X()),
                  finite(base.Y() + end * direction.Y()), finite(base.Z() + end * direction.Z()));
                try { p.Transform(transform); poles.push([finite(p.X()), finite(p.Y()), finite(p.Z())]); }
                finally { p.delete(); }
                weights.push(arc.Weight(i));
              }
            } finally { base.delete(); }
          }
          coefficients.push({ u: clamped(Number(arc.Degree()), u[k - 1], u[k]), v: clamped(1, v[0], v[1]), poles, weights });
        } finally { handle.delete(); }
      }
      return finishGrid('extrusion', u, v, coefficients);
    }
  }
  if (extrusion) return finish('extrusion', extrusionCoefficients(oc, adaptor, owned, checkpoint));
  const bezierHandle = owned.keep(adaptor.Bezier());
  if (bezierHandle.IsNull()) throw new Error('freeform-bound: missing native surface');
  return finish('bezier', patchCoefficients(borrowHandle(bezierHandle), [0, 1], [0, 1]));
}
