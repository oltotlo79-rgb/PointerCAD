import { describe, expect, it } from 'vitest';
import { SOLID_PLASTIC_PLAN_SCHEMA, type SolidPlasticPlan } from './solidPlastic.js';
import { SOLID_PLASTIC_INPUT_SCHEMA, solidPlasticInputSha256, translateSolidPlastic } from './solidPlasticTranslation.js';

/** PROVISIONAL (authored, unexecuted). Benchmark constants stated for this test only, not a material specification. */
function plan(): SolidPlasticPlan {
  return { schema: SOLID_PLASTIC_PLAN_SCHEMA, units: 'N-mm-MPa',
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [[0, 1, 2, 3]],
    material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
      source: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' } },
    prescribedMm: [{ node: 0, dof: 'x', valueMm: 0 }, { node: 0, dof: 'y', valueMm: 0 }, { node: 0, dof: 'z', valueMm: 0 },
      { node: 1, dof: 'x', valueMm: 1 }],
    forcesN: [], loadFactor: [0, 1e-3], stepsPerSegment: 1 };
}
function input(revision = 3, value: SolidPlasticPlan = plan()) {
  return { schema: SOLID_PLASTIC_INPUT_SCHEMA, source: { documentId: 'solid-plastic-fixture', revision }, plan: value };
}

describe('solid plastic input binding (provisional)', () => {
  it('copies a valid input so later caller mutation cannot change it', () => {
    const nodes = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const translated = translateSolidPlastic({ ...input(), plan: { ...plan(), nodes } });
    nodes[1][0] = 9;
    expect(translated.input.plan.nodes[1]).toEqual([1, 0, 0]);
    expect(translated.input.source).toEqual({ documentId: 'solid-plastic-fixture', revision: 3 });
  });

  it('rejects a wrong schema, an invalid source and an invalid plan', () => {
    expect(() => translateSolidPlastic({ ...input(), schema: 'pointercad-solid-plastic/2' })).toThrow('unsupported input schema');
    expect(() => translateSolidPlastic({ ...input(), source: { documentId: '', revision: 3 } })).toThrow('source.documentId');
    expect(() => translateSolidPlastic(input(-1))).toThrow('source.revision must be a non-negative integer');
    expect(() => translateSolidPlastic(input(3, { ...plan(), stepsPerSegment: 0 }))).toThrow('stepsPerSegment');
  });

  it('binds the digest to revision and material, so a stale or changed request differs', async () => {
    const base = await solidPlasticInputSha256(input());
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(await solidPlasticInputSha256(input())).toBe(base);
    expect(await solidPlasticInputSha256(input(4))).not.toBe(base);
    const harder = { ...plan(), material: { ...plan().material, hardeningModulusMPa: 3000 } };
    expect(await solidPlasticInputSha256(input(3, harder))).not.toBe(base);
  });
});
