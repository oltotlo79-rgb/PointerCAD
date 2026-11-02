/** Current occurrence + uniquely resolved native circle -> owned world-mm evidence.
 * This does not generate a bead, restore a saved curve, or prove a throat surface.
 */
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { resolveSubShapeReference } from '../../kernelBridge/referenceResolution.js';
import type { SolidBody } from '../../kernelBridge/solidContracts.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { resolveJointOccurrence, type JointOccurrenceInputs, type JointOccurrenceView, type ResolvedJointOccurrence } from '../jointOccurrence.js';
import { applyPlacementToDirection, applyPlacementToPoint, quaternionFromBasis } from '../placementMath.js';
import type { CircularWeldPathEvidence } from './curvedWeldPath.js';
import { WELD_DIRECTION_TOLERANCE, WELD_LENGTH_TOLERANCE_MM } from './types.js';

export interface CircularWeldSelectionContext {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  /** Same lookup as nested weld commands: view.bodies.get(occurrence.partKey).
   * Part-coordinate bodies must belong to this resolved part's current cache.
   */
  readonly bodiesOf: (occurrence: ResolvedJointOccurrence) => readonly SolidBody[] | null;
}

function finite3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3
    && [0, 1, 2].every(index => typeof value[index] === 'number' && Number.isFinite(value[index]));
}
function owned(value: Vec3): Vec3 { return Object.freeze([value[0], value[1], value[2]]); }
function stamp(occurrence: ResolvedJointOccurrence): string {
  return JSON.stringify([occurrence.path, occurrence.sourceKey, occurrence.partKey,
    occurrence.worldPlacement.position, occurrence.worldPlacement.rotation]);
}

/** Never trusts the pick's fingerprint as geometry, nor an index-only match.
 * Both existing current-occurrence and subshape ambiguity checks run here.
 * Later document/library/view changes require a new call, not reuse of a snapshot.
 */
export function resolveCircularWeldSelection(context: CircularWeldSelectionContext,
  path: readonly string[], reference: SubShapeRef): CircularWeldPathEvidence | null {
  const resolved = resolveJointOccurrence(context.inputs, path, context.view);
  if (!resolved.ok || context.inputs.document.id.trim() === '') return null;
  const occurrence = resolved.occurrence, identity = stamp(occurrence);
  const bodies = context.bodiesOf(occurrence);
  if (bodies === null) return null;
  const matches = bodies.filter(body => body.featureId === reference.bodyFeatureId), body = matches[0];
  if (matches.length !== 1 || body === undefined || !body.isValid || body.bodyKind === 'mesh') return null;
  const steps = occurrence.resolvedPart.steps.filter(step => step.featureId === body.featureId
    && step.visible && occurrence.resolvedPart.liveBodyIds.includes(step.featureId));
  const step = steps[0];
  if (steps.length !== 1 || step === undefined || step.key.trim() === '') return null;
  const match = resolveSubShapeReference(body, reference);
  if (match.status !== 'matched' || match.match.geometry.kind !== 'edge' || match.match.geometry.curveKind !== 'circle') return null;
  const edges = body.edges.filter(edge => edge.index === match.match.reference.index), edge = edges[0];
  if (edges.length !== 1 || edge === undefined || edge.curveKind !== 'circle' || !Number.isSafeInteger(edge.index) || edge.index < 0) return null;
  const basis = edge.circleBasis;
  if (basis == null || !finite3(basis.origin) || !finite3(basis.xAxis) || !finite3(basis.yAxis) || !finite3(basis.normal)
    || edge.radius === null || !Number.isFinite(edge.radius) || edge.radius <= 0
    || (basis.orientation !== 1 && basis.orientation !== -1) || !Array.isArray(basis.parameterRange) || basis.parameterRange.length !== 2) return null;
  const first = basis.parameterRange[0], last = basis.parameterRange[1], span = last - first;
  if (!Number.isFinite(first) || !Number.isFinite(last) || !(span > 0 && span <= 2 * Math.PI)
    || !Number.isFinite(span * edge.radius) || span * edge.radius <= WELD_LENGTH_TOLERANCE_MM
    || quaternionFromBasis(basis.xAxis, basis.yAxis, basis.normal, WELD_DIRECTION_TOLERANCE) === null) return null;
  // worldPlacement already includes every parent. Never compose the leaf again.
  const placement = occurrence.worldPlacement;
  const centerMm = applyPlacementToPoint(placement, basis.origin), xAxis = applyPlacementToDirection(placement, basis.xAxis);
  const yAxis = applyPlacementToDirection(placement, basis.yAxis), normal = applyPlacementToDirection(placement, basis.normal);
  if (!finite3(centerMm) || quaternionFromBasis(xAxis, yAxis, normal, WELD_DIRECTION_TOLERANCE) === null) return null;
  // A synchronous lookup must not swap inputs/source/pose before publishing.
  const current = resolveJointOccurrence(context.inputs, path, context.view);
  if (!current.ok || stamp(current.occurrence) !== identity) return null;
  const parameterRange: readonly [number, number] = Object.freeze([first, last]);
  return Object.freeze({ kind: 'circle-edge', source: Object.freeze({ documentId: context.inputs.document.id,
    ownerId: occurrence.leafComponent.id, occurrencePath: Object.freeze([...occurrence.path]), sourceKey: occurrence.sourceKey,
    // Same evaluated-position/quaternion ordering as placementFingerprint, for the solved WORLD pose.
    placementKey: JSON.stringify([placement.position, placement.rotation]), bodyFeatureId: body.featureId,
    bodyKey: step.key, edgeIndex: edge.index }), centerMm: owned(centerMm), xAxis: owned(xAxis),
    yAxis: owned(yAxis), normal: owned(normal), radiusMm: edge.radius, parameterRange, orientation: basis.orientation });
}
