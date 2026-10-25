import { readShellAnalysisInput, type ShellAnalysisInput, type ShellFixed6, type ShellVector3 } from './shellAnalysisModel.js';

/**
 * W07 shell input -> fixed native wrapper shellAnalysis.py (OOFEM's existing TR_SHELL02 with
 * SimpleCS), and the pure derivation of surface stresses from the native section resultants.
 *
 * Sign convention: the top side of an element is the side its normal
 * e3 = (N2 - N1) x (N3 - N1) / |...| points to (the node order, never a thickness sign), exactly
 * the frame of OOFEM's DKTPlate3d/TrPlanestressRotAllman3d. With M = integral of sigma * z dz
 * (z along e3) and a linear through-thickness distribution:
 *   sigma_top = N/t + 6M/t^2, sigma_bottom = N/t - 6M/t^2, tau_rep = 1.5 Q/t.
 * tau_rep is the parabolic maximum at the midsurface of a homogeneous section (zero at both faces).
 */
export const SHELL_PLAN_SCHEMA = 'pointercad-shell-tri3-plan/1';
export const SHELL_NATIVE_SCHEMA = 'pointercad-shell-tri3-native/1';
export const SHELL_RESULT_SCHEMA = 'pointercad-shell-tri3-result/1';
/** The only element this path calls: the existing native OOFEM element, named exactly. */
export const SHELL_NATIVE_ELEMENT = { record: 'tr_shell02', className: 'TR_SHELL02', crossSection: 'SimpleCrossSection',
  integrationPoints: 4 } as const;
export const SHELL_LIMITS = { nodes: 20000, elements: 40000 } as const;

/** OOFEM tensor order in global axes: xx, yy, zz, yz, xz, xy. */
export type ShellTensor6 = readonly [number, number, number, number, number, number];
/** Global Fx, Fy, Fz [N] then Mx, My, Mz [N mm]; for displacements ux, uy, uz [mm] then rx, ry, rz [rad]. */
export type ShellNodal6 = readonly [number, number, number, number, number, number];
export interface ShellFrame { readonly e1: ShellVector3; readonly e2: ShellVector3; readonly e3: ShellVector3; readonly areaMm2: number }

export interface ShellAnalysisPlan {
  readonly schema: typeof SHELL_PLAN_SCHEMA;
  readonly input: ShellAnalysisInput;
  readonly element: typeof SHELL_NATIVE_ELEMENT.record;
  readonly integrationPoints: typeof SHELL_NATIVE_ELEMENT.integrationPoints;
  readonly fixed: readonly ShellFixed6[];
  readonly loads: readonly ShellNodal6[];
  /** Unit normal e3 of each element: the top side of its surface stresses. */
  readonly normals: readonly ShellVector3[];
}

export interface ShellSurfaceStress {
  /** N/t + 6M/t^2 on the side e3 points to [MPa], global tensor components. */
  readonly topMPa: ShellTensor6;
  /** N/t - 6M/t^2 on the opposite side [MPa]. */
  readonly bottomMPa: ShellTensor6;
}

export interface ShellTransverseShear {
  /** DKT is shear rigid: its native Q is identically zero, so Q comes from the native moments. */
  readonly source: 'moment-gradient-equilibrium';
  /** Qx = dMxx/dx + dMxy/dy, Qy = dMxy/dx + dMyy/dy in the element axes e1, e2 [N/mm]. */
  readonly localNPerMm: readonly [number, number];
  readonly globalNPerMm: ShellVector3;
  /** 1.5 Q / t as a global vector [MPa]. */
  readonly representativeMPa: ShellVector3;
  /** Largest misfit of the linear moment fit through the native points [N mm/mm] (DKT moments are linear). */
  readonly fitResidualNmmPerMm: number;
}

export interface ShellPointResult {
  readonly xyzMm: ShellVector3;
  /** Native membrane part of IST_ShellForceTensor: plane-stress stress N/t [MPa] (not thickness-multiplied natively). */
  readonly membraneStressMPa: ShellTensor6;
  /** N = t * membraneStressMPa [N/mm]. */
  readonly membraneForceNPerMm: ShellTensor6;
  readonly momentNmmPerMm: ShellTensor6;
  readonly curvaturePerMm: ShellTensor6;
  readonly membraneStrain: ShellTensor6;
  readonly surface: ShellSurfaceStress;
}

