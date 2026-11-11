import { translateSolidFinite, type CadSolidFiniteOutcome } from '@pointercad/fem';
import { SOLID_FIELD_QUANTITIES, solidFieldLegend, solidFieldValue,
  type SolidFieldMesh, type SolidFieldQuantity } from '../solidAnalysis/solidFieldView.js';

/** Display only; step is the native record's 1-based step, never a new load increment. */
export interface SolidFiniteFieldChoice {
  readonly step: number;
  readonly quantity: SolidFieldQuantity;
  readonly deformationScale: number;
}
export const DEFAULT_SOLID_FINITE_FIELD_VIEW: SolidFiniteFieldChoice = Object.freeze({
  step: 1, quantity: 'vonMises', deformationScale: 1,
});

const finiteRow = (row: readonly number[] | undefined, length: number): boolean =>
  Array.isArray(row) && row.length === length && Array.from(row).every(Number.isFinite);
const sameRow = (left: readonly number[] | undefined, right: readonly number[] | undefined): boolean =>
  left !== undefined && right !== undefined && left.length === right.length
  && Array.from(left).every((value, index) => value === right[index]);
function sameInput(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(translateSolidFinite(left).input) === JSON.stringify(translateSolidFinite(right).input); }
  catch { return false; }
}

/**
 * One admitted finite result, without constructing a linear result. Geometry is the analysed reference mesh;
 * Cauchy sigma is row-major, mapped explicitly to the existing [xx, yy, zz, yz, xz, xy] display utilities.
 * Boundary triangles retain their owning element's constant value, with no nodal stress averaging.
 */
export function buildSolidFiniteFieldMesh(outcome: CadSolidFiniteOutcome | null,
  choice: SolidFiniteFieldChoice): SolidFieldMesh | null {
  if (outcome === null || outcome.kind !== 'result' || !Number.isSafeInteger(choice.step) || choice.step < 1
    || !SOLID_FIELD_QUANTITIES.includes(choice.quantity) || !Number.isFinite(choice.deformationScale)
    || choice.deformationScale < 0) return null;
  const { input, result, prepared, mesh } = outcome, { plan, source } = input;
  if (!sameInput(result.input, input) || result.units !== 'N-mm-MPa'
    || result.refusedCommits.length !== 0 || result.records.length !== plan.steps
    || Array.from(result.records).some((record, index) => record === undefined || record.step !== index + 1)
    || prepared.input.source.documentId !== source.documentId || prepared.input.source.revision !== source.revision
    || mesh.input.source.documentId !== source.documentId || mesh.input.source.revision !== source.revision
    || prepared.input.source.meshKey !== mesh.inputSha256) return null;
  const { nodes, elements } = plan, record = result.records[choice.step - 1];
  if (record === undefined || record.step !== choice.step || nodes.length !== prepared.input.nodes.length
    || elements.length !== prepared.input.elements.length || record.displacementMm.length !== nodes.length
    || record.elements.length !== elements.length || mesh.coordinates.length !== nodes.length * 3
    || mesh.tetrahedra.length !== elements.length * 4) return null;
  for (let node = 0; node < nodes.length; node += 1) {
    if (!finiteRow(nodes[node], 3) || !finiteRow(record.displacementMm[node], 3)
      || !sameRow(nodes[node], prepared.input.nodes[node])
      || !sameRow(nodes[node], mesh.coordinates.slice(node * 3, node * 3 + 3))) return null;
  }
  const elementValues: number[] = [], tetrahedra = new Set<string>();
  const faces = new Map<string, { readonly element: number; readonly corners: readonly [number, number, number]; count: number }>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index], state = record.elements[index];
    if (state === undefined) return null;
    const sigma = state.sigma;
    if (!sameRow(element, prepared.input.elements[index].nodes)
      || !sameRow(element, mesh.tetrahedra.slice(index * 4, index * 4 + 4)) || !finiteRow(sigma, 9)) return null;
    const key = [...element].sort((left, right) => left - right).join(',');
    if (tetrahedra.has(key)) return null;
    tetrahedra.add(key);
    elementValues.push(solidFieldValue([sigma[0], sigma[4], sigma[8], sigma[5], sigma[2], sigma[1]], choice.quantity));
    const [a, b, c, d] = element;
    for (const corners of [[a, c, b], [a, b, d], [a, d, c], [b, c, d]] as const) {
      const faceKey = [...corners].sort((left, right) => left - right).join(',');
      const prior = faces.get(faceKey);
      if (prior === undefined) faces.set(faceKey, { element: index, corners, count: 1 });
      else { prior.count += 1; if (prior.count > 2) return null; }
    }
  }
  const legend = solidFieldLegend(elementValues);
  if (legend === null) return null;
  const positions: number[] = [], triangleElements: number[] = [];
  for (const face of faces.values()) {
    if (face.count !== 1) continue;
    for (const node of face.corners) {
      const point = nodes[node], move = record.displacementMm[node];
      for (let axis = 0; axis < 3; axis += 1) positions.push(point[axis] + choice.deformationScale * move[axis]);
    }
    triangleElements.push(face.element);
  }
  if (triangleElements.length === 0 || positions.some(value => !Number.isFinite(value))) return null;
  return { quantity: choice.quantity, deformationScale: choice.deformationScale, positions, triangleElements, elementValues, legend };
}
