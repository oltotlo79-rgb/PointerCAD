import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import { compareVerification } from './verificationComparison.testSupport.js';
import { verificationData } from './verificationInput.testSupport.js';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected native record');
  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(entries);
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite native number');
  return value;
}

describe('W20-A accepted contact history ownership', () => {
  it('executes all 11 independent state ownership checks through the normal entry', () => {
    const result = spawnSync('python', ['-B', '-X', 'utf8',
      fileURLToPath(new URL('./solidContactConvergence.test.py', import.meta.url)), '-v'], {
      cwd: fileURLToPath(new URL('./', import.meta.url)), encoding: 'utf8', timeout: 60_000,
      maxBuffer: 2_000_000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    const detail = `Python exit=${String(result.status)} signal=${String(result.signal)}\n`
      + `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    expect(result.error, detail).toBeUndefined();
    expect(result.signal, detail).toBeNull();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 11 tests in [\d.]+s(?:\r?\n|$)/u);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)OK(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/^test_[^\r\n]+ \.\.\. ok\r?$/gmu)], detail).toHaveLength(11);
    console.info(result.stdout.trim());
    console.info(result.stderr.trim());
  }, 65_000);
});

describe('W20-A actual packaged StaticStructural/NRSolver contact', () => {
  const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
  const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
  const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
  const originalFetch = globalThis.fetch;
  let runtime: PyodideRuntime, deniedRequests = 0;
  const nativeStdout: string[] = [], nativeStderr: string[] = [];
  beforeAll(async () => {
    globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
    const pins = record(record(manifest).files);
    for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
      'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) {
      const pin = record(pins[`assets/${name}`]);
      const bytes = readFileSync(join(assets, name));
      expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
        .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
    }
    const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
    if (!isLoader(loader)) throw new Error('Invalid packaged loader');
    const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
      lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
      packages: ['numpy'], fullStdLib: false,
      stdout: line => { nativeStdout.push(line); console.info('[contact native stdout]', line); },
      stderr: line => { nativeStderr.push(line); console.error('[contact native stderr]', line); } });
    if (!isRuntime(loaded)) throw new Error('Invalid packaged runtime');
    runtime = loaded;
    runtime.FS.mkdirTree('/pcad_fem');
    for (const name of ['solidContact.py', 'solidContactFriction.py', 'solidContactSolver.py']) {
      runtime.FS.writeFile(`/pcad_fem/${name}`, new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url))));
    }
    runtime.FS.writeFile('/pcad_fem/contact_convergence_tests.py',
      new Uint8Array(readFileSync(new URL('./solidContactConvergence.test.py', import.meta.url))));
    await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
    runtime.runPython(`import sys
sys.path.insert(0, '/pcad_fem')
import json
import contact_convergence_tests as native_contact_checks
print('contact-stdout-retained', flush=True)
print('contact-stderr-retained', file=sys.stderr, flush=True)
`);
    expect(nativeStdout).toContain('contact-stdout-retained');
    expect(nativeStderr).toContain('contact-stderr-retained');
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

  function invoke(name: 'run_native_history' | 'run_native_iteration_failure' | 'run_native_cancellation'): Record<string, unknown> {
    let raw: unknown;
    try {
      raw = runtime.runPython(`json.dumps(native_contact_checks.${name}(), allow_nan=False)`);
    } catch (cause) {
      throw new Error(`Native contact ${name} failed\nstdout:\n${nativeStdout.join('\n')}\nstderr:\n${nativeStderr.join('\n')}`, { cause });
    }
    if (typeof raw !== 'string') throw new Error('Missing native contact result');
    const parsed: unknown = JSON.parse(raw);
    return record(parsed);
  }

  it('solves stick, slip, separation and recontact through the ordinary native Newton', () => {
    const result = invoke('run_native_history');
    expect(result.success).toBe(true);
    expect(result.acceptedStepCount).toBe(5);
    expect(result.contactElementCount).toBe(2);
    if (!Array.isArray(result.states) || result.states.length !== 5) throw new Error('Missing five native states');
    const actualInput = record(result.verificationInput);
    if (typeof actualInput.units !== 'string') throw new Error('Missing native contact units');
    const comparisonInput = { geometry: verificationData(actualInput.geometry), boundary: verificationData(actualInput.boundary),
      material: verificationData(actualInput.material), units: actualInput.units, source: verificationData(actualInput.source) };
    const firstState = record(result.states[0]);
    if (!Array.isArray(firstState.actualDisplacementMm) || firstState.actualDisplacementMm.length !== 4) throw new Error('Missing first contact displacements');
    const caseId = 'contact-first-stick-v1';
    for (const value of firstState.actualDisplacementMm) {
      const comparison = compareVerification(caseId, { caseId, input: comparisonInput, value: numeric(value) });
      expect(comparison.passed).toBe(true);
      expect(comparison.error).toBeLessThanOrEqual(1e-6);
    }
    const sampleValue = numeric(firstState.actualDisplacementMm[0]);
    expect(() => compareVerification(caseId, { caseId, input: { ...comparisonInput, units: 'incorrect' }, value: sampleValue })).toThrow();
    expect(() => compareVerification(caseId, { caseId, input: { ...comparisonInput, source: 'incorrect' }, value: sampleValue })).toThrow();
    expect(() => compareVerification(caseId, { caseId, input: { ...comparisonInput, geometry: null }, value: sampleValue })).toThrow();
    const expectedDisplacements = [.1 / 2210000, .7 / 210000, 1 / 210000, 1 / 210000, 1.7 / 210000];
    const expectedForces = [2000000 * expectedDisplacements[0], .3, 0, 0, .3];
    const expectedDissipation = [0, .3 * (expectedDisplacements[1] - .3 / 2000000), 0, 0,
      .3 * (expectedDisplacements[4] - expectedDisplacements[3] - .3 / 2000000)];
    for (const [index, item] of result.states.entries()) {
      const state = record(item);
      expect(state.step).toBe(index + 1);
      expect(state.expectedDisplacementMm).toBe(expectedDisplacements[index]);
      expect(state.nativeEquationCount).toBe(4);
      expect(state.matrixType).toBe('SkylineU (smtype 1)');
      expect(state.strictComplementarityQualified).toBe(false);
      expect(numeric(state.maximumRelativeDisplacementError)).toBeLessThanOrEqual(1e-6);
      if (!Array.isArray(state.actualDisplacementMm) || state.actualDisplacementMm.length !== 4) throw new Error('Missing four native free displacements');
      for (const value of state.actualDisplacementMm) {
        expect(Math.abs(numeric(value) - expectedDisplacements[index]) / expectedDisplacements[index]).toBeLessThanOrEqual(1e-6);
      }
      expect(Math.abs(numeric(state.actualTangentialForceN) - expectedForces[index])).toBeLessThanOrEqual(1e-8);
      expect(Math.abs(numeric(state.actualAddedDissipationNmm) - expectedDissipation[index])).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(numeric(state.actualNormalForceN) - (index === 2 ? 0 : 1))).toBeLessThanOrEqual(1e-8);
      expect(numeric(state.freeResidual)).toBeLessThanOrEqual(1e-8);
      expect(numeric(record(state.nativeCallbacks).residual)).toBeGreaterThan(0);
      if (!Array.isArray(state.physical) || state.physical.length !== 6) throw new Error('Missing six material-point diagnostics');
      for (const point of state.physical) {
        const physical = record(point);
        expect(numeric(physical.referenceLengthMm)).toBe(10);
        expect(numeric(physical.referenceForceN)).toBe(1);
        expect(Math.max(0, -numeric(physical.gapMm))).toBeLessThanOrEqual(1e-6 * 10);
        expect(numeric(physical.pressureGapNPerMm)).toBe(numeric(physical.pressureMPa) * numeric(physical.gapMm));
        expect(numeric(physical.forceGapNmm)).toBe(numeric(physical.normalForceN) * numeric(physical.gapMm));
        expect(numeric(physical.dimensionlessForceGap)).toBe(numeric(physical.forceGapNmm) / 10);
      }
    }
    expect(numeric(record(result.callbacks).tangent)).toBeGreaterThan(0);
    console.info(`W20-A actual native history ${JSON.stringify(result)}`);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('refuses actual native iteration shortage without committing a partial success', () => {
    const result = invoke('run_native_iteration_failure');
    expect(result.successResultCount).toBe(0);
    expect(result.acceptedStepCount).toBe(0);
    expect(result.acceptedUnchanged).toBe(true);
    expect(numeric(record(result.nativeCallbacks).tangent)).toBeGreaterThan(0);
    expect(numeric(record(result.nativeCallbacks).residual)).toBeGreaterThan(0);
    expect(record(result.failure).success).toBe(false);
    console.info(`W20-A actual native iteration rejection ${JSON.stringify(result)}`);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('cancels a real native trial while preserving the accepted history', () => {
    const result = invoke('run_native_cancellation');
    expect(result.successResultCount).toBe(0);
    expect(result.acceptedStepCount).toBe(0);
    expect(result.acceptedUnchanged).toBe(true);
    expect(numeric(result.cancellationChecks)).toBeGreaterThanOrEqual(3);
    expect(numeric(record(result.nativeCallbacks).evaluations)).toBeGreaterThan(0);
    expect(record(result.failure).success).toBe(false);
    console.info(`W20-A actual native cancellation ${JSON.stringify(result)}`);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
