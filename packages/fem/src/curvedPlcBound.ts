/**
 * Versioned curved PLC route evidence (AUTHOR-ONLY, UNEXECUTED; GO-21 successor of curvedPlcBound.ts 9d417253, which is
 * kept as the failed original). Product path packages/fem/src/curvedPlcBound.ts.
 *
 * Astra's counterexamples against 9d417253: (1) adding the node tolerance to the ideal-sphere circumradius formula
 * underestimates the deviation of a triangle whose vertices sit inside the tolerance band; (2) sum(area x chord bound)
 * is not a volume error bound (inscribed regular tetrahedron). This successor therefore:
 *  - bounds each triangle's distance to the analytic surface from its ACTUAL double coordinates only:
 *      sphere   (center c, radius r): every point p of the flat triangle has min_T |p - c| <= |p - c| <= max_vertex |v - c|
 *               (convexity of the norm), so deviation <= max(max_vertex |v - c| - r, r - min_T |p - c|), where min_T is
 *               the exact point-to-triangle distance;
 *      cylinder (axis point o, unit axis a, radius r): the same with the distance to the axis line, i.e. the 2D
 *               distance in the plane normal to a (a linear projection), so min_T is the distance from the projected
 *               axis point to the projected triangle (0 if it is inside);
 *    no ideal-surface formula and no constant inflation; the node tolerance is only an admission filter;
 *  - reports sum(area x bound) as volumeDeviationEstimateMm3 with estimateIsBound literal false. It must not be used as
 *    an acceptance ceiling for CAD-volume accuracy.
 * Numerical assumptions (declared, not proven): the kernel's analytic parameters (axisOrigin/axis/radius) describe the
 * face's surface; double rounding of these few operations is far below any practical tolerance but is not enclosed by
 * interval arithmetic. exactProof and globalCertified are literal false.
 */
export const CURVED_PLC_BOUND_SCHEMA = 'pointercad-curved-plc-bound/2';

type V3 = readonly [number, number, number];
type V2 = readonly [number, number];
export type CurvedSurface =
  | { readonly kind: 'plane' }
  | { readonly kind: 'cylinder'; readonly origin: V3; readonly axis: V3; readonly radius: number }
  | { readonly kind: 'sphere'; readonly center: V3; readonly radius: number }
  | { readonly kind: 'cone'; readonly origin: V3; readonly axis: V3; readonly referenceRadius: number; readonly semiAngle: number }
  | { readonly kind: 'torus'; readonly origin: V3; readonly axis: V3; readonly majorRadius: number; readonly minorRadius: number };

/** Same-copy native spline evaluation, bound to exact current global triangle addresses. */
export interface FreeformPlcSurface {
  readonly kind: 'freeform';
  readonly surfaceKind: 'bspline' | 'bezier' | 'extrusion';
  readonly triangles: readonly { readonly triangleIndex: number; readonly maxNodeOffsetMm: number;
    readonly maxChordDeviationMm: number }[];
}

export interface CurvedFaceBound {
  readonly tag: number;
  readonly kind: Exclude<CurvedSurface['kind'], 'plane'> | 'freeform';
  readonly triangles: number;
  readonly maxNodeSurfaceOffsetMm: number;
  /** Conservative (up to double rounding) maximum distance from any point of this face's triangles to the surface. */
  readonly maxChordDeviationBoundMm: number;
  readonly volumeDeviationEstimateMm3: number;
}
export interface CurvedPlcBound {
  readonly schema: typeof CURVED_PLC_BOUND_SCHEMA;
  readonly nodeToleranceMm: number;
  readonly faces: readonly CurvedFaceBound[];
  readonly maxChordDeviationBoundMm: number;
  /** First-order estimate sum(area x bound); NOT a volume error bound. */
  readonly volumeDeviationEstimateMm3: number;
  readonly estimateIsBound: false;
  readonly exactProof: false;
  readonly globalCertified: false;
}

