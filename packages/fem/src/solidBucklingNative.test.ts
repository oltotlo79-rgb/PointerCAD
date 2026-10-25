import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { SOLID_BUCKLING_ASSETS } from './assets.js';
import { analyzeSolidBuckling, isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { SolidBucklingInput, SolidBucklingResult } from './solidBucklingModel.js';
import { solidBucklingInputSha256 } from './solidBucklingTranslation.js';
import { solidBucklingResultMatches } from './solidBucklingPublicResult.js';
import { singleTetBenchmark, singleTetLoadFactors } from './solidBuckling.testSupport.js';

// Actual packaged Pyodide 0.29.3 + NumPy 2.2.5 + OOFEM wheel, actual solidBuckling.py from the runtime closure and the
// production runtime.analyzeSolidBuckling -> native LinearStatic + ltrspace K + Structural3DElement initial-stress
// matrix -> decodeSolidBuckling path. Expected load factors are the independent closed forms of
// solidBuckling.testSupport.ts; no reply is canned.
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

let runtime: PyodideRuntime | undefined;
let denied = 0;
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
  runtime = loaded;
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; });

async function solve(input: SolidBucklingInput): Promise<SolidBucklingResult> {
  if (runtime === undefined) throw new Error('Pyodide did not load');
  const result = await analyzeSolidBuckling(runtime, input, { wrapper: verified('solidBuckling.py'),
    wheelLocation: join(assets, wheel).split(sep).join('/') }, () => undefined);
  expect(solidBucklingResultMatches(result, input, await solidBucklingInputSha256(input))).toBe(true);
  // The native element initial-stress matrices equalled the closed-form tet4 matrices of D B u.
  expect(result.maximumElementInitialStressError).toBeLessThanOrEqual(1e-10);
  expect(denied).toBe(0);
  return result;
}

describe('solid prestress buckling on the actual packaged OOFEM runtime', () => {
  it('pins solidBuckling.py identically in assets.ts, the runtime manifest and the shipped bytes', () => {
    const bytes = verified('solidBuckling.py');
    expect(SOLID_BUCKLING_ASSETS).toEqual([{ file: 'solidBuckling.py', bytes: bytes.byteLength, sha256: sha256(bytes) }]);
  });
  it('reproduces the closed-form corner-tetrahedron load factors and scales them as 1/P and E', async () => {
    for (const options of [{}, { loadN: 2000 }, { youngMPa: 410000 }, { poisson: 0 }]) {
      const result = await solve(singleTetBenchmark(options));
      const expected = singleTetLoadFactors(options);
      result.modes.forEach((mode, index) => {
        expect(Math.abs(mode.loadFactor / expected[index] - 1)).toBeLessThanOrEqual(1e-9);
      });
      expect(result.modes[0].shape[1][2]).toBe(0);
      expect(Math.abs(result.modes[0].shape[1][1])).toBeCloseTo(1, 10);
    }
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  it('refuses a tension reference state instead of reporting a load factor', async () => {
    if (runtime === undefined) throw new Error('Pyodide did not load');
    await expect(analyzeSolidBuckling(runtime, singleTetBenchmark({ loadN: -1000 }), { wrapper: verified('solidBuckling.py'),
      wheelLocation: join(assets, wheel).split(sep).join('/') }, () => undefined)).rejects.toThrow('solid-buckling-no-positive-mode');
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
