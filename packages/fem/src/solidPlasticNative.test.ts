import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { SOLID_PLASTIC_ASSETS } from './assets.js';
import { analyzeSolidPlastic, isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { SolidPlasticPlan } from './solidPlastic.js';
import type { SolidVector3 } from './solidAnalysisModel.js';
import { solidPlasticResultMatches, type SolidPlasticResult } from './solidPlasticPublicResult.js';
import { solidPlasticInputSha256, type SolidPlasticInput } from './solidPlasticTranslation.js';

// Actual packaged Pyodide 0.29.3 + NumPy 2.2.5 + OOFEM wheel, actual solidPlasticAnalysis.py from the runtime closure
// and the production runtime.analyzeSolidPlastic -> OOFEM MisesMat/ltrspace -> decodeSolidPlastic path. No reply is
// canned (solidPlasticIntegration.test.ts covers the client with a mocked interpreter; this file is the native solve).
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function pin(name: string): { sha256: string; bytes: number } {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)) throw new Error('runtime manifest has no files');
  const files: unknown = manifest.files;
  if (typeof files !== 'object' || files === null || !(`assets/${name}` in files)) throw new Error(`unpinned asset ${name}`);
  const row: unknown = Object.entries(files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof row !== 'object' || row === null || !('sha256' in row) || !('bytes' in row)
    || typeof row.sha256 !== 'string' || typeof row.bytes !== 'number') throw new Error(`invalid pin ${name}`);
  return { sha256: row.sha256, bytes: row.bytes };
}
function verified(name: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(assets, name)));
  expect({ name, bytes: bytes.byteLength, sha256: sha256(bytes) }).toEqual({ name, ...pin(name) });
  return bytes;
}

/*
 * Benchmark (units N-mm-MPa): a body under homogeneous UNIAXIAL stress xx. Symmetry supports on x = 0, y = 0 and
 * z = 0 and a prescribed end displacement d * factor on x = L leave the lateral faces free, so the exact field is
 * u = (eps x, eps_t y, eps_t z) with sigma_yy = sigma_zz = 0 and no shear, which tet4 represents exactly.
 * The independent oracle below is the closed-form small-strain J2 uniaxial response with linear isotropic hardening
 * (yield sigma0 + H kappa, kappa the accumulated uniaxial plastic strain): elastic slope E, plastic tangent
 * E H / (E + H), elastic unloading with slope E and no new plastic strain, plastic incompressibility (lateral plastic
 * strain -eps_p / 2) and elastic lateral strain -nu sigma / E. The values equal the hand-derived plasticBarNative
 * proof table (252.47524752475247 MPa, 1.2376237623762376e-3, ...), independent of OOFEM.
 */
const L = 10;
const E = 200000, NU = 0.3, SIGMA0 = 250, H = 2000;
const STRAIN_AT_FACTOR_ONE = 2.5e-3;
const KNOTS = [0, 1, 0, -1, 0];
interface Uniaxial { readonly stress: number; readonly plastic: number; readonly lateral: number }
function oracle(knots: readonly number[], hardening: number): Uniaxial[] {
  let plastic = 0, kappa = 0;
  return knots.slice(1).map(knot => {
    const strain = knot * STRAIN_AT_FACTOR_ONE, trial = E * (strain - plastic);
    const excess = Math.abs(trial) - (SIGMA0 + hardening * kappa);
    let stress = trial;
    if (excess > 0) {
      const increment = excess / (E + hardening), sign = Math.sign(trial);
      plastic += sign * increment; kappa += increment; stress = trial - sign * E * increment;
    }
    return { stress, plastic, lateral: -NU * stress / E - plastic / 2 };
  });
}
const material = (hardening: number): SolidPlasticPlan['material'] => ({ youngMPa: E, poisson: NU, yieldStressMPa: SIGMA0,
  hardeningModulusMPa: hardening, source: { kind: 'user-supplied', reference: 'Numerical uniaxial benchmark entered for this test' } });
