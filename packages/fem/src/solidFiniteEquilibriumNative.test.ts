import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';

/*
 * EX-09 W34 first slice: general tetrahedral mesh, nodal force and displacement histories and the per-step free-DOF
 * equilibrium of solidFiniteEquilibrium.py, solved by the actual packaged Pyodide + OOFEM wheel (ltrspace nlgeo 1,
 * StaticStructural/NRSolver rtolf 1e-10) with the accepted W33 finite J2 law. Independent expectations (closed forms
 * computed here, never by the module):
 *   affine fields: a linear tetrahedron reproduces x = F X exactly, so with the boundary of a 4-tet patch prescribed by
 *     F = R diag(s, s^-1/2, s^-1/2) (fixed rotation R) the free interior node must sit at F X and every element must
 *     carry the coaxial isochoric logarithmic J2 stress tau = R diag(t, -t/2, -t/2) R^T, t = 2 G (ln s - p) (W33 oracle);
 *   uniaxial dead load on a 2-tet patch: nominal stress P11 = tau11 / lambda, tau11 = E (ln lambda - p) with the 1D
 *     return of linear isotropic hardening, lateral stretch mu = exp(-nu tau11 / E - p / 2) (W33 oracle), solved for
 *     lambda by bisection; consistent nodal forces f_a = sum_e V_e P grad N_a from the element shape gradients.
 * The free-DOF residual |external - internal| / max(free load, constrained internal action, internal force) must be <= 1e-8 at every accepted
 * step (W34), and load-increment refinement must change the results by <= 1% (W34); inverted elements, non-finite input
 * and a failed solve must be refused with nothing committed. Units N-mm-MPa.
 */
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const lawUrl = new URL('./solidFiniteMaterial.py', import.meta.url);
const entryUrl = new URL('./solidFiniteEquilibrium.py', import.meta.url);
const pythonCasesUrl = new URL('./solidFiniteEquilibrium.test.py', import.meta.url);
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function verified(name: string): void {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)) throw new Error('runtime manifest has no files');
  const files: unknown = manifest.files;
  const row: unknown = typeof files === 'object' && files !== null ? Object.entries(files).find(([key]) => key === `assets/${name}`)?.[1] : undefined;
  if (typeof row !== 'object' || row === null || !('sha256' in row) || typeof row.sha256 !== 'string') throw new Error(`unpinned ${name}`);
  expect(sha256(new Uint8Array(readFileSync(join(assets, name))))).toBe(row.sha256);
}

const E = 200000, NU = 0.3, SY = 250, G = E / (2 * (1 + NU)), L = 10;
const PLAN_SCHEMA = 'pointercad-finite-j2-equilibrium-plan/1';

// ---- 3x3 row-major helpers and shape gradients (independent of the module) ----
const mm = (a: readonly number[], b: readonly number[]): number[] =>
  Array.from({ length: 9 }, (_, n) => [0, 1, 2].reduce((s, k) => s + a[3 * Math.floor(n / 3) + k] * b[3 * k + (n % 3)], 0));
const mt = (a: readonly number[]): number[] => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const det3 = (a: readonly number[]): number => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6])
  + a[2] * (a[3] * a[7] - a[4] * a[6]);
function inv3(a: readonly number[]): number[] {
  const d = det3(a);
  return [a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4],
    a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5],
    a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]].map(v => v / d);
}
const apply = (f: readonly number[], x: readonly number[]): number[] =>
  [0, 1, 2].map(i => f[3 * i] * x[0] + f[3 * i + 1] * x[1] + f[3 * i + 2] * x[2]);
