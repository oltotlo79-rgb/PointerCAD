import { crossVec2 as cross } from '../../sketch/vec2.js';
/** Internal finite plane/full-cylinder admission. No saved schema, solver or bead generation. */
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { resolveSubShapeReference } from '../../kernelBridge/referenceResolution.js';
import type { SolidBody, SolidFaceEntry } from '../../kernelBridge/solidContracts.js';
import { dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { resolveJointOccurrence } from '../jointOccurrence.js';
import { applyPlacementToDirection, applyPlacementToPoint, quaternionFromBasis } from '../placementMath.js';
import type { CircularFilletWeldSection } from './circularFilletWeldGeometry.js';
import { resolveCircularWeldSelection, type CircularWeldSelectionContext } from './circularWeldSelection.js';
import { createCircularWeldPath, type CircularWeldPathEvidence } from './curvedWeldPath.js';
import { selectedWeldCylinder } from './cylindricalWeld.js';
import { WELD_DIRECTION_TOLERANCE as D, WELD_LENGTH_TOLERANCE_MM as L } from './types.js';
import { COVERED_RATIO, UNCOVERED_RATIO } from './weldContact.js';

interface Pick { readonly path: readonly string[]; readonly reference: SubShapeRef }
interface FacePick extends Pick { readonly sourceKey: string; readonly bodyKey: string; readonly placementKey: string }
export interface CircularWeldContactRequest {
  readonly edge: Pick; readonly plane: FacePick; readonly cylinder: FacePick;
  readonly definition: unknown; readonly currentBeads: unknown;
  readonly section: Omit<CircularFilletWeldSection, 'beadId'>;
}
type P = readonly [number, number];
type Boundary = { readonly line: readonly [P, P] } | { readonly center: P; readonly radius: number; readonly range: readonly [number, number] };
const TAU = 2 * Math.PI;
const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const at = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const polar = (u: number, r = 1): P => [r * Math.cos(u), r * Math.sin(u)];
const finite = (v: readonly number[]): boolean => v.every(Number.isFinite);
function roots(a: number, b: number, c: number): number[] {
  const delta = b * b - 4 * a * c;
  return a > 0 && delta >= 0 ? [(-b - Math.sqrt(delta)) / (2 * a), (-b + Math.sqrt(delta)) / (2 * a)] : [];
}
function face(context: CircularWeldSelectionContext, pick: FacePick) {
  const result = resolveJointOccurrence(context.inputs, pick.path, context.view);
  if (!result.ok) return null;
  const occurrence = result.occurrence, bodies = context.bodiesOf(occurrence);
  const matches = bodies?.filter(b => b.featureId === pick.reference.bodyFeatureId), body = matches?.[0];
  if (matches?.length !== 1 || body === undefined || !body.isValid || body.bodyKind !== 'solid') return null;
  const steps = occurrence.resolvedPart.steps.filter(s => s.featureId === body.featureId && s.visible && occurrence.resolvedPart.liveBodyIds.includes(s.featureId));
  if (steps.length !== 1 || !steps[0].key.trim()) return null;
  if (pick.sourceKey !== occurrence.sourceKey || pick.bodyKey !== steps[0].key
    || pick.placementKey !== JSON.stringify([occurrence.worldPlacement.position, occurrence.worldPlacement.rotation])) return null;
  const resolved = resolveSubShapeReference(body, pick.reference);
  if (resolved.status !== 'matched' || resolved.match.geometry.kind !== 'face') return null;
  const faces = body.faces.filter(f => f.index === resolved.match.reference.index), value = faces[0];
  const indices = value?.boundaryEdgeIndices;
  if (faces.length !== 1 || value === undefined || indices === undefined || !indices.length || new Set(indices).size !== indices.length
    || Array.from(indices).some(i => !Number.isSafeInteger(i) || i < 0 || body.edges.filter(e => e.index === i).length !== 1)) return null;
  const edges = indices.map(i => body.edges.find(e => e.index === i));
  if (edges.some(e => e === undefined || !['line', 'circle'].includes(e.curveKind))) return null;
  const stamp = JSON.stringify([occurrence.path, occurrence.sourceKey, occurrence.worldPlacement, steps[0].key, value, edges]);
  return { occurrence, body, value, indices, stamp };
}
function projection(e: CircularWeldPathEvidence, p: Vec3): P {
  const v = subVec3(p, e.centerMm); return [dotVec3(v, e.xAxis), dotVec3(v, e.yAxis)];
}
function boundaries(f: NonNullable<ReturnType<typeof face>>, e: CircularWeldPathEvidence): Boundary[] | null {
  const rows: Boundary[] = [], placement = f.occurrence.worldPlacement;
  const point = (v: Vec3): Vec3 => applyPlacementToPoint(placement, v);
  const direction = (v: Vec3): Vec3 => applyPlacementToDirection(placement, v);
  const onPlane = (p: Vec3): boolean => finite(p) && Math.abs(dotVec3(subVec3(p, e.centerMm), e.normal)) <= L;
  for (const index of f.indices) {
    const edge = f.body.edges.find(v => v.index === index);
    if (edge === undefined) return null;
    if (edge.curveKind === 'line') {
      const a = point(edge.start), b = point(edge.end);
      if (!onPlane(a) || !onPlane(b) || lengthVec3(subVec3(a, b)) <= L) return null;
      rows.push({ line: [projection(e, a), projection(e, b)] });
    } else {
      const basis = edge.circleBasis;
      if (basis === undefined || edge.radius === null || !(edge.radius > L) || !Number.isFinite(edge.radius)
        || quaternionFromBasis(basis.xAxis, basis.yAxis, basis.normal, D) === null || !finite(basis.parameterRange)
        || !(basis.parameterRange[1] > basis.parameterRange[0] && basis.parameterRange[1] - basis.parameterRange[0] <= TAU)) return null;
      const c = point(basis.origin), n = direction(basis.normal), x = direction(basis.xAxis);
      if (!onPlane(c) || Math.abs(Math.abs(dotVec3(n, e.normal)) - 1) > D) return null;
      const phase = Math.atan2(dotVec3(x, e.yAxis), dotVec3(x, e.xAxis)), sign = dotVec3(n, e.normal) > 0 ? 1 : -1;
      const a = phase + sign * basis.parameterRange[0], b = phase + sign * basis.parameterRange[1];
      rows.push({ center: projection(e, c), radius: edge.radius, range: [Math.min(a, b), Math.max(a, b)] });
    }
  }
  return rows;
}
function interior(p: P, lo: number, hi: number, start: number, span: number): boolean {
  const r = Math.hypot(...p), angle = ((Math.atan2(p[1], p[0]) - start) % TAU + TAU) % TAU;
  const shrink = Math.min(L, (hi - lo) / 4), angular = Math.min(L / hi, span / 4);
  return r > lo + shrink && r < hi - shrink && (span === TAU || (angle > angular && angle < span - angular));
}
/** Partition at every analytic radial/angular crossing; interval probes are not coverage sampling. */
function crosses(edge: Boundary, lo: number, hi: number, start: number, span: number): boolean {
  const cuts = [0, 'line' in edge ? 1 : TAU];
  const shrink = Math.min(L, (hi - lo) / 4), angular = Math.min(L / hi, span / 4);
  const rays = [polar(start + angular), polar(start + span - angular)];
  if ('line' in edge) {
    const [a, b] = edge.line, d = sub(b, a);
    for (const r of [lo + shrink, hi - shrink]) cuts.push(...roots(dot(d, d), 2 * dot(a, d), dot(a, a) - r * r));
    for (const ray of rays) if (cross(ray, d) !== 0) cuts.push(-cross(ray, a) / cross(ray, d));
  } else {
    const c = edge.center, r = edge.radius;
    const solve = (a: number, b: number, value: number) => {
      const size = Math.hypot(a, b);
      if (size > 0 && Math.abs(value) <= size) {
        const phase = Math.atan2(b, a), angle = Math.acos(value / size);
        cuts.push(((phase + angle) % TAU + TAU) % TAU, ((phase - angle) % TAU + TAU) % TAU);
      }
    };
    for (const radius of [lo + shrink, hi - shrink]) solve(2 * r * c[0], 2 * r * c[1], radius * radius - dot(c, c) - r * r);
    for (const ray of rays) solve(-r * ray[1], r * ray[0], -cross(ray, c));
  }
  const limit = 'line' in edge ? 1 : TAU, sorted = cuts.filter(t => Number.isFinite(t) && t >= 0 && t <= limit).sort((a, b) => a - b);
  return sorted.some((t, i) => {
    if (i === 0 || t === sorted[i - 1]) return false;
    const u = (t + sorted[i - 1]) / 2;
    const p: P = 'line' in edge ? at(edge.line[0], edge.line[1], u) : [edge.center[0] + edge.radius * Math.cos(u), edge.center[1] + edge.radius * Math.sin(u)];
    return interior(p, lo, hi, start, span);
  });
}
/** Complete face-boundary even/odd containment; supports inner wires and actual partial arcs. */
function contains(edges: readonly Boundary[], p: P): boolean {
  let count = 0;
  for (const edge of edges) {
    if ('line' in edge) {
      const [a, b] = edge.line;
      if ((a[1] > p[1]) !== (b[1] > p[1]) && at(a, b, (p[1] - a[1]) / (b[1] - a[1]))[0] > p[0]) count++;
    } else {
      const y = p[1] - edge.center[1], square = edge.radius ** 2 - y ** 2;
      if (!(square > 0)) continue;
      for (const x of [-Math.sqrt(square), Math.sqrt(square)]) {
        if (edge.center[0] + x <= p[0]) continue;
        const angle = Math.atan2(y, x), [lo, hi] = edge.range;
        for (let k = Math.ceil((lo - angle) / TAU); k <= Math.floor((hi - angle) / TAU); k++) {
          const u = angle + k * TAU;
          if ((u > lo && u < hi) || (u === lo && x > 0) || (u === hi && x < 0)) count++;
        }
      }
    }
  }
  return count % 2 === 1;
}
function clip(poly: readonly P[], ray: P, sign: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = sign * cross(ray, a), db = sign * cross(ray, b);
    if (da >= 0) out.push(a);
    if ((da < 0) !== (db < 0)) out.push(at(a, b, da / (da - db)));
  }
  return out;
}
/** Green integral of polygon intersect disk, splitting each edge at exact circle intersections. */
function diskArea(poly: readonly P[], radius: number): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], d = sub(b, a);
    const cuts = [0, 1, ...roots(dot(d, d), 2 * dot(a, d), dot(a, a) - radius * radius).filter(t => t > 0 && t < 1)].sort((a, b) => a - b);
    for (let j = 1; j < cuts.length; j++) {
      const p = at(a, b, cuts[j - 1]), q = at(a, b, cuts[j]), mid = at(p, q, .5);
      area += dot(mid, mid) <= radius * radius ? cross(p, q) / 2 : radius * radius * Math.atan2(cross(p, q), dot(p, q)) / 2;
    }
  }
  return Math.abs(area);
}
function coverage(body: SolidBody, face: SolidFaceEntry, project: (p: Vec3) => P, lo: number, hi: number, start: number, span: number): number | null {
  if (!Number.isSafeInteger(face.triangleOffset) || !Number.isSafeInteger(face.triangleCount) || face.triangleOffset < 0 || face.triangleCount <= 0
    || (face.triangleOffset + face.triangleCount) * 3 > body.mesh.indices.length) return null;
  let area = 0, magnitude = 0;
  for (let i = face.triangleOffset; i < face.triangleOffset + face.triangleCount; i++) {
    const triangle: P[] = [];
    for (let j = 0; j < 3; j++) {
      const index = body.mesh.indices[i * 3 + j] * 3, raw = body.mesh.positions, origin = body.coordinateFrame?.origin ?? [0, 0, 0];
      if (index + 2 >= raw.length) return null;
      const p: Vec3 = [raw[index] + origin[0], raw[index + 1] + origin[1], raw[index + 2] + origin[2]];
      if (!finite(p)) return null;
      magnitude = Math.max(magnitude, ...p.map(Math.abs)); triangle.push(project(p));
    }
    for (let from = start; from < start + span;) {
      const to = Math.min(start + span, from + Math.PI / 2);
      if (!(to > from)) return null;
      const polygon = clip(clip(triangle, polar(from), 1), polar(to), -1);
      area += diskArea(polygon, hi) - diskArea(polygon, lo); from = to;
    }
  }
  const target = span * (hi * hi - lo * lo) / 2, perimeter = span * (hi + lo) + 2 * (hi - lo);
  const error = body.coordinateFrame?.maximumFloat32ErrorMm ?? magnitude * 2 ** -22;
  return !Number.isFinite(error) || error < 0 || perimeter * error >= UNCOVERED_RATIO * target ? null : area / target;
}