export type CurvedPlcRefusalCode = 'unsupported-surface' | 'off-surface-node' | 'invalid-surface' | 'invalid-input';
export class CurvedPlcRefusal extends Error {
  override readonly name = 'CurvedPlcRefusal';
  constructor(readonly code: CurvedPlcRefusalCode, message: string) { super(message); }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const finite3 = (a: V3): boolean => a.length === 3 && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/** Exact closest point of triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5), returned as a distance. */
export function pointTriangleDistance(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return norm(ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return norm(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return norm(sub(p, add(a, scale(ab, d1 / (d1 - d3)))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return norm(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return norm(sub(p, add(a, scale(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return norm(sub(p, add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))))));
  }
  const denominator = 1 / (va + vb + vc);
  return norm(sub(p, add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)))));
}

function segmentDistance2(p: V2, a: V2, b: V2): number {
  const ab: V2 = [b[0] - a[0], b[1] - a[1]], ap: V2 = [p[0] - a[0], p[1] - a[1]];
  const length2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = length2 > 0 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1]) / length2)) : 0;
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1]);
}

/** Distance from the origin to the (possibly degenerate) 2D triangle abc; 0 when the origin is inside or on it. */
export function originTriangleDistance2(a: V2, b: V2, c: V2): number {
  const side = (u: V2, v: V2): number => u[0] * v[1] - u[1] * v[0];
  const s1 = side(a, b), s2 = side(b, c), s3 = side(c, a);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (inside && area !== 0) return 0;
  return Math.min(segmentDistance2([0, 0], a, b), segmentDistance2([0, 0], b, c), segmentDistance2([0, 0], c, a));
}

function unit(axis: V3): V3 {
  const length = norm(axis);
  if (!Number.isFinite(length) || !(length > 0)) throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: zero or nonfinite axis');
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/** Orthonormal frame (u, v) of the plane normal to the unit axis. */
function frame(axis: V3): readonly [V3, V3] {
  const helper: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(axis, helper));
  return [u, cross(axis, u)];
}

function validateSurface(surface: Exclude<CurvedSurface, { kind: 'plane' }>): void {
  const origin = surface.kind === 'sphere' ? surface.center : surface.origin;
  if (!finite3(origin)) throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: nonfinite analytic origin');
  if (surface.kind !== 'sphere') unit(surface.axis);
  if (surface.kind === 'cone') {
    if (!Number.isFinite(surface.referenceRadius) || surface.referenceRadius < 0
      || !Number.isFinite(surface.semiAngle) || !(Math.abs(surface.semiAngle) > 0)
      || !(Math.abs(surface.semiAngle) < Math.PI / 2)) {
      throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: invalid cone radius or semi-angle');
    }
  } else if (surface.kind === 'torus') {
    // Only embedded ring tori: horn/spindle singularities are not admitted as ordinary surface patches.
    if (!Number.isFinite(surface.majorRadius) || !Number.isFinite(surface.minorRadius)
      || !(surface.minorRadius > 0) || !(surface.majorRadius > surface.minorRadius)) {
      throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: an embedded ring torus is required');
    }
  } else if (!Number.isFinite(surface.radius) || !(surface.radius > 0)) {
    throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: invalid analytic radius');
  }
}

/** All-triangle numerical enclosure in axial/radial coordinates, without a discontinuous atan2 chart.
 * Axial extrema are at vertices; radial minimum is the exact projected-triangle distance and maximum is at a vertex.
 * This bounds the underlying primitive. Native face meshing/identity, not this routine, supplies trimmed-domain provenance.
 */
