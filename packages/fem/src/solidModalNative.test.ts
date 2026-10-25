import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { SOLID_MODAL_ASSETS } from './assets.js';
import { analyzeSolidModal, isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { SolidModalInput, SolidModalResult } from './solidModalModel.js';
import { solidModalInputSha256 } from './solidModalTranslation.js';
import { solidModalResultMatches } from './solidModalPublicResult.js';

// Actual packaged Pyodide 0.29.3 + NumPy 2.2.5 + OOFEM wheel, actual solidModal.py from the runtime closure and the
// production runtime.analyzeSolidModal -> native -> decodeSolidModal path. No reply is canned. The Worker/offline
// loader (analyzeSolidModalInBrowser) needs a DedicatedWorkerGlobalScope and is covered by solidModalRuntime.test.ts.
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

const RHO = 7.85e-9;
const source = { documentId: 'native-doc', revision: 7, meshKey: 'tet:7' };
/** Unit tet (L = 10 mm, nu = 0), node 1 x and node 2 x free: K = diag(E L / 6, E L / 12),
 * M = rho V / 20 [[2, 1], [1, 2]] with V = L^3 / 6; the generalized 2 x 2 problem is solved here in closed form. */
function supported(densityKgM3 = 7850): SolidModalInput {
  return { schema: 'pointercad-solid-tet4-modal/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }], modeCount: 2 };
}
function closedForm(rho: number): number[] {
  const volume = 1000 / 6, k1 = 205000 * 10 / 6, k2 = 205000 * 10 / 12, d = rho * volume / 10, o = rho * volume / 20;
  const a = d * d - o * o, b = d * (k1 + k2), root = Math.sqrt(b * b - 4 * a * k1 * k2), larger = (b + root) / (2 * a);
  return [k1 * k2 / (a * larger), larger];
}
/** Regular tetrahedron (cube vertices +-10 mm), nu = 0.25, unrestrained: five deviatoric modes at 10 mu / (rho a^2)
 * and the dilatation at 15 K / (rho a^2), ratio exactly 2.5. */
const freeFree: SolidModalInput = { ...supported(), nodes: [[10, 10, 10], [-10, 10, -10], [10, -10, -10], [-10, -10, 10]],
  constraints: [], modeCount: 6, materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.25, densityKgM3: 7850 }] };

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

async function solve(input: SolidModalInput): Promise<SolidModalResult> {
  if (runtime === undefined) throw new Error('Pyodide did not load');
  const wrapper = verified('solidModal.py');
  const phases: string[] = [];
  const result = await analyzeSolidModal(runtime, input, { wrapper,
    wheelLocation: join(assets, wheel).split(sep).join('/') }, phase => { phases.push(phase); });
  expect(phases).toEqual(['loading-packages', 'solving']);
  expect(solidModalResultMatches(result, input, await solidModalInputSha256(input))).toBe(true);
  // The native element masses were compared with the closed-form consistent tet4 mass and no fallback exists.
  expect(result.maximumElementMassError).toBeLessThanOrEqual(1e-10);
  expect(denied).toBe(0);
  return result;
}

describe('solid modal on the actual packaged OOFEM runtime', () => {
  it('pins solidModal.py identically in assets.ts, the runtime manifest and the shipped bytes', () => {
    const bytes = verified('solidModal.py');
    expect(SOLID_MODAL_ASSETS).toEqual([{ file: 'solidModal.py', bytes: bytes.byteLength, sha256: sha256(bytes) }]);
  });
  it('reproduces the closed-form supported spectrum and halves it for four times the density', async () => {
    const light = await solve(supported());
    closedForm(RHO).forEach((lambda, index) => {
      expect(Math.abs(light.modes[index].eigenvaluePerSecondSquared - lambda) / lambda).toBeLessThanOrEqual(1e-9);
    });
    expect(light.applicability).toBe('supported');
    expect(light.modes.every(mode => mode.massNormalizedShapePerSqrtT[0].every(value => value === 0))).toBe(true);
    const heavy = await solve(supported(4 * 7850));
    heavy.modes.forEach((mode, index) => {
      expect(mode.frequencyHz / light.modes[index].frequencyHz).toBeCloseTo(0.5, 9);
      const scale = Math.max(...light.modes[index].massNormalizedShapePerSqrtT.flat().map(Math.abs));
      mode.massNormalizedShapePerSqrtT.flat().forEach((value, k) => {
        expect(Math.abs(Math.abs(value) - Math.abs(light.modes[index].massNormalizedShapePerSqrtT.flat()[k]) / 2))
          .toBeLessThanOrEqual(1e-9 * scale);
      });
    });
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  it('removes six rigid modes free-free and returns the exact regular-tetrahedron degeneracy', async () => {
    const result = await solve(freeFree);
    expect([result.applicability, result.rigidBodyModes, result.freeDofs]).toEqual(['free-free', 6, 12]);
    const values = result.modes.map(mode => mode.eigenvaluePerSecondSquared);
    const deviatoric = 10 * (205000 / 2.5) / (RHO * 100);
    values.slice(0, 5).forEach(value => { expect(Math.abs(value - deviatoric) / deviatoric).toBeLessThanOrEqual(1e-9); });
    expect(values[5] / values[0]).toBeCloseTo(2.5, 9);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  it('refuses invalid input before the runtime is touched', async () => {
    if (runtime === undefined) throw new Error('Pyodide did not load');
    const before = loads.length;
    await expect(analyzeSolidModal(runtime, { ...supported(), modeCount: 3 },
      { wrapper: verified('solidModal.py'), wheelLocation: wheel }, () => undefined)).rejects.toThrow('solid-modal-input');
    expect(loads.length).toBe(before);
  });
});
