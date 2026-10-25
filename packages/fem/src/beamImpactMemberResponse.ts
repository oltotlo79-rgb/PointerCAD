import type { Vector3 } from './analysisModel.js';
import { beamFrame } from './analysisValidation.js';
import { beamImpactResultMatches } from './beamImpactBinding.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { translateBeamImpact } from './beamImpactTranslation.js';

/** One signed extreme among the emitted samples only (never between them); the first sample wins a tie. */
export interface ImpactMemberExtreme {
  readonly sample: number;
  readonly timeS: number;
  readonly value: number;
}
export interface ImpactMemberSeries {
  /** One value per emitted sample, in sample order. */
  readonly values: readonly number[];
  readonly maximum: ImpactMemberExtreme;
  readonly minimum: ImpactMemberExtreme;
}
/** Member-mean section resultants of one original CAD member from its two sampled end nodes, in SI units on the
 * member frame of beamFrame (x start->end, y = localYHint projected normal to x, z = x cross y; the section
 * principal axes are local y/z and the shear centre is the centroid, analysisModel.ts). With d = end - start:
 *   axial strain = (d u . x) / L, axial stress = E strain (Pa, tension positive), axial force = E A strain (N),
 *   torque = G J (d theta . x) / L (N m), bending moment about y = E Iy (d theta . y) / L, about z = E Iz (d theta . z) / L,
 * moments as right-hand vectors on the local axes. For the linear elastic small-displacement beam of the impact scope
 * the section resultant is stiffness times the rate of the section rotation (or of the axial displacement), so its
 * length-weighted mean over the member equals the end difference divided by L regardless of the segment count.
 * These are member means, not end, peak or interior section forces: under double curvature the mean moment is zero
 * while the end moments are not. Fibre bending stress, torsional shear stress, transverse shear, combined or
 * equivalent stress and any yield check are unassessed (see IMPACT_MEMBER_UNASSESSED). */
export interface ImpactMemberResponse {
  readonly memberId: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly startSolverNode: number;
  readonly endSolverNode: number;
  readonly lengthM: number;
  readonly frame: { readonly x: Vector3; readonly y: Vector3; readonly z: Vector3 };
  readonly youngPa: number;
  readonly shearPa: number;
  readonly areaM2: number;
  readonly iyM4: number;
  readonly izM4: number;
  readonly torsionM4: number;
  readonly axialStrain: ImpactMemberSeries;
  readonly axialStressPa: ImpactMemberSeries;
  readonly axialForceN: ImpactMemberSeries;
  readonly meanTorqueNm: ImpactMemberSeries;
  readonly meanMomentYNm: ImpactMemberSeries;
  readonly meanMomentZNm: ImpactMemberSeries;
}
/** Quantities this measure does not provide and why; the consumer must show them as unassessed, never as zero. */
export const IMPACT_MEMBER_UNASSESSED = {
  'end-and-interior-section-forces': 'the impact result holds original CAD node responses only, not mesh-interior nodes or element end forces',
  'bending-fibre-stress': 'BeamSection has no extreme-fibre distance or section modulus',
  'torsional-shear-stress': 'BeamSection has no torsion section modulus or wall thickness',
  'transverse-shear': 'shear resultants need interior moment gradients that the samples do not hold',
  'combined-or-equivalent-stress': 'needs the fibre and shear stresses above',
  'yield-check': 'BeamMaterial has no sourced yield strength or other allowable',
} as const;
export interface ImpactMemberResponseSet {
  readonly measure: 'member-mean-linear-section-resultants-from-sampled-end-responses/1';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly inputSha256: string;
  readonly sampleTimesS: readonly number[];
  readonly members: readonly ImpactMemberResponse[];
  readonly unassessed: typeof IMPACT_MEMBER_UNASSESSED;
}
type MemberProperties = Omit<ImpactMemberResponse, 'startSolverNode' | 'endSolverNode' | 'axialStrain' | 'axialStressPa'
  | 'axialForceN' | 'meanTorqueNm' | 'meanMomentYNm' | 'meanMomentZNm'>;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`impact-member: non-finite ${label}`);
  return value;
}
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const difference = (a: Vector3, b: Vector3): Vector3 => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];

function series(result: BeamImpactResult, values: readonly number[]): ImpactMemberSeries {
  let high = 0, low = 0;
  values.forEach((value, index) => {
    if (value > values[high]) high = index;
    if (value < values[low]) low = index;
  });
  const extreme = (index: number): ImpactMemberExtreme => ({ sample: index, timeS: result.samples[index].timeS, value: values[index] });
  return { values, maximum: extreme(high), minimum: extreme(low) };
}

