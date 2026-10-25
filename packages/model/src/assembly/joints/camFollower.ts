import { crossVec3, dotVec3, lengthVec3, subVec3 } from '../../sketch/vec3.js';
import type { Joint } from '../types.js';
import type { RigidPlacement } from '../placementMath.js';
import { DEFAULT_RIGID_CHARACTERISTIC_LENGTH } from '../constraints/solveRigid.js';
import type { MateVariableSet } from '../constraints/mateVariables.js';
import { driveJointRows, jointValue } from './driveJoint.js';
import { transformJointFrame, type JointFramePair } from './jointFrames.js';
import { prepareJointResiduals, type JointResidualInput, type JointResidualSkipReason,
  type PreparedJointResidual } from './jointResiduals.js';
import type { MechanismCouplingRow } from './mechanismCoupling.js';

/**
 * Circular eccentric disc cam (revolute joint) driving an in-line translating roller follower (slider joint).
 * Evaluated numeric input only; persisted dimensions are ExpressionValue like the gear relation.
 *
 * Topology: the cam joint and the slider share exactly one component (the support). The other component of the cam
 * joint is the cam, the other component of the slider is the follower. The origin of the slider frame on the follower
 * is the roller centre (the knife tip when r = 0).
 *
 * Contact kinematics (exact for this geometry, no force model): with u = theta - phase, the distance from the
 * cam axis to the roller centre is rho(u) = e cos u + sqrt((R + r)^2 - e^2 sin^2 u). The row makes the actual
 * distance of the roller centre from the cam axis equal rho(theta), so an authored pose out of contact is pulled into
 * contact by the solver like a mate, or the solve fails and the scene is kept.
 * Validity: R > 0, r >= 0, 0 <= e < R + r. The joints must be in line (follower axis perpendicular to and
 * intersecting the cam axis) at the reference pose. Solid-to-solid contact of the CAD bodies is NOT checked:
 * the assembly solver has no body distance query, so contact means the authored dimensions, not certified contact.
 */
export interface CamFollowerCoupling {
  readonly id: string;
  readonly kind: 'cam';
  /** Revolute joint carrying the disc cam. */
  readonly camJointId: string;
  /** Slider joint carrying the follower. */
  readonly followerJointId: string;
  readonly discRadiusMm: number;
  readonly eccentricityMm: number;
  /** 0 is a knife-edge follower. */
  readonly rollerRadiusMm: number;
  /** Cam angle (deg) at which the eccentricity points along the follower axis toward the follower. */
  readonly phaseDeg: number;
  readonly referenceAngleCam: number;
  readonly suppressed: boolean;
}

export type CamFollowerFailureReason = JointResidualSkipReason | 'missingJoint' | 'suppressedJoint' | 'duplicateJoint'
  | 'duplicateCoupling' | 'duplicateReference' | 'unsupportedJoint' | 'unsupportedTopology' | 'invalidCamDimensions'
  | 'invalidPhase' | 'invalidReference' | 'notInLine' | 'multipleDrivers' | 'unrepresentableCoupling';
export interface CamFollowerFailure {
  readonly ok: false;
  readonly couplingId: string;
  readonly reason: CamFollowerFailureReason;
}
export interface PreparedCamFollower {
  readonly definition: CamFollowerCoupling;
  readonly cam: PreparedJointResidual;
  readonly follower: PreparedJointResidual;
  /** d(distance of the roller centre from the cam axis) / d(slider translation): +1 or -1. The slider translation is
   * (o_a - o_b) . b.z, so the sign depends on the side of the cam axis and on which slider side is the follower. */
  readonly direction: 1 | -1;
  /** Support-fixed guide coordinate of the cam axis times the side (mm): distance = direction * x - offset. */
  readonly offsetMm: number;
  /** asin(e / (R + r)) in degrees: the largest pressure angle of the in-line follower. */
  readonly maximumPressureAngleDeg: number;
}

const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const DEG = Math.PI / 180;
/** Relative tolerance of the in-line check (perpendicular and intersecting axes at the reference pose). */
const IN_LINE_TOLERANCE = 1e-9;
const LENGTH_TOLERANCE_MM = 1e-9;
const refusal = (couplingId: string, reason: CamFollowerFailureReason): CamFollowerFailure =>
  ({ ok: false, couplingId, reason });

/** Distance from the cam axis to the roller centre (mm) at cam angle thetaDeg. */
export function camFollowerLift(c: Pick<CamFollowerCoupling, 'discRadiusMm' | 'eccentricityMm' | 'rollerRadiusMm' | 'phaseDeg'>,
  thetaDeg: number): number {
  const u = (thetaDeg - c.phaseDeg) * DEG, reach = c.discRadiusMm + c.rollerRadiusMm, e = c.eccentricityMm;
  return e * Math.cos(u) + Math.sqrt(reach * reach - e * e * Math.sin(u) ** 2);
}

