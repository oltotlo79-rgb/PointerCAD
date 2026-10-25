import type { SolidMaterial, SolidVector3 } from './solidAnalysisModel.js';
import { solidArray, solidNumber, solidRecord, solidStrainStress, solidTetGeometry, solidVector } from './solidAnalysisTranslation.js';
import type { SolidModalInput, SolidModalMode, SolidModalResult } from './solidModalModel.js';
import { solidModalReservedBytes, translateSolidModal } from './solidModalTranslation.js';

export const SOLID_MODAL_METHOD = 'oofem-ltrspace-isole-consistent-mass-numpy-eigh/1';
const NATIVE_FIELDS = ['schema', 'source', 'massMatrix', 'units', 'modes', 'totalMassT', 'rigidBodyModes', 'freeDofs',
  'maximumMassOrthogonalityError', 'maximumRigidMotionResidual', 'maximumElementMassError', 'reservedNumericBytes'];
const MODE_FIELDS = ['number', 'eigenvaluePerSecondSquared', 'frequencyHz', 'normalizedResidual', 'massNormalizedShapePerSqrtT'];
const tolerance = 1e-8;
function fail(message: string): never { throw new Error(`solid-modal-result: ${message}`); }
function bounded(value: unknown, maximum: number, label: string): number {
  const result = solidNumber(value);
  if (!(result >= 0 && result <= maximum)) fail(label);
  return result;
}
interface Operator {
  readonly nodes: readonly number[];
  readonly gradients: readonly SolidVector3[];
  readonly volumeMm3: number;
  readonly material: SolidMaterial;
  readonly densityTPerMm3: number;
}
/** Closed-form CST stiffness action V B^T sigma (the constitutive response the static decoder checks against
 * every native K_e u_e) and consistent tet4 mass action rho V / 20 (sum_b u_b + u_a), both per node. */
function act(operators: readonly Operator[], count: number, field: readonly SolidVector3[]): { stiffness: number[][]; mass: number[][] } {
  const stiffness = Array.from({ length: count }, () => [0, 0, 0]), mass = Array.from({ length: count }, () => [0, 0, 0]);
  for (const element of operators) {
    const local = element.nodes.map(node => field[node]);
    const s = solidStrainStress(element.gradients, local, element.material).stressMPa;
    const sum = [0, 1, 2].map(axis => local.reduce((total, v) => total + v[axis], 0));
    const scale = element.densityTPerMm3 * element.volumeMm3 / 20;
    element.nodes.forEach((node, a) => {
      const [x, y, z] = element.gradients[a];
      const force = [x * s[0] + y * s[5] + z * s[4], x * s[5] + y * s[1] + z * s[3], x * s[4] + y * s[3] + z * s[2]];
      for (let axis = 0; axis < 3; axis += 1) {
        stiffness[node][axis] += element.volumeMm3 * force[axis];
        mass[node][axis] += scale * (sum[axis] + local[a][axis]);
      }
    });
  }
  return { stiffness, mass };
}
function dot(field: readonly SolidVector3[], action: readonly number[][]): number {
  return field.reduce((sum, v, node) => sum + v[0] * action[node][0] + v[1] * action[node][1] + v[2] * action[node][2], 0);
}

/** Strict native/2 reader. Every mode is re-checked against an independent closed-form stiffness and mass:
 * eigen-residual, mass orthonormality and, free-free, orthogonality to the six rigid motions. Lowest-ness of
 * the returned modes is the native eigh result and is not re-proved here. */
