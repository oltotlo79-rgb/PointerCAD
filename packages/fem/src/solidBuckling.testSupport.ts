import type { SolidAnalysisInput, SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import type { SolidBucklingInput } from './solidBucklingModel.js';

/** Independent closed-form references for the solid prestress-buckling contract.
 * Nothing here imports the product translation, decoder or native wrapper.
 *
 * Linear-shape tetrahedron N_a(x) = a_a + g_a . x (constant gradients g_a), constant
 * Cauchy stress S. The initial-stress (geometric) stiffness of the updated-Lagrange
 * linearization (Bathe, Finite Element Procedures, 2nd ed., eq. 6.79 "K_NL";
 * Zienkiewicz & Taylor, Vol. 2, ch. 10) integrates
 *   Kg[3a+i][3b+j] = V * (g_a^T S g_b) * delta_ij,
 * exactly, because every factor is constant over the element. */
export function tet4Gradients(points: readonly SolidVector3[]): { volume: number; gradients: SolidVector3[] } {
  const [p0, p1, p2, p3] = points;
  const e = [p1, p2, p3].map(p => [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]]);
  // Jacobian J has rows e1, e2, e3; gradients of N1..N3 are the columns of J^{-1}.
  const det = e[0][0] * (e[1][1] * e[2][2] - e[1][2] * e[2][1]) - e[0][1] * (e[1][0] * e[2][2] - e[1][2] * e[2][0])
    + e[0][2] * (e[1][0] * e[2][1] - e[1][1] * e[2][0]);
  const inverse = (r: number, c: number): number => {
    const rows = [0, 1, 2].filter(i => i !== c), cols = [0, 1, 2].filter(j => j !== r);
    const minor = e[rows[0]][cols[0]] * e[rows[1]][cols[1]] - e[rows[0]][cols[1]] * e[rows[1]][cols[0]];
    return ((r + c) % 2 === 0 ? 1 : -1) * minor / det;
  };
  const g: SolidVector3[] = [0, 1, 2].map(node => [inverse(0, node), inverse(1, node), inverse(2, node)]);
  const g0: SolidVector3 = [-(g[0][0] + g[1][0] + g[2][0]), -(g[0][1] + g[1][1] + g[2][1]), -(g[0][2] + g[1][2] + g[2][2])];
  return { volume: det / 6, gradients: [g0, ...g] };
}

/** Voigt stress order xx, yy, zz, yz, xz, xy (same order as SolidElementResult.stressMPa). */
export function tet4InitialStress(points: readonly SolidVector3[], stress: SolidVector6): number[][] {
  const { volume, gradients } = tet4Gradients(points);
  const s = [[stress[0], stress[5], stress[4]], [stress[5], stress[1], stress[3]], [stress[4], stress[3], stress[2]]];
  const matrix = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  for (let a = 0; a < 4; a += 1) for (let b = 0; b < 4; b += 1) {
    let scalar = 0;
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) scalar += gradients[a][i] * s[i][j] * gradients[b][j];
    for (let i = 0; i < 3; i += 1) matrix[3 * a + i][3 * b + i] = volume * scalar;
  }
  return matrix;
}

export interface SingleTetOptions {
  readonly lengthMm?: number;
  readonly youngMPa?: number;
  readonly poisson?: number;
  /** Positive = compression of the free vertex toward the fixed face. */
  readonly loadN?: number;
}

/** Corner tetrahedron (0,0,0),(L,0,0),(0,L,0),(0,0,L). Vertices 0, 2, 3 are fully
 * prescribed, vertex 1 has only z prescribed, and carries the force (-P, 0, 0).
 * With g_1 = (1/L, 0, 0) the only strains are eps_xx = u1x/L and gamma_xy = u1y/L,
 * so isotropic elasticity gives (V = L^3/6, mu = E/(2(1+nu)), lambdaL = E nu/((1+nu)(1-2nu))):
 *   K_xx = V (lambdaL + 2 mu) / L^2, K_yy = V mu / L^2, K_xy = 0,
 *   static u1x = -P / K_xx, sigma_xx = (lambdaL + 2 mu) u1x / L = -P L / V,
 *   Kg at the free vertex = V sigma_xx / L^2 * I = -(P / L) * I.
 * (K + lambda Kg) phi = 0 therefore has the two load factors
 *   lambda_y = K_yy L / P = mu L^2 / (6 P),  lambda_x = K_xx L / P = (lambdaL + 2 mu) L^2 / (6 P). */
export function singleTetBenchmark(options: SingleTetOptions = {}): SolidBucklingInput {
  const L = options.lengthMm ?? 10, P = options.loadN ?? 1000;
  const reference: SolidAnalysisInput = {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'solid-buckling-doc', revision: 3, meshKey: 'tet:corner' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: options.youngMPa ?? 205000, poisson: options.poisson ?? 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, false, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [-P, 0, 0] }], surfaceLoads: [],
  };
  return { schema: 'pointercad-solid-tet4-buckling/1', reference, modeCount: 2 };
}

/** Ascending closed-form load factors of singleTetBenchmark (both positive only in compression). */
export function singleTetLoadFactors(options: SingleTetOptions = {}): [number, number] {
  const L = options.lengthMm ?? 10, P = options.loadN ?? 1000, E = options.youngMPa ?? 205000, nu = options.poisson ?? 0.3;
  const mu = E / (2 * (1 + nu)), lame = E * nu / ((1 + nu) * (1 - 2 * nu));
  const y = mu * L * L / (6 * P), x = (lame + 2 * mu) * L * L / (6 * P);
  return y <= x ? [y, x] : [x, y];
}