/** d rho / d theta in mm per radian. */
export function camFollowerLiftSlope(c: Pick<CamFollowerCoupling, 'discRadiusMm' | 'eccentricityMm' | 'rollerRadiusMm' | 'phaseDeg'>,
  thetaDeg: number): number {
  const u = (thetaDeg - c.phaseDeg) * DEG, reach = c.discRadiusMm + c.rollerRadiusMm, e = c.eccentricityMm;
  const root = Math.sqrt(reach * reach - e * e * Math.sin(u) ** 2);
  return -e * Math.sin(u) - e * e * Math.sin(u) * Math.cos(u) / root;
}

/** Dimension admission: the follower stays in contact for every angle only when e < R + r. */
export function camDimensionFailure(c: CamFollowerCoupling): CamFollowerFailure | null {
  if (!finite(c.discRadiusMm) || !finite(c.eccentricityMm) || !finite(c.rollerRadiusMm)
    || c.discRadiusMm <= 0 || c.rollerRadiusMm < 0 || c.eccentricityMm < 0
    || c.eccentricityMm >= c.discRadiusMm + c.rollerRadiusMm) return refusal(c.id, 'invalidCamDimensions');
  if (!finite(c.phaseDeg)) return refusal(c.id, 'invalidPhase');
  if (!finite(c.referenceAngleCam)) return refusal(c.id, 'invalidReference');
  return null;
}

/** The single component shared by the cam joint and the slider, or null when they share none or both. */
function sharedSupport(cam: PreparedJointResidual, follower: PreparedJointResidual): string | null {
  const shared = [follower.componentA, follower.componentB].filter(id => id === cam.componentA || id === cam.componentB);
  return shared.length === 1 && follower.componentA !== follower.componentB ? shared[0] : null;
}

/** In-line check on the support-fixed guide, not on the transient roller (Astra review r1, blocker 1).
 * The slider keeps the relative rotation of its frames from the start of a solve (jointResiduals.ts slider rows) and
 * constrains o_a - o_b to b.z, so the follower travels on the guide line through the support-side slider origin g with
 * world direction w = b.z; both are fixed to the support. The guide must be perpendicular to the cam axis (support-side
 * cam frame) and intersect it; t = (c - g) . w is the guide coordinate of that intersection. With f = +1 for the follower
 * on slider side a (roller = g + x w) and -1 on side b (roller = g - x w), the signed roller coordinate from the cam axis
 * is f x - t. Its sign s at the authored pose fixes the side (0 cannot tell it and is refused); then the distance is
 * s (f x - t) = direction x - offset with direction = s f and offset = s t, a support-fixed scalar. The authored roller
 * may be out of contact or off the guide: the rows pull it onto the guide and into contact. Inputs are only read. */
function inLineGeometry(cam: PreparedJointResidual, follower: PreparedJointResidual, support: string,
  placements: ReadonlyMap<string, RigidPlacement>, reachMm: number, translationMm: number):
  { direction: 1 | -1; offsetMm: number } | null {
  const camOnA = cam.componentA === support, followerIsA = follower.componentB === support;
  const supportPlacement = placements.get(support), placementB = placements.get(follower.componentB);
  if (supportPlacement === undefined || placementB === undefined) return null;
  const camFrame = transformJointFrame(camOnA ? cam.frames.a : cam.frames.b, supportPlacement);
  const guide = transformJointFrame(followerIsA ? follower.frames.b : follower.frames.a, supportPlacement);
  const sliderB = transformJointFrame(follower.frames.b, placementB);
  if (camFrame === null || guide === null || sliderB === null) return null;
  const axis = sliderB.z;
  if (Math.abs(dotVec3(camFrame.z, axis)) > IN_LINE_TOLERANCE) return null;
  const normal = crossVec3(camFrame.z, axis), size = lengthVec3(normal);
  if (!finite(size) || size <= 0) return null;
  const tolerance = Math.max(LENGTH_TOLERANCE_MM, IN_LINE_TOLERANCE * reachMm);
  const gap = Math.abs(dotVec3(subVec3(guide.origin, camFrame.origin), normal)) / size;
  if (gap > tolerance) return null;
  const crossing = dotVec3(subVec3(camFrame.origin, guide.origin), axis);
  const signed = (followerIsA ? 1 : -1) * translationMm - crossing;
  if (!finite(crossing) || !finite(signed) || Math.abs(signed) <= tolerance) return null;
  const side = signed > 0 ? 1 : -1;
  return { direction: side * (followerIsA ? 1 : -1) > 0 ? 1 : -1, offsetMm: side * crossing };
}

