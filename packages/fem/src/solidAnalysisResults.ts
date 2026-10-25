import type { SolidAnalysisInput, SolidAnalysisResult, SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import { SOLID_LIMITS, solidArray, solidNumber, solidRecord, solidStrainStress, solidTetGeometry,
  solidVector, translateSolidAnalysis } from './solidAnalysisTranslation.js';

export const SOLID_METHOD = 'oofem-ltrspace-isole-native-ldlt/1';
const tolerance = 1e-8;
function fail(message: string): never { throw new Error(`solid-result: ${message}`); }
function near(actual: number, expected: number, scale: number, label: string): void {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || !Number.isFinite(scale)
    || !(Math.abs(actual - expected) <= tolerance * Math.max(1e-300, scale))) fail(label);
}
function vector6(value: unknown): SolidVector6 {
  const values = solidArray(value, 6, 6).map(solidNumber);
  return [values[0], values[1], values[2], values[3], values[4], values[5]];
}
function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length
      || Reflect.ownKeys(left).length !== left.length + 1 || Reflect.ownKeys(right).length !== right.length + 1) return false;
    for (let i = 0; i < left.length; i += 1) if (!Object.hasOwn(left, i) || !Object.hasOwn(right, i) || !same(left[i], right[i])) return false;
    return true;
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return Reflect.ownKeys(a).length === Reflect.ownKeys(b).length && Reflect.ownKeys(a).every(
      key => typeof key === 'string' && Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return left === right;
}

/** Recover constant engineering strains/stresses from the actual native solver
 * displacement. Compare B^T sigma V against every original native K_e u_e action,
 * then check free equilibrium, reaction balance and energy independently. */
export function decodeSolidAnalysis(raw: unknown, value: SolidAnalysisInput, inputSha256: string): SolidAnalysisResult {
  if (!/^[a-f0-9]{64}$/u.test(inputSha256)) fail('invalid digest');
  const { input, plan } = translateSolidAnalysis(value);
  const row = solidRecord(raw, ['schema', 'source', 'displacementMm', 'elementForcesN', 'reservedNumericBytes', 'minimumScaledPivot']);
  if (row.schema !== 'pointercad-solid-tet4-native/1' || !same(row.source, input.source)) fail('native source/schema changed');
  const reservedNumericBytes = solidNumber(row.reservedNumericBytes), minimumScaledPivot = solidNumber(row.minimumScaledPivot);
  if (!Number.isSafeInteger(reservedNumericBytes) || reservedNumericBytes <= 0 || reservedNumericBytes > input.numericBudgetBytes
    || !(minimumScaledPivot > 1e-12 && minimumScaledPivot <= 1 + 1e-10)) fail('native allocation/pivot refusal');
  const displacementMm = solidArray(row.displacementMm, input.nodes.length, input.nodes.length).map(solidVector);
  const nativeActions = solidArray(row.elementForcesN, input.elements.length, input.elements.length)
    .map(value => solidArray(value, 12, 12).map(solidNumber));
  const internal: [number, number, number][] = input.nodes.map(() => [0, 0, 0]);
  const materialMap = new Map(input.materials.map(material => [material.id, material]));
  const loadScale = Math.max(1e-300, ...plan.forcesN.map(v => Math.max(...v.map(Math.abs))));
  let strainEnergyNmm = 0;
  const elements = input.elements.map((element, i) => {
    const material = materialMap.get(element.materialId);
    if (material === undefined) fail('material association changed');
    const geometry = solidTetGeometry(element.nodes.map(node => input.nodes[node]));
    const result = solidStrainStress(geometry.gradients, element.nodes.map(node => displacementMm[node]), material);
    const stress = result.stressMPa;
    const expected: number[] = [];
    for (const [x, y, z] of geometry.gradients) expected.push(
      geometry.volumeMm3 * (x * stress[0] + y * stress[5] + z * stress[4]),
      geometry.volumeMm3 * (x * stress[5] + y * stress[1] + z * stress[3]),
      geometry.volumeMm3 * (x * stress[4] + y * stress[3] + z * stress[2]));
    const scale = Math.max(loadScale, ...expected.map(Math.abs), ...nativeActions[i].map(Math.abs));
    for (let local = 0; local < 4; local += 1) for (let axis = 0; axis < 3; axis += 1) {
      const action = nativeActions[i][3 * local + axis];
      near(action, expected[3 * local + axis], scale, 'native action differs from constant-strain constitutive response');
      internal[element.nodes[local]][axis] = solidNumber(internal[element.nodes[local]][axis] + action);
    }
    const energy = 0.5 * geometry.volumeMm3 * result.strain.reduce((sum, e, component) => sum + e * stress[component], 0);
    if (!Number.isFinite(energy) || energy < 0) fail('invalid strain energy');
    strainEnergyNmm = solidNumber(strainEnergyNmm + energy);
    return result;
  });
  const forceScale = Math.max(loadScale, ...internal.map(v => Math.max(...v.map(Math.abs))));
  let maximumRelativeEquilibriumResidual = 0;
  const reactionN = input.nodes.map((_, node): SolidVector3 => {
    const reaction: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      if (plan.fixed[node][axis]) {
        if (displacementMm[node][axis] !== 0) fail('nonzero fixed translation');
        reaction[axis] = solidNumber(internal[node][axis] - plan.forcesN[node][axis]);
      } else maximumRelativeEquilibriumResidual = Math.max(maximumRelativeEquilibriumResidual,
        Math.abs(internal[node][axis] - plan.forcesN[node][axis]) / forceScale);
    }
    return reaction;
  });
  if (!(maximumRelativeEquilibriumResidual <= tolerance)) fail('free-DOF equilibrium');
  const total: [number, number, number] = [0, 0, 0], moment: [number, number, number] = [0, 0, 0];
  const origin = input.nodes[0];
  let absoluteForce = 0, absoluteMoment = 0, work = 0;
  for (let node = 0; node < input.nodes.length; node += 1) {
    const force = solidVector(plan.forcesN[node].map((v, axis) => v + reactionN[node][axis]));
    const arm = input.nodes[node].map((v, axis) => v - origin[axis]);
    const torque = [arm[1] * force[2] - arm[2] * force[1], arm[2] * force[0] - arm[0] * force[2], arm[0] * force[1] - arm[1] * force[0]];
    for (let axis = 0; axis < 3; axis += 1) {
      total[axis] += force[axis]; moment[axis] += torque[axis];
      absoluteForce += Math.abs(force[axis]); absoluteMoment += Math.abs(torque[axis]);
      work += plan.forcesN[node][axis] * displacementMm[node][axis];
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    near(total[axis], 0, absoluteForce, 'total force balance');
    near(moment[axis], 0, absoluteMoment, 'total moment balance');
  }
  near(2 * strainEnergyNmm, work, Math.max(Math.abs(work), 2 * strainEnergyNmm), 'strain energy/external work');
  return { kind: 'oofem-linear-solid-tet4', method: SOLID_METHOD, units: 'N-mm-MPa', structuralCertification: false,
    source: input.source, inputSha256, displacementMm, reactionN, elements, strainEnergyNmm,
    maximumRelativeEquilibriumResidual, reservedNumericBytes, nativeElementForcesN: nativeActions, minimumScaledPivot };
}

