/** Input contract only. Passing validation does not prove native support,
 * adequate restraints, mesh quality, convergence or structural safety. */
export const SHELL_ANALYSIS_SCHEMA = 'pointercad-shell-tri3/1';
export type ShellVector3 = readonly [number, number, number];
export type ShellFixed6 = readonly [boolean, boolean, boolean, boolean, boolean, boolean];

export interface ShellAnalysisInput {
  readonly schema: typeof SHELL_ANALYSIS_SCHEMA;
  readonly source: { readonly documentId: string; readonly revision: number; readonly meshKey: string };
  readonly units: 'N-mm-MPa-rad';
  /** Explicit reference surface; offsetMm locates the midsurface. No solid-to-shell inference. */
  readonly surface: 'explicit-reference-surface';
  readonly nodes: readonly ShellVector3[];
  readonly elements: readonly {
    /** Zero-based triangle nodes; their winding defines the positive normal. */
    readonly nodes: readonly [number, number, number];
    readonly materialId: string;
    readonly thicknessMm: number;
    /** Signed distance along the normal from the reference surface to the midsurface.
     * Acceptance as input does not establish native offset support. */
    readonly offsetMm: number;
  }[];
  readonly materials: readonly { readonly id: string; readonly youngMPa: number; readonly poisson: number }[];
  readonly constraints: readonly {
    readonly node: number;
    /** Global ux, uy, uz, rx, ry, rz; true prescribes zero, rotations are radians. */
    readonly fixed: ShellFixed6;
  }[];
  readonly nodalLoads: readonly {
    readonly node: number;
    readonly forceN: ShellVector3;
    readonly momentNmm: ShellVector3;
  }[];
}

function refuse(path: string): never { throw new Error(`shell-input: ${path}`); }
function record(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse(path);
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) return refuse(path);
  return row;
}
function array(value: unknown, minimum: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum) return refuse(path);
  // Array.from retains holes as undefined, so incomplete arrays cannot evade validation.
  return Array.from(value);
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return refuse(path);
  return value;
}
function positive(value: unknown, path: string): number {
  const number = finite(value, path);
  return number > 0 ? number : refuse(path);
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return refuse(path);
  return value;
}
function integer(value: unknown, path: string): number {
  const number = finite(value, path);
  return Number.isSafeInteger(number) && number >= 0 ? number : refuse(path);
}
function vector(value: unknown, path: string): ShellVector3 {
  const row = array(value, 3, path);
  if (row.length !== 3) return refuse(path);
  return [finite(row[0], path), finite(row[1], path), finite(row[2], path)];
}
function fixed6(value: unknown): ShellFixed6 {
  const row = array(value, 6, 'constraints.fixed');
  const [ux, uy, uz, rx, ry, rz] = row;
  if (row.length !== 6 || typeof ux !== 'boolean' || typeof uy !== 'boolean' || typeof uz !== 'boolean'
    || typeof rx !== 'boolean' || typeof ry !== 'boolean' || typeof rz !== 'boolean') return refuse('constraints.fixed');
  return [ux, uy, uz, rx, ry, rz];
}

/** Parse untrusted JSON data without default thickness, inferred units, missing
 * rotations or discarded loads. No stiffness, load translation or solve is performed. */
export function readShellAnalysisInput(value: unknown): ShellAnalysisInput {
  const input = record(value, ['schema', 'source', 'units', 'surface', 'nodes', 'elements', 'materials',
    'constraints', 'nodalLoads'], 'fields');
  if (input.schema !== SHELL_ANALYSIS_SCHEMA) return refuse('schema');
  if (input.units !== 'N-mm-MPa-rad') return refuse('units');
  if (input.surface !== 'explicit-reference-surface') return refuse('surface');
  const source = record(input.source, ['documentId', 'revision', 'meshKey'], 'source');
  const nodes = array(input.nodes, 3, 'nodes').map(point => vector(point, 'nodes.coordinate'));
  const nodeIndex = (value: unknown): number => {
    const index = integer(value, 'node index');
    return index < nodes.length ? index : refuse('node index');
  };
  const materialIds = new Set<string>();
  const materials = array(input.materials, 1, 'materials').map(value => {
    const material = record(value, ['id', 'youngMPa', 'poisson'], 'material');
    const id = text(material.id, 'material.id');
    if (materialIds.has(id)) return refuse('duplicate material');
    materialIds.add(id);
    const poisson = finite(material.poisson, 'material.poisson');
    if (poisson <= -1 || poisson >= 0.5) return refuse('material.poisson');
    return { id, youngMPa: positive(material.youngMPa, 'material.youngMPa'), poisson };
  });
  const elementKeys = new Set<string>(), usedNodes = new Set<number>();
  const elements = array(input.elements, 1, 'elements').map(value => {
    const element = record(value, ['nodes', 'materialId', 'thicknessMm', 'offsetMm'], 'element');
    const indices = vector(element.nodes, 'element.nodes');
    indices.forEach(nodeIndex);
    if (new Set(indices).size !== 3) return refuse('element.nodes');
    const key = [...indices].sort((a, b) => a - b).join(':');
    if (elementKeys.has(key)) return refuse('duplicate triangle');
    elementKeys.add(key);
    indices.forEach(index => usedNodes.add(index));
    const materialId = text(element.materialId, 'element.materialId');
    if (!materialIds.has(materialId)) return refuse('element.materialId');
    return { nodes: indices, materialId, thicknessMm: positive(element.thicknessMm, 'element.thicknessMm'),
      offsetMm: finite(element.offsetMm, 'element.offsetMm') };
  });
  if (usedNodes.size !== nodes.length) return refuse('unused node');
  const constrained = new Set<number>();
  const constraints = array(input.constraints, 0, 'constraints').map(value => {
    const constraint = record(value, ['node', 'fixed'], 'constraint');
    const node = nodeIndex(constraint.node);
    if (constrained.has(node)) return refuse('duplicate constraint');
    constrained.add(node);
    return { node, fixed: fixed6(constraint.fixed) };
  });
  const loaded = new Set<number>();
  const nodalLoads = array(input.nodalLoads, 0, 'nodalLoads').map(value => {
    const load = record(value, ['node', 'forceN', 'momentNmm'], 'nodal load');
    const node = nodeIndex(load.node);
    if (loaded.has(node)) return refuse('duplicate nodal load');
    loaded.add(node);
    return { node, forceN: vector(load.forceN, 'forceN'), momentNmm: vector(load.momentNmm, 'momentNmm') };
  });
  return { schema: SHELL_ANALYSIS_SCHEMA, source: { documentId: text(source.documentId, 'source.documentId'),
    revision: integer(source.revision, 'source.revision'), meshKey: text(source.meshKey, 'source.meshKey') },
  units: 'N-mm-MPa-rad', surface: 'explicit-reference-surface', nodes, elements, materials, constraints, nodalLoads };
}
