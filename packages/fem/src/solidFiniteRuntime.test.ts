import { describe, expect, it } from 'vitest';
import type { PyodideRuntime } from './runtime.js';
import { SOLID_FINITE_PLAN_SCHEMA } from './solidFinitePlan.js';
import { analyzeSolidFinite, SOLID_FINITE_RESPONSE_LIMIT, solidFiniteRuntimeClaimed } from './solidFiniteRuntime.js';
import { SOLID_FINITE_INPUT_SCHEMA, solidFiniteInputSha256, translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';

/*
 * Fake-runtime contract of the finite equilibrium entry: I/O, JSON-only data, fixed Python, response bound, error identity
 * and one analysis per runtime. Native physics is not exercised here; it is proven by solidFiniteEquilibriumNative.test.ts
 * (packaged Pyodide + OOFEM wheel). The reply is one hand-written accepted step of one tetrahedron:
 * F = diag(1.25, 0.875, 0.875), S = diag(160, 0, 0) give J = 0.95703125, P = diag(200, 0, 0), tau = diag(250, 0, 0).
 */
const L = 10, J1 = 0.95703125;
function input(documentId = 'doc', revision = 3): SolidFiniteInput {
  return translateSolidFinite({ schema: SOLID_FINITE_INPUT_SCHEMA, source: { documentId, revision }, plan: {
    schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa', nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]], elements: [[0, 1, 2, 3]],
    material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 }, steps: 1,
    prescribedMm: [[0, 'x'], [0, 'y'], [0, 'z'], [1, 'y'], [1, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']]
      .map(([node, dof]) => ({ node, dof, valuesMm: [0] })),
    forcesN: [{ node: 1, dof: 'x', valuesN: [100] }] } }).input;
}
function native(retained = 1): Record<string, unknown> {
  return { schema: 'pointercad-finite-j2-equilibrium/1',
    method: 'oofem-ltrspace-nlgeo1-staticstructural-nrsolver-pointercad-finite-j2/1', units: 'N-mm-MPa',
    scope: 'finite-strain-j2-linear-isotropic-hardening-tet4-internal', structuralCertification: false, freeResidualBound: 1e-8,
    records: [{ step: 1, time: 1, freeResidualRatio: 0, forceScaleN: 100,
      displacementMm: [[0, 0, 0], [0.005, 0, 0], [0, -0.0015, 0], [0, 0, -0.0015]],
      internalN: [[-60, 10, 0], [100, -10, 0], [-20, 0, 0], [-20, 0, 0]], externalN: [[0, 0, 0], [100, 0, 0], [0, 0, 0], [0, 0, 0]],
      elements: [{ J: J1, tau: [250, 0, 0, 0, 0, 0, 0, 0, 0], P: [200, 0, 0, 0, 0, 0, 0, 0, 0], sigma: [250 / J1, 0, 0, 0, 0, 0, 0, 0, 0],
        alpha: 0, plastic: false, dissipation: 0, q: 250, native: { F9: [1.25, 0.875, 0.875, 0, 0, 0, 0, 0, 0], S6: [160, 0, 0, 0, 0, 0] } }] }],
    refusedCommits: [], retainedNativeAnalyses: retained, runtimeAnalysisLimit: 8 };
}
const programs = { material: Uint8Array.of(0x33), equilibrium: Uint8Array.of(0x34), wheelLocation: 'https://pointercad.invalid/fem/assets/oofem.whl' };

interface Fake { readonly runtime: PyodideRuntime; readonly calls: string[]; readonly files: Map<string, string | Uint8Array>; readonly sources: string[] }
function fake(reply: () => unknown, overrides: Partial<Pick<PyodideRuntime, 'loadPackage'>> = {}): Fake {
  const calls: string[] = [], files = new Map<string, string | Uint8Array>(), sources: string[] = [];
  const runtime: PyodideRuntime = { version: '0.29.3',
    FS: { mkdirTree: path => { calls.push(`mkdir ${path}`); }, writeFile: (path, value) => { calls.push(`write ${path}`); files.set(path, value); } },
    runPython: source => { calls.push('run'); sources.push(source); return reply(); },
    loadPackage: overrides.loadPackage ?? ((packages, options) => {
      calls.push(`load ${String(packages)} integrity=${String(options?.checkIntegrity)}`);
      return Promise.resolve(undefined);
    }) };
  return { runtime, calls, files, sources };
}

describe('finite equilibrium runtime entry (fake runtime)', () => {
  it('validates the input before touching the runtime and does not claim it for a refused input', async () => {
    const target = fake(() => JSON.stringify(native()));
    const invalid = { ...input(), plan: { ...input().plan, steps: 0 } };
    await expect(analyzeSolidFinite(target.runtime, invalid, programs, () => undefined)).rejects.toThrow('finite-equilibrium-plan: steps');
    const extra = { ...input(), source: { documentId: 'doc', revision: 3, generation: 1 } };
    await expect(analyzeSolidFinite(target.runtime, extra, programs, () => undefined)).rejects.toThrow('finite-equilibrium-input: source must have exactly');
    expect(target.calls).toEqual([]);
    expect(solidFiniteRuntimeClaimed(target.runtime)).toBe(false);
    await expect(analyzeSolidFinite(target.runtime, input(), programs, () => undefined)).resolves.toMatchObject({ retainedNativeAnalyses: 1 });
  });

  it('loads the pinned wheel, writes the plan only as JSON data next to the two fixed files and runs fixed Python', async () => {
    const value = input(), target = fake(() => JSON.stringify(native())), phases: string[] = [];
    const result = await analyzeSolidFinite(target.runtime, value, programs, phase => { phases.push(phase); });
    expect(target.calls).toEqual([`load ${programs.wheelLocation} integrity=true`, 'mkdir /pcad_fem',
      'write /pcad_fem/finite-equilibrium-plan.json', 'write /pcad_fem/solidFiniteMaterial.py', 'write /pcad_fem/solidFiniteEquilibrium.py', 'run']);
    expect(phases).toEqual(['loading-packages', 'solving']);
    expect(JSON.parse(String(target.files.get('/pcad_fem/finite-equilibrium-plan.json')))).toEqual(value.plan);
    expect(target.files.get('/pcad_fem/solidFiniteMaterial.py')).toBe(programs.material);
    expect(target.files.get('/pcad_fem/solidFiniteEquilibrium.py')).toBe(programs.equilibrium);
    const [source] = target.sources;
    expect(source).toContain('from solidFiniteEquilibrium import run_finite_equilibrium');
    expect(source).toContain("open('/pcad_fem/finite-equilibrium-plan.json', encoding='utf-8')");
    expect(source.trim().split('\n').at(-1)).toBe('run_finite_equilibrium(oofem, plan)');
    expect(source).not.toMatch(/_NATIVE_LIFETIME|\bgc\b|collect|clear\(/u);
    expect(result.inputSha256).toBe(await solidFiniteInputSha256(value));
    expect(result.input).toEqual(value);
    expect(result.records[0].elements[0].P[0]).toBe(200);
  });

  it('never places caller content in Python source', async () => {
    const hostile = input("x'); import os; os.system('calc') #", 7), plain = fake(() => JSON.stringify(native())), other = fake(() => JSON.stringify(native()));
    await analyzeSolidFinite(plain.runtime, input(), programs, () => undefined);
    await analyzeSolidFinite(other.runtime, hostile, programs, () => undefined);
    expect(other.sources).toEqual(plain.sources);
    expect(other.sources[0]).not.toContain('os.system');
    expect(String(other.files.get('/pcad_fem/finite-equilibrium-plan.json'))).not.toContain('os.system');   // the plan holds no source
  });

  it('hosts at most one call per runtime: a second call, a call after a failure and a concurrent call are refused', async () => {
    const target = fake(() => JSON.stringify(native()));
    await analyzeSolidFinite(target.runtime, input(), programs, () => undefined);
    const before = target.calls.length;
    await expect(analyzeSolidFinite(target.runtime, input(), programs, () => undefined)).rejects.toThrow('already hosted a finite analysis');
    expect(target.calls).toHaveLength(before);
    expect(solidFiniteRuntimeClaimed(target.runtime)).toBe(true);

    const failure = new Error('native boundary');
    const failed = fake(() => { throw failure; });
    await expect(analyzeSolidFinite(failed.runtime, input(), programs, () => undefined)).rejects.toBe(failure);
    await expect(analyzeSolidFinite(failed.runtime, input(), programs, () => undefined)).rejects.toThrow('already hosted');
    expect(failed.calls.filter(call => call === 'run')).toHaveLength(1);

    const shared = fake(() => JSON.stringify(native()));
    const outcomes = await Promise.allSettled([analyzeSolidFinite(shared.runtime, input(), programs, () => undefined),
      analyzeSolidFinite(shared.runtime, input(), programs, () => undefined)]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(shared.calls.filter(call => call === 'run')).toHaveLength(1);
  });

  it('propagates the original error objects of the package loader, the file system, Python and the phase callback', async () => {
    const loadError = new Error('wheel integrity');
    const loading = fake(() => JSON.stringify(native()), { loadPackage: () => Promise.reject(loadError) });
    await expect(analyzeSolidFinite(loading.runtime, input(), programs, () => undefined)).rejects.toBe(loadError);
    const writeError = new Error('FS full');
    const writing = fake(() => JSON.stringify(native()));
    writing.runtime.FS.writeFile = () => { throw writeError; };
    await expect(analyzeSolidFinite(writing.runtime, input(), programs, () => undefined)).rejects.toBe(writeError);
    const pythonError = Object.assign(new Error('PythonError: Traceback ... ValueError: finite-equilibrium: free-DOF force residual'),
      { type: 'ValueError' });
    await expect(analyzeSolidFinite(fake(() => { throw pythonError; }).runtime, input(), programs, () => undefined)).rejects.toBe(pythonError);
    const callbackError = new Error('listener failed');
    const listener = fake(() => JSON.stringify(native()));
    await expect(analyzeSolidFinite(listener.runtime, input(), programs, phase => { if (phase === 'solving') throw callbackError; }))
      .rejects.toBe(callbackError);
    expect(listener.calls).not.toContain('run');
  });

  it('bounds the response before JSON.parse and decodes it strictly', async () => {
    for (const reply of [42, undefined, { toString: () => JSON.stringify(native()) }]) {
      await expect(analyzeSolidFinite(fake(() => reply).runtime, input(), programs, () => undefined))
        .rejects.toThrow('finite-equilibrium-runtime: invalid bounded finite equilibrium response');
    }
    // Over the bound: refused by the bound, not by the JSON parser (the text is not even valid JSON).
    await expect(analyzeSolidFinite(fake(() => '{'.padEnd(SOLID_FINITE_RESPONSE_LIMIT + 1, ' ')).runtime, input(), programs, () => undefined))
      .rejects.toThrow('invalid bounded finite equilibrium response');
    // Exactly at the bound: a valid reply padded with JSON whitespace is accepted.
    const padded = JSON.stringify(native()).padEnd(SOLID_FINITE_RESPONSE_LIMIT, ' ');
    expect(padded).toHaveLength(SOLID_FINITE_RESPONSE_LIMIT);
    await expect(analyzeSolidFinite(fake(() => padded).runtime, input(), programs, () => undefined)).resolves.toMatchObject({ structuralCertification: false });
    await expect(analyzeSolidFinite(fake(() => '{"schema": ').runtime, input(), programs, () => undefined)).rejects.toThrow(SyntaxError);
    await expect(analyzeSolidFinite(fake(() => JSON.stringify({ ...native(), records: [] })).runtime, input(), programs, () => undefined))
      .rejects.toThrow('finite-equilibrium-result: records must hold all 1 accepted steps');
  });

  it('refuses a reply that reports an earlier native analysis in the same interpreter', async () => {
    await expect(analyzeSolidFinite(fake(() => JSON.stringify(native(2))).runtime, input(), programs, () => undefined))
      .rejects.toThrow('finite-equilibrium-runtime: the runtime retains 2 native analyses; a finite analysis needs a fresh runtime');
  });

  it('keeps the largest legitimate reply (Python json.dumps, 24-character doubles, 19984 element states) within the bound', () => {
    // 4 steps x (4 nodes + 4996 elements) = 20000 states, the most element states read_plan allows.
    const d = -2.2250738585072014e-308, nine = Array.from({ length: 9 }, () => d), three = [d, d, d];
    const element = { J: d, tau: nine, P: nine, sigma: nine, alpha: d, plastic: false, dissipation: d, q: d,
      native: { F9: nine, S6: nine.slice(0, 6) } };
    const records = Array.from({ length: 4 }, () => ({ step: 200, time: d, freeResidualRatio: d, forceScaleN: d,
      displacementMm: [three, three, three, three], internalN: [three, three, three, three], externalN: [three, three, three, three],
      elements: Array.from({ length: 4996 }, () => element) }));
    const largest = { ...native(), records, refusedCommits: [], retainedNativeAnalyses: 8 };
    const text = JSON.stringify(largest).replaceAll(',', ', ').replaceAll(':', ': ');
    expect(String(d)).toHaveLength(24);
    expect(text.length).toBeGreaterThan(25_000_000);
    expect(text.length).toBeLessThan(SOLID_FINITE_RESPONSE_LIMIT);
  });
});