export interface ShellElementResult {
  readonly nativeClass: typeof SHELL_NATIVE_ELEMENT.className;
  readonly thicknessMm: number;
  readonly frame: ShellFrame;
  readonly points: readonly ShellPointResult[];
  /** Unsmooth element-local derivative of the raw integration-point moments; retained for diagnostics. */
  readonly transverseShear: ShellTransverseShear;
}

export interface ShellRecoveredNode {
  readonly node: number;
  readonly xyzMm: ShellVector3;
  readonly contributingElements: readonly number[];
  /** Boundary averages are one-sided and generally biased; they are not extrapolated. */
  readonly boundary: boolean;
  readonly membraneForceNPerMm: ShellTensor6;
  readonly momentNmmPerMm: ShellTensor6;
  readonly surface: ShellSurfaceStress;
}

export interface ShellRecoveredShear extends Omit<ShellTransverseShear, 'source'> {
  readonly source: 'nodal-average-moment-gradient';
}

export type ShellPlanarRecovery = {
  readonly status: 'available';
  readonly source: 'area-weighted-element-centroid';
  readonly scope: 'coplanar-uniform-section';
  readonly nodes: readonly ShellRecoveredNode[];
  /** Element order matches input.elements. Q is constant within each triangle. */
  readonly transverseShear: readonly ShellRecoveredShear[];
} | {
  readonly status: 'unavailable';
  readonly code: 'nonplanar' | 'nonuniform-section';
  readonly reason: string;
};

export interface ShellAnalysisResult {
  readonly schema: typeof SHELL_RESULT_SCHEMA;
  readonly source: ShellAnalysisInput['source'];
  readonly element: { readonly record: 'tr_shell02'; readonly className: 'TR_SHELL02'; readonly crossSection: 'SimpleCrossSection' };
  readonly displacement: readonly ShellNodal6[];
  readonly reactions: readonly ShellNodal6[];
  readonly checks: {
    readonly freeResidualRelative: number; readonly balanceRelative: number;
    readonly minimumScaledPivot: number; readonly refactorizationDifferenceRelative: number;
  };
  readonly elements: readonly ShellElementResult[];
  /** Postprocessing only; raw points above are retained even when recovery is unavailable. */
  readonly recovery: ShellPlanarRecovery;
}

function refuse(code: string, reason: string): never { throw new Error(`${code}: ${reason}`); }
function sub(a: ShellVector3, b: ShellVector3): ShellVector3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: ShellVector3, b: ShellVector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: ShellVector3, b: ShellVector3): ShellVector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: ShellVector3): number { return Math.hypot(a[0], a[1], a[2]); }
function scaled(a: ShellVector3, factor: number): ShellVector3 { return [a[0] * factor, a[1] * factor, a[2] * factor]; }
function finite(value: number, code: string, what: string): number {
  return Number.isFinite(value) ? value : refuse(code, `${what} is not a finite number`);
}

/** The element frame of OOFEM's DKTPlate3d: e1 along N1->N2, e3 = e1 x (N3 - N1), e2 = e3 x e1. */
export function shellElementFrame(points: readonly [ShellVector3, ShellVector3, ShellVector3]): ShellFrame {
  const edge = sub(points[1], points[0]), other = sub(points[2], points[0]);
  const longest = Math.max(norm(edge), norm(other), norm(sub(points[2], points[1])));
  const areaMm2 = norm(cross(edge, other)) / 2;
  if (!(longest > 0) || !Number.isFinite(longest) || !(areaMm2 > 1e-12 * longest * longest)) {
    refuse('shell-geometry', 'degenerate triangle: zero area or collinear nodes have no normal or top side');
  }
  const e1 = scaled(edge, 1 / norm(edge));
  const normal = cross(e1, other);
  const e3 = scaled(normal, 1 / norm(normal));
  return { e1, e2: cross(e3, e1), e3, areaMm2 };
}