/** Current admission only; no result caching across owner/source/placement changes. */
export function resolveCircularWeldContact(context: CircularWeldSelectionContext, request: CircularWeldContactRequest) {
  const refuse = (reason: string) => Object.freeze({ reason, contacts: Object.freeze([]) });
  const e = resolveCircularWeldSelection(context, request.edge.path, request.edge.reference);
  const path = e === null ? null : createCircularWeldPath(request.definition, e, request.currentBeads);
  const plane = face(context, request.plane), cylinder = face(context, request.cylinder), s = request.section;
  if (e === null || path === null || plane === null || cylinder === null) return refuse('currentSelectionUnavailable');
  if (JSON.stringify(plane.occurrence.path) === JSON.stringify(cylinder.occurrence.path)) return refuse('sameOccurrence');
  if (![s.radialLegMm, s.normalLegMm].every(v => Number.isFinite(v) && v > L) || ![1, -1].includes(s.radialDirection)
    || ![1, -1].includes(s.normalDirection) || e.radiusMm + s.radialDirection * s.radialLegMm <= L) return refuse('invalidSection');
  const sectionStamp = JSON.stringify(s);
  const owns = [plane, cylinder].some(f => JSON.stringify(f.occurrence.path) === JSON.stringify(e.source.occurrencePath)
    && f.body.featureId === e.source.bodyFeatureId && f.indices.includes(e.source.edgeIndex));
  if (!owns) return refuse('edgeNotOnSelectedFace');
  const basis = plane.value.planarBasis, placement = plane.occurrence.worldPlacement;
  if (plane.value.surfaceKind !== 'plane' || basis === undefined || quaternionFromBasis(basis.xAxis, basis.yAxis, basis.normal, D) === null) return refuse('planeUnavailable');
  const normal = applyPlacementToDirection(placement, basis.normal), origin = applyPlacementToPoint(placement, basis.origin);
  if (dotVec3(normal, scaleVec3(e.normal, s.normalDirection)) < 1 - D || Math.abs(dotVec3(subVec3(e.centerMm, origin), normal)) > L) return refuse('planeMaterialSide');
  const root = path.frameAt(e.parameterRange[0])?.positionMm;
  const band = root === undefined ? null : selectedWeldCylinder([cylinder.body], request.cylinder.reference, cylinder.occurrence.worldPlacement, root);
  if (band === null || Math.abs(band.radius - e.radiusMm) > L || Math.abs(Math.abs(dotVec3(band.axis, e.normal)) - 1) > D
    || (band.side === 'exterior' ? 1 : -1) !== s.radialDirection) return refuse('cylinderUnavailable');
  const offset = subVec3(e.centerMm, band.origin), z = dotVec3(offset, band.axis), end = z + s.normalDirection * s.normalLegMm * dotVec3(e.normal, band.axis);
  if (lengthVec3(subVec3(offset, scaleVec3(band.axis, z))) > L || Math.min(z, end) < band.span[0] - L || Math.max(z, end) > band.span[1] + L) return refuse('cylinderBandTooShort');
  const edges = boundaries(plane, e);
  if (edges === null) return refuse('unsupportedBoundary');
  const lo = Math.min(e.radiusMm, e.radiusMm + s.radialDirection * s.radialLegMm), hi = Math.max(e.radiusMm, e.radiusMm + s.radialDirection * s.radialLegMm);
  const contacts = [];
  for (const bead of path.definition.intervals) {
    const start = Math.min(bead.fromParameter, bead.toParameter), span = Math.abs(bead.toParameter - bead.fromParameter);
    if (edges.some(edge => crosses(edge, lo, hi, start, span))) return refuse('boundaryCrossed');
    if (!contains(edges, polar(start + span / 2, (lo + hi) / 2))) return refuse('notInsideSelectedFace');
    const ratio = coverage(plane.body, plane.value, p => projection(e, applyPlacementToPoint(placement, p)), lo, hi, start, span);
    if (ratio === null || !Number.isFinite(ratio) || ratio < COVERED_RATIO) return refuse('coverageUnproved');
    contacts.push(Object.freeze({ beadId: bead.beadId, planeAreaMm2: span * (hi * hi - lo * lo) / 2,
      cylinderAreaMm2: e.radiusMm * s.normalLegMm * span, coveredRatio: ratio }));
  }
  const current = resolveCircularWeldSelection(context, request.edge.path, request.edge.reference);
  if (JSON.stringify(current) !== JSON.stringify(e) || face(context, request.plane)?.stamp !== plane.stamp
    || face(context, request.cylinder)?.stamp !== cylinder.stamp) return refuse('selectionChanged');
  const finalPath = current === null ? null : createCircularWeldPath(request.definition, current, request.currentBeads);
  if (JSON.stringify(finalPath?.definition) !== JSON.stringify(path.definition)
    || JSON.stringify(request.section) !== sectionStamp) return refuse('selectionChanged');
  return Object.freeze({ reason: null, contacts: Object.freeze(contacts) });
}
