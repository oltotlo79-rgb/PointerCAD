import { SHELL_ANALYSIS_SCHEMA, type ShellAnalysisInput, type ShellFixed6, type ShellVector3 } from './shellAnalysisModel.js';

/**
 * Pure mesh, support and load generators for shellBenchmark.test.ts (no tests here; not in the vitest include).
 * Units N-mm-MPa-rad. Every triangle is counter-clockwise in the grid indices (i, j), so the element normal
 * e3 = (N2 - N1) x (N3 - N1) is +Z for the plates and points away from the cylinder axis for the roof.
 * Restraint flags are the global ux, uy, uz, rx, ry, rz of ShellAnalysisInput (true = prescribed zero).
 */

type Triangle = [number, number, number];
type Flags = [boolean, boolean, boolean, boolean, boolean, boolean];
const UX = 0, UY = 1, UZ = 2, RX = 3, RY = 4, RZ = 5;

 interface BenchmarkMesh {
  readonly cells: number;
  readonly nodes: readonly ShellVector3[];
  readonly triangles: readonly Triangle[];
  /** Node index of the grid point (i, j), 0 <= i, j <= cells. */
  readonly at: (i: number, j: number) => number;
}

interface BenchmarkCase {
  readonly input: ShellAnalysisInput;
  readonly mesh: BenchmarkMesh;
  /** The node whose displacement is compared with the published value. */
  readonly probe: number;
}

/** cells x cells grid, node (i, j) at place(i, j); each cell is split along alternating diagonals ("union jack"):
 * along (i, j)-(i+1, j+1) when i + j is even, otherwise along (i+1, j)-(i, j+1). With an even number of cells the
 * pattern is symmetric about both centre lines and both diagonals of the grid. */
 function unionJackMesh(cells: number, place: (i: number, j: number) => ShellVector3): BenchmarkMesh {
  if (!Number.isSafeInteger(cells) || cells < 1) throw new Error('shell-benchmark: cells must be a positive integer');
  const at = (i: number, j: number): number => j * (cells + 1) + i;
  const nodes: ShellVector3[] = [];
  for (let j = 0; j <= cells; j += 1) for (let i = 0; i <= cells; i += 1) nodes.push(place(i, j));
  const triangles: Triangle[] = [];
  for (let j = 0; j < cells; j += 1) {
    for (let i = 0; i < cells; i += 1) {
      const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if ((i + j) % 2 === 0) triangles.push([a, b, c], [a, c, d]);
      else triangles.push([a, b, d], [b, c, d]);
    }
  }
  return { cells, nodes, triangles, at };
}

/** Area of the flat triangle p, q, r [mm^2]. */
export function triangleArea(p: ShellVector3, q: ShellVector3, r: ShellVector3): number {
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}

/**
 * Equivalent nodal loads of a uniform surface load p [N/mm^2 = MPa, a fixed global vector]: every flat triangle
 * gives F_i = p * A_e / 3 to each of its three vertices, and no nodal moments. A_e / 3 is the integral of the linear
 * interpolation function N_i over the triangle, so this is the work-equivalent load for a linearly interpolated
 * displacement, and it is the lumped pressure load used with the DKT plate, whose transverse displacement is defined
 * only along the element edges. The rows sum to p times the total (faceted) area.
 */
export function lumpedSurfaceLoads(mesh: BenchmarkMesh, perAreaN: ShellVector3): ShellAnalysisInput['nodalLoads'] {
  const sums = mesh.nodes.map((): [number, number, number] => [0, 0, 0]);
  for (const [a, b, c] of mesh.triangles) {
    const share = triangleArea(mesh.nodes[a], mesh.nodes[b], mesh.nodes[c]) / 3;
    for (const node of [a, b, c]) for (let axis = 0; axis < 3; axis += 1) sums[node][axis] += perAreaN[axis] * share;
  }
  const rows: { node: number; forceN: ShellVector3; momentNmm: ShellVector3 }[] = [];
  sums.forEach((force, node) => {
    if (force.some(value => value !== 0)) rows.push({ node, forceN: [force[0], force[1], force[2]], momentNmm: [0, 0, 0] });
  });
  return rows;
}

function benchmarkInput(meshKey: string, mesh: BenchmarkMesh, material: { readonly youngMPa: number; readonly poisson: number },
  thicknessMm: number, flags: readonly Flags[], perAreaN: ShellVector3): ShellAnalysisInput {
  return { schema: SHELL_ANALYSIS_SCHEMA, source: { documentId: 'shell-benchmark', revision: 1, meshKey },
    units: 'N-mm-MPa-rad', surface: 'explicit-reference-surface', nodes: mesh.nodes,
    elements: mesh.triangles.map(nodes => ({ nodes, materialId: 'benchmark', thicknessMm, offsetMm: 0 })),
    materials: [{ id: 'benchmark', youngMPa: material.youngMPa, poisson: material.poisson }],
    constraints: flags.flatMap((fixed, node): { node: number; fixed: ShellFixed6 }[] => (fixed.some(Boolean) ? [{ node, fixed }] : [])),
    nodalLoads: lumpedSurfaceLoads(mesh, perAreaN) };
}

function gridFlags(mesh: BenchmarkMesh, rule: (i: number, j: number, fixed: Flags) => void): Flags[] {
  const flags = mesh.nodes.map((): Flags => [false, false, false, false, false, false]);
  for (let j = 0; j <= mesh.cells; j += 1) for (let i = 0; i <= mesh.cells; i += 1) rule(i, j, flags[mesh.at(i, j)]);
  return flags;
}

type PlateSupport = 'simply-supported' | 'clamped';

