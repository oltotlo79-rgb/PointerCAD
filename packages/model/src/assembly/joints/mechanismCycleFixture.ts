/** Test-only constructions and oracles. Never import the coupling law, residuals or joint-value readers here. */
import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { composePlacement, IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument, Joint, MechanismCamCoupling, MechanismGearCoupling } from '../types.js';
import type { JointFrame, JointFramePair } from './jointFrames.js';

type Vector = readonly [number, number, number];
const X: Vector = [1, 0, 0], Y: Vector = [0, 1, 0], Z: Vector = [0, 0, 1];
const DEG = Math.PI / 180;
const frame: JointFrame = { origin: [0, 0, 0], x: X, y: Y, z: Z };
const sliderFrame: JointFrame = { origin: [0, 0, 0], x: Y, y: Z, z: X };
const add = (a: Vector, b: Vector): Vector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const oracleDistance = (a: Vector, b: Vector): number => Math.hypot(...subtract(a, b));

/** Expand q v q* directly, independently of the model's placement/frame transforms. */
export function oracleDirection(placement: RigidPlacement, v: Vector): Vector {
  const [x, y, z, w] = placement.rotation;
  const n = x * x + y * y + z * z + w * w;
  if (!Number.isFinite(n) || n === 0) throw new Error('Invalid oracle quaternion');
  return [
    ((w * w + x * x - y * y - z * z) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2]) / n,
    (2 * (x * y + w * z) * v[0] + (w * w - x * x + y * y - z * z) * v[1] + 2 * (y * z - w * x) * v[2]) / n,
    (2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (w * w - x * x - y * y + z * z) * v[2]) / n,
  ];
}

export const oraclePoint = (placement: RigidPlacement, v: Vector): Vector => add(placement.position, oracleDirection(placement, v));

export function requireCyclePlacement(placements: ReadonlyMap<string, RigidPlacement>, id: string): RigidPlacement {
  const found = placements.get(id);
  if (found === undefined) throw new Error(`Missing cycle fixture placement: ${id}`);
  return found;
}

/** Read the signed angle from world basis vectors; a reference only selects the 360-degree representative. */
export function oracleAngle(support: RigidPlacement, moving: RigidPlacement, reference: number, movingOnA = true): number {
  const a = oracleDirection(support, X), b = oracleDirection(moving, X), axis = oracleDirection(support, Z);
  const principal = (movingOnA ? -1 : 1) * Math.atan2(dot(cross(a, b), axis), dot(a, b)) / DEG;
  return principal + 360 * Math.round((reference - principal) / 360);
}

/** atan2 of the basis-vector cross/dot avoids acos losing precision near a zero rotation. */
export function oraclePoseError(a: RigidPlacement, b: RigidPlacement): { positionMm: number; orientationDeg: number } {
  const angles = [X, Y, Z].map(axis => {
    const u = oracleDirection(a, axis), v = oracleDirection(b, axis);
    return Math.atan2(Math.hypot(...cross(u, v)), dot(u, v)) / DEG;
  });
  return { positionMm: oracleDistance(a.position, b.position), orientationDeg: Math.max(...angles) };
}

export interface CycleCamDimensions {
  readonly radiusMm: number;
  readonly eccentricityMm: number;
  readonly rollerRadiusMm: number;
  readonly phaseDeg: number;
}

/** Circle/line intersection: (s-e cos u)^2 + (e sin u)^2 = (R+r)^2, positive outer root. */
export function oracleRollerDistance(dimensions: CycleCamDimensions, angleDeg: number): number {
  const u = (angleDeg - dimensions.phaseDeg) * DEG;
  const x = dimensions.eccentricityMm * Math.cos(u), y = dimensions.eccentricityMm * Math.sin(u);
  const reach = dimensions.radiusMm + dimensions.rollerRadiusMm;
  return x + Math.sqrt((reach - y) * (reach + y));
}

export interface CycleCamGeometry {
  readonly dimensions: CycleCamDimensions;
  readonly camId: string;
  readonly followerId: string;
  readonly pivot: Vector;
  readonly side: 1 | -1;
  readonly camOnA: boolean;
}