/** sigma = N/t +- 6M/t^2 componentwise; the top is the side the element normal points to. */
export function shellSurfaceStress(membraneForceNPerMm: ShellTensor6, momentNmmPerMm: ShellTensor6,
  thicknessMm: number): ShellSurfaceStress {
  if (!Number.isFinite(thicknessMm) || !(thicknessMm > 0)) refuse('shell-thickness', 'surface stress needs a finite thickness > 0 mm');
  const side = (sign: 1 | -1): ShellTensor6 => {
    const value = membraneForceNPerMm.map((force, i) => finite(
      force / thicknessMm + sign * 6 * momentNmmPerMm[i] / (thicknessMm * thicknessMm), 'shell-numeric', 'surface stress'));
    return [value[0], value[1], value[2], value[3], value[4], value[5]];
  };
  return { topMPa: side(1), bottomMPa: side(-1) };
}

/** tau_rep = 1.5 Q/t: midsurface maximum of the parabolic transverse shear of a homogeneous section. */
export function shellTransverseShearStress(shearNPerMm: ShellVector3, thicknessMm: number): ShellVector3 {
  if (!Number.isFinite(thicknessMm) || !(thicknessMm > 0)) refuse('shell-thickness', 'shear stress needs a finite thickness > 0 mm');
  const value = scaled(shearNPerMm, 1.5 / thicknessMm);
  return [finite(value[0], 'shell-numeric', 'tau'), finite(value[1], 'shell-numeric', 'tau'), finite(value[2], 'shell-numeric', 'tau')];
}

function tensorMatrix(t: ShellTensor6): readonly ShellVector3[] {
  return [[t[0], t[5], t[4]], [t[5], t[1], t[3]], [t[4], t[3], t[2]]];
}
/** a^T T b for a symmetric tensor in OOFEM order. */
function project(t: ShellTensor6, a: ShellVector3, b: ShellVector3): number {
  const matrix = tensorMatrix(t);
  return dot(a, [dot(matrix[0], b), dot(matrix[1], b), dot(matrix[2], b)]);
}
function solve3(m: readonly ShellVector3[], r: ShellVector3): ShellVector3 {
  const det = dot(m[0], cross(m[1], m[2]));
  if (!(Math.abs(det) > 0)) refuse('shell-geometry', 'integration points do not span the element plane');
  const replace = (column: number): number => {
    const rows = m.map((row, i) => row.map((v, j) => (j === column ? r[i] : v)));
    return dot([rows[0][0], rows[0][1], rows[0][2]], cross([rows[1][0], rows[1][1], rows[1][2]], [rows[2][0], rows[2][1], rows[2][2]]));
  };
  return [replace(0) / det, replace(1) / det, replace(2) / det];
}

/** Q from equilibrium of the native moment field: fit the in-plane moments linearly through the
 * native integration points (exact for DKT, whose curvature is linear) and differentiate. */
