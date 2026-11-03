import { createPrefixedError } from './valueGuards.js';
import { subVec3 as sub, crossVec3 as cross, dotVec3 as dot } from '@pointercad/model/vec3';
import { sha256Hex } from './sha256.js';
import type { SolidAnalysisInput, SolidAnalysisPlan, SolidMaterial, SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import { readOptionalMaterialCapacity } from '@pointercad/model/beam-analysis';

/** Same node/element capacity as the existing tet4 mesh contract. */
export const SOLID_LIMITS = { nodes: 10000, elements: 50000, materials: 50000, loads: 200000 } as const;
const fail: (message: string) => never = createPrefixedError('solid-input');
export function solidRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) fail('unexpected fields');
  return row;
}
export function solidArray(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail('invalid dense bounded array');
  const array: unknown[] = value;
  for (let index = 0; index < array.length; index += 1) if (!Object.hasOwn(array, index)) fail('sparse array');
  return array;
}
export function solidNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('non-finite number');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) fail('invalid identity');
  return value;
}
export function solidVector(value: unknown): [number, number, number] {
  const row = solidArray(value, 3, 3);
  return [solidNumber(row[0]), solidNumber(row[1]), solidNumber(row[2])];
}
function index(value: unknown, count: number): number {
  const result = solidNumber(value);
  if (!Number.isSafeInteger(result) || result < 0 || result >= count) fail('invalid node index');
  return result;
}
/** Inverse of the physical Jacobian, without a centroid or sampled approximation. */
export function solidTetGeometry(points: readonly SolidVector3[]): { volumeMm3: number; gradients: readonly SolidVector3[] } {
  if (points.length !== 4) fail('tet4 requires four points');
  const a = sub(points[1], points[0]), b = sub(points[2], points[0]), c = sub(points[3], points[0]);
  const determinant = solidNumber(dot(a, cross(b, c)));
  if (!(determinant > 0)) fail('non-positive tetrahedron volume');
  const gradients = [cross(b, c), cross(c, a), cross(a, b)].map(v => solidVector(v.map(x => x / determinant)));
  const first = solidVector([0, 1, 2].map(axis => -gradients.reduce((sum, v) => sum + v[axis], 0)));
  const volumeMm3 = solidNumber(determinant / 6);
  if (!(volumeMm3 > 0) || !first.every(Number.isFinite)) fail('unresolved tetrahedron scale');
  return { volumeMm3, gradients: [first, ...gradients] };
}
/** Engineering shear order matches the native ltrspace source/proof: yz,xz,xy. */
export function solidStrainStress(gradients: readonly SolidVector3[], displacement: readonly SolidVector3[], material: SolidMaterial): {
  strain: SolidVector6; stressMPa: SolidVector6;
} {
  const derivative = (component: number, axis: number): number => gradients.reduce(
    // The gradient of a common translation is exactly zero. Subtract it before
    // multiplying so rigid motion cannot cancel small elastic deformation.
    (sum, gradient, node) => sum + gradient[axis] * (displacement[node][component] - displacement[0][component]), 0);
  const strain: SolidVector6 = [derivative(0, 0), derivative(1, 1), derivative(2, 2),
    derivative(1, 2) + derivative(2, 1), derivative(0, 2) + derivative(2, 0), derivative(0, 1) + derivative(1, 0)];
  const shear = material.youngMPa / (2 * (1 + material.poisson));
  const lambda = material.youngMPa * material.poisson / ((1 + material.poisson) * (1 - 2 * material.poisson));
  const trace = strain[0] + strain[1] + strain[2];
  const stressMPa: SolidVector6 = [2 * shear * strain[0] + lambda * trace, 2 * shear * strain[1] + lambda * trace,
    2 * shear * strain[2] + lambda * trace, shear * strain[3], shear * strain[4], shear * strain[5]];
  if (![...strain, ...stressMPa].every(Number.isFinite)) fail('non-finite strain/stress');
  return { strain, stressMPa };
}

