import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { cantilever } from './analysisCases.testSupport.js';
import { loadPackagedRuntime, verifiedAsset, wheelLocation } from './linearStaticBenchmark.testSupport.js';
import { analyzeBeam, analyzeSolid, type PyodideRuntime } from './runtime.js';
import { compareVerification } from './verificationComparison.testSupport.js';
import { linearInput } from './verificationCases.testSupport.js';
import { beamInputSha256 } from './analysisTranslation.js';
import { beamResultMatches } from './analysisResults.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';
import type { SolidAnalysisInput, SolidVector3 } from './solidAnalysisModel.js';

/** Cantilever in N, m, Pa; the same numbers analysisCases.testSupport cantilever() builds, restated as the oracle. */
const BEAM = { lengthM: 2, forceN: 4000, youngPa: 208e9, shearPa: 80e9, areaM2: 0.003, izM4: 5e-6,
  shearFactor: 5 / 6 } as const;

/** Timoshenko tip deflection under a tip force P along local y (bending about z): P L^3 / (3 E Iz) + P L / (k G A). */
function cantileverTipDeflectionM(forceN: number): number {
  const { lengthM: L, youngPa: E, shearPa: G, areaM2: A, izM4: I, shearFactor: k } = BEAM;
  return forceN * L ** 3 / (3 * E * I) + forceN * L / (k * G * A);
}

/** Legacy Euler-Bernoulli formula without the shear term; only used as a negative oracle. */
function cantileverTipDeflectionWithoutShearM(forceN: number): number {
  const { lengthM: L, youngPa: E, izM4: I } = BEAM;
  return forceN * L ** 3 / (3 * E * I);
}

/** Axial tip elongation P L / (E A). */
function axialElongationM(forceN: number): number {
  return forceN * BEAM.lengthM / (BEAM.youngPa * BEAM.areaM2);
}

/** Prismatic bar in N-mm-MPa: x in [0, 30], y in [0, 4], z in [0, 6], nu = 0.3, end stress 10 MPa. */
const BAR = { lengthMm: 30, widthMm: 4, heightMm: 6, youngMPa: 210000, poisson: 0.3, stressMPa: 10 } as const;

const barForceN = (): number => BAR.stressMPa * BAR.widthMm * BAR.heightMm;

/** Uniaxial stress sigma_xx = P / A: u = (s x / E, -nu s y / E, -nu s z / E). Free lateral contraction. */
function uniaxialDisplacementMm(point: SolidVector3): SolidVector3 {
  const strain = BAR.stressMPa / BAR.youngMPa;
  return [strain * point[0], -BAR.poisson * strain * point[1], -BAR.poisson * strain * point[2]];
}

/**
 * Level n: 5n x n x n Cartesian cells, each split into the six Kuhn tetrahedra about its main diagonal (conforming).
 * Supports remove only the six rigid modes and never restrain Poisson contraction: every x = 0 node is held in x,
 * the origin also in y and z, and (0, width, 0) also in z. The exact uniaxial field satisfies all of them exactly.
 * The x = L end carries the uniform traction (stress, 0, 0) on its exterior element faces.
 */
function tensionBar(level: number): SolidAnalysisInput {
  const nx = 5 * level, ny = level, nz = level;
  const id = (i: number, j: number, k: number): number => (i * (ny + 1) + j) * (nz + 1) + k;
  const nodes: SolidVector3[] = [];
  for (let i = 0; i <= nx; i += 1) for (let j = 0; j <= ny; j += 1) for (let k = 0; k <= nz; k += 1)
    nodes.push([BAR.lengthMm * i / nx, BAR.widthMm * j / ny, BAR.heightMm * k / nz]);
  const elements: SolidAnalysisInput['elements'][number][] = [];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;
  const signedVolume = (a: number, b: number, c: number, d: number): number => {
    const [p, q, r, s] = [nodes[a], nodes[b], nodes[c], nodes[d]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const w = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  for (let i = 0; i < nx; i += 1) for (let j = 0; j < ny; j += 1) for (let k = 0; k < nz; k += 1) {
    const corner = (bits: readonly [number, number, number]): number => id(i + bits[0], j + bits[1], k + bits[2]);
    for (const [a0, a1] of permutations) {
      const first: [number, number, number] = [0, 0, 0], second: [number, number, number] = [0, 0, 0];
      first[a0] = 1; second[a0] = 1; second[a1] = 1;
      const tet: [number, number, number, number] = [corner([0, 0, 0]), corner(first), corner(second), corner([1, 1, 1])];
      if (signedVolume(...tet) < 0) [tet[1], tet[2]] = [tet[2], tet[1]];
      elements.push({ materialId: 'bar', nodes: tet });
    }
  }
  const faces = new Map<string, { readonly nodes: [number, number, number]; count: number }>();
  for (const { nodes: [a, b, c, d] } of elements) for (const face of [[b, c, d], [a, d, c], [a, b, d], [a, c, b]] as const) {
    const key = [...face].sort((x, y) => x - y).join(','), found = faces.get(key);
    if (found) found.count += 1; else faces.set(key, { nodes: [face[0], face[1], face[2]], count: 1 });
  }
  const surfaceLoads = [...faces.values()].filter(face => face.count === 1
    && face.nodes.every(node => nodes[node][0] === BAR.lengthMm))
    .map(face => ({ nodes: face.nodes, tractionMPa: [BAR.stressMPa, 0, 0] as const }));
  const constraints: SolidAnalysisInput['constraints'][number][] = [];
  for (let j = 0; j <= ny; j += 1) for (let k = 0; k <= nz; k += 1)
    constraints.push({ node: id(0, j, k), fixed: [true, j === 0 && k === 0, k === 0 && (j === 0 || j === ny)] });
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'W14-tension-bar', revision: 1, meshKey: `tension-${level}` },
    units: 'N-mm-MPa', numericBudgetBytes: 128 * 1024 * 1024, nodes, elements,
    materials: [{ id: 'bar', youngMPa: BAR.youngMPa, poisson: BAR.poisson }], constraints, nodalLoads: [], surfaceLoads };
}

