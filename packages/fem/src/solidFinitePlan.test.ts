import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSolidFinitePlan, SOLID_FINITE_PLAN_SCHEMA } from './solidFinitePlan.js';

// Plans are written here as plain JSON values; the acceptance oracle is the actual Python read_plan of
// solidFiniteEquilibrium.py (host CPython, no native solver), given the same JSON text that the runtime writes.
const entryUrl = new URL('./solidFiniteEquilibrium.py', import.meta.url);
const L = 10;
const MATERIAL = { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 };
type Value = Record<string, unknown>;

const zeros = (steps: number): number[] => Array.from({ length: steps }, () => 0);
const fixed = (pairs: readonly (readonly [number, string])[], steps: number): Value[] =>
  pairs.map(([node, dof]) => ({ node, dof, valuesMm: zeros(steps) }));
const FIXED_2TET = [[0, 'x'], [0, 'y'], [0, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']] as const;
/** 2-tet patch (0, 1, 2, 3) and (1, 2, 3, 4) of the W34 suite: 7 zero displacements, x forces at nodes 1 and 4. */
function plan(steps = 2, forces: readonly number[] = Array.from({ length: steps }, (_, k) => 100 * (k + 1))): Value {
  return { schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa',
    nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]], elements: [[0, 1, 2, 3], [1, 2, 3, 4]],
    material: { ...MATERIAL }, steps, prescribedMm: fixed(FIXED_2TET, steps),
    forcesN: [1, 4].map(node => ({ node, dof: 'x', valuesN: [...forces] })) };
}
/** One tetrahedron under a displacement-only history (no nodal force): needs referenceForceN. */
function displacementPlan(nodes: unknown = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]]): Value {
  const pairs = [[0, 'x'], [0, 'y'], [0, 'z'], [1, 'y'], [1, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']] as const;
  return { schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa', nodes, elements: [[0, 1, 2, 3]], material: { ...MATERIAL },
    steps: 2, prescribedMm: [...fixed(pairs, 2), { node: 1, dof: 'x', valuesMm: [0.01, 0.02] }], forcesN: [], referenceForceN: 25000 };
}
/** k disjoint positive tetrahedra (4 k nodes), the corner of each fixed, one x force per tetrahedron. */
function disjoint(k: number, steps: number): Value {
  const tets = Array.from({ length: k }, (_, t) => t);
  return { schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa',
    nodes: tets.flatMap(t => [[3 * L * t, 0, 0], [3 * L * t + L, 0, 0], [3 * L * t, L, 0], [3 * L * t, 0, L]]),
    elements: tets.map(t => [4 * t, 4 * t + 1, 4 * t + 2, 4 * t + 3]), material: { ...MATERIAL }, steps,
    prescribedMm: tets.flatMap(t => fixed([[4 * t, 'x'], [4 * t, 'y'], [4 * t, 'z']], steps)),
    forcesN: tets.map(t => ({ node: 4 * t + 1, dof: 'x', valuesN: Array.from({ length: steps }, () => 1) })) };
}
/** (0,0,0), (1,0,0), (0,1,0), (0,0,h): 6 V = h and the longest edge is sqrt(2), so the bound is 2.83e-12. */
const flat = (h: number): Value => displacementPlan([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, h]]);
const replace = (base: Value, changes: Value): Value => ({ ...base, ...changes });
const without = (base: Value, key: string): Value => Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
const material = (changes: Value): Value => replace(plan(), { material: { ...MATERIAL, ...changes } });
const loads = (first: Value, second: Value = { node: 4, dof: 'x', valuesN: [100, 200] }): Value =>
  replace(plan(), { forcesN: [first, second] });

const accepted: [string, Value][] = [
  ['2-tet dead-load history (reference = largest |force|)', plan()],
  ['displacement history with referenceForceN', displacementPlan()],
  ['explicit referenceForceN next to nodal forces', replace(plan(), { referenceForceN: 7 })],
  ['a zero-force step inside a loaded history', plan(3, [100, 0, -50])],
  ['volume just above 1e-12 x edge^3', flat(4e-12)],
  ['19950 recorded states (190 steps x 105)', disjoint(21, 190)],
  ['200 steps', disjoint(1, 200)],
  ['negative coordinates', displacementPlan([[-5, -5, -5], [5, -5, -5], [-5, 5, -5], [-5, -5, 5]])],
  ['poisson 0 and hardening 0', material({ poisson: 0, hardeningModulusMPa: 0 })],
];
const refused: [string, Value][] = [
  ['an unknown plan field', replace(plan(), { extra: 1 })],
  ['a missing plan field', without(plan(), 'forcesN')],
  ['another plan schema', replace(plan(), { schema: 'pointercad-solid-plastic-plan/1' })],
  ['other units', replace(plan(), { units: 'N-m-Pa' })],
  ['a null coordinate', replace(plan(), { nodes: [[0, 0, null], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]] })],
  ['a string coordinate', replace(plan(), { nodes: [[0, 0, '0'], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]] })],
  ['a boolean force value', loads({ node: 1, dof: 'x', valuesN: [true, 100] })],
  ['a 2-component node', replace(plan(), { nodes: [[0, 0], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]] })],
  ['3 nodes', displacementPlan([[0, 0, 0], [L, 0, 0], [0, L, 0]])],
  ['no element', replace(plan(), { elements: [] })],
  ['a fractional node index', replace(plan(), { elements: [[0, 1, 2, 3], [1, 2, 3, 4.5]] })],
  ['an out-of-range node index', replace(plan(), { elements: [[0, 1, 2, 3], [1, 2, 3, 5]] })],
  ['a repeated node in an element', replace(plan(), { elements: [[0, 1, 2, 3], [1, 2, 2, 4]] })],
  ['an inverted element (negative 6V)', replace(plan(), { elements: [[0, 2, 1, 3], [1, 2, 3, 4]] })],
  ['a coplanar (collapsed) element', displacementPlan([[0, 0, 0], [L, 0, 0], [0, L, 0], [L, L, 0]])],
  ['volume just below 1e-12 x edge^3', flat(2e-12)],
  ['an unused node', replace(plan(), { elements: [[0, 1, 2, 3]] })],
  ['an extra material field', material({ densityKgM3: 7850 })],
  ['a missing material field', replace(plan(), { material: { youngMPa: 1, poisson: 0.3, yieldStressMPa: 1 } })],
  ['poisson 0.5', material({ poisson: 0.5 })],
  ['negative poisson', material({ poisson: -0.1 })],
  ['zero Young modulus', material({ youngMPa: 0 })],
  ['zero yield stress', material({ yieldStressMPa: 0 })],
  ['softening', material({ hardeningModulusMPa: -1 })],
  ['0 steps', replace(plan(1), { steps: 0 })],
  ['fractional steps', replace(plan(2), { steps: 2.5 })],
  ['201 steps', disjoint(1, 201)],
  ['21000 recorded states (200 steps x 105)', disjoint(21, 200)],
  ['a history one value short', replace(plan(3), { prescribedMm: [...fixed(FIXED_2TET, 3).slice(1), { node: 0, dof: 'x', valuesMm: [0, 0] }] })],
  ['a history one value long', loads({ node: 1, dof: 'x', valuesN: [1, 2, 3] })],
  ['a DOF prescribed twice', replace(plan(), { prescribedMm: [...fixed(FIXED_2TET, 2), { node: 0, dof: 'x', valuesMm: [0, 0] }] })],
  ['a DOF prescribed and loaded', loads({ node: 1, dof: 'x', valuesN: [1, 1] }, { node: 0, dof: 'y', valuesN: [1, 1] })],
  ['a DOF loaded twice', loads({ node: 4, dof: 'x', valuesN: [1, 1] })],
  ['an unknown DOF name', loads({ node: 1, dof: 'w', valuesN: [1, 1] })],
  ['an extra history field', loads({ node: 1, dof: 'x', valuesN: [1, 1], unit: 'N' })],
  ['no prescribed displacement', replace(plan(), { prescribedMm: [] })],
  ['every DOF prescribed', replace(displacementPlan(), { prescribedMm: [0, 1, 2, 3].flatMap(node => fixed([[node, 'x'], [node, 'y'], [node, 'z']], 2)) })],
  ['a displacement history without force or reference', without(displacementPlan(), 'referenceForceN')],
  ['only zero forces and no reference', plan(2, [0, 0])],
  ['a zero referenceForceN', replace(displacementPlan(), { referenceForceN: 0 })],
  ['a negative referenceForceN', replace(plan(), { referenceForceN: -1 })],
  ['a null referenceForceN', replace(plan(), { referenceForceN: null })],
];