export function recoverShellTransverseShear(frame: ShellFrame, origin: ShellVector3,
  points: readonly { readonly xyzMm: ShellVector3; readonly momentNmmPerMm: ShellTensor6 }[], thicknessMm: number): ShellTransverseShear {
  if (points.length < 3) refuse('shell-result', 'at least three integration points are needed for a moment gradient');
  const local = points.map(point => {
    const offset = sub(point.xyzMm, origin);
    const m: ShellVector3 = [project(point.momentNmmPerMm, frame.e1, frame.e1),
      project(point.momentNmmPerMm, frame.e2, frame.e2), project(point.momentNmmPerMm, frame.e1, frame.e2)];
    return { x: dot(offset, frame.e1), y: dot(offset, frame.e2), m };
  });
  const normal: ShellVector3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const { x, y } of local) {
    const row: ShellVector3 = [1, x, y];
    for (let i = 0; i < 3; i += 1) normal[i] = [normal[i][0] + row[i], normal[i][1] + row[i] * x, normal[i][2] + row[i] * y];
  }
  const fits = [0, 1, 2].map(component => {
    const rhs = local.reduce<ShellVector3>((sum, { x, y, m }) => [sum[0] + m[component], sum[1] + m[component] * x,
      sum[2] + m[component] * y], [0, 0, 0]);
    return solve3(normal, rhs);
  });
  const fitResidualNmmPerMm = Math.max(...local.flatMap(({ x, y, m }) => fits.map((fit, component) =>
    Math.abs(fit[0] + fit[1] * x + fit[2] * y - m[component]))));
  // Plate equilibrium without distributed moments: Qx = dMxx/dx + dMxy/dy, Qy = dMxy/dx + dMyy/dy.
  const qx = finite(fits[0][1] + fits[2][2], 'shell-numeric', 'Qx'), qy = finite(fits[2][1] + fits[1][2], 'shell-numeric', 'Qy');
  const globalNPerMm: ShellVector3 = [qx * frame.e1[0] + qy * frame.e2[0], qx * frame.e1[1] + qy * frame.e2[1],
    qx * frame.e1[2] + qy * frame.e2[2]];
  return { source: 'moment-gradient-equilibrium', localNPerMm: [qx, qy], globalNPerMm,
    representativeMPa: shellTransverseShearStress(globalNPerMm, thicknessMm),
    fitResidualNmmPerMm: finite(fitResidualNmmPerMm, 'shell-numeric', 'moment fit') };
}

function refuseNonpositiveThickness(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('elements' in value)) return;
  const elements = value.elements;
  if (!Array.isArray(elements)) return;
  const rows: unknown[] = Array.from(elements);
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null || !('thicknessMm' in row)) return;
    const thickness = row.thicknessMm;
    if (typeof thickness === 'number' && !(thickness > 0)) {
      refuse('shell-thickness', `element ${index} has thicknessMm ${String(thickness)}; a shell needs a finite thickness `
        + 'greater than 0 mm. A sign never selects the top side: the node order (normal e3) does');
    }
  });
}

