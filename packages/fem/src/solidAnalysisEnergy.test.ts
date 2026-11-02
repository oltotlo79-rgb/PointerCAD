import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SOLID_ASSETS } from './assets.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { SolidAnalysisInput, SolidVector3 } from './solidAnalysisModel.js';
import { solidInputSha256, solidTetGeometry, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { decodeSolidAnalysis } from './solidAnalysisResults.js';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';

const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
let runtime: PyodideRuntime;
let deniedRequests = 0;
const originalFetch = globalThis.fetch;
function verified(name: string): Uint8Array {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing manifest');
  const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error('Missing asset pin');
  const bytes = new Uint8Array(readFileSync(join(assets, name)));
  expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
  return bytes;
}
beforeAll(async () => {
  const wrapper = verified('solidAnalysis.py');
  const reviewedSource = readFileSync(new URL('./solidAnalysis.py', import.meta.url));
  expect(createHash('sha256').update(wrapper).digest('hex'))
    .toBe(createHash('sha256').update(reviewedSource).digest('hex'));
  expect(SOLID_ASSETS).toEqual([{ file: 'solidAnalysis.py', bytes: wrapper.byteLength,
    sha256: createHash('sha256').update(wrapper).digest('hex') }]);
  globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: console.info, stderr: console.error });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged runtime');
  runtime = loaded;
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/solid_analysis.py', wrapper);
  await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
  runtime.runPython("import sys\nsys.path.insert(0, '/pcad_fem')\nimport solid_analysis as ordering\n");
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

function box(translation: number): SolidAnalysisInput {
  const nodes: SolidVector3[] = Array.from({ length: 8 }, (_, i) => [i & 1 ? 20 : -20, i & 2 ? 15 : -15, i & 4 ? 5 : -5]);
  const cells = [[0,1,3,7],[0,1,5,7],[0,2,3,7],[0,2,6,7],[0,4,5,7],[0,4,6,7]];
  const elements = cells.map(cell => {
    try { solidTetGeometry(cell.map(i => nodes[i])); } catch { [cell[1],cell[2]]=[cell[2],cell[1]]; }
    return { nodes: cell as [number,number,number,number], materialId: 'm' };
  });
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'energy-box', revision: 1, meshKey: 'six-tet' },
    units: 'N-mm-MPa', numericBudgetBytes: 16*1024*1024, nodes, elements, materials: [{ id:'m',youngMPa:210000,poisson:0.3 }],
    constraints: nodes.map((p,node) => ({ node, fixed: [p[0]===20,p[1]===-15,p[2]===5] as const,
      prescribedMm: [p[0]===20 ? translation : 0,0,0] as const })).filter(c => c.fixed.some(Boolean)), nodalLoads: [], surfaceLoads: [],
    gravity: { accelerationMps2:[0,0,-9.81], densities:[{materialId:'m',densityKgM3:7800}] } };
}

async function solve(input: SolidAnalysisInput) {
  const { plan } = translateSolidAnalysis(input);
  runtime.FS.writeFile('/pcad_fem/solid-input.json', JSON.stringify(plan));
  const value = runtime.runPython('ordering.run_solid_analysis()');
  if (typeof value !== 'string') throw new Error('native JSON required');
  const raw: unknown = JSON.parse(value);
  return decodeSolidAnalysis(raw, input, await solidInputSha256(input));
}
it('preserves native gravity strain, stress and energy under common 0.2 mm translation', async () => {
  const baseline = await solve(box(0)), shifted = await solve(box(0.2));
  // Independent mass * gravity: 40*30*10 mm3 * 1e-9 m3/mm3 * 7800 kg/m3.
  const gravity = -40 * 30 * 10 * 1e-9 * 7800 * 9.81;
  expect(gravity).toBeCloseTo(-0.918216, 14);
  for (const result of [baseline, shifted]) {
    expect(result.reactionN.reduce((sum, force) => sum + force[2], 0)).toBeCloseTo(-gravity, 8);
    expect(result.strainEnergyNmm).toBeGreaterThan(0);
  }
  expect(Math.abs(shifted.strainEnergyNmm / baseline.strainEnergyNmm - 1)).toBeLessThan(1e-8);
  for (let element = 0; element < baseline.elements.length; element++) for (const field of ['strain', 'stressMPa'] as const) {
    const expected = baseline.elements[element][field], actual = shifted.elements[element][field];
    const scale = Math.max(...expected.map(Math.abs));
    expect(Math.max(...actual.map((v, axis) => Math.abs(v - expected[axis]))) / scale).toBeLessThan(1e-8);
  }
  for (let node = 0; node < baseline.displacementMm.length; node++) for (let axis = 0; axis < 3; axis++) {
    expect(shifted.displacementMm[node][axis] - baseline.displacementMm[node][axis]).toBeCloseTo(axis === 0 ? 0.2 : 0, 14);
  }
}, FUNCTIONAL_TEST_TIMEOUT_MS);

// Independent unit tet: V=1/6, E=48, nu=0, exx=1/8, sxx=6,
// end forces +/-1 N, 2U=1/8 Nmm. Binary-exact deformation remains
// representable even when the common translation is more than 1e9 mm.
it.each([0, 0.2, 2 ** 30])('retains independent elastic energy and rejects free imbalance at translation %s', translation => {
  const input: SolidAnalysisInput = {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'rigid-work', revision: 1, meshKey: 'unit' },
    units: 'N-mm-MPa', numericBudgetBytes: 1024 * 1024,
    nodes: [[0,0,0],[1,0,0],[0,1,0],[0,0,1]], elements: [{ nodes: [0,1,2,3], materialId: 'm' }],
    materials: [{ id: 'm', youngMPa: 48, poisson: 0 }],
    constraints: [0,1,2,3].map(node => ({ node, fixed: [node !== 1,true,true],
      prescribedMm: [node === 1 ? 0 : translation, translation, translation] })),
    nodalLoads: [{ node: 1, forceN: [1,0,0] }], surfaceLoads: [],
  };
  const raw = { schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [0,1,2,3].map(node => [translation + (node === 1 ? 0.125 : 0), translation, translation]),
    elementForcesN: [[-1,0,0,1,0,0,0,0,0,0,0,0]], reservedNumericBytes: 4096, minimumScaledPivot: 1 };
  const digest = 'a'.repeat(64), result = decodeSolidAnalysis(raw, input, digest);
  expect(result.elements[0].strain[0]).toBeCloseTo(0.125, 14);
  expect(result.elements[0].stressMPa[0]).toBeCloseTo(6, 14);
  expect(result.strainEnergyNmm).toBeCloseTo(0.0625, 14);
  expect(() => decodeSolidAnalysis(raw, { ...input, nodalLoads: [{ node: 1, forceN: [1.001,0,0] }] }, digest))
    .toThrow('free-DOF equilibrium');
  expect(() => decodeSolidAnalysis({ ...raw, elementForcesN: [[-1.001,0,0,1,0,0,0,0,0,0,0,0]] }, input, digest))
    .toThrow('native action differs');
});