interface Verdict { readonly ok: boolean; readonly message?: string; readonly referenceForceN?: number }
function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}
function pythonVerdicts(cases: readonly Value[]): Verdict[] {
  const code = [
    'import json, sys',
    'from solidFiniteEquilibrium import read_plan',
    'out = []',
    'for case in json.load(sys.stdin):',
    '    try:',
    '        plan = read_plan(case)',
    '        out.append({"ok": True, "referenceForceN": plan["referenceForceN"]})',
    '    except ValueError as error:',
    '        out.append({"ok": False, "message": str(error)})',
    'print(json.dumps(out))'].join('\n');
  const result = spawnSync('python', ['-B', '-X', 'utf8', '-c', code], { input: JSON.stringify(cases), encoding: 'utf8',
    timeout: 120_000, maxBuffer: 16_000_000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: dirname(fileURLToPath(entryUrl)) } });
  const detail = `exit=${String(result.status)}\n${result.error?.message ?? ''}\n${result.stderr}`;
  expect(result.error, detail).toBeUndefined();
  expect(result.status, detail).toBe(0);
  const verdicts: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(verdicts) || verdicts.length !== cases.length || !verdicts.every(isVerdict)) {
    throw new Error(`unexpected Python verdicts: ${detail}`);
  }
  return verdicts;
}
const accepts = (value: unknown): boolean => { try { readSolidFinitePlan(value); return true; } catch { return false; } };