const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

// W14: actual pinned offline Pyodide + OOFEM through the public analyzeBeam / analyzeSolid routes, compared with
// closed forms only. This is a linear-elastic oracle; it says nothing about material-grade conformity, plasticity or fatigue.
describe('W14 independent linear-static oracles on the packaged offline OOFEM', () => {
  const originalFetch = globalThis.fetch;
  let runtime: PyodideRuntime, deniedRequests = 0;
  beforeAll(async () => {
    globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
    runtime = await loadPackagedRuntime();
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

  it('matches the Timoshenko cantilever tip deflection and axial elongation, rejecting the shear-free formula and a flipped sign', async () => {
    const programs = { wrapper: verifiedAsset('beamAnalysis.py'), wheelLocation: wheelLocation() };
    const bending = cantilever({ mode: 'y' });
    // The fixture is input only; pin that it carries the oracle's constants before trusting the comparison.
    expect(bending.units).toBe('N-m');
    expect(bending.nodes.find(node => node.id === 'tip')?.position).toEqual([BEAM.lengthM, 0, 0]);
    expect(bending.materials[0]).toMatchObject({ youngModulus: BEAM.youngPa, shearModulus: BEAM.shearPa });
    expect(bending.sections[0]).toMatchObject({ area: BEAM.areaM2, iz: BEAM.izM4, shearFactor: BEAM.shearFactor });
    expect(bending.loads[0]).toMatchObject({ nodeId: 'tip', force: [0, BEAM.forceN, 0] });
    const tip = async (document: ReturnType<typeof cantilever>): Promise<readonly number[]> => {
      const result = await analyzeBeam(runtime, document, programs, () => undefined);
      expect(beamResultMatches(result, document, await beamInputSha256(document))).toBe(true);
      const stale = { ...document, revision: document.revision + 1 };
      expect(beamResultMatches(result, stale, await beamInputSha256(stale))).toBe(false);
      const found = result.nodes.find(node => node.nodeId === 'tip');
      if (found === undefined) throw new Error('Missing tip node result');
      return found.displacementM;
    };
    const expected = cantileverTipDeflectionM(BEAM.forceN), bent = await tip(bending);
    expect(relative(bent[1], expected), 'tip deflection vs PL^3/(3EI)+PL/(kGA)').toBeLessThanOrEqual(1e-3);
    expect(compareVerification('linear-cantilever-tip-y-v1', { caseId: 'linear-cantilever-tip-y-v1', input: linearInput(bending), value: bent[1] }).passed).toBe(true);
    // Negative oracle 1: the shear-free formula is off by PL/(kGA) / total = 3.9e-3 and must not pass the same limit.
    expect(relative(bent[1], cantileverTipDeflectionWithoutShearM(BEAM.forceN))).toBeGreaterThan(1e-3);
    // Negative oracle 2: reversing the load reverses the deflection; the unreversed expectation must fail.
    const reversed = await tip(cantilever({ mode: 'y', forceMultiplier: -1 }));
    expect(relative(reversed[1], -expected)).toBeLessThanOrEqual(1e-3);
    expect(relative(reversed[1], expected)).toBeGreaterThan(1e-3);
    const axial = await tip(cantilever({ mode: 'axial' }));
    expect(relative(axial[0], axialElongationM(BEAM.forceN)), 'axial PL/(EA)').toBeLessThanOrEqual(1e-6);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('reproduces uniaxial tension displacement and the non-singular stress P/A on three refinements with free Poisson contraction', async () => {
    const programs = { wrapper: verifiedAsset('solidAnalysis.py'), wheelLocation: wheelLocation() };
    const area = BAR.widthMm * BAR.heightMm, force = barForceN(), stress = force / area;
    const tipMm = BAR.stressMPa * BAR.lengthMm / BAR.youngMPa;
    const cornerLateralMm = -BAR.poisson * BAR.stressMPa * BAR.widthMm / BAR.youngMPa;
    for (const level of [1, 2, 3]) {
      const input = tensionBar(level), before = structuredClone(input);
      const result = await analyzeSolid(runtime, input, programs, () => undefined);
      expect(result.elements).toHaveLength(input.elements.length);
      const support = result.reactionN.reduce((total, row) => total + row[0], 0);
      expect(relative(support, -force), `level ${level} support force vs -P`).toBeLessThanOrEqual(1e-6);
      let worst = 0;
      input.nodes.forEach((point, node) => {
        const exact = uniaxialDisplacementMm(point), got = result.displacementMm[node];
        worst = Math.max(worst, Math.hypot(got[0] - exact[0], got[1] - exact[1], got[2] - exact[2]) / tipMm);
      });
      expect(worst, `level ${level} displacement error / (sigma L / E)`).toBeLessThanOrEqual(1e-3);
      // The far corner (L, W, H) is the last node: free contraction must actually occur, not be restrained to zero.
      const corner = result.displacementMm[input.nodes.length - 1];
      expect(relative(corner[1], cornerLateralMm), `level ${level} lateral contraction`).toBeLessThanOrEqual(1e-3);
      for (const element of result.elements) {
        expect(relative(element.stressMPa[0], stress)).toBeLessThanOrEqual(0.01);
        expect(Math.max(...element.stressMPa.slice(1).map(value => Math.abs(value))) / stress).toBeLessThanOrEqual(0.01);
      }
      expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
      expect(input).toEqual(before);
    }
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