function supports(nodes: readonly SolidVector3[]): SolidPlasticPlan['prescribedMm'] {
  const rows: { node: number; dof: 'x' | 'y' | 'z'; valueMm: number }[] = [];
  nodes.forEach((point, node) => {
    if (point[0] === 0) rows.push({ node, dof: 'x', valueMm: 0 });
    if (point[0] === L) rows.push({ node, dof: 'x', valueMm: STRAIN_AT_FACTOR_ONE * L });
    if (point[1] === 0) rows.push({ node, dof: 'y', valueMm: 0 });
    if (point[2] === 0) rows.push({ node, dof: 'z', valueMm: 0 });
  });
  return rows;
}
/** One tetrahedron with three faces on the symmetry planes (constant strain). */
const ONE_NODES: readonly SolidVector3[] = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]];
/** A cube split into six positively oriented tetrahedra around its main diagonal (Kuhn triangulation). */
const CUBE_NODES: readonly SolidVector3[] = Array.from({ length: 8 }, (_, n) => [L * (n & 1), L * ((n >> 1) & 1), L * ((n >> 2) & 1)] as const);
function positive(tet: readonly [number, number, number, number]): readonly [number, number, number, number] {
  const [a, b, c, d] = tet.map(n => CUBE_NODES[n]);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const volume = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  return volume > 0 ? tet : [tet[0], tet[1], tet[3], tet[2]];
}
const CUBE_ELEMENTS = ([[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]] as const).map(positive);
function input(options: { nodes?: readonly SolidVector3[]; elements?: SolidPlasticPlan['elements']; hardening?: number;
  knots?: readonly number[]; steps?: number; revision?: number } = {}): SolidPlasticInput {
  const nodes = options.nodes ?? ONE_NODES;
  return { schema: 'pointercad-solid-plastic/1', source: { documentId: 'native-plastic-doc', revision: options.revision ?? 3 },
    plan: { schema: 'pointercad-oofem-solid-plastic-plan/1', units: 'N-mm-MPa', nodes,
      elements: options.elements ?? [[0, 1, 2, 3]], material: material(options.hardening ?? H), prescribedMm: supports(nodes),
      forcesN: [], loadFactor: options.knots ?? KNOTS, stepsPerSegment: options.steps ?? 5 } };
}

let runtime: PyodideRuntime | undefined;
let denied = 0;
const loads: string[] = [];
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  globalThis.fetch = () => { denied += 1; return Promise.reject(new Error('offline-request-denied')); };
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid Pyodide version or API');
  const real = loaded;
  runtime = { version: real.version, FS: real.FS, runPython: code => real.runPython(code),
    loadPackage: (packages, options) => { loads.push(String(packages)); return real.loadPackage(packages, options); } };
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; });

