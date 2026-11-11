import { summarizeSolidYield, type CadSolidOutcome } from '@pointercad/fem';
import type { MessageKey } from '../i18n/t.js';
import { buildSolidFieldMesh, type SolidFieldMesh } from './solidFieldView.js';

type Outcome = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector = readonly [number, number, number];
/** Display unit of each probe quantity, as message keys (the shown text always comes from the i18n table). */
export const SOLID_PROBE_UNITS = {
  length: 'solidAnalysis.unitLength', stress: 'solidAnalysis.unitStress', force: 'solidAnalysis.unitForce',
  energy: 'solidAnalysis.unitEnergy', strain: 'solidAnalysis.dimensionless',
} as const satisfies Readonly<Record<string, MessageKey>>;
/** Same identifier as the CSV metadata `coordinates` row (packages/fem/src/solidResultReport.ts). */
const SOLID_PROBE_COORDINATES = 'global-XYZ-undeformed';
export interface SolidElementProbe {
  readonly elementIndex: number;
  readonly materialId: string;
  readonly strain: readonly number[];
  readonly stressMPa: readonly number[];
  readonly vonMisesMPa: number;
  /** von Mises equivalent strain sqrt(2/3 e':e') of the engineering strain (tensor shear = gamma / 2), dimensionless. */
  readonly equivalentStrain: number;
  /** Element strain energy V / 2 (eps . sigma) with engineering shear strains, N·mm. */
  readonly strainEnergyNmm: number;
  /** Yield point or proof stress of the material evidence divided by von Mises; not a design safety factor. */
  readonly yieldRatio: number | null;
  /** Why `yieldRatio` is null: no material yield evidence, or exactly zero equivalent stress (never Infinity). */
  readonly capacityMissing: boolean;
  readonly zeroStress: boolean;
  readonly units: typeof SOLID_PROBE_UNITS;
  /** Document global XYZ components; positions are the undeformed analysed nodes. */
  readonly coordinates: typeof SOLID_PROBE_COORDINATES;
  readonly nodes: readonly { readonly index: number; readonly positionMm: Vector;
    readonly displacementMm: Vector; readonly reactionN: Vector }[];
}

/** (sqrt(2) / 3) sqrt((xx - yy)^2 + (yy - zz)^2 + (zz - xx)^2 + 3/2 (yz^2 + xz^2 + xy^2)) for [xx, yy, zz, yz, xz, xy]
 * engineering strains; equals |eps| for an incompressible uniaxial strain. */
export function equivalentStrain(strain: readonly number[]): number {
  const [x, y, z, yz, xz, xy] = strain;
  return Math.SQRT2 / 3 * Math.sqrt((x - y) ** 2 + (y - z) ** 2 + (z - x) ** 2 + 1.5 * (yz ** 2 + xz ** 2 + xy ** 2));
}
/** Signed Tet4 volume det[X1 - X0, X2 - X0, X3 - X0] / 6 in mm^3. */
function tetVolumeMm3([a, b, c, d]: readonly Vector[]): number {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const e3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  return (e1[0] * (e2[1] * e3[2] - e2[2] * e3[1]) - e1[1] * (e2[0] * e3[2] - e2[2] * e3[0])
    + e1[2] * (e2[0] * e3[1] - e2[1] * e3[0])) / 6;
}

/** Uses original Tet4 and node indices. Display deformation is never applied to displacement. */
export async function readSolidElementProbe(outcome: Outcome, field: SolidFieldMesh, elementIndex: number): Promise<SolidElementProbe | null> {
  if (!Number.isSafeInteger(elementIndex) || elementIndex < 0) return null;
  const snapshot = JSON.stringify(outcome);
  try {
    // Existing FEM validator checks full input digest, native forces and the result, not a caller-supplied hash.
    const summary = await summarizeSolidYield(outcome.prepared.input, outcome.result);
    if (JSON.stringify(outcome) !== snapshot) return null;
    const currentField = buildSolidFieldMesh(outcome, field.quantity, field.deformationScale);
    if (currentField === null || JSON.stringify(currentField) !== JSON.stringify(field)) return null;
    const element = outcome.prepared.input.elements[elementIndex];
    const result = outcome.result.elements[elementIndex];
    const capacity = summary.elements[elementIndex];
    if (element === undefined || result === undefined || capacity === undefined
      || capacity.elementIndex !== elementIndex || capacity.materialId !== element.materialId) return null;
    const nodes = element.nodes.map(index => ({ index, positionMm: outcome.prepared.input.nodes[index],
      displacementMm: outcome.result.displacementMm[index], reactionN: outcome.result.reactionN[index] }));
    if (nodes.some(node => !Number.isSafeInteger(node.index) || node.index < 0
      || [node.positionMm, node.displacementMm, node.reactionN].some(vector => vector === undefined
        || vector.length !== 3 || vector.some(value => !Number.isFinite(value))))) return null;
    const volume = tetVolumeMm3(nodes.map(node => node.positionMm));
    const strainEnergyNmm = volume / 2 * result.strain.reduce((sum, value, index) => sum + value * result.stressMPa[index], 0);
    const equivalent = equivalentStrain(result.strain);
    if (!(volume > 0) || !Number.isFinite(strainEnergyNmm) || !Number.isFinite(equivalent)) return null;
    return { elementIndex, materialId: element.materialId, strain: result.strain, stressMPa: result.stressMPa,
      vonMisesMPa: capacity.vonMisesMPa, equivalentStrain: equivalent, strainEnergyNmm, yieldRatio: capacity.yieldRatio,
      capacityMissing: capacity.capacity === null, zeroStress: capacity.zeroStress, units: SOLID_PROBE_UNITS,
      coordinates: SOLID_PROBE_COORDINATES, nodes };
  } catch { return null; }
}