function rotation(axis: readonly number[], angle: number): number[] {
  const n = Math.hypot(axis[0], axis[1], axis[2]), [x, y, z] = axis.map(v => v / n), c = Math.cos(angle), s = Math.sin(angle);
  return [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s,
    y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s,
    z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)];
}
/** Reference volume and the four shape-function gradients of a linear tetrahedron (rows of J^-1, J = [x1-x0 x2-x0 x3-x0]). */
function shape(nodes: readonly number[][], element: readonly number[]): { volume: number; grads: number[][] } {
  const [p0, p1, p2, p3] = element.map(i => nodes[i]);
  const j = [0, 1, 2].flatMap(i => [p1[i] - p0[i], p2[i] - p0[i], p3[i] - p0[i]]);
  const ji = inv3(j), rows = [0, 1, 2].map(a => [ji[3 * a], ji[3 * a + 1], ji[3 * a + 2]]);
  return { volume: det3(j) / 6, grads: [[0, 1, 2].map(k => -rows[0][k] - rows[1][k] - rows[2][k]), ...rows] };
}
/** Consistent nodal forces sum_e V_e P grad N_a of a uniform first Piola-Kirchhoff stress P (row-major). */
function consistentForces(nodes: readonly number[][], elements: readonly number[][], p: readonly number[]): number[][] {
  const forces = nodes.map(() => [0, 0, 0]);
  for (const element of elements) {
    const { volume, grads } = shape(nodes, element);
    element.forEach((node, a) => [0, 1, 2].forEach(i => {
      forces[node][i] += volume * [0, 1, 2].reduce((s, k) => s + p[3 * i + k] * grads[a][k], 0);
    }));
  }
  return forces;
}

// ---- closed-form logarithmic J2 oracles (W33) ----
/** Signed plastic strain p and alpha of an isochoric coaxial history (modulus 3 G). */
function isochoric(stretches: readonly number[], h: number): { p: number; alpha: number }[] {
  let p = 0, alpha = 0;
  return stretches.map(s => {
    const e = Math.log(s), q = 3 * G * (e - p);
    if (q > SY + h * alpha) { const next = (3 * G * e - SY - h * alpha + h * p) / (3 * G + h); alpha += next - p; p = next; }
    else if (-q > SY + h * alpha) { const next = (3 * G * e + SY + h * alpha + h * p) / (3 * G + h); alpha += p - next; p = next; }
    return { p, alpha };
  });
}
/** Uniaxial dead nominal stress history: stretch lambda, Kirchhoff tau11, plastic strain p, alpha, lateral stretch mu. */
function uniaxialUnderLoad(nominal: readonly number[], h: number): { lambda: number; tau: number; p: number; alpha: number; mu: number }[] {
  let p = 0, alpha = 0;
  return nominal.map(target => {
    const respond = (e: number): { tau: number; p: number; alpha: number } => {
      const trial = E * (e - p), limit = SY + h * alpha;
      if (trial > limit) { const dg = (trial - limit) / (E + h); return { tau: trial - E * dg, p: p + dg, alpha: alpha + dg }; }
      if (-trial > limit) { const dg = (-trial - limit) / (E + h); return { tau: trial + E * dg, p: p - dg, alpha: alpha + dg }; }
      return { tau: trial, p, alpha };
    };
    let low = -0.5, high = 0.5;  // tau(e) - P exp(e) increases in e here (plastic slope E h / (E + h) > tau)
    for (let k = 0; k < 200; k += 1) {
      const mid = (low + high) / 2;
      if (respond(mid).tau - target * Math.exp(mid) > 0) high = mid; else low = mid;
    }
    const e = (low + high) / 2, state = respond(e);
    p = state.p; alpha = state.alpha;
    return { lambda: Math.exp(e), tau: state.tau, p, alpha, mu: Math.exp(-NU * state.tau / E - p / 2) };
  });
}