function refuseReversedNormals(elements: ShellAnalysisInput['elements']): void {
  const edges = new Map<string, { element: number; forward: boolean }[]>();
  elements.forEach((element, index) => {
    const [a, b, c] = element.nodes;
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(from, to)}-${Math.max(from, to)}`;
      edges.set(key, [...(edges.get(key) ?? []), { element: index, forward: from < to }]);
    }
  });
  for (const [key, uses] of edges) {
    if (uses.length > 2) {
      refuse('shell-orientation', `edge ${key} is shared by elements ${uses.map(use => use.element).join(', ')}; `
        + 'at a nonmanifold edge the top and bottom sides are undefined');
    }
    if (uses.length === 2 && uses[0].forward === uses[1].forward) {
      refuse('shell-orientation', `elements ${uses[0].element} and ${uses[1].element} traverse their shared edge ${key} `
        + 'in the same direction, so their normals point to opposite sides and top and bottom would swap between them; '
        + 'reorder one triangle so that the surface has one top side');
    }
  }
}

function refuseUnrestrainedMotion(input: ShellAnalysisInput, fixed: readonly ShellFixed6[]): void {
  const parent = input.nodes.map((_, index) => index);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    while (parent[node] !== root) { const next = parent[node]; parent[node] = root; node = next; }
    return root;
  };
  for (const { nodes: [a, b, c] } of input.elements) { parent[find(b)] = find(a); parent[find(c)] = find(a); }
  const groups = new Map<number, number[]>();
  input.nodes.forEach((_, node) => {
    const root = find(node), group = groups.get(root);
    if (group === undefined) groups.set(root, [node]); else group.push(node);
  });
  for (const group of groups.values()) {
    const origin = input.nodes[group[0]];
    const length = Math.max(...group.map(node => norm(sub(input.nodes[node], origin))));
    if (!(length > 0) || !Number.isFinite(length)) refuse('shell-geometry', `surface at node ${group[0]} has no extent`);
    const basis: number[][] = [];
    for (const node of group) {
      // Linearized rigid motion u = a + w x p, theta = w; rows give the restrained component.
      const [x, y, z] = scaled(sub(input.nodes[node], origin), 1 / length);
      const rows = [[1, 0, 0, 0, z, -y], [0, 1, 0, -z, 0, x], [0, 0, 1, y, -x, 0],
        [0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 1]];
      fixed[node].forEach((restrained, axis) => {
        if (!restrained) return;
        const vector = [...rows[axis]];
        for (const direction of basis) {
          const projection = vector.reduce((sum, v, i) => sum + v * direction[i], 0);
          for (let i = 0; i < 6; i += 1) vector[i] -= projection * direction[i];
        }
        const size = Math.hypot(...vector);
        if (size > 1e-9) basis.push(vector.map(v => v / size));
      });
    }
    if (basis.length !== 6) {
      refuse('shell-mechanism', `the connected surface containing node ${group[0]} restrains ${basis.length} of its 6 `
        + 'rigid-body motions (3 translations, 3 rotations); add constraints so that it cannot move without deforming');
    }
  }
}

/** Fresh validated copy (the caller's data is never modified) and the plan for shellAnalysis.py.
 * Refusals carry a reason: thickness <= 0, degenerate triangle, reversed or nonmanifold top side,
 * nonzero offset (TR_SHELL02 has no eccentricity), unrestrained rigid-body motion. */
export function translateShellAnalysis(value: unknown): { readonly input: ShellAnalysisInput; readonly plan: ShellAnalysisPlan } {
  refuseNonpositiveThickness(value);
  const input = readShellAnalysisInput(value);
  if (input.nodes.length > SHELL_LIMITS.nodes || input.elements.length > SHELL_LIMITS.elements) {
    refuse('shell-limit', `at most ${SHELL_LIMITS.nodes} nodes and ${SHELL_LIMITS.elements} elements`);
  }
  const normals = input.elements.map((element, index) => {
    if (element.offsetMm !== 0) {
      refuse('shell-offset', `element ${index} has offsetMm ${element.offsetMm}; the native TR_SHELL02 has its nodes on `
        + 'the midsurface and no eccentricity, so a nonzero offset is not part of this path (nodes are never shifted silently)');
    }
    const [a, b, c] = element.nodes;
    const points: [ShellVector3, ShellVector3, ShellVector3] = [input.nodes[a], input.nodes[b], input.nodes[c]];
    const longest = Math.max(norm(sub(points[1], points[0])), norm(sub(points[2], points[0])), norm(sub(points[2], points[1])));
    if (!(norm(cross(sub(points[1], points[0]), sub(points[2], points[0]))) / 2 > 1e-12 * longest * longest)) {
      refuse('shell-geometry', `element ${index} is degenerate (zero area or collinear nodes), so it has no normal or top side`);
    }
    return shellElementFrame(points).e3;
  });
  refuseReversedNormals(input.elements);
  const fixed: ShellFixed6[] = input.nodes.map(() => [false, false, false, false, false, false]);
  for (const constraint of input.constraints) fixed[constraint.node] = constraint.fixed;
  const loads: ShellNodal6[] = input.nodes.map(() => [0, 0, 0, 0, 0, 0]);
  for (const load of input.nodalLoads) loads[load.node] = [...load.forceN, ...load.momentNmm];
  refuseUnrestrainedMotion(input, fixed);
  return { input, plan: { schema: SHELL_PLAN_SCHEMA, input, element: SHELL_NATIVE_ELEMENT.record,
    integrationPoints: SHELL_NATIVE_ELEMENT.integrationPoints, fixed, loads, normals } };
}

function resultRecord(value: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('shell-result', `${what} is not an object`);
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) {
    refuse('shell-result', `${what} has unexpected fields`);
  }
  return row;
}
function resultList(value: unknown, length: number, what: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) refuse('shell-result', `${what} must have ${length} entries`);
  return Array.from(value);
}
function resultNumber(value: unknown, what: string): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : refuse('shell-result', `${what} is not finite`);
}
function resultSix(value: unknown, what: string): ShellTensor6 {
  const [a, b, c, d, e, f] = resultList(value, 6, what).map(v => resultNumber(v, what));
  return [a, b, c, d, e, f];
}
function resultThree(value: unknown, what: string): ShellVector3 {
  const [a, b, c] = resultList(value, 3, what).map(v => resultNumber(v, what));
  return [a, b, c];
}
function bounded(value: unknown, what: string, accept: (v: number) => boolean): number {
  const number = resultNumber(value, what);
  return accept(number) ? number : refuse('shell-result', `${what} ${number} fails the native check`);
}

interface RawPoint { readonly xyzMm: ShellVector3; readonly force: ShellTensor6; readonly moment: ShellTensor6;
  readonly strain: ShellTensor6; readonly curvature: ShellTensor6 }

function readPoints(value: unknown, index: number): RawPoint[] {
  return resultList(value, SHELL_NATIVE_ELEMENT.integrationPoints, `element ${index} points`).map(point => {
    const row = resultRecord(point, ['xyzMm', 'IST_ShellForceTensor', 'IST_ShellMomentTensor', 'IST_ShellStrainTensor',
      'IST_CurvatureTensor'], `element ${index} point`);
    return { xyzMm: resultThree(row.xyzMm, 'xyzMm'), force: resultSix(row.IST_ShellForceTensor, 'force'),
      moment: resultSix(row.IST_ShellMomentTensor, 'moment'), strain: resultSix(row.IST_ShellStrainTensor, 'strain'),
      curvature: resultSix(row.IST_CurvatureTensor, 'curvature') };
  });
}

function nativeTransverse(t: ShellTensor6, frame: ShellFrame): number {
  return Math.max(Math.abs(project(t, frame.e3, frame.e3)), Math.abs(project(t, frame.e1, frame.e3)), Math.abs(project(t, frame.e2, frame.e3)));
}

/** Area-weighted nodal averaging, for a consistently oriented plane with one homogeneous section.
 * N_i = sum(A_e N_e(centroid))/sum(A_e), M_i likewise (global tensor components).
 * On each triangle Q = div(M_h), where M_h is the linear interpolation of the three nodal M_i.
 * This is not an error estimator or an accuracy guarantee: edge averages are one-sided, and even
 * interior gradients can be inaccurate near free edges, concentrated loads or on irregular meshes.
 * Curved/folded surfaces and section interfaces require a different recovery and return a reason.
 * The caller supplies the validated input and decoded native element results; neither is modified.
 */
export function recoverPlanarShell(input: ShellAnalysisInput, elements: readonly ShellElementResult[]): ShellPlanarRecovery {
  if (elements.length !== input.elements.length || elements.length === 0) refuse('shell-result', 'recovery element count mismatch');
  const first = input.elements[0], normal = elements[0].frame.e3, origin = input.nodes[first.nodes[0]];
  const extent = input.nodes.reduce((size, point) => Math.max(size, norm(sub(point, origin))), 0);
  if (elements.some(element => norm(sub(element.frame.e3, normal)) > 1e-9)
    || input.nodes.some(point => Math.abs(dot(sub(point, origin), normal)) > 1e-9 * extent)) {
    return { status: 'unavailable', code: 'nonplanar', reason: 'Nodal averaging requires one oriented plane; curved or folded '
      + 'shells need tangent-plane transport and a separate recovery. Raw native integration-point results are retained.' };
  }
  if (input.elements.some(element => element.materialId !== first.materialId || element.thicknessMm !== first.thicknessMm)) {
    return { status: 'unavailable', code: 'nonuniform-section', reason: 'Nodal averaging across material or thickness interfaces '
      + 'is not supported. Raw native integration-point results are retained without smoothing across the interface.' };
  }
  const members = input.nodes.map((): number[] => []);
  const edges = new Map<string, { nodes: readonly [number, number]; count: number }>();
  input.elements.forEach((element, index) => {
    for (const node of element.nodes) members[node].push(index);
    const [a, b, c] = element.nodes;
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(from, to)}-${Math.max(from, to)}`, edge = edges.get(key);
      if (edge === undefined) edges.set(key, { nodes: [from, to], count: 1 }); else edge.count += 1;
    }
    // The pinned four-point DKT rule's first point is the centroid. Check its identity before using it.
    const point = elements[index].points[0];
    const centerAt = (axis: number): number => input.nodes[a][axis]
      + ((input.nodes[b][axis] - input.nodes[a][axis]) + (input.nodes[c][axis] - input.nodes[a][axis])) / 3;
    const center: ShellVector3 = [centerAt(0), centerAt(1), centerAt(2)];
    const edgeLength = Math.max(norm(sub(input.nodes[b], input.nodes[a])), norm(sub(input.nodes[c], input.nodes[a])));
    if (point === undefined || norm(sub(point.xyzMm, center)) > 1e-9 * edgeLength) {
      refuse('shell-result', `element ${index} first integration point is not its centroid`);
    }
  });
  const boundary = new Set<number>();
  for (const edge of edges.values()) if (edge.count === 1) for (const node of edge.nodes) boundary.add(node);
  const nodes = members.map((contributingElements, node): ShellRecoveredNode => {
    const area = contributingElements.reduce((sum, index) => sum + elements[index].frame.areaMm2, 0);
    if (!(area > 0) || !Number.isFinite(area)) refuse('shell-result', `node ${node} has no finite recovery patch`);
    const average = (field: 'membraneForceNPerMm' | 'momentNmmPerMm'): ShellTensor6 => {
      const values = [0, 0, 0, 0, 0, 0];
      for (const index of contributingElements) {
        const weight = elements[index].frame.areaMm2 / area;
        const tensor = elements[index].points[0][field];
        for (let axis = 0; axis < 6; axis += 1) values[axis] += weight * tensor[axis];
      }
      return resultSix(values, 'nodal average');
    };
    const membraneForceNPerMm = average('membraneForceNPerMm'), momentNmmPerMm = average('momentNmmPerMm');
    return { node, xyzMm: [...input.nodes[node]], contributingElements, boundary: boundary.has(node),
      membraneForceNPerMm, momentNmmPerMm, surface: shellSurfaceStress(membraneForceNPerMm, momentNmmPerMm, first.thicknessMm) };
  });
  const transverseShear = input.elements.map((element, index): ShellRecoveredShear => ({
    ...recoverShellTransverseShear(elements[index].frame, input.nodes[element.nodes[0]], element.nodes.map(node => nodes[node]), first.thicknessMm),
    source: 'nodal-average-moment-gradient',
  }));
  return { status: 'available', source: 'area-weighted-element-centroid', scope: 'coplanar-uniform-section', nodes, transverseShear };
}

