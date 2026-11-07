import { describe, expect, it } from 'vitest';
import type { SolidVector3, SolidVector6 } from './solidAnalysisModel.js';
import { decodeSolidBuckling } from './solidBucklingResults.js';
import { solidBucklingInputSha256, translateSolidBuckling } from './solidBucklingTranslation.js';
import { singleTetBenchmark, singleTetLoadFactors } from './solidBuckling.testSupport.js';

/** Independent closed-form references for the solid prestress-buckling contract.
 * Nothing here imports the product translation, decoder or native wrapper.
 *
 * Linear-shape tetrahedron N_a(x) = a_a + g_a . x (constant gradients g_a), constant
 * Cauchy stress S. The initial-stress (geometric) stiffness of the updated-Lagrange
 * linearization (Bathe, Finite Element Procedures, 2nd ed., eq. 6.79 "K_NL";
 * Zienkiewicz & Taylor, Vol. 2, ch. 10) integrates
 *   Kg[3a+i][3b+j] = V * (g_a^T S g_b) * delta_ij,
 * exactly, because every factor is constant over the element. */
function tet4Gradients(points: readonly SolidVector3[]): { volume: number; gradients: SolidVector3[] } {
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
function tet4InitialStress(points: readonly SolidVector3[], stress: SolidVector6): number[][] {
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

const multiply = (matrix: readonly (readonly number[])[], vector: readonly number[]): number[] =>
  matrix.map(row => row.reduce((sum, value, index) => sum + value * vector[index], 0));
const skew: SolidVector3[] = [[0, 0, 0], [12, 1, -2], [3, 9, 1], [-1, 2, 11]];

describe('independent tet4 initial-stress oracle', () => {
  it('has V sigma / L^2 on the loaded vertex of the corner tetrahedron and nothing else', () => {
    const L = 10, sigma = -60;
    const matrix = tet4InitialStress([[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]], [sigma, 0, 0, 0, 0, 0]);
    const expected = (L ** 3 / 6) * sigma / L ** 2;
    for (let i = 0; i < 3; i += 1) expect(matrix[3 + i][3 + i]).toBeCloseTo(expected, 12);
    expect(matrix[3][4]).toBe(0);
    // Vertex 0 carries g_0 = (-1/L, 0, 0); vertices 2 and 3 have no x gradient.
    expect(matrix[0][3]).toBeCloseTo(-expected, 12);
    expect(matrix[6][6]).toBe(0);
    expect(matrix[9][9]).toBe(0);
  });
  it('is symmetric and annihilates every rigid translation for a general stress state', () => {
    const matrix = tet4InitialStress(skew, [-40, 15, 7, -3, 9, 21]);
    matrix.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(matrix[j][i], 10)));
    for (const translation of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -2, 5]]) {
      const field = [0, 1, 2, 3].flatMap(() => translation);
      multiply(matrix, field).forEach(value => expect(Math.abs(value)).toBeLessThan(1e-9));
    }
    const { volume, gradients } = tet4Gradients(skew);
    expect(volume).toBeGreaterThan(0);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(gradients.reduce((sum, g) => sum + g[axis], 0))).toBeLessThan(1e-15);
    }
  });
  it('is linear in stress and changes sign between compression and tension', () => {
    const compression = tet4InitialStress(skew, [-10, 0, 0, 0, 0, 0]);
    const tension = tet4InitialStress(skew, [20, 0, 0, 0, 0, 0]);
    compression.forEach((row, i) => row.forEach((value, j) => expect(tension[i][j]).toBeCloseTo(-2 * value, 10)));
  });
  it('scales the benchmark load factors as 1/P, E and L^2 and is dimensionless', () => {
    const [y, x] = singleTetLoadFactors();
    const [y2] = singleTetLoadFactors({ loadN: 2000 });
    const [yE] = singleTetLoadFactors({ youngMPa: 410000 });
    const [yL] = singleTetLoadFactors({ lengthMm: 20 });
    expect(y2 / y).toBeCloseTo(0.5, 12);
    expect(yE / y).toBeCloseTo(2, 12);
    expect(yL / y).toBeCloseTo(4, 12);
    // nu = 0: mu = E/2 and lambdaL = 0, so lambda_x / lambda_y = 2 exactly.
    const [y0, x0] = singleTetLoadFactors({ poisson: 0 });
    expect(x0 / y0).toBeCloseTo(2, 12);
    expect(y0).toBeCloseTo(205000 * 100 / (12 * 1000), 9);
    expect(x).toBeGreaterThan(y);
    const [tensionY, tensionX] = singleTetLoadFactors({ loadN: -1000 });
    expect(tensionY).toBeLessThan(0);
    expect(tensionX).toBeLessThan(0);
  });
});