// ---- result reading (unknown JSON from Python) ----
interface ElementRecord { J: number; tau: number[]; P: number[]; alpha: number; plastic: boolean; F9: number[] }
interface StepRecord { residual: number; displacement: number[][]; internal: number[][]; external: number[][]; elements: ElementRecord[] }
const field = (row: object, key: string): unknown => Object.entries(row).find(([name]) => name === key)?.[1];
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('non-finite native value');
  return value;
}
function vector(value: unknown, size: number): number[] {
  if (!Array.isArray(value) || value.length !== size) throw new Error('bad native vector');
  return value.map(finite);
}
function rows(value: unknown): number[][] {
  if (!Array.isArray(value)) throw new Error('bad native rows');
  return value.map((row: unknown) => vector(row, 3));
}
function readElement(value: unknown): ElementRecord {
  if (typeof value !== 'object' || value === null) throw new Error('bad element record');
  const native = field(value, 'native'), plastic = field(value, 'plastic');
  if (typeof native !== 'object' || native === null || typeof plastic !== 'boolean') throw new Error('bad element fields');
  return { J: finite(field(value, 'J')), tau: vector(field(value, 'tau'), 9), P: vector(field(value, 'P'), 9),
    alpha: finite(field(value, 'alpha')), plastic, F9: vector(field(native, 'F9'), 9) };
}
function readResult(text: unknown): { records: StepRecord[]; refused: unknown; retained: number; limit: number } {
  if (typeof text !== 'string') throw new Error('native run returned no JSON text');
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || field(value, 'schema') !== 'pointercad-finite-j2-equilibrium/1'
    || field(value, 'units') !== 'N-mm-MPa' || field(value, 'freeResidualBound') !== 1e-8) throw new Error('unexpected native result');
  const records = field(value, 'records');
  if (!Array.isArray(records)) throw new Error('native result has no records');
  return { refused: field(value, 'refusedCommits'), retained: finite(field(value, 'retainedNativeAnalyses')),
    limit: finite(field(value, 'runtimeAnalysisLimit')),
    records: records.map((row: unknown) => {
      if (typeof row !== 'object' || row === null) throw new Error('bad step record');
      const elements = field(row, 'elements');
      if (!Array.isArray(elements)) throw new Error('step record has no elements');
      return { residual: finite(field(row, 'freeResidualRatio')), displacement: rows(field(row, 'displacementMm')),
        internal: rows(field(row, 'internalN')), external: rows(field(row, 'externalN')), elements: elements.map(readElement) };
    }) };
}
const maxAbs = (values: readonly number[]): number => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const OOFEM9 = [0, 4, 8, 5, 2, 1, 7, 6, 3];

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
  loaded.FS.writeFile('/pcad_fem/solidFiniteEquilibrium.py', new Uint8Array(readFileSync(entryUrl)));
  runtime = loaded;
}, FUNCTIONAL_TEST_TIMEOUT_MS);
// The runtime retains every native analysis (module docstring); the test drops its only reference here and the vitest
// worker process ends the WebAssembly instance (no native destruction is exposed by the binding).
afterAll(() => { globalThis.fetch = originalFetch; runtime = undefined; });

type Dof = 'x' | 'y' | 'z';
const DOF: Dof[] = ['x', 'y', 'z'];
interface Plan { schema: string; units: string; nodes: number[][]; elements: number[][]; material: Record<string, number>;
  steps: number; prescribedMm: { node: number; dof: Dof; valuesMm: number[] }[]; forcesN: { node: number; dof: Dof; valuesN: number[] }[];
  referenceForceN?: number }

function python(code: string[]): unknown {
  if (runtime === undefined) throw new Error('Pyodide did not load');
  return runtime.runPython(['import sys, json', 'sys.path.insert(0, "/pcad_fem")', 'import oofem', 'import solidFiniteMaterial as law',
    'import solidFiniteEquilibrium as fe', ...code, ''].join('\n'));
}
function runPlan(plan: Plan, path: string): ReturnType<typeof readResult> {
  if (runtime === undefined) throw new Error('Pyodide did not load');
  runtime.FS.writeFile(`${path}-plan.json`, JSON.stringify(plan));
  return readResult(python([`fe.run_finite_equilibrium(oofem, json.load(open("${path}-plan.json", encoding="utf-8")), "${path}")`]));
}

