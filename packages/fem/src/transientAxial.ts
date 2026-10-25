import type { Vector3 } from './analysisModel.js';
import type { BeamTransientInput, BeamTransientResult } from './transientModel.js';
import { transientResultMatches } from './transientResults.js';
import { translateBeamTransient } from './transientTranslation.js';

/** One signed extreme among the emitted samples only (never between them), with its sample time. */
export interface TransientAxialExtreme {
  readonly sample: number;
  readonly timeS: number;
  readonly strain: number;
  readonly stressPa: number;
}
/** Linear axial measure of one original CAD member from its two end nodes:
 * strain = ((u_end - u_start) . x) / L and stress = E * strain, with x the unit start->end axis of the
 * undeformed member, L its undeformed length in m and E the member's Young modulus in Pa.
 * This is the mean axial strain over the whole member (the change of its chord length). It is not bending
 * stress, combined or equivalent stress, a yield or fatigue check, or the strain inside a subdivided member. */
export interface TransientMemberAxial {
  readonly memberId: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly startSolverNode: number;
  readonly endSolverNode: number;
  readonly lengthM: number;
  readonly axis: Vector3;
  readonly youngPa: number;
  /** One value per emitted sample, in sample order; tension positive, compression negative. */
  readonly strain: readonly number[];
  readonly stressPa: readonly number[];
  /** Largest signed strain (most tensile) and smallest (most compressive); the first sample wins a tie. */
  readonly maximum: TransientAxialExtreme;
  readonly minimum: TransientAxialExtreme;
}
export interface TransientAxialResponse {
  readonly measure: 'member-mean-linear-axial-from-sampled-end-translations/1';
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly inputSha256: string;
  readonly sampleTimesS: readonly number[];
  readonly members: readonly TransientMemberAxial[];
}
type MemberGeometry = Pick<TransientMemberAxial, 'memberId' | 'startNodeId' | 'endNodeId' | 'lengthM' | 'axis' | 'youngPa'>;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`transient-axial: non-finite ${label}`);
  return value;
}

/** The single arithmetic for both the derivation and the content association below. */
function memberSeries(result: BeamTransientResult, geometry: MemberGeometry): TransientMemberAxial {
  const startIndex = result.samples[0].nodes.findIndex(node => node.nodeId === geometry.startNodeId);
  const endIndex = result.samples[0].nodes.findIndex(node => node.nodeId === geometry.endNodeId);
  if (startIndex < 0 || endIndex < 0) throw new Error('transient-axial: member end node is missing');
  const { axis, lengthM, youngPa } = geometry;
  const strain = result.samples.map(sample => {
    const a = sample.nodes[startIndex].displacementM, b = sample.nodes[endIndex].displacementM;
    return finite(((b[0] - a[0]) * axis[0] + (b[1] - a[1]) * axis[1] + (b[2] - a[2]) * axis[2]) / lengthM, 'strain');
  });
  const stressPa = strain.map(value => finite(youngPa * value, 'stress'));
  let high = 0, low = 0;
  strain.forEach((value, index) => {
    if (value > strain[high]) high = index;
    if (value < strain[low]) low = index;
  });
  const extreme = (index: number): TransientAxialExtreme => ({ sample: index, timeS: result.samples[index].timeS,
    strain: strain[index], stressPa: stressPa[index] });
  return { ...geometry, startSolverNode: result.samples[0].nodes[startIndex].solverNode,
    endSolverNode: result.samples[0].nodes[endIndex].solverNode, strain, stressPa,
    maximum: extreme(high), minimum: extreme(low) };
}

/** Derives the axial measure from a validated result and the input it was computed for.
 * Trusted-caller contract: `input` must be the exact input FemClient.analyzeTransient verified this result against,
 * where the SHA-256 digest of the input was compared with the result (client.ts). This synchronous function does not
 * recompute that digest. It re-decodes the result against `input` (shape, times, load factors, supports, rest at
 * time 0 and peaks) and rejects any mismatch or non-finite derived value with `transient-axial: ...`.
 * No solve is repeated. */
export function transientAxialResponse(result: BeamTransientResult, input: BeamTransientInput): TransientAxialResponse {
  if (!transientResultMatches(result, input, result.inputSha256)) {
    throw new Error('transient-axial: result does not match its input');
  }
  const geometry = translateBeamTransient(input).input.geometry;
  const lengthScale = geometry.units === 'N-mm' ? 0.001 : 1;
  const positions = new Map(geometry.nodes.map(node => [node.id, node.position]));
  const materials = new Map(geometry.materials.map(material => [material.id, material.youngModulus]));
  const members = geometry.members.map((member): TransientMemberAxial => {
    const start = positions.get(member.startNodeId), end = positions.get(member.endNodeId);
    const young = materials.get(member.materialId);
    if (start === undefined || end === undefined || young === undefined) {
      throw new Error('transient-axial: member end node or material is missing');
    }
    const chord: Vector3 = [(end[0] - start[0]) * lengthScale, (end[1] - start[1]) * lengthScale,
      (end[2] - start[2]) * lengthScale];
    const lengthM = finite(Math.hypot(...chord), 'length');
    if (!(lengthM > 0)) throw new Error('transient-axial: zero-length member');
    const axis: Vector3 = [chord[0] / lengthM, chord[1] / lengthM, chord[2] / lengthM];
    // youngModulus is N/length^2 in the document unit system (analysisModel.ts); Pa = N/m^2. The translation
    // already bounds it to (1e-30, 1e30] Pa, so this check is defensive.
    const youngPa = finite(young / (lengthScale * lengthScale), 'Young modulus');
    return memberSeries(result, { memberId: member.id, startNodeId: member.startNodeId, endNodeId: member.endNodeId,
      lengthM, axis, youngPa });
  });
  return { measure: 'member-mean-linear-axial-from-sampled-end-translations/1', analysisId: result.analysisId,
    analysisRevision: result.analysisRevision, inputSha256: result.inputSha256,
    sampleTimesS: result.samples.map(sample => sample.timeS), members };
}

function sameExtreme(a: TransientAxialExtreme, b: TransientAxialExtreme): boolean {
  return a.sample === b.sample && a.timeS === b.timeS && a.strain === b.strain && a.stressPa === b.stressPa;
}

/** True only when the derived measure belongs to this displayed result: the same digest, id, revision and time grid,
 * and every stored strain, stress, extreme and solver node recomputed from this result's own displacements with the
 * stored member geometry (members x samples products, no hashing). A different result on the same grid fails. */
export function transientAxialMatches(axial: TransientAxialResponse | null, result: BeamTransientResult): boolean {
  if (axial === null || axial.inputSha256 !== result.inputSha256 || axial.analysisId !== result.analysisId
    || axial.analysisRevision !== result.analysisRevision || axial.sampleTimesS.length !== result.samples.length
    || !axial.sampleTimesS.every((time, index) => time === result.samples[index].timeS)) return false;
  try {
    return axial.members.every(member => {
      const again = memberSeries(result, member);
      return again.startSolverNode === member.startSolverNode && again.endSolverNode === member.endSolverNode
        && member.strain.length === again.strain.length
        && again.strain.every((value, index) => value === member.strain[index] && again.stressPa[index] === member.stressPa[index])
        && sameExtreme(again.maximum, member.maximum) && sameExtreme(again.minimum, member.minimum);
    });
  } catch { return false; }
}
