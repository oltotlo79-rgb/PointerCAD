import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';

/*
 * EX-09 W33 candidate: finite-strain J2 (solidFiniteMaterial.py, multiplicative split, Hencky elasticity, exponential
 * map) in the actual packaged Pyodide + OOFEM wheel, injected through the binding's Python material trampoline into
 * the native ltrspace nlgeo 1 element and the native StaticStructural/NRSolver (run_native_tet). Independent oracles
 * below: closed-form logarithmic-strain J2 responses with linear isotropic hardening for coaxial histories (fixed
 * principal axes, where the exponential-map return is exact) including elastic unloading and reverse yielding:
 *   isochoric F = diag(s, s^-1/2, s^-1/2): tau11 = 2 G (ln s - p), tau22 = tau33 = -tau11 / 2, J = 1;
 *   uniaxial stress (free lateral faces): tau11 = E (ln s - p), lateral stretch = exp(-nu tau11 / E - p / 2);
 * p is the signed plastic strain, alpha = sum |dp|, yield |tau11 - tau22| = sigma_y + H alpha. P = F S is recomputed
 * here from the native F and S records. Point-level objectivity, tangent, energy, adapter-state and driver-boundary
 * checks are the 12 Python cases of solidFiniteMaterial.test.py, executed below with the host Python like
 * beamFrictionPython.test.ts.
 */
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const lawUrl = new URL('./solidFiniteMaterial.py', import.meta.url);
const pythonCasesUrl = new URL('./solidFiniteMaterial.test.py', import.meta.url);
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function verified(name: string): void {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)) throw new Error('runtime manifest has no files');
  const files: unknown = manifest.files;
  const row: unknown = typeof files === 'object' && files !== null ? Object.entries(files).find(([key]) => key === `assets/${name}`)?.[1] : undefined;
  if (typeof row !== 'object' || row === null || !('sha256' in row) || typeof row.sha256 !== 'string') throw new Error(`unpinned ${name}`);
  expect(sha256(new Uint8Array(readFileSync(join(assets, name))))).toBe(row.sha256);
}

const E = 200000, NU = 0.3, SY = 250, H = 1000, G = E / (2 * (1 + NU)), L = 10;
const PARAMETERS = { youngMPa: E, poisson: NU, yieldStressMPa: SY, hardeningModulusMPa: H };
const NODES = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]];
const STRETCHES = [1.0005, 1.002, 1.01, 1.05, 1.1, 1.2, 1.15];

/** Signed plastic strain p and alpha for a coaxial history with elastic modulus `modulus` (3 G isochoric, E uniaxial). */
function coaxial(modulus: number): { p: number; alpha: number }[] {
  let p = 0, alpha = 0;
  return STRETCHES.map(s => {
    const e = Math.log(s), q = modulus * (e - p);
    if (q > SY + H * alpha) {
      const next = (modulus * e - SY - H * alpha + H * p) / (modulus + H);
      alpha += next - p; p = next;
    } else if (-q > SY + H * alpha) {
      const next = (modulus * e + SY + H * alpha + H * p) / (modulus + H);
      alpha += p - next; p = next;
    }
    return { p, alpha };
  });
}

interface NativeRecord { freeResidualRatio: number; callbacks: number[]; displacementMm: number[][];
  native: { F9: number[]; P9: number[]; S6: number[] }; alpha: number; tau: number[]; P: number[]; J: number;
  plastic: boolean; dissipation: number; statusClass: string }
