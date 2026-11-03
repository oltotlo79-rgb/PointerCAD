import { summarizeSolidYield, type CadSolidOutcome } from '@pointercad/fem';
import { buildSolidFieldMesh, type SolidFieldMesh } from './solidFieldView.js';

type Outcome = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector = readonly [number, number, number];
export interface SolidElementProbe {
  readonly elementIndex: number;
  readonly materialId: string;
  readonly strain: readonly number[];
  readonly stressMPa: readonly number[];
  readonly vonMisesMPa: number;
  /** Yield point or proof stress of the material evidence divided by von Mises; not a design safety factor. */
  readonly yieldRatio: number | null;
  /** Why `yieldRatio` is null: no material yield evidence, or exactly zero equivalent stress (never Infinity). */
  readonly capacityMissing: boolean;
  readonly zeroStress: boolean;
  readonly nodes: readonly { readonly index: number; readonly positionMm: Vector;
    readonly displacementMm: Vector; readonly reactionN: Vector }[];
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
    return { elementIndex, materialId: element.materialId, strain: result.strain, stressMPa: result.stressMPa,
      vonMisesMPa: capacity.vonMisesMPa, yieldRatio: capacity.yieldRatio,
      capacityMissing: capacity.capacity === null, zeroStress: capacity.zeroStress, nodes };
  } catch { return null; }
}