/** Validates the native answer against the plan and derives N = t * sigma_raw, the surface stresses and Q. */
export function decodeShellAnalysis(raw: unknown, plan: ShellAnalysisPlan): ShellAnalysisResult {
  const row = resultRecord(raw, ['schema', 'source', 'elementRecord', 'elementClasses', 'crossSectionClasses', 'displacement',
    'reactions', 'freeResidualRelative', 'balanceRelative', 'minimumScaledPivot', 'refactorizationDifferenceRelative',
    'integrationPoints'], 'native result');
  const { input } = plan;
  if (row.schema !== SHELL_NATIVE_SCHEMA || row.elementRecord !== SHELL_NATIVE_ELEMENT.record) refuse('shell-result', 'not the fixed TR_SHELL02 wrapper');
  if (JSON.stringify(row.source) !== JSON.stringify(input.source)) refuse('shell-result', 'result belongs to another source');
  const elementCount = input.elements.length;
  if (resultList(row.elementClasses, elementCount, 'elementClasses').some(name => name !== SHELL_NATIVE_ELEMENT.className)
    || resultList(row.crossSectionClasses, elementCount, 'crossSectionClasses').some(name => name !== SHELL_NATIVE_ELEMENT.crossSection)) {
    refuse('shell-result', 'an element is not the native TR_SHELL02 with SimpleCrossSection');
  }
  const displacement = resultList(row.displacement, input.nodes.length, 'displacement').map(v => resultSix(v, 'displacement'));
  const reactions = resultList(row.reactions, input.nodes.length, 'reactions').map(v => resultSix(v, 'reactions'));
  plan.fixed.forEach((flags, node) => flags.forEach((restrained, axis) => {
    if (restrained ? displacement[node][axis] !== 0 : reactions[node][axis] !== 0) refuse('shell-result', `node ${node} DOF ${axis} mixes restraint and reaction`);
  }));
  const checks = { freeResidualRelative: bounded(row.freeResidualRelative, 'free residual', v => v >= 0 && v <= 1e-8),
    balanceRelative: bounded(row.balanceRelative, 'overall balance', v => v >= 0 && v <= 1e-8),
    minimumScaledPivot: bounded(row.minimumScaledPivot, 'scaled pivot', v => v > 1e-12 && v <= 1 + 1e-10),
    refactorizationDifferenceRelative: bounded(row.refactorizationDifferenceRelative, 'refactorization', v => v >= 0 && v <= 1e-8) };
  const raws = resultList(row.integrationPoints, elementCount, 'integrationPoints').map(readPoints);
  // One stress scale for the whole model so that zero fields (no bending, no membrane) are not divided by noise.
  const stressScale = Math.max(1e-300, ...raws.flatMap((points, index) => points.flatMap(point => [...point.force.map(Math.abs),
    ...point.moment.map(v => 6 * Math.abs(v) / input.elements[index].thicknessMm ** 2)])));
  const elements = input.elements.map((element, index): ShellElementResult => {
    const corners: [ShellVector3, ShellVector3, ShellVector3] = [input.nodes[element.nodes[0]], input.nodes[element.nodes[1]],
      input.nodes[element.nodes[2]]];
    const frame = shellElementFrame(corners), t = element.thicknessMm;
    const longest = Math.max(norm(sub(corners[1], corners[0])), norm(sub(corners[2], corners[0])), norm(sub(corners[2], corners[1])));
    const points = raws[index].map((point): ShellPointResult => {
      const offset = sub(point.xyzMm, corners[0]);
      const twice = 2 * frame.areaMm2;
      const l2 = dot(cross(sub(corners[2], corners[0]), offset), frame.e3) / -twice, l3 = dot(cross(sub(corners[1], corners[0]), offset), frame.e3) / twice;
      if (Math.abs(dot(offset, frame.e3)) > 1e-9 * longest || Math.min(l2, l3, 1 - l2 - l3) < -1e-9) {
        refuse('shell-result', `element ${index} integration point is outside its triangle`);
      }
      if (nativeTransverse(point.force, frame) > 1e-9 * stressScale || 6 * nativeTransverse(point.moment, frame) / (t * t) > 1e-9 * stressScale) {
        refuse('shell-result', `element ${index} native resultants are not tangent to the element (Q of DKT must be zero)`);
      }
      const membraneForceNPerMm = resultSix(point.force.map(v => v * t), 'membrane force');
      return { xyzMm: point.xyzMm, membraneStressMPa: point.force, membraneForceNPerMm, momentNmmPerMm: point.moment,
        curvaturePerMm: point.curvature, membraneStrain: point.strain, surface: shellSurfaceStress(membraneForceNPerMm, point.moment, t) };
    });
    const transverseShear = recoverShellTransverseShear(frame, corners[0], points, t);
    if (6 * transverseShear.fitResidualNmmPerMm / (t * t) > 1e-8 * stressScale) {
      refuse('shell-result', `element ${index} native moments are not the linear DKT field`);
    }
    return { nativeClass: SHELL_NATIVE_ELEMENT.className, thicknessMm: t, frame, points, transverseShear };
  });
  return { schema: SHELL_RESULT_SCHEMA, source: input.source, element: { record: SHELL_NATIVE_ELEMENT.record,
    className: SHELL_NATIVE_ELEMENT.className, crossSection: SHELL_NATIVE_ELEMENT.crossSection }, displacement, reactions, checks, elements,
  recovery: recoverPlanarShell(input, elements) };
}