/** Fresh ownership, strict fields, explicit boundary-face loads, no geometry ties. */
export function translateSolidAnalysis(value: unknown): { input: SolidAnalysisInput; plan: SolidAnalysisPlan } {
  const hasGravity = value !== null && typeof value === 'object' && Object.hasOwn(value, 'gravity');
  const row = solidRecord(value, ['schema', 'source', 'units', 'numericBudgetBytes', 'nodes', 'elements', 'materials',
    'constraints', 'nodalLoads', 'surfaceLoads', ...(hasGravity ? ['gravity'] : [])]);
  if (row.schema !== 'pointercad-solid-tet4/1' || row.units !== 'N-mm-MPa') fail('unsupported schema or units');
  const numericBudgetBytes = solidNumber(row.numericBudgetBytes);
  if (!Number.isSafeInteger(numericBudgetBytes) || numericBudgetBytes <= 0) fail('explicit numeric budget required');
  const sourceRow = solidRecord(row.source, ['documentId', 'revision', 'meshKey']);
  const revision = solidNumber(sourceRow.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid source revision');
  const source = { documentId: text(sourceRow.documentId), revision, meshKey: text(sourceRow.meshKey) };
  const nodes = solidArray(row.nodes, SOLID_LIMITS.nodes, 4).map(solidVector);
  const materials = solidArray(row.materials, SOLID_LIMITS.materials, 1).map(value => {
    const hasCapacity = value !== null && typeof value === 'object' && Object.hasOwn(value, 'capacity');
    const material = solidRecord(value, ['id', 'youngMPa', 'poisson', ...(hasCapacity ? ['capacity'] : [])]);
    const youngMPa = solidNumber(material.youngMPa), poisson = solidNumber(material.poisson);
    if (!(youngMPa > 0) || !(poisson > -1 && poisson < 0.5)) fail('invalid isotropic material');
    if (![youngMPa / (2 * (1 + poisson)), youngMPa / (3 * (1 - 2 * poisson))].every(v => Number.isFinite(v) && v > 0))
      fail('unresolved material scale');
    return { id: text(material.id), youngMPa, poisson, ...readOptionalMaterialCapacity(material, 'materials') };
  });
  const materialIds = new Set(materials.map(material => material.id));
  if (materialIds.size !== materials.length) fail('duplicate material');
  const parent: number[] = [];
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) { const next = parent[i]; parent[i] = root; i = next; }
    return root;
  };
  const faces = new Map<string, { element: number; count: number; parity: number }>();
  const used = new Set<number>(), elementKeys = new Set<string>();
  const elements = solidArray(row.elements, SOLID_LIMITS.elements, 1).map((value, elementIndex) => {
    parent.push(elementIndex);
    const element = solidRecord(value, ['nodes', 'materialId']);
    const ids = solidArray(element.nodes, 4, 4).map(v => index(v, nodes.length));
    if (new Set(ids).size !== 4) fail('repeated tetrahedron node');
    const key = [...ids].sort((a, b) => a - b).join(',');
    if (elementKeys.has(key)) fail('duplicate tetrahedron');
    elementKeys.add(key);
    const materialId = text(element.materialId);
    if (!materialIds.has(materialId)) fail('missing material');
    solidTetGeometry(ids.map(i => nodes[i]));
    for (const id of ids) used.add(id);
    for (let omitted = 0; omitted < 4; omitted += 1) {
      const faceIds = ids.filter((_, i) => i !== omitted);
      let inversions = omitted;
      for (let a = 0; a < 3; a += 1) for (let b = a + 1; b < 3; b += 1) if (faceIds[a] > faceIds[b]) inversions += 1;
      const parity = inversions % 2;
      const face = faceIds.sort((a, b) => a - b).join(',');
      const previous = faces.get(face), count = (previous?.count ?? 0) + 1;
      if (count > 2) fail('nonmanifold tetrahedron face');
      if (previous !== undefined) {
        if (previous.parity === parity) fail('same-side shared tetrahedron face');
        parent[find(elementIndex)] = find(previous.element);
      }
      faces.set(face, { element: elementIndex, count, parity });
    }
    return { nodes: [ids[0], ids[1], ids[2], ids[3]] as const, materialId };
  });
  if (used.size !== nodes.length) fail('unused unconstrained node');
  const fixed: [boolean, boolean, boolean][] = nodes.map(() => [false, false, false]);
  let prescribedMm: [number, number, number][] | undefined;
  const constrained = new Set<number>();
  const constraints = solidArray(row.constraints, nodes.length).map(value => {
    const hasPrescribed = value !== null && typeof value === 'object' && Object.hasOwn(value, 'prescribedMm');
    const item = solidRecord(value, ['node', 'fixed', ...(hasPrescribed ? ['prescribedMm'] : [])]);
    const node = index(item.node, nodes.length);
    if (constrained.has(node)) fail('duplicate constraint node');
    constrained.add(node);
    const flags = solidArray(item.fixed, 3, 3);
    if (flags.some(flag => typeof flag !== 'boolean') || !flags.some(flag => flag === true)) fail('invalid translation restraints');
    const tuple: [boolean, boolean, boolean] = [flags[0] === true, flags[1] === true, flags[2] === true];
    fixed[node] = tuple;
    if (hasPrescribed) {
      const displacement = solidVector(item.prescribedMm);
      if (displacement.some((v, axis) => !tuple[axis] && v !== 0)) fail('prescribed displacement on an unrestrained axis');
      prescribedMm ??= nodes.map(() => [0, 0, 0]);
      prescribedMm[node] = [...displacement];
      return { node, fixed: tuple, prescribedMm: displacement };
    }
    return { node, fixed: tuple };
  });
  // A positive-volume tet has exactly six rigid modes. A full shared triangular
  // face propagates the same rigid motion to its neighbor. Point/edge-only
  // connections are not an implicit tie/contact law and are refused explicitly.
  const components = new Map<number, number[]>();
  const nodeComponents = new Map<number, number>();
  for (let element = 0; element < elements.length; element += 1) {
    const root = find(element), component = components.get(root) ?? [];
    for (const node of elements[element].nodes) {
      const previous = nodeComponents.get(node);
      if (previous !== undefined && previous !== root) fail('point/edge-only connection requires an explicit interface law');
      if (previous === undefined) { nodeComponents.set(node, root); component.push(node); }
    }
    components.set(root, component);
  }
  for (const component of components.values()) {
    const origin = nodes[component[0]];
    const length = Math.max(...component.map(i => Math.hypot(...sub(nodes[i], origin))));
    if (!(length > 0) || !Number.isFinite(length)) fail('invalid component extent');
    const basis: number[][] = [];
    for (const node of component) {
      const [x, y, z] = sub(nodes[node], origin).map(v => v / length);
      const rows = [[1, 0, 0, 0, z, -y], [0, 1, 0, -z, 0, x], [0, 0, 1, y, -x, 0]];
      for (let axis = 0; axis < 3; axis += 1) if (fixed[node][axis]) {
        const vector = [...rows[axis]];
        for (const direction of basis) {
          const projection = vector.reduce((sum, v, i) => sum + v * direction[i], 0);
          for (let i = 0; i < 6; i += 1) vector[i] -= projection * direction[i];
        }
        const norm = Math.hypot(...vector);
        if (norm > 1e-12) basis.push(vector.map(v => v / norm));
      }
    }
    if (basis.length !== 6) fail('unrestrained component rigid-body motion');
  }
  const forcesN: [number, number, number][] = nodes.map(() => [0, 0, 0]);
  const add = (node: number, force: SolidVector3): void => {
    for (let axis = 0; axis < 3; axis += 1) forcesN[node][axis] = solidNumber(forcesN[node][axis] + force[axis]);
  };
  const nodalLoads = solidArray(row.nodalLoads, SOLID_LIMITS.loads).map(value => {
    const load = solidRecord(value, ['node', 'forceN']);
    const node = index(load.node, nodes.length), forceN = solidVector(load.forceN);
    add(node, forceN); return { node, forceN };
  });
  const surfaceLoads = solidArray(row.surfaceLoads, SOLID_LIMITS.loads).map(value => {
    const load = solidRecord(value, ['nodes', 'tractionMPa']);
    const ids = solidArray(load.nodes, 3, 3).map(v => index(v, nodes.length));
    if (new Set(ids).size !== 3 || faces.get([...ids].sort((a, b) => a - b).join(','))?.count !== 1) fail('load is not an exterior element face');
    const tractionMPa = solidVector(load.tractionMPa);
    const area = solidNumber(Math.hypot(...cross(sub(nodes[ids[1]], nodes[ids[0]]), sub(nodes[ids[2]], nodes[ids[0]]))) / 2);
    if (!(area > 0)) fail('invalid boundary area');
    const force = solidVector(tractionMPa.map(v => v * area / 3));
    for (const node of ids) add(node, force);
    return { nodes: [ids[0], ids[1], ids[2]] as const, tractionMPa };
  });
  let gravity: SolidAnalysisInput['gravity'];
  if (hasGravity) {
    const item = solidRecord(row.gravity, ['accelerationMps2', 'densities']);
    const accelerationMps2 = solidVector(item.accelerationMps2), densityByMaterial = new Map<string, number>();
    const densities = solidArray(item.densities, materials.length, 1).map(value => {
      const density = solidRecord(value, ['materialId', 'densityKgM3']);
      const materialId = text(density.materialId), densityKgM3 = solidNumber(density.densityKgM3);
      if (!materialIds.has(materialId)) fail('unknown gravity material');
      if (densityByMaterial.has(materialId)) fail('duplicate gravity material');
      if (!(densityKgM3 > 0)) fail('gravity density must be positive');
      densityByMaterial.set(materialId, densityKgM3);
      return { materialId, densityKgM3 };
    });
    for (const element of elements) {
      const density = densityByMaterial.get(element.materialId);
      if (density === undefined) fail('missing gravity material density');
      // Linear tet4 lumping: integral(N_a dV) = V_e / 4. In N-mm-MPa,
      // f_a[N] += V_e[mm^3] * 1e-9[m^3/mm^3] * rho[kg/m^3] * g[m/s^2] / 4.
      const { volumeMm3 } = solidTetGeometry(element.nodes.map(node => nodes[node]));
      const massKg = solidNumber(volumeMm3 * 1e-9 * density);
      if (!(massKg > 0)) fail('unresolved gravity mass');
      const force = solidVector(accelerationMps2.map(g => massKg * g / 4));
      if (force.some((v, axis) => v === 0 && accelerationMps2[axis] !== 0)) fail('unresolved gravity force');
      for (const node of element.nodes) add(node, force);
    }
    gravity = { accelerationMps2, densities };
  }
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source, units: 'N-mm-MPa', numericBudgetBytes, nodes,
    elements, materials, constraints, nodalLoads, surfaceLoads, ...(gravity === undefined ? {} : { gravity }) };
  return { input, plan: { schema: 'pointercad-solid-tet4-plan/1', input, forcesN, fixed,
    ...(prescribedMm === undefined ? {} : { prescribedMm }) } };
}

export async function solidInputSha256(input: SolidAnalysisInput): Promise<string> {
  const owned = translateSolidAnalysis(input).input;
  return sha256Hex(new TextEncoder().encode(JSON.stringify(owned)));
}