export function oracleCamErrors(geometry: CycleCamGeometry, placements: ReadonlyMap<string, RigidPlacement>, target: number) {
  const { dimensions: d, camId, followerId, pivot, side, camOnA } = geometry;
  const support = requireCyclePlacement(placements, 'ground');
  const cam = requireCyclePlacement(placements, camId), follower = requireCyclePlacement(placements, followerId);
  const phase = d.phaseDeg * DEG * (camOnA ? 1 : -1);
  const centre = oraclePoint(cam, [side * d.eccentricityMm * Math.cos(phase), side * d.eccentricityMm * Math.sin(phase), 0]);
  const expected = oraclePoint(support, add(pivot, [side * oracleRollerDistance(d, target), 0, 0]));
  const span = subtract(follower.position, oraclePoint(support, pivot));
  return {
    positionMm: oracleDistance(follower.position, expected),
    contactGapMm: Math.abs(oracleDistance(follower.position, centre) - d.radiusMm - d.rollerRadiusMm),
    guideMm: Math.hypot(...cross(span, oracleDirection(support, X))),
    angleDeg: Math.abs(oracleAngle(support, cam, target, camOnA) - target),
    followerOrientationDeg: oraclePoseError(support, follower).orientationDeg,
  };
}

function component(id: string, placement: RigidPlacement): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'oracle-part' }, fixed: id === 'ground', visible: true,
    suppressed: false, placement: { position: [expressionValueFromNumber(placement.position[0]),
      expressionValueFromNumber(placement.position[1]), expressionValueFromNumber(placement.position[2])], rotation: placement.rotation } };
}

function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'origin' },
    b: { kind: 'origin', componentId: b, element: 'origin' }, minValue: null, maxValue: null, suppressed: false };
}

function camDefinition(id: string, camJointId: string, followerJointId: string, d: CycleCamDimensions, referenceAngleCam = 0): MechanismCamCoupling {
  return { id, kind: 'cam', camJointId, followerJointId, discRadiusMm: expressionValueFromNumber(d.radiusMm),
    eccentricityMm: expressionValueFromNumber(d.eccentricityMm), rollerRadiusMm: expressionValueFromNumber(d.rollerRadiusMm),
    phaseDeg: expressionValueFromNumber(d.phaseDeg), referenceAngleCam, suppressed: false };
}

export const CYCLE_TRANSFORM: RigidPlacement = { position: [12, -17, 23],
  rotation: quaternionFromAxisAngle([2 / 3, -1 / 3, 2 / 3], 0.8) };

export function createCamCycleFixture(dimensions: CycleCamDimensions, layout: {
  readonly side: 1 | -1; readonly camOnA: boolean; readonly followerOnA: boolean; readonly transform?: RigidPlacement;
}) {
  const transform = layout.transform ?? IDENTITY_PLACEMENT;
  const placements = new Map<string, RigidPlacement>([['ground', transform], ['cam', transform], ['follower',
    composePlacement(transform, { ...IDENTITY_PLACEMENT, position: [layout.side * oracleRollerDistance(dimensions, 0), 0, 0] })]]);
  const joints = [joint('jc', 'revolute', layout.camOnA ? 'cam' : 'ground', layout.camOnA ? 'ground' : 'cam'),
    joint('jf', 'slider', layout.followerOnA ? 'follower' : 'ground', layout.followerOnA ? 'ground' : 'follower')];
  const guide = { ...sliderFrame, origin: [-7, 0, 0] as Vector };
  const frames = new Map<string, JointFramePair>([['jc', { a: frame, b: frame }], ['jf',
    layout.followerOnA ? { a: sliderFrame, b: guide } : { a: guide, b: sliderFrame }]]);
  const assembly: AssemblyDocument = { ...createAssemblyDocument('Independent cam cycle'), joints,
    components: [...placements].map(([id, pose]) => component(id, pose)), camCouplings: [camDefinition('cam-cycle', 'jc', 'jf', dimensions)] };
  const geometry: CycleCamGeometry = { dimensions, camId: 'cam', followerId: 'follower', pivot: [0, 0, 0],
    side: layout.side, camOnA: layout.camOnA };
  return { assembly, frames, placements, geometry };
}

export interface AffineCycleEdge {
  readonly from: string;
  readonly to: string;
  readonly ratio: number;
  readonly phaseDeg: number;
}

/** Compose an explicitly ordered closed walk; no graph traversal or admission code is reused. */
export function oracleAffineCycle(edges: readonly AffineCycleEdge[]) {
  if (edges.length === 0) throw new Error('Empty oracle cycle');
  let product = 1, phaseDeg = 0;
  edges.forEach((edge, index) => {
    if (edge.to !== edges[(index + 1) % edges.length].from) throw new Error('Oracle walk is not closed');
    product *= edge.ratio;
    phaseDeg = edge.ratio * phaseDeg + edge.phaseDeg;
  });
  return { product, phaseDeg, returnedAngle: (angle: number) => product * angle + phaseDeg };
}