async function solve(value: SolidPlasticInput): Promise<SolidPlasticResult> {
  if (runtime === undefined) throw new Error('Pyodide did not load');
  const phases: string[] = [];
  const result = await analyzeSolidPlastic(runtime, value, { wrapper: verified('solidPlasticAnalysis.py'),
    wheelLocation: join(assets, wheel).split(sep).join('/') }, phase => { phases.push(phase); });
  expect(phases).toEqual(['loading-packages', 'solving']);
  expect(solidPlasticResultMatches(result, value, await solidPlasticInputSha256(value))).toBe(true);
  expect([result.method, result.scope, result.structuralCertification]).toEqual(
    ['oofem-misesmat-htype0-ltrspace-staticstructural/2', 'small-strain-j2-linear-isotropic-hardening-tet4', false]);
  expect(denied).toBe(0);
  return result;
}
const near = (actual: number, expected: number, scale: number): void => {
  expect(Math.abs(actual - expected) / scale, `${actual} vs ${expected}`).toBeLessThanOrEqual(1e-8);
};
/** Every element of every recorded segment end carries the oracle's uniaxial state; lateral and shear stress vanish. */
function expectUniaxial(result: SolidPlasticResult, expected: readonly Uniaxial[]): void {
  expect(result.records).toHaveLength(expected.length);
  result.records.forEach((record, segment) => {
    const want = expected[segment];
    expect(record.freeResidualRatio).toBeLessThanOrEqual(1e-8);
    for (const state of record.elements) {
      near(state.stressMPa[0], want.stress, SIGMA0);
      for (const index of [1, 2, 3, 4, 5]) near(state.stressMPa[index], 0, SIGMA0);
      near(state.plasticStrain[0], want.plastic, SIGMA0 / E);
      near(state.plasticStrain[1], -want.plastic / 2, SIGMA0 / E);
      near(state.plasticStrain[2], -want.plastic / 2, SIGMA0 / E);
      near(state.strain[1], want.lateral, SIGMA0 / E);
      near(state.strain[2], want.lateral, SIGMA0 / E);
    }
    // The free lateral displacements are the exact field: y and z of every node scale with the lateral strain.
    record.displacementMm.forEach((u, node) => {
      const point = result.input.plan.nodes[node];
      near(u[1], want.lateral * point[1], SIGMA0 / E * L);
      near(u[2], want.lateral * point[2], SIGMA0 / E * L);
    });
  });
}

