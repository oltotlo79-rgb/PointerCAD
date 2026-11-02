import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SOLID_PLASTIC_INPUT_SCHEMA } from './solidPlasticTranslation.js';
import { SOLID_FINITE_PLAN_SCHEMA } from './solidFinitePlan.js';
import { SOLID_FINITE_INPUT_SCHEMA, solidFiniteInputSha256, translateSolidFinite } from './solidFiniteTranslation.js';

const L = 10;
type Value = Record<string, unknown>;
/** One tetrahedron, 9 zero displacements, an x force history at node 1 (keys in the canonical order). */
function plan(): Value {
  return { schema: SOLID_FINITE_PLAN_SCHEMA, units: 'N-mm-MPa', nodes: [[0, 0, 0], [L, 0, 0], [0, L, 0], [0, 0, L]],
    elements: [[0, 1, 2, 3]], material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 }, steps: 2,
    prescribedMm: [[0, 'x'], [0, 'y'], [0, 'z'], [1, 'y'], [1, 'z'], [2, 'x'], [2, 'z'], [3, 'x'], [3, 'y']]
      .map(([node, dof]) => ({ node, dof, valuesMm: [0, 0] })),
    forcesN: [{ node: 1, dof: 'x', valuesN: [100, 200] }] };
}
function input(revision = 3, planValue: Value = plan()): Value {
  return { schema: SOLID_FINITE_INPUT_SCHEMA, source: { documentId: 'doc', revision }, plan: planValue };
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('finite equilibrium input envelope', () => {
  it('copies a valid input and binds it to its document revision and canonical JSON digest', async () => {
    const { input: copy, plan: copiedPlan } = translateSolidFinite(input());
    expect(copy).toEqual(input());
    expect(copiedPlan).toBe(copy.plan);
    const canonical = JSON.stringify(input());
    expect(JSON.stringify(copy)).toBe(canonical);
    expect(await solidFiniteInputSha256(input())).toBe(sha256(canonical));    // independent Node digest of the same bytes
  });
  it('is distinct from the small-strain envelope and keeps its own literal schema', () => {
    expect(SOLID_FINITE_INPUT_SCHEMA).not.toBe(SOLID_PLASTIC_INPUT_SCHEMA);
    expect(() => translateSolidFinite({ ...input(), schema: SOLID_PLASTIC_INPUT_SCHEMA })).toThrow('finite-equilibrium-input: unsupported input schema');
    expect(() => translateSolidFinite({ ...input(), plan: { ...plan(), schema: 'pointercad-solid-plastic-plan/1' } }))
      .toThrow('finite-equilibrium-plan: unsupported plan schema');
  });
  it.each([
    ['an extra envelope field', { ...input(), extra: true }, 'must have exactly the fields schema, source, plan'],
    ['a missing plan', { schema: SOLID_FINITE_INPUT_SCHEMA, source: { documentId: 'doc', revision: 3 } }, 'must have exactly the fields'],
    ['an extra source field', { ...input(), source: { documentId: 'doc', revision: 3, generation: 1 } }, 'source must have exactly'],
    ['an empty document id', { ...input(), source: { documentId: '', revision: 3 } }, 'source.documentId must have 1 to 256 characters'],
    ['a 257-character document id', { ...input(), source: { documentId: 'd'.repeat(257), revision: 3 } }, 'source.documentId'],
    ['a negative revision', input(-1), 'source.revision must be a non-negative integer'],
    ['a fractional revision', input(1.5), 'source.revision'],
    ['an unsafe revision', input(2 ** 53), 'source.revision'],
    ['an invalid plan', input(3, { ...plan(), steps: 0 }), 'finite-equilibrium-plan: steps must be an integer from 1 to 200'],
    ['an array', [input()], '$ must be an object'],
  ])('refuses %s', (_name, value, message) => {
    expect(() => translateSolidFinite(value)).toThrow(message);
  });
  it('isolates the copy from later caller mutations and freezes it', () => {
    const value = input(), source = { documentId: 'doc', revision: 3 };
    const owned = { ...value, source };
    const { input: copy } = translateSolidFinite(owned);
    source.revision = 4;
    source.documentId = 'other';
    expect(copy.source).toEqual({ documentId: 'doc', revision: 3 });
    expect(Object.isFrozen(copy) && Object.isFrozen(copy.source) && Object.isFrozen(copy.plan)).toBe(true);
    expect(() => { Object.assign(copy.source, { revision: 9 }); }).toThrow(TypeError);
  });
  it('hashes the validated copy: caller key order is irrelevant, every value and the revision are bound', async () => {
    const reference = await solidFiniteInputSha256(input());
    const p = plan();
    const reordered = { plan: Object.fromEntries(Object.entries(p).reverse()), source: { revision: 3, documentId: 'doc' }, schema: SOLID_FINITE_INPUT_SCHEMA };
    expect(await solidFiniteInputSha256(reordered)).toBe(reference);
    expect(await solidFiniteInputSha256(input(4))).not.toBe(reference);
    expect(await solidFiniteInputSha256(input(3, { ...plan(), forcesN: [{ node: 1, dof: 'x', valuesN: [100, 200.00000000000003] }] })))
      .not.toBe(reference);
    expect(await solidFiniteInputSha256(input(3, { ...plan(), referenceForceN: 200 }))).not.toBe(reference);
    expect(await solidFiniteInputSha256({ ...input(), source: { documentId: 'doc2', revision: 3 } })).not.toBe(reference);
    await expect(solidFiniteInputSha256({ ...input(), extra: 1 })).rejects.toThrow('finite-equilibrium-input');
  });
});