/** a -> b -> c -> a gear ring, plus a -> cam -> followerA -> two-pin link -> followerC -> cam -> c.
 * Both discs have the same radial law because thetaC=thetaA+13 and phaseC=phaseA+13.
 * The link's two local pins are (0,0,0), (0,60,0). Their world separation must remain exactly 60 mm. */
export function createMechanismCycleFixture(phaseErrorDeg = 0) {
  const dimensions: CycleCamDimensions = { radiusMm: 20, eccentricityMm: 5, rollerRadiusMm: 4, phaseDeg: 25 };
  const camC = { ...dimensions, phaseDeg: 38 };
  const edges: readonly AffineCycleEdge[] = [
    { from: 'ja', to: 'jb', ratio: -2, phaseDeg: 20 },
    { from: 'jb', to: 'jc', ratio: -0.5, phaseDeg: 23 },
    { from: 'jc', to: 'ja', ratio: 1, phaseDeg: -13 + phaseErrorDeg },
  ];
  const mechanismCouplings: MechanismGearCoupling[] = edges.map((edge, i) => ({ id: `ring-${i}`, kind: 'gear',
    jointAId: edge.from, jointBId: edge.to, ratio: expressionValueFromNumber(edge.ratio),
    phaseDeg: expressionValueFromNumber(edge.phaseDeg), referenceAngleA: [0, 20, 13][i], suppressed: false }));
  const reach = oracleRollerDistance(dimensions, 0);
  const placements = new Map<string, RigidPlacement>([['ground', CYCLE_TRANSFORM]]);
  for (const [id, y, angle] of [['a', 0, 0], ['b', -40, 20], ['c', 60, 13]] as const) {
    placements.set(id, composePlacement(CYCLE_TRANSFORM, { position: [0, y, 0], rotation: quaternionFromAxisAngle(Z, -angle * DEG) }));
  }
  for (const [id, y] of [['followerA', 0], ['followerC', 60], ['link', 0]] as const)
    placements.set(id, composePlacement(CYCLE_TRANSFORM, { ...IDENTITY_PLACEMENT, position: [reach, y, 0] }));
  const joints: Joint[] = [joint('ja', 'revolute', 'a', 'ground'), joint('jb', 'revolute', 'b', 'ground'),
    joint('jc', 'revolute', 'c', 'ground'), joint('jfa', 'slider', 'followerA', 'ground'), joint('jfc', 'slider', 'followerC', 'ground'),
    joint('pin-a', 'revolute', 'link', 'followerA'), joint('pin-c', 'revolute', 'link', 'followerC')];
  const frames = new Map<string, JointFramePair>();
  for (const [id, y] of [['ja', 0], ['jb', -40], ['jc', 60]] as const)
    frames.set(id, { a: frame, b: { ...frame, origin: [0, y, 0] } });
  for (const [id, y] of [['jfa', 0], ['jfc', 60]] as const)
    frames.set(id, { a: sliderFrame, b: { ...sliderFrame, origin: [0, y, 0] } });
  frames.set('pin-a', { a: frame, b: frame });
  frames.set('pin-c', { a: { ...frame, origin: [0, 60, 0] }, b: frame });
  const assembly: AssemblyDocument = { ...createAssemblyDocument('Gear cam link cycle'), joints, mechanismCouplings,
    components: [...placements].map(([id, pose]) => component(id, pose)), camCouplings: [
      camDefinition('cam-a', 'ja', 'jfa', dimensions), camDefinition('cam-c', 'jc', 'jfc', camC, 13)] };
  const cams: readonly CycleCamGeometry[] = [
    { dimensions, camId: 'a', followerId: 'followerA', pivot: [0, 0, 0], side: 1, camOnA: true },
    { dimensions: camC, camId: 'c', followerId: 'followerC', pivot: [0, 60, 0], side: 1, camOnA: true },
  ];
  return { assembly, frames, placements, edges, cams };
}

export function oracleLinkErrors(placements: ReadonlyMap<string, RigidPlacement>) {
  const link = requireCyclePlacement(placements, 'link');
  const a = requireCyclePlacement(placements, 'followerA'), c = requireCyclePlacement(placements, 'followerC');
  return { pinAMm: oracleDistance(oraclePoint(link, [0, 0, 0]), a.position),
    pinCMm: oracleDistance(oraclePoint(link, [0, 60, 0]), c.position),
    lengthMm: Math.abs(oracleDistance(a.position, c.position) - 60) };
}