describe('finite equilibrium plan reader', () => {
  it.each(accepted)('accepts %s', (_name, value) => {
    expect(JSON.parse(JSON.stringify(readSolidFinitePlan(value)))).toEqual(value);
  });
  it.each(refused)('refuses %s', (_name, value) => {
    expect(() => readSolidFinitePlan(value)).toThrow(/^finite-equilibrium-plan: /u);
  });
  it('agrees with the actual Python read_plan on every accepted and refused case (same JSON text)', () => {
    const cases = [...accepted, ...refused];
    const verdicts = pythonVerdicts(cases.map(([, value]) => value));
    const disagreements = cases.map(([name, value], index) => ({ name, python: verdicts[index], typescript: accepts(value) }))
      .filter(row => row.python.ok !== row.typescript);
    expect(disagreements).toEqual([]);
    expect(verdicts.slice(0, accepted.length).every(row => row.ok)).toBe(true);
    expect(verdicts.slice(accepted.length).every(row => !row.ok && /^finite-equilibrium: /u.test(row.message ?? ''))).toBe(true);
    expect(verdicts[0].referenceForceN).toBe(200);   // largest |force| of the 2-tet history is the native force scale
    expect(verdicts[2].referenceForceN).toBe(7);     // an explicit reference is kept even with nodal forces
  }, 125_000);
  it('refuses values that JSON cannot carry before any Python sees them', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => readSolidFinitePlan(loads({ node: 1, dof: 'x', valuesN: [100, bad] })))
        .toThrow('finite-equilibrium-plan: forcesN[0].valuesN[1] must be a finite number');
    }
    expect(() => readSolidFinitePlan(replace(plan(), { referenceForceN: undefined }))).toThrow('referenceForceN must be a finite number');
    const sparse: unknown[] = [];
    sparse[1] = 100;
    expect(() => readSolidFinitePlan(loads({ node: 1, dof: 'x', valuesN: sparse }))).toThrow('forcesN[0].valuesN[0] must be a finite number');
    expect(() => readSolidFinitePlan({ ...plan(), [Symbol('hidden')]: 1 })).toThrow('plan must have the fields');
    const inherited: unknown = Object.create(plan());
    expect(() => readSolidFinitePlan(inherited)).toThrow('plan must have the fields');
  });
  it('returns a deep-frozen copy that later caller mutations cannot reach', () => {
    const nodes = [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]], valuesN = [100, 200], youngMPa = { ...MATERIAL };
    const value = replace(plan(), { nodes, material: youngMPa, forcesN: [{ node: 1, dof: 'x', valuesN }, { node: 4, dof: 'x', valuesN: [1, 2] }] });
    const copy = readSolidFinitePlan(value);
    valuesN[0] = 1;
    nodes[1][0] = 99;
    youngMPa.youngMPa = 1;
    expect(copy.forcesN[0].valuesN).toEqual([100, 200]);
    expect(copy.nodes[1]).toEqual([L, 0, 0]);
    expect(copy.material.youngMPa).toBe(200000);
    expect([copy, copy.nodes, copy.nodes[0], copy.elements, copy.elements[1], copy.material, copy.prescribedMm, copy.prescribedMm[0],
      copy.prescribedMm[0].valuesMm, copy.forcesN, copy.forcesN[0], copy.forcesN[0].valuesN].every(part => Object.isFrozen(part))).toBe(true);
    const negativeZero = readSolidFinitePlan(replace(plan(), { nodes: [[-0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L], [L, L, L]] }));
    expect(Object.is(negativeZero.nodes[0][0], 0)).toBe(true);
  });
  it('reads each caller field once, so a changing getter cannot make the copy differ from what was validated', () => {
    let reads = 0;
    const value = { ...plan(), get steps(): number { reads += 1; return reads === 1 ? 2 : 0; } };
    expect(readSolidFinitePlan(value).steps).toBe(2);
    expect(reads).toBe(1);
  });
});