describe('solid buckling translation', () => {
  it('reuses the static contract as the reference state and counts free DOFs', () => {
    const { input, plan } = translateSolidBuckling(singleTetBenchmark());
    expect(plan.freeDofs).toBe(2);
    expect(plan.reference.forcesN[1]).toEqual([-1000, 0, 0]);
    expect(plan.reference.fixed[1]).toEqual([false, false, true]);
    expect(input.modeCount).toBe(2);
  });
  it('refuses invalid mode counts and more modes than free DOFs', () => {
    for (const modeCount of [0, 13, 1.5]) {
      expect(() => translateSolidBuckling({ ...singleTetBenchmark(), modeCount })).toThrow('solid-buckling-modes:');
    }
    expect(() => translateSolidBuckling({ ...singleTetBenchmark(), modeCount: 3 })).toThrow('solid-buckling-supports:');
  });
  it('refuses a reference state without load on a free DOF', () => {
    const base = singleTetBenchmark();
    for (const nodalLoads of [[], [{ node: 0, forceN: [-1000, 0, 0] }], [{ node: 1, forceN: [0, 0, -1000] }]]) {
      expect(() => translateSolidBuckling({ ...base, reference: { ...base.reference, nodalLoads } }))
        .toThrow('solid-buckling-load:');
    }
  });
  it('refuses rigid-body motion, unknown schema and extra fields', () => {
    const base = singleTetBenchmark();
    expect(() => translateSolidBuckling({ ...base, reference: { ...base.reference,
      constraints: [{ node: 0, fixed: [true, true, true] }] } })).toThrow('unrestrained component rigid-body motion');
    expect(() => translateSolidBuckling({ ...base, schema: 'pointercad-beam-buckling/1' })).toThrow('solid-buckling-schema:');
    expect(() => translateSolidBuckling({ ...base, follower: true })).toThrow('unexpected fields');
  });
  it('hashes the owned input and changes with the requested modes', async () => {
    const one = await solidBucklingInputSha256(singleTetBenchmark());
    expect(one).toMatch(/^[0-9a-f]{64}$/u);
    expect(await solidBucklingInputSha256(singleTetBenchmark())).toBe(one);
    expect(await solidBucklingInputSha256({ ...singleTetBenchmark(), modeCount: 1 })).not.toBe(one);
  });
});

describe('solid buckling result decoding', () => {
  const input = singleTetBenchmark();
  const hash = 'a'.repeat(64);
  const [lowest, second] = singleTetLoadFactors();
  const shape = (free: SolidVector3): SolidVector3[] => [[0, 0, 0], free, [0, 0, 0], [0, 0, 0]];
  const reply = () => ({
    schema: 'pointercad-solid-tet4-buckling-native/1', source: { ...input.reference.source }, freeDofs: 2,
    referenceEquilibriumResidual: 1e-13, maximumElementInitialStressError: 1e-14,
    modes: [{ number: 1, loadFactor: lowest, normalizedResidual: 1e-14, shape: shape([0, 1, 0]) },
      { number: 2, loadFactor: second, normalizedResidual: 1e-14, shape: shape([-1, 0, 0]) }],
  });
  it('propagates a reply that satisfies the independent closed-form benchmark', () => {
    const result = decodeSolidBuckling(reply(), input, hash);
    expect(result).toMatchObject({ kind: 'oofem-solid-tet4-buckling', method: 'oofem-ltrspace-initial-stress-eigh/1',
      scope: 'linear-elastic-prestress-bifurcation', units: 'N-mm-MPa', freeDofs: 2, inputSha256: hash,
      structuralCertification: false, source: input.reference.source });
    expect(result.modes.map(mode => mode.loadFactor)).toEqual([lowest, second]);
  });
  it('refuses every invalid metadata, ordering, sign, support and normalization', () => {
    const cases: [string, (raw: ReturnType<typeof reply>) => unknown][] = [
      ['descending', raw => ({ ...raw, modes: [{ ...raw.modes[1], number: 1 }, { ...raw.modes[0], number: 2 }] })],
      ['tension or zero', raw => ({ ...raw, modes: [{ ...raw.modes[0], loadFactor: -lowest }, raw.modes[1]] })],
      ['support', raw => ({ ...raw, modes: [{ ...raw.modes[0], shape: shape([0, 1, 1e-9]) }, raw.modes[1]] })],
      ['normalization', raw => ({ ...raw, modes: [{ ...raw.modes[0], shape: shape([0, 0.5, 0]) }, raw.modes[1]] })],
      ['mode residual', raw => ({ ...raw, modes: [{ ...raw.modes[0], normalizedResidual: 2e-8 }, raw.modes[1]] })],
      ['reference residual', raw => ({ ...raw, referenceEquilibriumResidual: 2e-8 })],
      ['initial stress', raw => ({ ...raw, maximumElementInitialStressError: 2e-8 })],
      ['free DOFs', raw => ({ ...raw, freeDofs: 3 })],
      ['source', raw => ({ ...raw, source: { ...raw.source, revision: 4 } })],
      ['mode count', raw => ({ ...raw, modes: [raw.modes[0]] })],
      ['extra field', raw => ({ ...raw, certified: true })],
      ['schema', raw => ({ ...raw, schema: 'pointercad-oofem-buckling-result/1' })],
    ];
    for (const [name, mutate] of cases) {
      expect(() => decodeSolidBuckling(mutate(reply()), input, hash), name).toThrow('solid-buckling-result:');
    }
    expect(() => decodeSolidBuckling(reply(), input, 'A'.repeat(64))).toThrow('solid-buckling-result:');
  });
});
