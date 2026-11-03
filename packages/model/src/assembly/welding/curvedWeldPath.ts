/** Internal circle-path proposal, not a saved schema or a native producer.
 * A cylindrical fillet cross-section is NOT evidence of a circular weld path.
 * The caller must obtain current evidence and the COMPLETE bead group independently.
 * Current SolidEdgeEntry.circleBasis supplies native parameters; circularWeldSelection resolves world evidence.
 */
import { hasExactOwnKeys as record, isFiniteNumber as finite } from '../../valueGuards.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { WELD_DIRECTION_TOLERANCE, WELD_LENGTH_TOLERANCE_MM } from './types.js';

export interface CircularWeldPathSource {
  readonly documentId: string;
  readonly ownerId: string;
  readonly occurrencePath: readonly string[];
  readonly sourceKey: string;
  readonly placementKey: string;
  readonly bodyFeatureId: string;
  readonly bodyKey: string;
  readonly edgeIndex: number;
}

/** Original circle parameter in radians, never reconstructed from a cylinder or polyline.
 * World-mm basis is the native circle basis after the occurrence's rigid placement.
 * parameterRange is increasing; orientation is separate, with no modulo/rebasing.
 */
export interface CircularWeldPathEvidence {
  readonly kind: 'circle-edge';
  readonly source: CircularWeldPathSource;
  readonly centerMm: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly normal: Vec3;
  readonly radiusMm: number;
  readonly parameterRange: readonly [number, number];
  readonly orientation: 1 | -1;
}

export interface CircularWeldBeadInterval {
  readonly beadId: string;
  readonly beadSourceKey: string;
  readonly fromParameter: number;
  readonly toParameter: number;
}

export interface CircularWeldPathDefinition {
  readonly kind: 'circular-weld-path';
  readonly evidence: CircularWeldPathEvidence;
  readonly intervals: readonly CircularWeldBeadInterval[];
}

export interface CircularWeldPathFrame {
  /** One shared world point for both sides. It is NOT a throat surface point. */
  readonly positionMm: Vec3;
  readonly radial: Vec3;
  readonly tangent: Vec3;
  /** radial cross tangent; reverses with the traversal, unlike radial. */
  readonly binormal: Vec3;
}

export interface CircularWeldPath {
  readonly definition: CircularWeldPathDefinition;
  readonly lengthMm: number;
  readonly occupiedLengthMm: number;
  readonly gaps: readonly { readonly fromParameter: number; readonly toParameter: number; readonly lengthMm: number }[];
  /** Whole-path geometry includes gaps, but cannot imply a bead or contact there. */
  readonly frameAt: (parameter: number) => CircularWeldPathFrame | null;
  /** A material sample must also identify an actual current bead interval. */
  readonly beadFrameAt: (beadId: string, parameter: number) => CircularWeldPathFrame | null;
}

function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function vector(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !finite(value[0]) || !finite(value[1]) || !finite(value[2])) return null;
  return Object.freeze([value[0], value[1], value[2]]);
}
function source(value: unknown): CircularWeldPathSource | null {
  const keys = ['documentId', 'ownerId', 'occurrencePath', 'sourceKey', 'placementKey', 'bodyFeatureId', 'bodyKey', 'edgeIndex'];
  if (!record(value, keys) || !text(value.documentId) || !text(value.ownerId) || !text(value.sourceKey)
    || !text(value.placementKey) || !text(value.bodyFeatureId) || !text(value.bodyKey)
    || !finite(value.edgeIndex) || !Number.isSafeInteger(value.edgeIndex) || value.edgeIndex < 0
    || !Array.isArray(value.occurrencePath) || value.occurrencePath.length === 0 || !value.occurrencePath.every(text)) return null;
  return Object.freeze({ documentId: value.documentId, ownerId: value.ownerId, occurrencePath: Object.freeze([...value.occurrencePath]),
    sourceKey: value.sourceKey, placementKey: value.placementKey, bodyFeatureId: value.bodyFeatureId, bodyKey: value.bodyKey, edgeIndex: value.edgeIndex });
}
function evidence(value: unknown): CircularWeldPathEvidence | null {
  if (!record(value, ['kind', 'source', 'centerMm', 'xAxis', 'yAxis', 'normal', 'radiusMm', 'parameterRange', 'orientation'])
    || value.kind !== 'circle-edge' || (value.orientation !== 1 && value.orientation !== -1)
    || !finite(value.radiusMm) || value.radiusMm <= 0 || !Array.isArray(value.parameterRange)
    || value.parameterRange.length !== 2 || !finite(value.parameterRange[0]) || !finite(value.parameterRange[1])) return null;
  const identity = source(value.source), centerMm = vector(value.centerMm), xAxis = vector(value.xAxis);
  const yAxis = vector(value.yAxis), normal = vector(value.normal);
  const lo = value.parameterRange[0], hi = value.parameterRange[1], span = hi - lo;
  if (identity === null || centerMm === null || xAxis === null || yAxis === null || normal === null
    || !(span > 0 && span <= 2 * Math.PI) || !Number.isFinite(span * value.radiusMm)
    || span * value.radiusMm <= WELD_LENGTH_TOLERANCE_MM
    || [xAxis, yAxis, normal].some(axis => Math.abs(lengthVec3(axis) - 1) > WELD_DIRECTION_TOLERANCE)
    || Math.abs(dotVec3(xAxis, yAxis)) > WELD_DIRECTION_TOLERANCE
    || lengthVec3(subVec3(crossVec3(xAxis, yAxis), normal)) > WELD_DIRECTION_TOLERANCE) return null;
  // Do not normalize an invalid basis or infer a missing orientation/range.
  const parameterRange: readonly [number, number] = Object.freeze([lo, hi]);
  return Object.freeze({ kind: 'circle-edge', source: identity, centerMm, xAxis, yAxis, normal, radiusMm: value.radiusMm,
    parameterRange, orientation: value.orientation });
}
function intervals(value: unknown): readonly CircularWeldBeadInterval[] | null {
  // Preserve the current analysis budget. Do not create unbounded derived cells.
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const rows: CircularWeldBeadInterval[] = [], ids = new Set<string>();
  for (const row of value) {
    if (!record(row, ['beadId', 'beadSourceKey', 'fromParameter', 'toParameter']) || !text(row.beadId)
      || !text(row.beadSourceKey) || ids.has(row.beadId) || !finite(row.fromParameter) || !finite(row.toParameter)) return null;
    ids.add(row.beadId);
    rows.push(Object.freeze({ beadId: row.beadId, beadSourceKey: row.beadSourceKey,
      fromParameter: row.fromParameter, toParameter: row.toParameter }));
  }
  return Object.freeze(rows);
}
function sameEvidence(a: CircularWeldPathEvidence, b: CircularWeldPathEvidence): boolean {
  // Both values have been strictly decoded into the same key order; includes every
  // coordinate, raw parameter, occurrence, body/source/placement identity and edge.
  return JSON.stringify(a) === JSON.stringify(b);
}
function rawFrame(e: CircularWeldPathEvidence, parameter: number): CircularWeldPathFrame | null {
  const [lo, hi] = e.parameterRange;
  if (!Number.isFinite(parameter) || parameter < lo || parameter > hi) return null;
  const radial = addVec3(scaleVec3(e.xAxis, Math.cos(parameter)), scaleVec3(e.yAxis, Math.sin(parameter)));
  const tangent = scaleVec3(addVec3(scaleVec3(e.xAxis, -Math.sin(parameter)), scaleVec3(e.yAxis, Math.cos(parameter))), e.orientation);
  const positionMm = addVec3(e.centerMm, scaleVec3(radial, e.radiusMm)), binormal = crossVec3(radial, tangent);
  if (![...positionMm, ...radial, ...tangent, ...binormal].every(Number.isFinite)) return null;
  return Object.freeze({ positionMm: Object.freeze(positionMm), radial: Object.freeze(radial), tangent: Object.freeze(tangent), binormal: Object.freeze(binormal) });
}