interface PlateSpec {
  readonly support: PlateSupport;
  /** 'quarter': the corner quarter [0, a/2]^2 with symmetry rows on x = a/2 and y = a/2; 'full': [0, a]^2. */
  readonly region: 'quarter' | 'full';
  /** Cells per side of the modelled region (even for 'full', so that the centre is a node). */
  readonly cells: number;
  readonly sideMm: number;
  readonly thicknessMm: number;
  readonly youngMPa: number;
  readonly poisson: number;
  /** Uniform pressure acting in +Z [MPa]. */
  readonly pressureMPa: number;
}

/**
 * Square plate a x a in the XY plane under a uniform pressure in +Z. Supports for the Kirchhoff (DKT) plate:
 * - simply supported ("hard"): w = 0 on every edge, and the tangential slope that w = 0 along the edge implies:
 *   rx = dw/dy = 0 on x = 0 and x = a, ry = -dw/dx = 0 on y = 0 and y = a; the normal slope stays free;
 * - clamped: w = rx = ry = 0 on every edge;
 * - quarter symmetry: ry = 0 (dw/dx = 0) on x = a/2 and rx = 0 (dw/dy = 0) on y = a/2.
 * The plate is flat and loaded only out of plane, so the membrane part (ux, uy and the drilling rz) is decoupled
 * from the bending part and unloaded: it is restrained at every node (its reactions are checked to be zero).
 * The probe is the plate centre: node (cells, cells) of the quarter or (cells/2, cells/2) of the full plate.
 */
export function plateCase(spec: PlateSpec): BenchmarkCase {
  const { support, region, cells, sideMm, thicknessMm, youngMPa, poisson, pressureMPa } = spec;
  if (region === 'full' && cells % 2 !== 0) throw new Error('shell-benchmark: a full plate needs an even number of cells');
  const span = region === 'quarter' ? sideMm / 2 : sideMm;
  const mesh = unionJackMesh(cells, (i, j) => [i * span / cells, j * span / cells, 0]);
  const flags = gridFlags(mesh, (i, j, fixed) => {
    fixed[UX] = true; fixed[UY] = true; fixed[RZ] = true;
    const edgeX = i === 0 || (region === 'full' && i === cells), edgeY = j === 0 || (region === 'full' && j === cells);
    if (edgeX || edgeY) fixed[UZ] = true;
    if (support === 'clamped' && (edgeX || edgeY)) { fixed[RX] = true; fixed[RY] = true; }
    if (support === 'simply-supported') { if (edgeX) fixed[RX] = true; if (edgeY) fixed[RY] = true; }
    if (region === 'quarter') { if (i === cells) fixed[RY] = true; if (j === cells) fixed[RX] = true; }
  });
  const meshKey = `plate-${support}-${region}-${cells}-t${thicknessMm}`;
  return { input: benchmarkInput(meshKey, mesh, { youngMPa, poisson }, thicknessMm, flags, [0, 0, pressureMPa]), mesh,
    probe: region === 'quarter' ? mesh.at(cells, cells) : mesh.at(cells / 2, cells / 2) };
}

/**
 * Scordelis-Lo roof (MacNeal & Harder 1985): cylinder radius R = 25 along X, length L = 50, 80 degree arc (40 degrees
 * either side of the crown), t = 0.25, E = 4.32e8, nu = 0, self weight 90 per unit area in -Z, rigid end diaphragms,
 * free straight edges. Reference: vertical displacement -0.3024 at the midpoint of a free edge. The published values
 * are dimensionless numbers of one consistent unit system (originally ft and lbf/ft^2); used unchanged as mm and MPa
 * here, the linear elastic answer is the same number in mm.
 */
export const SCORDELIS_LO = { radiusMm: 25, lengthMm: 50, thicknessMm: 0.25, youngMPa: 4.32e8, poisson: 0, weightMPa: 90,
  halfAngleRad: 40 * Math.PI / 180, referenceUzMm: -0.3024 } as const;

/**
 * Quarter of the roof, x in [0, L/2] and phi in [0, 40 deg] from the crown: node (i, j) at
 * (i L / (2 cells), R sin(phi_j), R cos(phi_j)) with phi_j = j * 40 deg / cells, so that each cell is a flat chord
 * quadrilateral and the triangles are faceted planes. Rows: x = 0 symmetry ux = ry = rz = 0; crown symmetry (phi = 0)
 * uy = rx = rz = 0; rigid diaphragm at x = L/2 uy = uz = 0 (ux and the rotations free). Self weight as lumped loads of
 * the flat triangle areas. The probe is the free-edge midpoint (x = 0, phi = 40 deg).
 */
export function scordelisLoCase(cells: number): BenchmarkCase {
  const { radiusMm, lengthMm, thicknessMm, youngMPa, poisson, weightMPa, halfAngleRad } = SCORDELIS_LO;
  const mesh = unionJackMesh(cells, (i, j) => {
    const phi = j * halfAngleRad / cells;
    return [i * lengthMm / (2 * cells), radiusMm * Math.sin(phi), radiusMm * Math.cos(phi)];
  });
  const flags = gridFlags(mesh, (i, j, fixed) => {
    if (i === 0) { fixed[UX] = true; fixed[RY] = true; fixed[RZ] = true; }
    if (j === 0) { fixed[UY] = true; fixed[RX] = true; fixed[RZ] = true; }
    if (i === cells) { fixed[UY] = true; fixed[UZ] = true; }
  });
  return { input: benchmarkInput(`scordelis-lo-${cells}`, mesh, { youngMPa, poisson }, thicknessMm, flags, [0, 0, -weightMPa]),
    mesh, probe: mesh.at(0, cells) };
}