function axialSurfaceBound(surface: Extract<CurvedSurface, { kind: 'cone' | 'torus' }>, nodes: readonly [V3, V3, V3], torusDepth = 2):
  { readonly offset: number; readonly bound: number } {
  const axis = unit(surface.axis), [u, v] = frame(axis);
  const local = nodes.map(p => sub(p, surface.origin));
  const projected = local.map((p): V2 => [dot(p, u), dot(p, v)]);
  const radii = projected.map(p => Math.hypot(...p)), heights = local.map(p => dot(p, axis));
  const loR = originTriangleDistance2(projected[0], projected[1], projected[2]), hiR = Math.max(...radii);
  const loZ = Math.min(...heights), hiZ = Math.max(...heights);
  if (![loR, hiR, loZ, hiZ, ...radii, ...heights].every(Number.isFinite)) {
    throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite axial projection');
  }
  if (surface.kind === 'torus') {
    // Distance to the generating circle equals |hypot(rho-R,z)-r|, including inside the torus hole.
    const minRadial = Math.max(loR - surface.majorRadius, surface.majorRadius - hiR, 0);
    const minAxial = Math.max(loZ, -hiZ, 0);
    const minTube = Math.hypot(minRadial, minAxial);
    const maxTube = Math.hypot(Math.max(Math.abs(loR - surface.majorRadius), Math.abs(hiR - surface.majorRadius)),
      Math.max(Math.abs(loZ), Math.abs(hiZ)));
    const offset = Math.max(...radii.map((r, i) => Math.abs(Math.hypot(r - surface.majorRadius, heights[i]) - surface.minorRadius)));
    const rectangleBound = Math.max(maxTube - surface.minorRadius, surface.minorRadius - minTube, 0);
    let bound = rectangleBound;
    if (loR > 0 && minTube > 0) {
      // For f(p)=hypot(rho-R,z)-r, the Cartesian Hessian eigenvalues are
      // 0, 1/q and (rho-R)/(q*rho). Their absolute values are at most H=max(1/q,1/rho).
      // The whole triangle stays at rho>=loR and q>=minTube. Linear interpolation has error
      // <= H/2 * sum(lambda_i*|v_i-p|^2) <= H*diameter^2/6 (three barycentric weights).
      // This second enclosure shrinks quadratically on oblique tube patches; a rho/z rectangle alone
      // may shrink only linearly. Near the axis/generating circle retain the original finite enclosure.
      const diameter = Math.max(norm(sub(nodes[0], nodes[1])), norm(sub(nodes[1], nodes[2])), norm(sub(nodes[2], nodes[0])));
      const hessian = Math.max(1 / minTube, 1 / loR);
      const interpolationBound = offset + ((hessian * diameter) / 6) * diameter;
      if (Number.isFinite(interpolationBound)) bound = Math.min(bound, interpolationBound);
    }
    if (torusDepth > 0) {
      // The four CLOSED midpoint triangles cover the whole parent triangle exactly.
      // Repeat twice (16 leaves, 21 enclosures total), independent of requested tolerance.
      // These are physical flat-triangle points, not new CAD nodes: keep their real
      // surface offsets in each enclosure, without applying the native-node admission test.
      const midpoint = (a: V3, b: V3): V3 => [a[0] / 2 + b[0] / 2, a[1] / 2 + b[1] / 2, a[2] / 2 + b[2] / 2];
      const [a, b, c] = nodes, ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      const cells: readonly (readonly [V3, V3, V3])[] = [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
      const coveredBound = Math.max(...cells.map(cell => axialSurfaceBound(surface, cell, torusDepth - 1).bound));
      // Both quantities enclose EVERY point; taking the tighter enclosure is not a
      // sampled maximum or a threshold clip. Retain the original bound if arithmetic overflows.
      if (Number.isFinite(coveredBound)) bound = Math.min(bound, coveredBound);
    }
    return { offset, bound };
  }
  const cosine = Math.cos(surface.semiAngle), sine = Math.sin(surface.semiAngle);
  // At height z the native cone radius is R + z*tan(angle). Test the same sign without division near the apex.
  const scaledRadii = heights.map(z => surface.referenceRadius * cosine + z * sine);
  if (scaledRadii.some(r => !Number.isFinite(r))) {
    throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite cone section');
  }
  const residuals = radii.map((r, i) => r * cosine - scaledRadii[i]);
  // Near a native apex, rounded coordinates can be just beyond the ray's origin. Use the actual ray distance,
  // not a second cone nappe and not an exact-sign rejection of otherwise in-tolerance nodes.
  const negativeHeights = scaledRadii.map(r => r < 0 ? r / Math.abs(sine) : 0);
  const offsets = residuals.map((f, i) => radii[i] * Math.abs(sine) + negativeHeights[i] * cosine < 0
    ? Math.hypot(radii[i], negativeHeights[i]) : Math.abs(f));
  // rho is convex. f=cos(angle)*rho-sin(angle)*z-R*cos(angle) is convex, so its maximum is at vertices.
  // For ANY unit direction d, rho(p) >= dot(d,p). Hence f is bounded below by the
  // minimum vertex value of the affine function cos(angle)*dot(d,p)-scaledRadius(z).
  // Keep each radius paired with its own height; never give a rounded apex's tiny
  // radial vector unit weight. Scaling the sum avoids overflow and changes no direction.
  const sum: V2 = hiR > 0
    ? [projected.reduce((s, p) => s + p[0] / hiR, 0), projected.reduce((s, p) => s + p[1] / hiR, 0)]
    : [0, 0];
  const length = Math.hypot(...sum);
  let lower = cosine * loR - Math.max(...scaledRadii);
  if (length > 0) {
    const direction: V2 = [sum[0] / length, sum[1] / length];
    const affineLower = Math.min(...projected.map((p, i) =>
      cosine * (p[0] * direction[0] + p[1] * direction[1]) - scaledRadii[i]));
    lower = Math.max(lower, affineLower);
  }
  const apexCorrection = Math.max(0, -Math.min(...negativeHeights) * cosine);
  return { offset: Math.max(...offsets), bound: Math.max(Math.max(...residuals), -lower, 0) + apexCorrection };
}

export function triangleSurfaceBound(surface: Exclude<CurvedSurface, { kind: 'plane' }>, nodes: readonly [V3, V3, V3],
  nodeTolerance: number): { readonly offset: number; readonly bound: number } {
  validateSurface(surface);
  if (!Number.isFinite(nodeTolerance) || !(nodeTolerance > 0) || !nodes.every(finite3)) {
    throw new CurvedPlcRefusal('invalid-input', 'curved-plc: invalid triangle coordinates or node tolerance');
  }
  if (surface.kind === 'cone' || surface.kind === 'torus') {
    const result = axialSurfaceBound(surface, nodes);
    if (!Number.isFinite(result.offset) || !Number.isFinite(result.bound)) {
      throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite axial bound');
    }
    if (!(result.offset <= nodeTolerance)) {
      throw new CurvedPlcRefusal('off-surface-node', `curved-plc: node ${String(result.offset)} mm off the ${surface.kind}`);
    }
    return result;
  }
  let radii: number[], minimum: number;
  if (surface.kind === 'cylinder') {
    const axis = unit(surface.axis), [u, v] = frame(axis);
    const projected = nodes.map((p): V2 => { const d = sub(p, surface.origin); return [dot(d, u), dot(d, v)]; });
    radii = projected.map(q => Math.hypot(q[0], q[1]));
    minimum = originTriangleDistance2(projected[0], projected[1], projected[2]);
  } else {
    radii = nodes.map(p => norm(sub(p, surface.center)));
    minimum = pointTriangleDistance(surface.center, nodes[0], nodes[1], nodes[2]);
  }
  const offset = Math.max(...radii.map(radius => Math.abs(radius - surface.radius)));
  if (!(offset <= nodeTolerance)) {
    throw new CurvedPlcRefusal('off-surface-node', `curved-plc: node ${String(offset)} mm off the ${surface.kind}`);
  }
  const bound = Math.max(Math.max(...radii) - surface.radius, surface.radius - minimum, 0);
  if (!Number.isFinite(bound)) throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite bound');
  return { offset, bound };
}

/**
 * Bound every triangle whose label names a curved face. `surfaces[tag]` must come from the current body's native face
 * classification; planar tags are skipped here because the unchanged planar PLC contract checks them.
 */
export function boundCurvedPlc(coordinates: readonly number[], triangles: readonly number[], tags: readonly number[],
  surfaces: readonly (CurvedSurface | FreeformPlcSurface)[], nodeToleranceMm: number, checkpoint: () => void): CurvedPlcBound {
  if (!Number.isFinite(nodeToleranceMm) || !(nodeToleranceMm > 0)) throw new CurvedPlcRefusal('invalid-input', 'curved-plc: node tolerance');
  if (triangles.length !== 3 * tags.length || coordinates.length % 3 !== 0) throw new CurvedPlcRefusal('invalid-input', 'curved-plc: dimensions');
  const count = coordinates.length / 3;
  const point = (i: number): V3 => {
    if (!Number.isSafeInteger(i) || i < 0 || i >= count) throw new CurvedPlcRefusal('invalid-input', 'curved-plc: node index');
    return [coordinates[3 * i], coordinates[3 * i + 1], coordinates[3 * i + 2]];
  };
  const faces = new Map<number, { kind: CurvedFaceBound['kind']; triangles: number; offset: number; bound: number; volume: number }>();
  const nativeRows = new Map<number, { readonly offset: number; readonly bound: number }>();
  for (let face = 0; face < surfaces.length; face += 1) {
    const surface = surfaces[face];
    if (surface.kind !== 'freeform') continue;
    if ((surface.surfaceKind !== 'bspline' && surface.surfaceKind !== 'bezier' && surface.surfaceKind !== 'extrusion')
      || surface.triangles.length > tags.length) {
      throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: invalid native freeform table');
    }
    let previous = -1;
    for (const row of surface.triangles) {
      checkpoint();
      if (!Number.isSafeInteger(row.triangleIndex) || row.triangleIndex <= previous || row.triangleIndex >= tags.length
        || tags[row.triangleIndex] !== face || nativeRows.has(row.triangleIndex)
        || !Number.isFinite(row.maxNodeOffsetMm) || row.maxNodeOffsetMm < 0 || !Number.isFinite(row.maxChordDeviationMm)
        || row.maxChordDeviationMm < row.maxNodeOffsetMm) {
        throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: invalid native triangle evidence');
      }
      previous = row.triangleIndex;
      nativeRows.set(row.triangleIndex, { offset: row.maxNodeOffsetMm, bound: row.maxChordDeviationMm });
    }
  }
  for (let t = 0; t < tags.length; t += 1) {
    if (t % 256 === 0) checkpoint();
    const tag = tags[t], surface = surfaces[tag];
    if (surface === undefined) throw new CurvedPlcRefusal('invalid-input', `curved-plc: face label ${String(tag)} has no surface`);
    if (surface.kind === 'plane') continue;
    if (surface.kind !== 'freeform') validateSurface(surface);
    const nodes: [V3, V3, V3] = [point(triangles[3 * t]), point(triangles[3 * t + 1]), point(triangles[3 * t + 2])];
    if (!nodes.every(finite3)) throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite node');
    const measured = surface.kind === 'freeform' ? nativeRows.get(t) : triangleSurfaceBound(surface, nodes, nodeToleranceMm);
    if (measured === undefined) throw new CurvedPlcRefusal('invalid-surface', 'curved-plc: missing native triangle evidence');
    const { offset, bound } = measured;
    if (offset > nodeToleranceMm) throw new CurvedPlcRefusal('off-surface-node', 'curved-plc: native freeform node offset');
    const area = norm(cross(sub(nodes[1], nodes[0]), sub(nodes[2], nodes[0]))) / 2;
    if (!(area > 0) || !Number.isFinite(area)) {
      throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonpositive or nonfinite triangle area');
    }
    const face = faces.get(tag) ?? { kind: surface.kind, triangles: 0, offset: 0, bound: 0, volume: 0 };
    const estimate = area * bound, volume = face.volume + estimate;
    if (!Number.isFinite(estimate) || !Number.isFinite(volume)) {
      throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite triangle or face volume estimate');
    }
    face.triangles += 1; face.offset = Math.max(face.offset, offset); face.bound = Math.max(face.bound, bound);
    face.volume = volume;
    faces.set(tag, face);
  }
  checkpoint();
  const rows = [...faces.entries()].sort((x, y) => x[0] - y[0]).map(([tag, face]): CurvedFaceBound => ({ tag, kind: face.kind,
    triangles: face.triangles, maxNodeSurfaceOffsetMm: face.offset, maxChordDeviationBoundMm: face.bound,
    volumeDeviationEstimateMm3: face.volume }));
  const volumeDeviationEstimateMm3 = rows.reduce((s, row) => s + row.volumeDeviationEstimateMm3, 0);
  if (!Number.isFinite(volumeDeviationEstimateMm3)) {
    throw new CurvedPlcRefusal('invalid-input', 'curved-plc: nonfinite total volume estimate');
  }
  return { schema: CURVED_PLC_BOUND_SCHEMA, nodeToleranceMm, faces: rows,
    maxChordDeviationBoundMm: rows.reduce((m, row) => Math.max(m, row.maxChordDeviationBoundMm), 0),
    volumeDeviationEstimateMm3,
    estimateIsBound: false, exactProof: false, globalCertified: false };
}