describe('solid J2 plasticity on the actual packaged OOFEM runtime', () => {
  it('pins solidPlasticAnalysis.py identically in assets.ts, the runtime manifest and the shipped bytes', () => {
    const bytes = verified('solidPlasticAnalysis.py');
    expect(SOLID_PLASTIC_ASSETS).toEqual([{ file: 'solidPlasticAnalysis.py', bytes: bytes.byteLength, sha256: sha256(bytes) }]);
  });

  it('stays exactly elastic below yield and invents no plastic strain', async () => {
    const result = await solve(input({ knots: [0, 0.4] }));
    expect(result.yielded).toBe(false);
    expectUniaxial(result, oracle([0, 0.4], H));
    near(result.records[0].elements[0].stressMPa[0], E * 0.4 * STRAIN_AT_FACTOR_ONE, SIGMA0);
    expect(result.records[0].elements[0].plasticStrain.every(value => value === 0)).toBe(true);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('yields, hardens with E H / (E + H), unloads elastically with slope E, and reverses into compression', async () => {
    const expected = oracle(KNOTS, H);
    // Hand values (plasticBarNative.proof.md) guard the oracle itself.
    near(expected[0].stress, 252.47524752475246, SIGMA0); near(expected[0].plastic, 1.2376237623762376e-3, SIGMA0 / E);
    near(expected[2].stress, -257.3767277717871, SIGMA0); near(expected[2].plastic, -1.2131163611410645e-3, SIGMA0 / E);
    const result = await solve(input());
    expect(result.yielded).toBe(true);
    expectUniaxial(result, expected);
    const [peak, unloaded] = result.records.map(record => record.elements[0]);
    // Unloading from the peak to zero end displacement: slope E, plastic strain unchanged (no new yielding).
    near((unloaded.stressMPa[0] - peak.stressMPa[0]) / (unloaded.strain[0] - peak.strain[0]), E, E);
    near(unloaded.plasticStrain[0], peak.plasticStrain[0], SIGMA0 / E);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('gives the same end states for 1, 5 and 20 increments per segment and for one or six elements', async () => {
    const expected = oracle(KNOTS, H);
    for (const steps of [1, 20]) expectUniaxial(await solve(input({ steps })), expected);
    const cube = await solve(input({ nodes: CUBE_NODES, elements: CUBE_ELEMENTS }));
    expect(cube.records.every(record => record.elements.length === 6)).toBe(true);
    expectUniaxial(cube, expected);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('uses the entered hardening: H = 0 is perfectly plastic at sigma0, and a changed material is a different request', async () => {
    const perfectInput = input({ hardening: 0 });
    const perfect = await solve(perfectInput);
    expectUniaxial(perfect, oracle(KNOTS, 0));
    near(perfect.records[0].elements[0].stressMPa[0], SIGMA0, SIGMA0);
    near(perfect.records[2].elements[0].stressMPa[0], -SIGMA0, SIGMA0);
    // Negative control: the hardening result differs from the perfectly plastic oracle by about 1 % at the peak.
    const hardened = await solve(input());
    expect(Math.abs(hardened.records[0].elements[0].stressMPa[0] - SIGMA0) / SIGMA0).toBeGreaterThan(5e-3);
    // Result invalidation: a result bound to one material or revision never matches another request.
    expect(solidPlasticResultMatches(hardened, perfectInput, await solidPlasticInputSha256(perfectInput))).toBe(false);
    const later = input({ revision: 4 });
    expect(solidPlasticResultMatches(hardened, later, await solidPlasticInputSha256(later))).toBe(false);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('refuses an invalid plan before the runtime is touched', async () => {
    if (runtime === undefined) throw new Error('Pyodide did not load');
    const before = loads.length;
    await expect(analyzeSolidPlastic(runtime, input({ hardening: -1 }),
      { wrapper: verified('solidPlasticAnalysis.py'), wheelLocation: wheel }, () => undefined)).rejects.toThrow('softening');
    expect(loads.length).toBe(before);
  });
});


describe('外力を除いた後の自由な残留変位の独立照合', () => {
  // V=L^3/6、u_x=eps*xより、自由なnode1-xの力はsigma*V/L=sigma*L^2/6。
  // 塑性例: sigma=260MPa、eps_p=(260-250)/2000=0.005、eps=0.005+260/200000=0.0063。
  // 力を0へ戻す除荷は弾性で、u_x(L)=L*eps_p=0.05mm。端変位を0に固定しない。
  it.each([
    { name: '降伏後は0.05mmが残る', peakStressMPa: 260, plasticStrain: 0.005,
      peakStrain: 0.0063, residualDisplacementMm: 0.05, yielded: true },
    { name: '降伏前は残らない', peakStressMPa: 200, plasticStrain: 0,
      peakStrain: 0.001, residualDisplacementMm: 0, yielded: false },
  ] as const)('$name', async ({ peakStressMPa, plasticStrain, peakStrain, residualDisplacementMm, yielded }) => {
    const base = input({ knots: [0, 1, 0], steps: 10 });
    const value: SolidPlasticInput = { ...base, plan: { ...base.plan,
      prescribedMm: base.plan.prescribedMm.filter(p => !(p.node === 1 && p.dof === 'x')),
      forcesN: [{ node: 1, dof: 'x', forceN: peakStressMPa * L * L / 6 }] } };
    expect(value.plan.prescribedMm.some(p => p.node === 1 && p.dof === 'x')).toBe(false);
    const result = await solve(value);
    expect(result.yielded).toBe(yielded);
    expectUniaxial(result, [
      { stress: peakStressMPa, plastic: plasticStrain, lateral: -NU * peakStressMPa / E - plasticStrain / 2 },
      { stress: 0, plastic: plasticStrain, lateral: -plasticStrain / 2 },
    ]);
    const [peak, unloaded] = result.records;
    expect(unloaded.loadFactor).toBe(0);
    near(peak.displacementMm[1][0], peakStrain * L, SIGMA0 / E * L);
    near(unloaded.displacementMm[1][0], residualDisplacementMm, SIGMA0 / E * L);
    // 全節点の軸変位も独立な一様場で照合する。残留の符号や局所節点だけを見落とさない。
    for (const [index, strain] of [peakStrain, plasticStrain].entries()) {
      result.records[index].displacementMm.forEach((u, node) => {
        near(u[0], strain * ONE_NODES[node][0], SIGMA0 / E * L);
      });
    }
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