/** Validate the complete active cam set before returning any prepared relation. */
export function prepareCamFollowers(input: {
  readonly couplings: readonly CamFollowerCoupling[];
  readonly joints: readonly Joint[];
  readonly frames: ReadonlyMap<string, JointFramePair>;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  /** Joints already driven by another relation (gear rows, an explicit drive): a follower among them is refused. */
  readonly drivenJointIds: ReadonlySet<string>;
}): CamFollowerFailure | { readonly ok: true; readonly prepared: readonly PreparedCamFollower[] } {
  const ids = new Set<string>(), followers = new Set<string>(), joints = new Map<string, Joint>(), duplicates = new Set<string>();
  for (const joint of input.joints) { if (joints.has(joint.id)) duplicates.add(joint.id); joints.set(joint.id, joint); }
  const noVariables: MateVariableSet = { variables: [], initial: [], movableComponentIds: [], frozen: new Map(),
    tooMany: false, columnOf: () => null, componentOf: () => null };
  const prepared: PreparedCamFollower[] = [];
  for (const c of input.couplings) {
    if (ids.has(c.id)) return refusal(c.id, 'duplicateCoupling'); ids.add(c.id);
    const dimensions = camDimensionFailure(c); if (dimensions !== null) return dimensions;
    if (c.suppressed) continue;
    if (c.camJointId === c.followerJointId) return refusal(c.id, 'duplicateReference');
    if (followers.has(c.followerJointId) || input.drivenJointIds.has(c.followerJointId)) return refusal(c.id, 'multipleDrivers');
    followers.add(c.followerJointId);
    const originals: Joint[] = [];
    for (const [id, kind] of [[c.camJointId, 'revolute'], [c.followerJointId, 'slider']] as const) {
      if (duplicates.has(id)) return refusal(c.id, 'duplicateJoint');
      const joint = joints.get(id);
      if (joint === undefined) return refusal(c.id, 'missingJoint');
      if (joint.suppressed) return refusal(c.id, 'suppressedJoint');
      if (joint.kind !== kind) return refusal(c.id, 'unsupportedJoint');
      originals.push(joint);
    }
    const report = prepareJointResiduals({ joints: originals, frames: input.frames, placements: input.placements });
    if (report.skipped.length > 0) return refusal(c.id, report.skipped[0].reason);
    const [cam, follower] = report.joints;
    if (cam === undefined || follower === undefined) return refusal(c.id, 'missingFrame');
    const support = sharedSupport(cam, follower);
    if (support === null) return refusal(c.id, 'unsupportedTopology');
    const angle = jointValue({ joint: cam, coordinate: 'angle', referenceAngle: c.referenceAngleCam,
      placements: input.placements, variableSet: noVariables });
    const translation = jointValue({ joint: follower, coordinate: 'translation', placements: input.placements,
      variableSet: noVariables });
    if (!angle.ok || !translation.ok) return refusal(c.id, 'invalidReference');
    const geometry = inLineGeometry(cam, follower, support, input.placements, c.discRadiusMm + c.rollerRadiusMm,
      translation.value);
    if (geometry === null) return refusal(c.id, 'notInLine');
    const maximumPressureAngleDeg = Math.asin(c.eccentricityMm / (c.discRadiusMm + c.rollerRadiusMm)) / DEG;
    if (!finite(geometry.offsetMm) || !finite(maximumPressureAngleDeg)) return refusal(c.id, 'unrepresentableCoupling');
    prepared.push({ definition: { ...c }, cam, follower, direction: geometry.direction, offsetMm: geometry.offsetMm,
      maximumPressureAngleDeg });
  }
  return { ok: true, prepared };
}

/** One permanent row per cam in the existing analytic joint chart:
 * (d*x - offset - rho(theta)) / L = (distance - rho(theta)) / L, gradient d*grad(x)/L - rho'(theta)/L * grad(theta). */
export function camFollowerRows(input: Omit<JointResidualInput, 'joints'> & {
  readonly prepared: readonly PreparedCamFollower[];
  readonly references: ReadonlyMap<string, number>;
}): CamFollowerFailure | { readonly ok: true; readonly rows: readonly MechanismCouplingRow[] } {
  const length = input.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  const rows: MechanismCouplingRow[] = [];
  for (const c of input.prepared) {
    const reference = input.references.get(c.cam.jointId) ?? c.definition.referenceAngleCam;
    const angle = driveJointRows({ ...input, joint: c.cam, coordinate: 'angle', referenceAngle: reference, target: 0 });
    const translation = driveJointRows({ ...input, joint: c.follower, coordinate: 'translation', target: 0 });
    if (!angle.ok || !translation.ok) return refusal(c.definition.id, 'rotationBranch');
    const thetaDeg = angle.actual, lift = camFollowerLift(c.definition, thetaDeg);
    const slope = camFollowerLiftSlope(c.definition, thetaDeg);
    const value = c.direction * translation.rows[0].value - (c.offsetMm + lift) / length;
    const gradient = new Map<number, number>([...translation.rows[0].gradient].map(([column, v]) => [column, c.direction * v] as const));
    for (const [column, v] of angle.rows[0].gradient) gradient.set(column, (gradient.get(column) ?? 0) - slope / length * v);
    if (!finite(value) || [...gradient.values()].some(v => !finite(v))) return refusal(c.definition.id, 'unrepresentableCoupling');
    rows.push({ couplingId: c.definition.id, jointAId: c.cam.jointId, jointBId: c.follower.jointId, value, gradient,
      // Same unit, scale and default tolerance as an existing translation drive row (driveJointRows).
      scale: 1 / length, unit: 'length',
      constant: angle.rows[0].constant === true && translation.rows[0].constant === true });
  }
  return { ok: true, rows };
}