/** The single arithmetic for both the derivation and the content association below. */
function memberSeries(result: BeamImpactResult, member: MemberProperties): ImpactMemberResponse {
  const startIndex = result.samples[0].nodes.findIndex(node => node.nodeId === member.startNodeId);
  const endIndex = result.samples[0].nodes.findIndex(node => node.nodeId === member.endNodeId);
  if (startIndex < 0 || endIndex < 0) throw new Error('impact-member: member end node is missing');
  const { frame, lengthM } = member;
  const strain: number[] = [], twist: number[] = [], bendY: number[] = [], bendZ: number[] = [];
  for (const sample of result.samples) {
    const a = sample.nodes[startIndex], b = sample.nodes[endIndex];
    const du = difference(a.displacementM, b.displacementM), dtheta = difference(a.rotationRad, b.rotationRad);
    strain.push(finite(dot(du, frame.x) / lengthM, 'axial strain'));
    twist.push(finite(dot(dtheta, frame.x) / lengthM, 'twist rate'));
    bendY.push(finite(dot(dtheta, frame.y) / lengthM, 'curvature about y'));
    bendZ.push(finite(dot(dtheta, frame.z) / lengthM, 'curvature about z'));
  }
  const times = (values: readonly number[], factor: number, label: string): number[] =>
    values.map(value => finite(factor * value, label));
  return { ...member, startSolverNode: result.samples[0].nodes[startIndex].solverNode,
    endSolverNode: result.samples[0].nodes[endIndex].solverNode,
    axialStrain: series(result, strain),
    axialStressPa: series(result, times(strain, member.youngPa, 'axial stress')),
    axialForceN: series(result, times(strain, finite(member.youngPa * member.areaM2, 'axial stiffness'), 'axial force')),
    meanTorqueNm: series(result, times(twist, finite(member.shearPa * member.torsionM4, 'torsional stiffness'), 'torque')),
    meanMomentYNm: series(result, times(bendY, finite(member.youngPa * member.iyM4, 'bending stiffness y'), 'moment about y')),
    meanMomentZNm: series(result, times(bendZ, finite(member.youngPa * member.izM4, 'bending stiffness z'), 'moment about z')) };
}

/** Derives the member-mean resultants from a validated impact result and the input it was computed for.
 * Trusted-caller contract as transientAxialResponse: `input` must be the exact input FemClient verified this result
 * against by SHA-256 (client.ts); this synchronous function does not recompute the digest. It re-decodes the result
 * against `input` through beamImpactResultMatches (shape, times, rest at t = 0, supports, gaps, energy and peaks) and
 * rejects any mismatch or non-finite derived value with `impact-member: ...`. No solve is repeated and the energy,
 * momentum and contact fields of the result are neither read nor changed. */
export function impactMemberResponse(result: BeamImpactResult, input: BeamImpactInput): ImpactMemberResponseSet {
  if (!beamImpactResultMatches(result, input, result.inputSha256)) {
    throw new Error('impact-member: result does not match its input');
  }
  const geometry = translateBeamImpact(input).input.geometry;
  const lengthScale = geometry.units === 'N-mm' ? 0.001 : 1;
  const positions = new Map(geometry.nodes.map(node => [node.id, node.position]));
  const materials = new Map(geometry.materials.map(material => [material.id, material]));
  const sections = new Map(geometry.sections.map(section => [section.id, section]));
  const members = geometry.members.map((member): ImpactMemberResponse => {
    const start = positions.get(member.startNodeId), end = positions.get(member.endNodeId);
    const material = materials.get(member.materialId), section = sections.get(member.sectionId);
    if (start === undefined || end === undefined || material === undefined || section === undefined) {
      throw new Error('impact-member: member end node, material or section is missing');
    }
    const { x, y, z, lengthM } = beamFrame(start, end, member.localYHint, lengthScale);
    if (!(finite(lengthM, 'length') > 0)) throw new Error('impact-member: zero-length member');
    // Document units: moduli N/length^2, area length^2, second moments and J length^4 (analysisModel.ts).
    const square = lengthScale * lengthScale;
    return memberSeries(result, { memberId: member.id, startNodeId: member.startNodeId, endNodeId: member.endNodeId,
      lengthM, frame: { x, y, z }, youngPa: finite(material.youngModulus / square, 'Young modulus'),
      shearPa: finite(material.shearModulus / square, 'shear modulus'), areaM2: finite(section.area * square, 'area'),
      iyM4: finite(section.iy * square * square, 'Iy'), izM4: finite(section.iz * square * square, 'Iz'),
      torsionM4: finite(section.torsionConstant * square * square, 'torsion constant') });
  });
  return { measure: 'member-mean-linear-section-resultants-from-sampled-end-responses/1', analysisId: result.analysisId,
    analysisRevision: result.analysisRevision, inputSha256: result.inputSha256,
    sampleTimesS: result.samples.map(sample => sample.timeS), members, unassessed: IMPACT_MEMBER_UNASSESSED };
}

function sameSeries(a: ImpactMemberSeries, b: ImpactMemberSeries): boolean {
  const same = (p: ImpactMemberExtreme, q: ImpactMemberExtreme): boolean =>
    p.sample === q.sample && p.timeS === q.timeS && p.value === q.value;
  return a.values.length === b.values.length && a.values.every((value, index) => value === b.values[index])
    && same(a.maximum, b.maximum) && same(a.minimum, b.minimum);
}

/** True only when the derived set belongs to this displayed result: the same digest, id, revision and time grid,
 * and every stored series recomputed from this result's own end responses with the stored member properties. */
export function impactMemberResponseMatches(set: ImpactMemberResponseSet | null, result: BeamImpactResult): boolean {
  if (set === null || set.inputSha256 !== result.inputSha256 || set.analysisId !== result.analysisId
    || set.analysisRevision !== result.analysisRevision || set.sampleTimesS.length !== result.samples.length
    || !set.sampleTimesS.every((time, index) => time === result.samples[index].timeS)) return false;
  try {
    return set.members.every(member => {
      const again = memberSeries(result, member);
      return again.startSolverNode === member.startSolverNode && again.endSolverNode === member.endSolverNode
        && sameSeries(again.axialStrain, member.axialStrain) && sameSeries(again.axialStressPa, member.axialStressPa)
        && sameSeries(again.axialForceN, member.axialForceN) && sameSeries(again.meanTorqueNm, member.meanTorqueNm)
        && sameSeries(again.meanMomentYNm, member.meanMomentYNm) && sameSeries(again.meanMomentZNm, member.meanMomentZNm);
    });
  } catch { return false; }
}
