import { solidArray, solidNumber, solidRecord, solidTetGeometry, solidVector } from './solidAnalysisTranslation.js';
import type { SolidModalApplicability, SolidModalInput, SolidModalMaterial, SolidModalPlan } from './solidModalModel.js';

/** Identical to solidModal.py MAX_NODES / MAX_ELEMENTS / MAX_MODES / MAX_DENSITY_T_PER_MM3 (1e5 kg/m^3). */
export const SOLID_MODAL_LIMITS = { nodes: 600, elements: 3000, modes: 20, densityTPerMm3: 1e-7 } as const;
function fail(message: string): never { throw new Error(`solid-modal-input: ${message}`); }
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) fail('invalid identity');
  return value;
}
function index(value: unknown, count: number): number {
  const result = solidNumber(value);
  if (!Number.isSafeInteger(result) || result < 0 || result >= count) fail('invalid node index');
  return result;
}
/** The only kg/m^3 -> t/mm^3 conversion of the modal route: 1 kg/m^3 = 1e-3 t / 1e9 mm^3. */
function tonnePerCubicMillimetre(densityKgM3: number): number { return densityKgM3 / 1e12; }
/** Mirror of solidModal.dense_modal_bytes (14 s^2 + 160 s + 4096 doubles, s = 3 x nodes). */
export function solidModalReservedBytes(nodeCount: number): number {
  const size = 3 * nodeCount;
  return (14 * size * size + 160 * size + 4096) * 8;
}