/** Snapshot admission only. A later source/owner/placement change requires a fresh call.
 * currentEvidence/currentBeads must come from the real current lookup, not the saved
 * definition itself. circularWeldSelection resolves current circle geometry; the complete
 * bead group still requires an independently checked producer.
 * The geometric radial frame is NOT a material normal, throat width or strength model.
 */
export function createCircularWeldPath(value: unknown, currentEvidence: unknown, currentBeads: unknown): CircularWeldPath | null {
  const snapshot = readCircularWeldPathSnapshot(value);
  const current = evidence(currentEvidence), beads = intervals(currentBeads);
  if (snapshot === null || current === null || beads === null) return null;
  const { evidence: e, intervals: spans } = snapshot.definition;
  if (!sameEvidence(e, current) || spans.length !== beads.length
    || spans.some(span => !beads.some(bead => bead.beadId === span.beadId
      && bead.beadSourceKey === span.beadSourceKey && bead.fromParameter === span.fromParameter && bead.toParameter === span.toParameter))) return null;
  return snapshot;
}

/** Geometry snapshot only. This does not certify current source, beads or contact.
 * Saved reconstruction must never present these saved values as current evidence.
 */
export function readCircularWeldPathSnapshot(value: unknown): CircularWeldPath | null {
  if (!record(value, ['kind', 'evidence', 'intervals']) || value.kind !== 'circular-weld-path') return null;
  const e = evidence(value.evidence), spans = intervals(value.intervals);
  if (e === null || spans === null) return null;
  const [lo, hi] = e.parameterRange, sign = e.orientation, start = sign === 1 ? lo : hi, finish = sign === 1 ? hi : lo;
  let previous = start, occupiedLengthMm = 0;
  const gaps: { readonly fromParameter: number; readonly toParameter: number; readonly lengthMm: number }[] = [];
  for (const span of spans) {
    const { fromParameter: from, toParameter: to } = span;
    const length = sign * (to - from) * e.radiusMm;
    if (from < lo || from > hi || to < lo || to > hi || sign * (from - previous) < 0
      || !Number.isFinite(length) || length <= WELD_LENGTH_TOLERANCE_MM) return null;
    if (from !== previous) gaps.push(Object.freeze({ fromParameter: previous, toParameter: from, lengthMm: sign * (from - previous) * e.radiusMm }));
    previous = to; occupiedLengthMm += length;
  }
  if (previous !== finish) gaps.push(Object.freeze({ fromParameter: previous, toParameter: finish, lengthMm: sign * (finish - previous) * e.radiusMm }));
  // Check global position representability before publishing a usable snapshot.
  if (![lo, hi, lo + (hi - lo) / 2].every(p => rawFrame(e, p) !== null) || !Number.isFinite(occupiedLengthMm)) return null;
  return Object.freeze({ definition: Object.freeze({ kind: 'circular-weld-path', evidence: e, intervals: spans }),
    lengthMm: (hi - lo) * e.radiusMm, occupiedLengthMm, gaps: Object.freeze(gaps),
    frameAt: (parameter: number) => rawFrame(e, parameter),
    beadFrameAt: (beadId: string, parameter: number) => {
      const span = spans.find(row => row.beadId === beadId);
      return span === undefined || sign * (parameter - span.fromParameter) < 0 || sign * (span.toParameter - parameter) < 0
        ? null : rawFrame(e, parameter);
    } });
}
