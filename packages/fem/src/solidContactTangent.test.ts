import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';

describe('W18-A fixed-reference frictionless contact', () => {
  it('runs all 22 independent Python integral, derivative and mapping checks', () => {
    const result = spawnSync('python', ['-B', '-X', 'utf8',
      fileURLToPath(new URL('./solidContactTangent.test.py', import.meta.url)), '-v'], {
      cwd: fileURLToPath(new URL('./', import.meta.url)), encoding: 'utf8',
      timeout: 60_000, maxBuffer: 2_000_000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    const detail = `Python exit=${String(result.status)} signal=${String(result.signal)}\n`
      + `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    expect(result.error, detail).toBeUndefined();
    expect(result.signal, detail).toBeNull();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 22 tests in [\d.]+s(?:\r?\n|$)/u);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)OK(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/^test_[^\r\n]+ \.\.\. ok\r?$/gmu)], detail).toHaveLength(22);
    console.info(result.stdout.trim());
    console.info(result.stderr.trim());
  }, 65_000);
});

describe('W18-A source contact with actual packaged OOFEM', () => {
  const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
  const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
  const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
  const originalFetch = globalThis.fetch;
  let runtime: PyodideRuntime, deniedRequests = 0;
  beforeAll(async () => {
    globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
    if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
      || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing manifest');
    for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
      'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) {
      const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
      if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error('Missing asset pin');
      const bytes = readFileSync(join(assets, name));
      expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
        .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
    }
    const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
    if (!isLoader(loader)) throw new Error('Invalid packaged loader');
    const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
      lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
      packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
    if (!isRuntime(loaded)) throw new Error('Invalid packaged runtime');
    runtime = loaded;
    runtime.FS.mkdirTree('/pcad_fem');
    for (const [source, target] of [['solidContact.py', 'solidContact.py'], ['solidAnalysis.py', 'solidAnalysis.py'],
      ['solidContactTangent.test.py', 'solidContactTangentTests.py']]) {
      runtime.FS.writeFile(`/pcad_fem/${target}`, new Uint8Array(readFileSync(new URL(`./${source}`, import.meta.url))));
    }
    await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
    runtime.runPython(`import sys
sys.path.insert(0, '/pcad_fem')
import json
import solidContactTangentTests as contact_fixture
`);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

  it('assembles contact into real native equations and solves the independent parallel-bar oracle', () => {
    const raw = runtime.runPython('json.dumps(contact_fixture.packaged_native_parallel_bar(), allow_nan=False)');
    if (typeof raw !== 'string') throw new Error('Missing native contact fixture result');
    const result: unknown = JSON.parse(raw);
    if (typeof result !== 'object' || result === null) throw new Error('Invalid native contact result');
    const fields = new Map(Object.entries(result));
    const numeric = (name: string): number => {
      const value: unknown = fields.get(name);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid native measure ${name}`);
      return value;
    };
    expect(fields.get('nativeVersion')).toBe('3.1.dev5+g214b161ed');
    expect(fields.get('nativeSolver')).toBe('skyline/LDLT');
    expect(fields.get('nativeReordered')).toBe(true);
    expect(numeric('nativeElementMatrices')).toBe(12);
    expect(numeric('nativeFreeEquations')).toBe(12);
    const expected = 1 / (210000 * 200 / 100 + 10000 * 200);
    expect(Math.abs(numeric('barStiffnessNPerMm') / 420000 - 1)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(numeric('contactStiffnessNPerMm') / 2000000 - 1)).toBeLessThanOrEqual(1e-8);
    expect(numeric('expectedDisplacementMm')).toBe(expected);
    const actual: unknown = fields.get('actualDisplacementMm');
    if (!Array.isArray(actual) || actual.length !== 4) throw new Error('Missing four native end displacements');
    for (const displacement of actual) {
      if (typeof displacement !== 'number' || !Number.isFinite(displacement)) throw new Error('Invalid native displacement');
      expect(Math.abs(displacement - expected) / expected).toBeLessThanOrEqual(1e-6);
    }
    expect(numeric('maximumRelativeDisplacementError')).toBeLessThanOrEqual(1e-6);
    expect(numeric('penetrationLimitMm')).toBe(1e-6 * 10);
    expect(numeric('penetrationMm')).toBeLessThanOrEqual(1e-6 * 10);
    expect(numeric('freeResidualN')).toBeLessThanOrEqual(1e-8);
    expect(numeric('forceResidualN')).toBeLessThanOrEqual(1e-8);
    expect(numeric('momentResidualNmm')).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(numeric('compressiveResultantN') / (2000000 * expected) - 1)).toBeLessThanOrEqual(1e-8);
    expect(numeric('minimumPositiveNativePivot')).toBeGreaterThan(0);
    console.info(`W18-A actual packaged native ${raw}`);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