/** Fresh ownership and strict fields; the same tet4 mesh rules as the static route (shared faces only). */
export function translateSolidModal(value: unknown): {
  input: SolidModalInput; plan: SolidModalPlan; applicability: SolidModalApplicability; elasticDofs: number;
  /** Physical mass of all input tetrahedra, including restrained degrees of freedom; not saved or sent to native code. */
  totalMassKg: number;
} {
  const row = solidRecord(value, ['schema', 'source', 'units', 'numericBudgetBytes', 'nodes', 'elements', 'materials',
    'constraints', 'modeCount']);
  if (row.schema !== 'pointercad-solid-tet4-modal/1' || row.units !== 'N-mm-MPa') fail('unsupported schema or units');
  const numericBudgetBytes = solidNumber(row.numericBudgetBytes);
  if (!Number.isSafeInteger(numericBudgetBytes) || numericBudgetBytes <= 0) fail('explicit numeric budget required');
  const sourceRow = solidRecord(row.source, ['documentId', 'revision', 'meshKey']);
  const revision = solidNumber(sourceRow.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid source revision');
  const source = { documentId: text(sourceRow.documentId), revision, meshKey: text(sourceRow.meshKey) };
  const nodes = solidArray(row.nodes, SOLID_MODAL_LIMITS.nodes, 4).map(solidVector);
  if (solidModalReservedBytes(nodes.length) > numericBudgetBytes) fail('dense modal reservation exceeds the numeric budget');
  const densities = new Map<string, number>();
  const materials = solidArray(row.materials, SOLID_MODAL_LIMITS.elements, 1).map((value): SolidModalMaterial => {
    const material = solidRecord(value, ['id', 'youngMPa', 'poisson', 'densityKgM3']);
    const id = text(material.id), youngMPa = solidNumber(material.youngMPa), poisson = solidNumber(material.poisson);
    const densityKgM3 = solidNumber(material.densityKgM3);
    if (!(youngMPa > 0) || !(poisson > -1 && poisson < 0.5)) fail('invalid isotropic material');
    if (![youngMPa / (2 * (1 + poisson)), youngMPa / (3 * (1 - 2 * poisson))].every(v => Number.isFinite(v) && v > 0))
      fail('unresolved material scale');
    const densityTPerMm3 = tonnePerCubicMillimetre(densityKgM3);
    if (!(densityTPerMm3 > 0 && densityTPerMm3 <= SOLID_MODAL_LIMITS.densityTPerMm3)) fail('density must be above 0 and at most 1e5 kg/m^3');
    if (densities.has(id)) fail('duplicate material');
    densities.set(id, densityTPerMm3);
    return { id, youngMPa, poisson, densityKgM3 };
  });
  const parent: number[] = [];
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) { const next = parent[i]; parent[i] = root; i = next; }
    return root;
  };
  const faces = new Map<string, { element: number; count: number; parity: number }>();
  const used = new Set<number>(), elementKeys = new Set<string>();
  let totalMassKg = 0;
  const elements = solidArray(row.elements, SOLID_MODAL_LIMITS.elements, 1).map((value, elementIndex) => {
    parent.push(elementIndex);
    const element = solidRecord(value, ['nodes', 'materialId']);
    const ids = solidArray(element.nodes, 4, 4).map(v => index(v, nodes.length));
    if (new Set(ids).size !== 4) fail('repeated tetrahedron node');
    const key = [...ids].sort((a, b) => a - b).join(',');
    if (elementKeys.has(key)) fail('duplicate tetrahedron');
    elementKeys.add(key);
    const materialId = text(element.materialId);
    if (!densities.has(materialId)) fail('missing material');
    const { volumeMm3 } = solidTetGeometry(ids.map(i => nodes[i]));
    totalMassKg += volumeMm3 * densityOf(densities, materialId) * 1000;
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
  if (used.size !== nodes.length) fail('every node must belong to an element');
  const fixed: [boolean, boolean, boolean][] = nodes.map(() => [false, false, false]);
  const constrained = new Set<number>();
  const constraints = solidArray(row.constraints, nodes.length).map(value => {
    const item = solidRecord(value, ['node', 'fixed']);
    const node = index(item.node, nodes.length);
    if (constrained.has(node)) fail('duplicate constraint node');
    constrained.add(node);
    const flags = solidArray(item.fixed, 3, 3);
    if (flags.some(flag => typeof flag !== 'boolean') || !flags.some(flag => flag === true)) fail('invalid translation restraints');
    const tuple: [boolean, boolean, boolean] = [flags[0] === true, flags[1] === true, flags[2] === true];
    fixed[node] = tuple;
    return { node, fixed: tuple };
  });
  // Point/edge-only connections are not an implicit tie law and are refused, as in the static route.
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
  const applicability: SolidModalApplicability = constraints.length === 0 ? 'free-free' : 'supported';
  if (applicability === 'free-free' && components.size !== 1) fail('an unrestrained model must be one face-connected solid');
  if (applicability === 'supported') for (const component of components.values()) {
    const origin = nodes[component[0]];
    const length = Math.max(...component.map(i => Math.hypot(...nodes[i].map((v, axis) => v - origin[axis]))));
    if (!(length > 0) || !Number.isFinite(length)) fail('invalid component extent');
    const basis: number[][] = [];
    for (const node of component) {
      const [x, y, z] = nodes[node].map((v, axis) => (v - origin[axis]) / length);
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
    if (basis.length !== 6) fail('a restrained model needs every component free of rigid-body motion');
  }
  const freeDofs = fixed.reduce((sum, flags) => sum + flags.filter(flag => !flag).length, 0);
  const elasticDofs = applicability === 'free-free' ? freeDofs - 6 : freeDofs;
  const modeCount = solidNumber(row.modeCount);
  if (!Number.isSafeInteger(modeCount) || modeCount < 1 || modeCount > SOLID_MODAL_LIMITS.modes) fail('1 to 20 modes required');
  if (modeCount > elasticDofs) fail('more modes requested than elastic degrees of freedom');
  const input: SolidModalInput = { schema: 'pointercad-solid-tet4-modal/1', source, units: 'N-mm-MPa', numericBudgetBytes,
    nodes, elements, materials, constraints, modeCount };
  const plan: SolidModalPlan = { schema: 'pointercad-solid-tet4-modal-plan/2', source, units: 'N-mm-MPa-t-s',
    numericBudgetBytes, nodes, elements, fixed, modeCount,
    materials: materials.map(m => ({ id: m.id, youngMPa: m.youngMPa, poisson: m.poisson, densityTPerMm3: densityOf(densities, m.id) })) };
  return { input, plan, applicability, elasticDofs, totalMassKg };
}
function densityOf(densities: ReadonlyMap<string, number>, id: string): number {
  const density = densities.get(id);
  if (density === undefined) fail('missing material density');
  return density;
}

export async function solidModalInputSha256(input: SolidModalInput): Promise<string> {
  const owned = translateSolidModal(input).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(owned)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