/** Shape gate only; the client additionally recomputes the complete association. */
export function isSolidAnalysisResult(value: unknown): value is SolidAnalysisResult {
  try {
    const row = solidRecord(value, ['kind', 'source', 'inputSha256', 'method', 'units', 'structuralCertification',
      'displacementMm', 'reactionN', 'elements', 'strainEnergyNmm', 'maximumRelativeEquilibriumResidual', 'reservedNumericBytes',
      'nativeElementForcesN', 'minimumScaledPivot']);
    if (row.kind !== 'oofem-linear-solid-tet4' || row.method !== SOLID_METHOD || row.units !== 'N-mm-MPa'
      || row.structuralCertification !== false || typeof row.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.inputSha256)) return false;
    const source = solidRecord(row.source, ['documentId', 'revision', 'meshKey']);
    if (typeof source.documentId !== 'string' || typeof source.meshKey !== 'string'
      || typeof source.revision !== 'number' || !Number.isSafeInteger(source.revision) || source.revision < 0) return false;
    const displacements = solidArray(row.displacementMm, SOLID_LIMITS.nodes, 4).map(solidVector);
    solidArray(row.reactionN, displacements.length, displacements.length).map(solidVector);
    for (const value of solidArray(row.elements, SOLID_LIMITS.elements, 1)) {
      const element = solidRecord(value, ['strain', 'stressMPa']); vector6(element.strain); vector6(element.stressMPa);
    }
    for (const force of solidArray(row.nativeElementForcesN, SOLID_LIMITS.elements, 1)) solidArray(force, 12, 12).map(solidNumber);
    const pivot = solidNumber(row.minimumScaledPivot), bytes = solidNumber(row.reservedNumericBytes);
    return solidNumber(row.strainEnergyNmm) >= 0 && solidNumber(row.maximumRelativeEquilibriumResidual) >= 0
      && solidNumber(row.maximumRelativeEquilibriumResidual) <= tolerance && Number.isSafeInteger(bytes)
      && bytes > 0 && pivot > 1e-12 && pivot <= 1 + 1e-10;
  } catch { return false; }
}

/** Re-decode original native actions against the current input and compare all
 * derived values. Property insertion order is irrelevant; vector order is not. */
export function solidResultMatches(value: unknown, input: SolidAnalysisInput, hash: string): value is SolidAnalysisResult {
  if (!isSolidAnalysisResult(value) || value.inputSha256 !== hash || !same(value.source, input.source)) return false;
  try {
    const decoded = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: value.source,
      displacementMm: value.displacementMm, elementForcesN: value.nativeElementForcesN,
      reservedNumericBytes: value.reservedNumericBytes, minimumScaledPivot: value.minimumScaledPivot }, input, hash);
    return same(value, decoded);
  } catch { return false; }
}
