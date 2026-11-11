import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { analyzeSolidContact, SolidContactRuntimeError } from './solidContactRuntime.js';
import { SOLID_CONTACT_ASSETS } from './solidContactAssets.js';
import { contactFixture, independentHash } from './solidContactBinding.testSupport.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import { isRecord } from './valueGuards.js';

type SolidContactPrograms = Parameters<typeof analyzeSolidContact>[2];

const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
function programs(): SolidContactPrograms {
  const source = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)));
  return { normal: source('solidContact.py'), friction: source('solidContactFriction.py'), solver: source('solidContactSolver.py'),
    driver: source('solidContactDriver.py'), wheelLocation: join(assets, wheel).split(sep).join('/') };
}

describe('solid contact runtime admits only exact pinned developer sources', () => {
  it.each(['normal', 'friction', 'solver', 'driver'] as const)('refuses altered %s before executing the interpreter', async key => {
    const { input } = await contactFixture(), actual = programs(), bytes = actual[key].slice(); bytes[0] ^= 1;
    const runPython = vi.fn(() => { throw new Error('Native execution must not occur'); });
    const loadPackage = vi.fn(() => Promise.resolve(undefined)), writeFile = vi.fn();
    const runtime: PyodideRuntime = { version: '0.29.3', runPython, loadPackage, FS: { mkdirTree: () => undefined, writeFile } };
    await expect(analyzeSolidContact(runtime, input, { ...actual, [key]: bytes }, () => undefined)).rejects.toThrow('asset-corrupt');
    expect(runPython).not.toHaveBeenCalled(); expect(loadPackage).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('fixed JSON contact driver through actual packaged OOFEM', () => {
  let runtime: PyodideRuntime, denied = 0;
  const originalFetch = globalThis.fetch;
  beforeAll(async () => {
    // Root must first copy the exact physical/driver programs and regenerate the
    // release manifest. Reading source-only substitutes cannot qualify runtime.
    const parsed: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.files)) throw new Error('Missing runtime manifest');
    for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
      'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel, ...SOLID_CONTACT_ASSETS.map(pin => pin.file)]) {
      const pin = parsed.files[`assets/${name}`], bytes = readFileSync(join(assets, name));
      if (!isRecord(pin)) throw new Error(`Root manifest entry missing: ${name}`);
      expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }).toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
      const contactPin = SOLID_CONTACT_ASSETS.find(item => item.file === name);
      if (contactPin !== undefined) expect({ bytes: bytes.byteLength, sha256: pin.sha256 }).toEqual({ bytes: contactPin.bytes, sha256: contactPin.sha256 });
    }
    globalThis.fetch = () => { denied++; return Promise.reject(new Error('offline-request-denied')); };
    const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
    if (!isLoader(loader)) throw new Error('Invalid packaged loader');
    const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
      lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
      packages: ['numpy'], fullStdLib: false, stdout: line => { console.info(line); }, stderr: line => { console.error(line); } });
    if (!isRuntime(loaded)) throw new Error('Invalid packaged runtime');
    runtime = loaded;
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(denied).toBe(0); });

  it('solves the independently specified five-state shear history and returns every native step', async () => {
    const { input } = await contactFixture(false), phases: string[] = [];
    const actualPrograms = programs();
    // Use the packaged bytes after their exact manifest/source comparison above.
    const packaged = SOLID_CONTACT_ASSETS.map(pin => new Uint8Array(readFileSync(join(assets, pin.file))));
    const result = await analyzeSolidContact(runtime, input, { normal: packaged[0], friction: packaged[1], solver: packaged[2],
      driver: packaged[3], wheelLocation: actualPrograms.wheelLocation }, phase => { phases.push(phase); });
    expect(phases).toEqual(['loading-packages', 'solving']);
    expect(result.inputSha256).toBe(independentHash(input)); expect(result.preparationSha256).toBe(input.preparationSha256);
    expect(result.source).toEqual(input.source); expect(result.steps).toHaveLength(5);
    expect(result.nativeIterationCount).toBeNull(); expect(result.strictComplementarityQualified).toBe(false);
    // G=E/2=105000 MPa, A=200 mm2, L=100 mm -> Ks=210000 N/mm.
    // Kt=10000*200=2000000 N/mm; closed Fn=10000*200*5e-7=1 N; mu*Fn=.3 N.
    const expectedU = [.1 / 2210000, .7 / 210000, 1 / 210000, 1 / 210000, 1.7 / 210000];
    const expectedFt = [2000000 * expectedU[0], .3, 0, 0, .3];
    const expectedD = [0, .3 * (expectedU[1] - .3 / 2000000), 0, 0, .3 * (expectedU[4] - expectedU[3] - .3 / 2000000)];
    for (const [index, step] of result.steps.entries()) {
      expect(step.step).toBe(index + 1); expect(step.nativeEquationCount).toBe(4); expect(step.freeResidual).toBeLessThanOrEqual(1e-8);
      for (const node of [4, 5, 6, 7]) expect(Math.abs(step.displacementMm[node][1] - expectedU[index]) / expectedU[index]).toBeLessThanOrEqual(1e-6);
      const points = step.patches.flatMap(patch => patch.points);
      expect(points).toHaveLength(6);
      expect(Math.abs(points.reduce((sum, point) => sum + point.normalForceN, 0) - (index === 2 ? 0 : 1))).toBeLessThanOrEqual(1e-8);
      expect(Math.abs(points.reduce((sum, point) => sum + point.tangentialForceN[1], 0) - expectedFt[index])).toBeLessThanOrEqual(1e-8);
      expect(Math.abs(points.reduce((sum, point) => sum + point.addedDissipationNmm, 0) - expectedD[index])).toBeLessThanOrEqual(1e-12);
    }
    console.info('W23-B actual packaged contact', JSON.stringify(result));
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('preserves actual native iteration failure as diagnostics and publishes no partial result', async () => {
    const { input } = await contactFixture(false);
    // The W20 one-iteration counterexample starts directly at the sliding load.
    Reflect.set(input, 'steps', 1); Reflect.set(input, 'maxIterations', 1);
    for (const history of input.prescribed) Reflect.set(history, 'values', [history.values[0]]);
    for (const history of input.loads) Reflect.set(history, 'values', [history.values[1]]);
    let returned = false, failure: unknown;
    try { await analyzeSolidContact(runtime, input, programs(), () => undefined); returned = true; } catch (error) { failure = error; }
    expect(returned).toBe(false); expect(failure).toBeInstanceOf(SolidContactRuntimeError);
    if (!(failure instanceof SolidContactRuntimeError)) throw new Error('Native failure diagnostic missing', { cause: failure });
    const detail = failure.contactDiagnostics;
    expect(detail.inputSha256).toBe(independentHash(input)); expect(detail.step).toBe(1);
    expect(detail.nativeIterationCount).toBeNull(); expect(detail.iterationLimit).toBe(1);
    expect(detail.nativeCallbacks?.tangent).toBeGreaterThan(0);
    expect(detail.nativeCallbacks?.residual).toBeGreaterThan(0);
    expect(detail.rawBeforeFailure.length).toBeLessThanOrEqual(32_768);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