// 2-tet patch: A = (0, 1, 2, 3), B = (1, 2, 3, 4); rigid motion removed by 7 zero displacements, x = 0 nodes stay in x = 0.
const TWO_NODES = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]];
const TWO_ELEMENTS = [[0, 1, 2, 3], [1, 2, 3, 4]];
const FIXED: [number, Dof][] = [[0, 'x'], [0, 'y'], [0, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']];
const UNIT_X = consistentForces(TWO_NODES, TWO_ELEMENTS, [1, 0, 0, 0, 0, 0, 0, 0, 0]);  // per 1 MPa nominal P11
function uniaxialPlan(nominal: readonly number[], h: number): Plan {
  return { schema: PLAN_SCHEMA, units: 'N-mm-MPa', nodes: TWO_NODES, elements: TWO_ELEMENTS,
    material: { youngMPa: E, poisson: NU, yieldStressMPa: SY, hardeningModulusMPa: h }, steps: nominal.length,
    prescribedMm: FIXED.map(([node, dof]) => ({ node, dof, valuesMm: nominal.map(() => 0) })),
    forcesN: [1, 4].map(node => ({ node, dof: 'x' as const, valuesN: nominal.map(p => p * UNIT_X[node][0]) })) };
}
function refine(nominal: readonly number[], parts: number): number[] {
  return nominal.flatMap((knot, k) => {
    const start = k === 0 ? 0 : nominal[k - 1];
    return Array.from({ length: parts }, (_, j) => start + (knot - start) * (j + 1) / parts);
  });
}

describe('finite-strain J2 equilibrium entry: host Python cases', () => {
  it('executes the 14 plan-reader, inverted/collapsed/non-finite, deck, force-balance, kinematics and lifetime cases', () => {
    const script = fileURLToPath(pythonCasesUrl);
    const result = spawnSync('python', ['-B', '-X', 'utf8', script, '-v'], { cwd: dirname(script), encoding: 'utf8', timeout: 120_000,
      maxBuffer: 2_000_000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: dirname(fileURLToPath(lawUrl)) } });
    const detail = `exit=${String(result.status)} signal=${String(result.signal)}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
    console.info(detail);
    expect(result.error, detail).toBeUndefined();
    expect(result.status, detail).toBe(0);
    expect(result.stderr, detail).toMatch(/(?:^|\r?\n)Ran 14 tests in [\d.]+s(?:\r?\n|$)/u);
    expect([...result.stderr.matchAll(/ \.\.\. ok\r?$/gmu)], detail).toHaveLength(14);
    expect(result.stdout.trim(), detail).toBe('solid-finite-equilibrium: 14 host cases passed');
  }, 125_000);
});

describe('finite-strain J2 equilibrium through the native OOFEM element and solver (packaged Pyodide + wheel)', () => {
  it('4-tet patch with a free interior node under a rotated isochoric history matches the exact affine field', () => {
    const H = 1000, R = rotation([1, 2, 3], Math.PI / 6), stretches = [1.0005, 1.002, 1.01, 1.05, 1.1, 1.2, 1.15];
    const nodes = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L], [L / 4, L / 4, L / 4]];
    const elements = [[4, 1, 2, 3], [0, 4, 2, 3], [0, 1, 4, 3], [0, 1, 2, 4]];
    const fs = stretches.map(s => mm(R, [s, 0, 0, 0, s ** -0.5, 0, 0, 0, s ** -0.5]));
    const plan: Plan = { schema: PLAN_SCHEMA, units: 'N-mm-MPa', nodes, elements, steps: stretches.length,
      material: { youngMPa: E, poisson: NU, yieldStressMPa: SY, hardeningModulusMPa: H },
      prescribedMm: [0, 1, 2, 3].flatMap(node => [0, 1, 2].map(dof => ({ node, dof: DOF[dof],
        valuesMm: fs.map(f => apply(f, nodes[node])[dof] - nodes[node][dof]) }))),
      forcesN: [], referenceForceN: SY * L * L };
    const { records, refused, retained, limit } = runPlan(plan, '/pcad_fem/fe-patch');
    const expected = isochoric(stretches, H);
    expect(refused).toEqual([]);
    expect(records).toHaveLength(stretches.length);
    expect(retained).toBeGreaterThanOrEqual(1);
    expect(retained).toBeLessThanOrEqual(limit);
    expect(limit).toBe(8);
    records.forEach((record, k) => {
      const f = fs[k], t = 2 * G * (Math.log(stretches[k]) - expected[k].p), scale = SY + H * expected[k].alpha;
      const tau = mm(mm(R, [t, 0, 0, 0, -t / 2, 0, 0, 0, -t / 2]), mt(R));
      expect(record.residual).toBeLessThanOrEqual(1e-8);
      const interior = apply(f, nodes[4]).map((v, i) => v - nodes[4][i]);
      expect(maxAbs(record.displacement[4].map((v, i) => v - interior[i]))).toBeLessThanOrEqual(1e-9 * L);
      expect(maxAbs(record.external.flat())).toBe(0);
      const reactions = consistentForces(nodes, elements, mm(tau, mt(inv3(f))));
      const reactionScale = maxAbs(reactions.flat());
      [0, 1, 2, 3].forEach(node => expect(maxAbs(record.internal[node].map((v, i) => v - reactions[node][i])) / reactionScale)
        .toBeLessThanOrEqual(1e-8));
      record.elements.forEach(element => {
        expect(maxAbs(element.tau.map((v, n) => v - tau[n])) / scale).toBeLessThanOrEqual(1e-8);
        expect(Math.abs(element.alpha - expected[k].alpha)).toBeLessThanOrEqual(1e-10);
        expect(Math.abs(element.J - 1)).toBeLessThanOrEqual(1e-10);
        expect(maxAbs(element.F9.map((v, n) => v - f[OOFEM9[n]]))).toBeLessThanOrEqual(1e-10);
      });
    });
    expect(records[6].elements[0].alpha).toBeGreaterThan(records[5].elements[0].alpha);  // reverse yielding
    // Same native patch and full loading/unloading history; only loads at the
    // prescribed boundary DOFs change. Keep all retained analyses (7 in total).
    for (const sign of [1, -1]) {
      const fixedLoads = plan.prescribedMm.map(({ node, dof }) => ({ node, dof,
        valuesN: stretches.map((_, k) => sign * (node + 1) * (DOF.indexOf(dof) + 1) * (k + 1) * 1000) }));
      const loaded = runPlan({ ...plan, forcesN: fixedLoads }, `/pcad_fem/fe-fixed-${String(sign)}`);
      expect(loaded.refused).toEqual([]); expect(loaded.records).toHaveLength(stretches.length);
      expect(loaded.retained).toBeLessThanOrEqual(8);
      loaded.records.forEach((record, k) => {
        const f = fs[k], t = 2 * G * (Math.log(stretches[k]) - expected[k].p), stressScale = SY + H * expected[k].alpha;
        const tau = mm(mm(R, [t,0,0,0,-t/2,0,0,0,-t/2]), mt(R));
        const exactInternal = consistentForces(nodes, elements, mm(tau, mt(inv3(f))));
        // Scale by structural internal forces, never by the added fixed load.
        const forceScale = maxAbs(exactInternal.flat());
        expect(record.residual).toBeLessThanOrEqual(1e-8);
        for (let node = 0; node < nodes.length; node++) for (let axis = 0; axis < 3; axis++) {
          const external = node < 4 ? sign * (node + 1) * (axis + 1) * (k + 1) * 1000 : 0;
          expect(record.external[node][axis]).toBe(external);
          expect(Math.abs(record.displacement[node][axis] - records[k].displacement[node][axis])).toBeLessThanOrEqual(1e-9 * L);
          const exactU = apply(f, nodes[node])[axis] - nodes[node][axis];
          expect(Math.abs(record.displacement[node][axis] - exactU)).toBeLessThanOrEqual(1e-9 * L);
          const reaction = record.internal[node][axis] - record.external[node][axis];
          const expectedReaction = exactInternal[node][axis] - external;
          expect(Math.abs(reaction - expectedReaction) / forceScale).toBeLessThanOrEqual(1e-8);
          expect(Math.abs((reaction - records[k].internal[node][axis]) + external) / forceScale).toBeLessThanOrEqual(1e-8);
        }
        record.elements.forEach((element, e) => {
          expect(maxAbs(element.tau.map((v, n) => v - tau[n])) / stressScale).toBeLessThanOrEqual(1e-8);
          expect(maxAbs(element.tau.map((v, n) => v - records[k].elements[e].tau[n])) / stressScale).toBeLessThanOrEqual(1e-8);
          expect(Math.abs(element.alpha - expected[k].alpha)).toBeLessThanOrEqual(1e-10);
          expect(Math.abs(element.alpha - records[k].elements[e].alpha)).toBeLessThanOrEqual(1e-10);
          expect(element.plastic).toBe(records[k].elements[e].plastic);
          expect(Math.abs(element.J - 1)).toBeLessThanOrEqual(1e-10);
          expect(maxAbs(element.F9.map((v, n) => v - f[OOFEM9[n]]))).toBeLessThanOrEqual(1e-10);
        });
        for (let axis = 0; axis < 3; axis++) {
          const totalExternal = record.external.reduce((sum, row) => sum + row[axis], 0);
          const totalReaction = record.internal.slice(0, 4).reduce((sum, row, node) => sum + row[axis] - record.external[node][axis], 0);
          expect(Math.abs(totalExternal + totalReaction) / forceScale).toBeLessThanOrEqual(1e-8);
        }
      });
    }
    expect(denied).toBe(0);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('2-tet patch under uniaxial dead load and unload: loaded free DOFs in native balance; 4x finer increments agree', () => {
    // First unloading increment 1000 -> 850 MPa: the step starts from the W33 committed-point (elastoplastic) tangent, and
    // a larger first unloading increment overshoots into reverse yielding and is refused (next test, RUN 20261030-073837).
    const H = 20000, nominal = [150, 300, 600, 900, 1000, 850, 0];
    const runs = [1, 4].map(parts => {
      const history = refine(nominal, parts);
      return { parts, history, expected: uniaxialUnderLoad(history, H),
        result: runPlan(uniaxialPlan(history, H), `/pcad_fem/fe-uniaxial-${String(parts)}`) };
    });
    for (const { history, expected, result } of runs) {
      expect(result.refused).toEqual([]);
      expect(result.records).toHaveLength(history.length);
      result.records.forEach((record, k) => {
        const { lambda, mu, tau, alpha, p } = expected[k], scale = SY + H * alpha;
        expect(record.residual).toBeLessThanOrEqual(1e-8);
        TWO_NODES.forEach((x, node) => {
          const exact = [(lambda - 1) * x[0], (mu - 1) * x[1], (mu - 1) * x[2]];
          expect(maxAbs(record.displacement[node].map((v, i) => v - exact[i]))).toBeLessThanOrEqual(1e-10 * L);
        });
        // Native dead loads equal the plan; reactions equal the consistent forces of P11 = tau / lambda.
        [1, 4].forEach(node => {
          const planned = history[k] * UNIT_X[node][0];
          expect(Math.abs(record.external[node][0] - planned)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(planned)));
        });
        const forceScale = Math.max(...[0, 1, 2, 3, 4].map(node => Math.abs(UNIT_X[node][0]))) * Math.max(Math.abs(history[k]), 1);
        [0, 2, 3].forEach(node => expect(Math.abs(record.internal[node][0] - tau / lambda * UNIT_X[node][0]) / forceScale)
          .toBeLessThanOrEqual(1e-8));
        record.elements.forEach(element => {
          const expectedTau = [tau, 0, 0, 0, 0, 0, 0, 0, 0];
          expect(maxAbs(element.tau.map((v, n) => v - expectedTau[n])) / scale).toBeLessThanOrEqual(1e-8);
          expect(Math.abs(element.alpha - alpha)).toBeLessThanOrEqual(1e-10);
          expect(Math.abs(element.J - lambda * mu * mu)).toBeLessThanOrEqual(1e-10);
        });
        if (history[k] === 0) expect(Math.abs(lambda - Math.exp(p))).toBeLessThanOrEqual(1e-12);  // residual plastic stretch
      });
    }
    const [coarse, fine] = runs;
    expect(coarse.result.records.some(record => record.elements[0].plastic)).toBe(true);
    expect(coarse.result.records[6].elements[0].alpha).toBe(coarse.result.records[4].elements[0].alpha);  // elastic unload
    expect(coarse.result.records[6].displacement[4][0]).toBeGreaterThan(0);                               // permanent set
    nominal.forEach((_, k) => {
      const a = coarse.result.records[k], b = fine.result.records[4 * k + 3];
      const difference = maxAbs(a.displacement[4].map((v, i) => v - b.displacement[4][i])) / maxAbs(b.displacement[4]);
      expect(difference).toBeLessThanOrEqual(0.01);   // W34 refinement limit
      expect(difference).toBeLessThanOrEqual(1e-8);   // exact coaxial return: the increment size does not matter here
      expect(Math.abs(a.elements[0].alpha - b.elements[0].alpha)).toBeLessThanOrEqual(1e-10);
    });
    expect(denied).toBe(0);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('refuses non-finite input before any native object, and an inverted element or a failed solve commits nothing', () => {
    if (runtime === undefined) throw new Error('Pyodide did not load');
    runtime.FS.writeFile('/pcad_fem/fe-bad-plan.json', JSON.stringify(uniaxialPlan([100, 200], 1000)));
    const inversion: Plan = { schema: PLAN_SCHEMA, units: 'N-mm-MPa', nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]],
      elements: [[0, 1, 2, 3]], material: { youngMPa: E, poisson: NU, yieldStressMPa: SY, hardeningModulusMPa: 1000 }, steps: 2,
      // Node 1 to x = -L with node 3 free only in y: det(x1 - x0, x2 - x0, x3 - x0) = -L^3 whatever y3 is (a genuine
      // inversion; a free z at node 3 would allow the proper 180-degree turn about y that the first run accepted).
      prescribedMm: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0], [3, 2]].map(([node, dof]) => ({
        node, dof: DOF[dof], valuesMm: node === 1 && dof === 0 ? [0.01 * L, -2 * L] : [0, 0] })),
      forcesN: [], referenceForceN: SY * L * L };
    runtime.FS.writeFile('/pcad_fem/fe-inversion-plan.json', JSON.stringify(inversion));
    // Regression of RUN 20261030-073437/073837: after plastic dead loading to 1000 MPa the first unloading increment to
    // 500 MPa starts from the elastoplastic committed-point tangent, overshoots into reverse yielding and 2-cycles until
    // the native NRSolver throws at maxiter 50 (nrsolver.C:286-288). It must be refused with the 5 accepted steps intact.
    runtime.FS.writeFile('/pcad_fem/fe-failed-plan.json', JSON.stringify(uniaxialPlan([150, 300, 600, 900, 1000, 500, 0], 20000)));
    const text = python([
      'out = {}',
      'def observe(run, error):',
      '    m = run.material',
      '    return {"type": type(error).__name__, "message": str(error), "notes": list(getattr(error, "__notes__", [])),',
      '            "records": len(run.records), "open": m.attempt is not None, "abandoned": list(m.abandonedSteps),',
      '            "accepted": list(m.acceptedSteps), "refused": len(m.refusedCommits),',
      '            "committed": [[s.committed["alpha"], list(s.committedE)] for s in m.statuses],',
      '            "trialCleared": all(s.trial is None and s.last is None and s.trialToken is None for s in m.statuses)}',
      'before = len(law._NATIVE_LIFETIME)',
      'bad = json.load(open("/pcad_fem/fe-bad-plan.json"))',
      'bad["forcesN"][0]["valuesN"][0] = float("nan")',
      'try:',
      '    fe.run_finite_equilibrium(oofem, bad, "/pcad_fem/fe-bad")',
      '    out["nonFinite"] = "accepted"',
      'except ValueError as error:',
      '    out["nonFinite"] = str(error)',
      'out["nonFiniteRetained"] = len(law._NATIVE_LIFETIME) - before',
      'for name in ("inversion", "failed"):',
      '    run = fe.FiniteEquilibriumRun(oofem, fe.read_plan(json.load(open(f"/pcad_fem/fe-{name}-plan.json"))), f"/pcad_fem/fe-{name}")',
      '    out[name], first = {"type": "accepted"}, None',
      '    while len(run.records) < run.plan["steps"]:',
      '        try:',
      '            run.advance()',
      '        except Exception as error:',
      '            out[name] = observe(run, error)',
      '            break',
      '        first = [[s.committed["alpha"], list(s.committedE)] for s in run.material.statuses]',
      '    out[name]["first"] = first',
      '    try:',
      '        run.advance()',
      '        out[name]["reuse"] = "accepted"',
      '    except ValueError as error:',
      '        out[name]["reuse"] = str(error)',
      '    run.close()',
      'out["retained"] = len(law._NATIVE_LIFETIME) - before',
      'json.dumps(out)']);
    if (typeof text !== 'string') throw new Error('negative checks returned no JSON text');
    const out: unknown = JSON.parse(text);
    if (typeof out !== 'object' || out === null) throw new Error('bad negative record');
    console.info(JSON.stringify(out, null, 1));
    expect(String(field(out, 'nonFinite'))).toMatch(/finite-equilibrium: forcesN\[0\]\.valuesN\[0\] must be a finite number/u);
    expect(field(out, 'nonFiniteRetained')).toBe(0);
    expect(field(out, 'retained')).toBe(2);
    const expectations: [string, number, RegExp][] = [
      // F = diag(-1, 1, 1) has E = 0, so the law cannot see it (RUN 20261030-074238 committed it); the entry's own
      // det F of the native displacements must refuse it before the commit.
      ['inversion', 1, /^finite-equilibrium: element 1 has det F = -1\.0 at step 2 \(inverted or collapsed element; nothing committed\)$/u],
      ['failed', 5, /^Convergence Exception Reason: Maximum number of iterations reached without convergence$/u]];
    for (const [name, accepted, message] of expectations) {
      const row = field(out, name);
      if (typeof row !== 'object' || row === null) throw new Error(`no ${name} record`);
      const first = field(row, 'first');
      expect(field(row, 'type')).not.toBe('accepted');
      expect(String(field(row, 'message'))).toMatch(message);           // the original exception object, re-raised
      expect(field(row, 'notes')).toEqual([`finite-equilibrium: raised at step ${String(accepted + 1)} of ${name === 'failed' ? '7' : '2'} `
        + '(nothing of this step committed)']);
      expect(row).toMatchObject({ records: accepted, open: false, abandoned: [accepted + 1], refused: 0, trialCleared: true,
        accepted: Array.from({ length: accepted }, (_, k) => k + 1) });
      expect(field(row, 'committed')).toEqual(first);                 // the last accepted history is intact
      expect(Array.isArray(first) && Array.isArray(first[0]) ? finite(first[0][0]) : 0).toBeGreaterThan(0);  // plastic
      expect(String(field(row, 'reuse'))).toContain('single use');
    }
    expect(denied).toBe(0);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
});