export function decodeSolidModal(raw: unknown, value: SolidModalInput, inputSha256: string): SolidModalResult {
  if (!/^[a-f0-9]{64}$/u.test(inputSha256)) fail('invalid digest');
  const { input, plan, applicability } = translateSolidModal(value);
  const row = solidRecord(raw, NATIVE_FIELDS);
  if (row.schema !== 'pointercad-solid-tet4-modal-native/2' || row.massMatrix !== 'consistent' || row.units !== 'N-mm-MPa-t-s')
    fail('native schema, mass matrix or units changed');
  const source = solidRecord(row.source, ['documentId', 'revision', 'meshKey']);
  if (source.documentId !== input.source.documentId || source.revision !== input.source.revision
    || source.meshKey !== input.source.meshKey) fail('native source changed');
  const count = plan.nodes.length;
  const freeDofs = plan.fixed.reduce((sum, flags) => sum + flags.filter(flag => !flag).length, 0);
  const rigidBodyModes = applicability === 'free-free' ? 6 : 0;
  if (row.rigidBodyModes !== rigidBodyModes || row.freeDofs !== freeDofs) fail('rigid-body or free DOF count changed');
  const reservedNumericBytes = solidNumber(row.reservedNumericBytes);
  if (reservedNumericBytes !== solidModalReservedBytes(count) || reservedNumericBytes > input.numericBudgetBytes)
    fail('native dense reservation differs from the request');
  const maximumMassOrthogonalityError = bounded(row.maximumMassOrthogonalityError, tolerance, 'native mass orthogonality');
  const maximumRigidMotionResidual = bounded(row.maximumRigidMotionResidual, applicability === 'free-free' ? 1e-10 : 0,
    'native rigid-motion residual');
  const maximumElementMassError = bounded(row.maximumElementMassError, 1e-10, 'native element mass is not the consistent tet4 mass');
  const materials = new Map(plan.materials.map(material => [material.id, material]));
  const operators = plan.elements.map((element): Operator => {
    const material = materials.get(element.materialId);
    if (material === undefined) fail('material association changed');
    const geometry = solidTetGeometry(element.nodes.map(node => plan.nodes[node]));
    return { nodes: element.nodes, gradients: geometry.gradients, volumeMm3: geometry.volumeMm3,
      material: { id: material.id, youngMPa: material.youngMPa, poisson: material.poisson }, densityTPerMm3: material.densityTPerMm3 };
  });
  const expectedMass = operators.reduce((sum, element) => sum + element.densityTPerMm3 * element.volumeMm3, 0);
  const totalMassT = solidNumber(row.totalMassT);
  if (!(Math.abs(totalMassT - expectedMass) <= expectedMass * 1e-10)) fail('total mass differs from rho V in t');
  let previous = 0;
  const modes = solidArray(row.modes, plan.modeCount, plan.modeCount).map((value, index): SolidModalMode => {
    const mode = solidRecord(value, MODE_FIELDS);
    if (mode.number !== index + 1) fail('mode numbering');
    const eigenvaluePerSecondSquared = solidNumber(mode.eigenvaluePerSecondSquared), frequencyHz = solidNumber(mode.frequencyHz);
    if (!(eigenvaluePerSecondSquared > 0) || eigenvaluePerSecondSquared < previous) fail('eigenvalues must be positive and ascending');
    previous = eigenvaluePerSecondSquared;
    if (!(Math.abs(frequencyHz - Math.sqrt(eigenvaluePerSecondSquared) / (2 * Math.PI)) <= frequencyHz * 1e-12))
      fail('frequency is not sqrt(eigenvalue) / 2 pi');
    const shape = solidArray(mode.massNormalizedShapePerSqrtT, count, count).map(solidVector);
    shape.forEach((v, node) => { for (let axis = 0; axis < 3; axis += 1) if (plan.fixed[node][axis] && v[axis] !== 0) fail('restrained translation in a mode shape'); });
    return { number: index + 1, eigenvaluePerSecondSquared, frequencyHz,
      normalizedResidual: bounded(mode.normalizedResidual, tolerance, 'native eigen-residual'), massNormalizedShapePerSqrtT: shape };
  });
  const actions = modes.map(mode => act(operators, count, mode.massNormalizedShapePerSqrtT));
  let independentMaximumResidual = 0;
  modes.forEach((mode, i) => {
    const lambda = mode.eigenvaluePerSecondSquared;
    let error = 0, stiffnessNorm = 0, massNorm = 0;
    for (let node = 0; node < count; node += 1) for (let axis = 0; axis < 3; axis += 1) if (!plan.fixed[node][axis]) {
      const k = actions[i].stiffness[node][axis], m = actions[i].mass[node][axis];
      error += (k - lambda * m) ** 2; stiffnessNorm += k * k; massNorm += m * m;
    }
    const denominator = Math.sqrt(stiffnessNorm) + lambda * Math.sqrt(massNorm), residual = Math.sqrt(error) / denominator;
    if (!(denominator > 0) || !(residual <= tolerance)) fail('independent eigen-residual exceeded 1e-8');
    independentMaximumResidual = Math.max(independentMaximumResidual, residual);
  });
  let independentMaximumOrthogonalityError = 0;
  modes.forEach((mode, i) => actions.forEach((action, j) => {
    const error = Math.abs(dot(mode.massNormalizedShapePerSqrtT, action.mass) - (i === j ? 1 : 0));
    if (!(error <= tolerance)) fail('independent mass orthonormality exceeded 1e-8');
    independentMaximumOrthogonalityError = Math.max(independentMaximumOrthogonalityError, error);
  }));
  if (applicability === 'free-free') {
    const centre = [0, 1, 2].map(axis => plan.nodes.reduce((sum, p) => sum + p[axis], 0) / count);
    const unit: SolidVector3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const rigid = [...unit.map(t => plan.nodes.map(() => t)), ...unit.map(([a, b, c]) => plan.nodes.map(([x, y, z]): SolidVector3 => {
      const [dx, dy, dz] = [x - centre[0], y - centre[1], z - centre[2]];
      return [b * dz - c * dy, c * dx - a * dz, a * dy - b * dx];
    }))];
    for (const motion of rigid) {
      const norm = Math.sqrt(dot(motion, act(operators, count, motion).mass));
      for (const action of actions) if (!(Math.abs(dot(motion, action.mass)) <= tolerance * norm)) fail('mode is not mass-orthogonal to rigid motion');
    }
  }
  return { kind: 'oofem-solid-tet4-modal', method: SOLID_MODAL_METHOD, source: input.source, inputSha256, units: 'N-mm-MPa-t-s',
    structuralCertification: false, applicability, nodes: plan.nodes, fixed: plan.fixed, rigidBodyModes, freeDofs, totalMassT, modes,
    maximumMassOrthogonalityError, maximumRigidMotionResidual, maximumElementMassError, reservedNumericBytes,
    independentMaximumResidual, independentMaximumOrthogonalityError };
}