const OOFEM9 = [0, 4, 8, 5, 2, 1, 7, 6, 3];
const VOIGT6 = [[0, 0], [1, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
const field = (row: object, key: string): unknown => Object.entries(row).find(([name]) => name === key)?.[1];
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('non-finite native value');
  return value;
}
function vector(value: unknown, size: number): number[] {
  if (!Array.isArray(value) || value.length !== size) throw new Error('bad native vector');
  return value.map(finite);
}
function readRecord(value: unknown): NativeRecord {
  if (typeof value !== 'object' || value === null) throw new Error('bad native record');
  const native = field(value, 'native'), plastic = field(value, 'plastic'), statusClass = field(value, 'statusClass');
  const displacement = field(value, 'displacementMm');
  if (typeof native !== 'object' || native === null || typeof plastic !== 'boolean' || typeof statusClass !== 'string'
    || !Array.isArray(displacement)) throw new Error('bad native record fields');
  return { freeResidualRatio: finite(field(value, 'freeResidualRatio')), callbacks: vector(field(value, 'callbacks'), 2),
    displacementMm: displacement.map((row: unknown) => vector(row, 3)),
    native: { F9: vector(field(native, 'F9'), 9), P9: vector(field(native, 'P9'), 9), S6: vector(field(native, 'S6'), 6) },
    alpha: finite(field(value, 'alpha')), tau: vector(field(value, 'tau'), 9), P: vector(field(value, 'P'), 9),
    J: finite(field(value, 'J')), plastic, dissipation: finite(field(value, 'dissipation')), statusClass };
}
function readRecords(text: unknown): { records: NativeRecord[]; refused: unknown } {
  if (typeof text !== 'string') throw new Error('native run returned no JSON text');
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || field(value, 'schema') !== 'pointercad-finite-j2-native-tet/1') throw new Error('unexpected native result');
  const records = field(value, 'records');
  if (!Array.isArray(records)) throw new Error('native result has no records');
  return { records: records.map(readRecord), refused: field(value, 'refusedCommits') };
}
const maxAbs = (values: readonly number[]): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** P = F S from the native 9-form F and 6-form S (OOFEM orders), returned in the row-major 3x3 order. */
function nativeFS(f9: readonly number[], s6: readonly number[]): number[] {
  const f = Array.from({ length: 9 }, () => 0), s = Array.from({ length: 9 }, () => 0);
  OOFEM9.forEach((index, k) => { f[index] = f9[k]; });
  VOIGT6.forEach(([i, j], k) => { s[3 * i + j] = s6[k]; s[3 * j + i] = s6[k]; });
  return Array.from({ length: 9 }, (_, n) => [0, 1, 2].reduce((sum, m) => sum + f[3 * Math.floor(n / 3) + m] * s[3 * m + (n % 3)], 0));
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
  await loaded.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
  loaded.FS.mkdirTree('/pcad_fem');
  loaded.FS.writeFile('/pcad_fem/solidFiniteMaterial.py', new Uint8Array(readFileSync(lawUrl)));
  runtime = loaded;
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; });

function runNative(prescribed: [number, number, number[]][], forceScale: number | null, path: string): { records: NativeRecord[]; refused: unknown } {
  if (runtime === undefined) throw new Error('Pyodide did not load');
  const input = JSON.stringify({ prescribed, forceScale, parameters: PARAMETERS, nodes: NODES, path });
  runtime.FS.writeFile(`${path}-input.json`, input);
  return readRecords(runtime.runPython([
    'import sys, json', 'sys.path.insert(0, "/pcad_fem")', 'import oofem', 'import solidFiniteMaterial as law',
    `plan = json.load(open("${path}-input.json", encoding="utf-8"))`,
    'law.run_native_tet(oofem, plan["nodes"], {(n, d): v for n, d, v in plan["prescribed"]}, len(plan["prescribed"][0][2]),',
    '                   plan["parameters"], plan["forceScale"], plan["path"])', ''].join('\n')));
}

