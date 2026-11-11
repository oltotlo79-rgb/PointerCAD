import { describe, expect, it } from 'vitest';
import { readSolidPlasticPlan, SOLID_PLASTIC_PLAN_SCHEMA, type SolidPlasticPlan } from './solidPlastic.js';

/** PROVISIONAL (authored, unexecuted). Benchmark constants stated for this test only, not a material specification. */
function plan(): SolidPlasticPlan {
  return { schema: SOLID_PLASTIC_PLAN_SCHEMA, units: 'N-mm-MPa',
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [[0, 1, 2, 3]],
    material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
      source: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' } },
    prescribedMm: [
      { node: 0, dof: 'x', valueMm: 0 }, { node: 0, dof: 'y', valueMm: 0 }, { node: 0, dof: 'z', valueMm: 0 },
      { node: 1, dof: 'x', valueMm: 0 }, { node: 1, dof: 'y', valueMm: 0.5 }, { node: 1, dof: 'z', valueMm: 0 },
      { node: 2, dof: 'x', valueMm: 0.5 }, { node: 2, dof: 'y', valueMm: 0 }, { node: 2, dof: 'z', valueMm: 0 },
      { node: 3, dof: 'x', valueMm: 0 }, { node: 3, dof: 'y', valueMm: 0 }],
    forcesN: [], loadFactor: [0, 3e-3, 0], stepsPerSegment: 3 };
}
function change(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...plan(), ...patch };
}

describe('candidate3 review regressions (provisional, unexecuted)', () => {
  const material = () => plan().material;
  const withReference = (reference: string) => change({ material: { ...material(),
    source: { kind: 'user-supplied', reference } } });
  it('counts the reference in code points, not UTF-16 units', () => {
    const astral = String.fromCodePoint(0x1d465);
    expect(() => readSolidPlasticPlan(withReference(astral.repeat(500)))).not.toThrow();
    expect(() => readSolidPlasticPlan(withReference(astral.repeat(501)))).toThrow('material.source.reference');
  });
  it('treats only the explicit whitespace set as empty, identically to the Python mirror', () => {
    for (const point of [0xa0, 0xfeff, 0x3000, 0x2028]) {
      expect(() => readSolidPlasticPlan(withReference(String.fromCodePoint(point).repeat(3))), point.toString(16))
        .toThrow('material.source.reference');
    }
    expect(() => readSolidPlasticPlan(withReference(String.fromCodePoint(0x3000) + 'a'))).not.toThrow();
  });
  it('refuses a prescription whose product with a knot overflows, and keeps the largest finite product', () => {
    const scaled = (valueMm: number, knot: number) => change({
      prescribedMm: plan().prescribedMm.map((p, index) => index === 4 ? { ...p, valueMm } : p), loadFactor: [0, knot] });
    expect(() => readSolidPlasticPlan(scaled(1e300, 1e10)))
      .toThrow('prescribedMm[4].valueMm times a load-factor knot must be finite');
    expect(() => readSolidPlasticPlan(scaled(1e300, 1e8))).not.toThrow();
  });
});

describe('solid plastic plan reader (provisional)', () => {
  it('accepts the simple-shear plan of proof-r2 unchanged', () => {
    expect(readSolidPlasticPlan(plan())).toEqual(plan());
  });

  it('rejects invalid material, source, topology, loading and step data with a stated reason', () => {
    const material = plan().material;
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['not an object', null, 'plan must be an object'],
      ['extra field', change({ note: 1 }), 'must have exactly the fields'],
      ['wrong schema', change({ schema: 'pointercad-oofem-solid-plastic-plan/2' }), 'unsupported plan schema'],
      ['wrong units', change({ units: 'N-m-Pa' }), 'units must be N-mm-MPa'],
      ['NaN coordinate', change({ nodes: [[Number.NaN, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] }), 'nodes[0][0] must be a finite number'],
      ['repeated element node', change({ elements: [[0, 1, 1, 3]] }), 'four distinct nodes'],
      ['node out of range', change({ elements: [[0, 1, 2, 4]] }), 'elements[0][3] must be a node index'],
      ['Poisson 0.5', change({ material: { ...material, poisson: 0.5 } }), 'material.poisson must be in [0, 0.5)'],
      ['yield above E', change({ material: { ...material, yieldStressMPa: 200000 } }), 'yieldStressMPa must be below'],
      ['softening', change({ material: { ...material, hardeningModulusMPa: -1 } }), 'softening is not supported'],
      ['grade-name source', change({ material: { ...material, source: { kind: 'grade', reference: 'SS400' } } }),
        'material.source.kind must be user-supplied'],
      ['empty reference', change({ material: { ...material, source: { kind: 'user-supplied', reference: ' ' } } }),
        'material.source.reference must be a non-empty statement'],
      ['bad direction', change({ prescribedMm: [{ node: 0, dof: 'w', valueMm: 0 }] }), 'prescribedMm[0].dof must be x, y or z'],
      ['repeated prescription', change({ prescribedMm: [{ node: 0, dof: 'x', valueMm: 0 }, { node: 0, dof: 'x', valueMm: 1 }] }),
        'repeats a node direction'],
      ['force on prescribed direction', change({ forcesN: [{ node: 0, dof: 'x', forceN: 1 }] }), 'acts on a prescribed direction'],
      ['nothing free', change({ prescribedMm: [...plan().prescribedMm, { node: 3, dof: 'z', valueMm: 0 }] }),
        'at least one degree of freedom must stay free'],
      ['first knot not 0', change({ loadFactor: [1e-3, 0] }), 'the first load-factor knot must be 0'],
      ['repeated knot', change({ loadFactor: [0, 1e-3, 1e-3] }), 'consecutive load-factor knots must differ'],
      ['zero steps', change({ stepsPerSegment: 0 }), 'stepsPerSegment must be an integer from 1 to 200'],
      ['too many steps', change({ loadFactor: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], stepsPerSegment: 200 }), 'at most 2000 steps'],
      // 11 recorded segments x (2000 nodes + 1 element) = 22011 > 20000; every other field stays valid.
      ['result size', change({ nodes: Array.from({ length: 2000 }, (_, i) => [i, 0, 0]),
        loadFactor: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], stepsPerSegment: 1 }),
      'at most 20000 recorded node and element states'],
    ];
    for (const [label, value, message] of cases) {
      expect(() => readSolidPlasticPlan(value), label).toThrow(message);
    }
  });
});
