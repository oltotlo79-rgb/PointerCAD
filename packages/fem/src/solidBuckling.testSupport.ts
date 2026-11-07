import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import type { SolidBucklingInput } from './solidBucklingModel.js';

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