describe('finite-strain J2 point law: independent Python cases (host Python with NumPy)', () => {
  it('executes all 12 tension, shear, superposed-rotation, tangent, state, conjugacy, adapter-ownership and driver-boundary cases', () => {
    const script = fileURLToPath(pythonCasesUrl);
    const result = spawnSync('python', ['-B', '-X', 'utf8', script, '-v'], { cwd: fileURLToPath(new URL('./', import.meta.url)),
      encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    const detail = `exit=${String(result.status)} signal=${String(result.signal)}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    console.info(detail);
    expect(result.error, detail).toBeUndefined();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 12 tests in [\d.]+s(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/ \.\.\. ok\r?$/gmu)], detail).toHaveLength(12);
    expect(result.stdout.trim(), detail).toBe('solid-finite-material: 12 independent cases passed');
  }, 125_000);
});

describe('finite-strain J2 through the native OOFEM element and solver (packaged Pyodide + wheel)', () => {
  it('isochoric tension with reverse yielding, all DOFs prescribed: native P = F S and closed-form Kirchhoff stress', () => {
    const prescribed: [number, number, number[]][] = [];
    NODES.forEach((x, node) => [0, 1, 2].forEach(dof => {
      prescribed.push([node, dof, STRETCHES.map(s => ((dof === 0 ? s : s ** -0.5) - 1) * x[dof])]);
    }));
    const { records, refused } = runNative(prescribed, null, '/pcad_fem/fj2-isochoric');
    const expected = coaxial(3 * G);
    expect(refused).toEqual([]);
    expect(records).toHaveLength(STRETCHES.length);
    records.forEach((record, index) => {
      const s = STRETCHES[index], scale = SY + H * expected[index].alpha, tau11 = 2 * G * (Math.log(s) - expected[index].p);
      expect(record.statusClass).toBe('PointerCadFiniteJ2Status');
      expect(record.callbacks[0]).toBeGreaterThanOrEqual(1);
      expect(Math.abs(record.tau[0] - tau11) / scale).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(record.tau[4] + tau11 / 2) / scale).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(record.alpha - expected[index].alpha)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(record.J - 1)).toBeLessThanOrEqual(1e-14);
      const fs = nativeFS(record.native.F9, record.native.S6);
      const p9 = OOFEM9.map(i => fs[i]);
      expect(maxAbs(record.native.P9.map((v, k) => v - p9[k])) / maxAbs(p9)).toBeLessThanOrEqual(1e-12);
      expect(maxAbs(record.native.P9.map((v, k) => v - record.P[OOFEM9[k]])) / maxAbs(p9)).toBeLessThanOrEqual(1e-10);
      expect(record.dissipation).toBeGreaterThanOrEqual(-1e-10);
    });
    expect(records[6].tau[0]).toBeLessThan(records[5].tau[0]);
    expect(records[6].alpha).toBeGreaterThan(records[5].alpha); // reverse yielding, not elastic unloading
    expect(denied).toBe(0);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('uniaxial stress with free lateral DOFs: native Newton equilibrium and closed-form stress and contraction', () => {
    const zero = STRETCHES.map(() => 0);
    const prescribed: [number, number, number[]][] = [[0, 0, zero], [0, 1, zero], [0, 2, zero], [1, 0, STRETCHES.map(s => (s - 1) * L)],
      [1, 1, zero], [1, 2, zero], [2, 0, zero], [2, 2, zero], [3, 0, zero], [3, 1, zero]];
    // Reference force of the free DOF groups (nrsolver.C:754-756): the force on an L x L face at first yield.
    const { records, refused } = runNative(prescribed, SY * L * L, '/pcad_fem/fj2-uniaxial');
    const expected = coaxial(E);
    expect(refused).toEqual([]);
    expect(records).toHaveLength(STRETCHES.length);
    records.forEach((record, index) => {
      const s = STRETCHES[index], tau11 = E * (Math.log(s) - expected[index].p), scale = SY + H * expected[index].alpha;
      const lateral = Math.exp(-NU * tau11 / E - expected[index].p / 2);
      expect(record.freeResidualRatio).toBeLessThanOrEqual(1e-8);
      expect(record.callbacks[1]).toBeGreaterThanOrEqual(2); // native Newton used the injected tangent
      expect(Math.abs(record.tau[0] - tau11) / scale).toBeLessThanOrEqual(1e-8);
      expect(Math.abs(record.alpha - expected[index].alpha)).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(1 + record.displacementMm[2][1] / L - lateral)).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(1 + record.displacementMm[3][2] / L - lateral)).toBeLessThanOrEqual(1e-10);
      expect(maxAbs([record.tau[4], record.tau[8]]) / scale).toBeLessThanOrEqual(1e-8);
      expect(record.dissipation).toBeGreaterThanOrEqual(-1e-10);
    });
    expect(records.some(record => record.plastic)).toBe(true);
    expect(denied).toBe(0);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('commits only the open, accepted and natively updated attempt; repeated evaluations do not accumulate', () => {
    if (runtime === undefined) throw new Error('Pyodide did not load');
    const text = runtime.runPython([
      'import json, oofem as fem, solidFiniteMaterial as law',
      'nodes = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]]',
      'prescribed = {(n, d): [((1.01 if d == 0 else 1.01 ** -0.5) - 1) * nodes[n][d]] for n in range(4) for d in range(3)}',
      'parameters = {"youngMPa": 200000.0, "poisson": 0.3, "yieldStressMPa": 250.0, "hardeningModulusMPa": 1000.0}',
      'problem, domain, material, free = law.prepare_native_tet(fem, nodes, prescribed, 1, parameters, None, "/pcad_fem/fj2-gate")',
      'problem.preInitializeNextStep()', 'step = problem.giveNextStep()', 'problem.initializeYourself(step)',
      'token = material.begin_step(step.giveNumber())', 'problem.solveYourselfAt(step)', 'element = domain.giveElement(1)',
      'ratio = law.free_residual_ratio(fem, element, step, free)', 'status = material.statuses[0]',
      'for _ in range(3):',
      '    law.free_residual_ratio(fem, element, step, free)',
      'out = {"trialAlpha": status.trial["alpha"], "committedAlpha": status.committed["alpha"], "refusals": []}',
      'for args in ((step.giveNumber(), token, ratio), (step.giveNumber(), token + "x", ratio), (2, token, ratio), (step.giveNumber(), token, 1e-6)):',
      '    try:',
      '        material.commit_accepted(*args)',
      '        out["refusals"].append("committed")',
      '    except ValueError as error:',
      '        out["refusals"].append(str(error))',
      'out["afterRefusal"] = status.committed["alpha"]',
      'problem.updateYourself(step)', 'material.commit_accepted(step.giveNumber(), token, ratio)',
      'out["afterCommit"] = status.committed["alpha"]', 'out["commits"] = status.commits',
      'try:',
      '    material.begin_step(step.giveNumber())',
      '    out["again"] = "begun"',
      'except ValueError as error:',
      '    out["again"] = str(error)',
      'problem.terminateAnalysis()', 'json.dumps(out)', ''].join('\n'));
    if (typeof text !== 'string') throw new Error('gate check returned no JSON text');
    const out: unknown = JSON.parse(text);
    if (typeof out !== 'object' || out === null) throw new Error('bad gate record');
    const alpha = (3 * G * Math.log(1.01) - SY) / (3 * G + H);
    expect(out).toMatchObject({ committedAlpha: 0, afterRefusal: 0, commits: 1 });
    const refusals = field(out, 'refusals');
    expect(Array.isArray(refusals) ? refusals.map((reason: unknown) => String(reason).replace(/\(.*$/u, '').trim()) : refusals).toEqual([
      'finite-j2: commit of step 1 refused', 'finite-j2: commit of step 1 refused', 'finite-j2: commit of step 2 refused',
      'finite-j2: commit of step 1 refused']);
    expect(String(field(out, 'again'))).toContain('already accepted');
    expect(Math.abs(finite(field(out, 'trialAlpha')) - alpha)).toBeLessThanOrEqual(1e-14);
    expect(Math.abs(finite(field(out, 'afterCommit')) - alpha)).toBeLessThanOrEqual(1e-14);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
