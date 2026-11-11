import { describe, expect, it } from 'vitest';
import { bucklingFixture } from './buckling.testSupport.js';
import { translateBeamFrictionContact, type BeamFrictionContactInput } from './frictionContactTranslation.js';

/** Two CAD nodes, one member. Independent loads below are N and Nmm (or Nm). */
function fixture(segments = 1, millimetres = true): BeamFrictionContactInput {
  const base = bucklingFixture({ segments, millimetres });
  const moment = millimetres ? 1000 : 1;
  return {
    schema: 'pointercad-beam-friction-contact/1', geometry: base.geometry, supports: base.supports,
    contacts: [{ kind: 'node-plane', id: 'floor', nodeId: 'node-1', normal: [0, 0, 2], gapM: 0.001 }],
    friction: { floor: 0.3 },
    stepLoads: [
      [{ id: 'first', kind: 'nodal', nodeId: 'node-1', force: [10, -20, 30], moment: [4 * moment, -5 * moment, 6 * moment] }],
      [{ id: 'second-a', kind: 'nodal', nodeId: 'node-0', force: [-7, 8, -9], moment: [0.01 * moment, -0.02 * moment, 0.03 * moment] },
        { id: 'second-b', kind: 'nodal', nodeId: 'node-1', force: [-1, 2, -3], moment: [-0.4 * moment, 0.5 * moment, -0.6 * moment] }],
    ],
  };
}

// Written from the nodal input and mm -> m conversion, never from translator output.
const FIRST = [0, 0, 0, 0, 0, 0, 10, -20, 30, 4, -5, 6];
const SECOND = [-7, 8, -9, 0.01, -0.02, 0.03, -1, 2, -3, -0.4, 0.5, -0.6];

describe('internal friction step input translation', () => {
  it('keeps independent full six-DOF steps, signs, original identities and SI units', () => {
    const result = translateBeamFrictionContact(fixture());
    expect(result.input.schema).toBe('pointercad-beam-friction-contact/1');
    expect(result.nodeIds).toEqual(['node-0', 'node-1']);
    expect(result.plan.nodes.map(node => node.number)).toEqual([1, 2]);
    expect(result.plan.nodes.map(node => node.positionM)).toEqual([[0, 0, 0], [1, 0, 0]]);
    expect(result.plan.nodes.map(node => node.restrained)).toEqual([
      [true, true, true, true, true, true], [false, false, false, false, false, false],
    ]);
    expect(result.plan.contacts).toEqual([{ id: 'floor', kind: 'node-plane', node: 2, normal: [0, 0, 1], gapM: 0.001 }]);
    expect(result.plan.loadFactors).toEqual([1]);
    expect(result.momentLengthM).toBe(1);
    expect(result.friction).toEqual({ floor: 0.3 });
    expect(result.loads).toEqual([FIRST, SECOND]);
    expect(result.plan.nodes.map(node => [...node.load])).toEqual([FIRST.slice(0, 6), FIRST.slice(6)]);
  });

  it('keeps execution order when the nonproportional path is reversed', () => {
    const input = fixture();
    expect(translateBeamFrictionContact({ ...input, stepLoads: [...input.stepLoads].reverse() }).loads).toEqual([SECOND, FIRST]);
  });

  it('keeps an exact zero middle unloading step between load and reverse load', () => {
    const input = fixture();
    const first = input.stepLoads[0][0];
    const zero = { ...first, force: [0, 0, 0], moment: [0, 0, 0] };
    const reverse = { ...first, force: [-10, 20, -30], moment: [-4000, 5000, -6000] };
    const result = translateBeamFrictionContact({ ...input, stepLoads: [[first], [zero], [reverse]] });
    expect(result.loads).toEqual([FIRST, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, -10, 20, -30, -4, 5, -6]]);
    expect(result.input.stepLoads[1]).toEqual([zero]);
  });

  it('keeps a leading zero step and plan without a hidden assembly preload', () => {
    const input = fixture();
    const zero = { ...input.stepLoads[0][0], force: [0, 0, 0], moment: [0, 0, 0] };
    const result = translateBeamFrictionContact({ ...input, stepLoads: [[zero], input.stepLoads[0]] });
    expect(result.loads).toEqual([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], FIRST]);
    expect(result.plan.nodes.map(node => node.load)).toEqual([[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]);
  });

  it('preserves a stage whose explicit same-node loads cancel exactly', () => {
    const input = fixture();
    const first = input.stepLoads[0][0];
    const reverse = { ...first, id: 'reverse', force: [-10, 20, -30], moment: [-4000, 5000, -6000] };
    const result = translateBeamFrictionContact({ ...input, stepLoads: [input.stepLoads[0], [first, reverse]] });
    expect(result.loads[1]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result.input.stepLoads[1]).toHaveLength(2);
  });

  it.each(['NaN', 'unknown node', 'duplicate id'])('refuses %s in a zero middle stage', issue => {
    const input = fixture();
    const zero = { ...input.stepLoads[0][0], force: [0, 0, 0], moment: [0, 0, 0] };
    const bad = issue === 'NaN' ? [{ ...zero, force: [NaN, 0, 0] }]
      : issue === 'unknown node' ? [{ ...zero, nodeId: 'missing' }] : [zero, zero];
    expect(() => translateBeamFrictionContact({ ...input, stepLoads: [input.stepLoads[0], bad] })).toThrow();
  });

  it('converts metre and millimetre requests to the same force/moment vectors', () => {
    expect(translateBeamFrictionContact(fixture(1, false)).loads).toEqual([FIRST, SECOND]);
    expect(translateBeamFrictionContact(fixture(1, true)).loads).toEqual([FIRST, SECOND]);
  });

  it('retains explicit mu zero rather than choosing a default', () => {
    const result = translateBeamFrictionContact({ ...fixture(), friction: { floor: 0 } });
    expect(result.friction).toEqual({ floor: 0 });
    expect(result.input.friction).toEqual({ floor: 0 });
  });

  it('gives every added refinement node six zero loads without inventing CAD ids', () => {
    const result = translateBeamFrictionContact(fixture(3));
    expect(result.nodeIds).toEqual(['node-0', 'node-1']);
    expect(result.plan.nodes.map(node => node.number)).toEqual([1, 2, 3, 4]);
    expect(result.loads).toEqual([[...FIRST, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [...SECOND, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
    expect(result.plan.members).toHaveLength(3);
    expect(result.momentLengthM).toBeCloseTo(1 / 3, 15);
  });

  it('sums multiple loads on a node using the existing translator', () => {
    const input = fixture();
    const load = input.stepLoads[0][0];
    const result = translateBeamFrictionContact({ ...input, stepLoads: [[load, { ...load, id: 'another' }]] });
    expect(result.loads).toEqual([[0, 0, 0, 0, 0, 0, 20, -40, 60, 8, -10, 12]]);
  });

  it('accepts one and exactly 32 steps, including repeated/reversed stages', () => {
    const input = fixture();
    expect(translateBeamFrictionContact({ ...input, stepLoads: [input.stepLoads[0]] }).loads).toEqual([FIRST]);
    const stages = Array.from({ length: 32 }, (_, index) => input.stepLoads[index % 2]);
    expect(translateBeamFrictionContact({ ...input, stepLoads: stages }).loads)
      .toEqual(Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? FIRST : SECOND));
  });

  it('owns canonical input and output after nested caller data is changed', () => {
    const input = fixture();
    const original = JSON.stringify(input);
    const result = translateBeamFrictionContact(input);
    expect(JSON.stringify(input)).toBe(original);
    const snapshot = JSON.stringify(result);
    Object.assign(input.geometry.nodes[1], { position: [99, 88, 77] });
    Object.assign(input.supports[0].restrained, { 0: false });
    Object.assign(input.contacts[0], { normal: [1, 0, 0], gapM: 9 });
    Object.assign(input.friction, { floor: 9 });
    Object.assign(input.stepLoads[0][0].force, { 0: 999 });
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(result.input.geometry).not.toBe(input.geometry);
    expect(result.input.stepLoads[0][0]).not.toBe(input.stepLoads[0][0]);
    expect(result.input.contacts[0].normal).toEqual([0, 0, 1]);
  });

  it('maps every contact explicitly even if coefficient keys arrive in another order', () => {
    const input = fixture();
    const contacts = [...input.contacts, { kind: 'node-plane', id: 'side', nodeId: 'node-1', normal: [0, 1, 0], gapM: 0 }];
    const result = translateBeamFrictionContact({ ...input, contacts, friction: { side: 0.1, floor: 0 } });
    expect(result.friction).toEqual({ floor: 0, side: 0.1 });
  });

  const input = fixture();
  const missing = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'friction'));
  const bad: readonly [string, unknown][] = [
    ['missing top-level field', missing], ['unknown top-level field', { ...input, solver: 'newton' }],
    ['other schema', { ...input, schema: 'pointercad-beam-contact/1' }],
    ['no stages', { ...input, stepLoads: [] }], ['33 stages', { ...input, stepLoads: Array.from({ length: 33 }, () => input.stepLoads[0]) }],
    ['empty stage', { ...input, stepLoads: [[]] }],
    ['missing mu', { ...input, friction: {} }], ['extra mu id', { ...input, friction: { floor: 0.3, other: 0 } }],
    ['wrong mu id', { ...input, friction: { other: 0.3 } }], ['negative mu', { ...input, friction: { floor: -0.1 } }],
    ['NaN mu', { ...input, friction: { floor: Number.NaN } }], ['infinite mu', { ...input, friction: { floor: Infinity } }],
    ['string mu', { ...input, friction: { floor: '0.3' } }], ['boolean mu', { ...input, friction: { floor: true } }],
    ['mu array', { ...input, friction: [0.3] }],
    ['duplicate contact id', { ...input, contacts: [...input.contacts, { ...input.contacts[0], normal: [1, 0, 0] }] }],
    ['extra contact field', { ...input, contacts: [{ ...input.contacts[0], mu: 0.3 }] }],
    ['missing contact normal', { ...input, contacts: [{ kind: 'node-plane', id: 'floor', nodeId: 'node-1', gapM: 0 }] }],
    ['unknown load node', { ...input, stepLoads: [[{ ...input.stepLoads[0][0], nodeId: 'missing' }]] }],
    ['duplicate load id', { ...input, stepLoads: [[input.stepLoads[0][0], input.stepLoads[0][0]]] }],
    ['extra load field', { ...input, stepLoads: [[{ ...input.stepLoads[0][0], scale: 2 }]] }],
    ['NaN load', { ...input, stepLoads: [[{ ...input.stepLoads[0][0], force: [NaN, 0, 0] }]] }],
    ['infinite moment', { ...input, stepLoads: [[{ ...input.stepLoads[0][0], moment: [0, Infinity, 0] }]] }],
    ['later invalid stage', { ...input, stepLoads: [input.stepLoads[0], [{ ...input.stepLoads[1][0], nodeId: 'missing' }]] }],
    ['all-zero path explicitly unsupported', { ...input, stepLoads: [[{ ...input.stepLoads[0][0], force: [0, 0, 0], moment: [0, 0, 0] }]] }],
    ['unknown geometry field', { ...input, geometry: { ...input.geometry, extra: 1 } }],
    ['missing supports', { ...input, supports: [] }],
    ['unknown support field', { ...input, supports: [{ ...input.supports[0], extra: 1 }] }],
  ];
  it.each(bad)('rejects %s before any runtime dispatch', (_label, value) => {
    expect(() => translateBeamFrictionContact(value)).toThrow();
  });

  it.each(['steps', 'stage', 'force', 'moment', 'contacts', 'normal', 'supports', 'restraints', 'geometry nodes'])(
    'rejects a sparse array in %s', target => {
    const input = fixture();
    const hole = new Array<unknown>(3); hole[0] = 0; hole[2] = 0;
    const changes: Record<string, Record<string, unknown>> = {
      steps: { stepLoads: new Array<unknown>(1) }, stage: { stepLoads: [new Array<unknown>(1)] },
      force: { stepLoads: [[{ ...input.stepLoads[0][0], force: hole }]] },
      moment: { stepLoads: [[{ ...input.stepLoads[0][0], moment: hole }]] },
      contacts: { contacts: new Array<unknown>(1) }, normal: { contacts: [{ ...input.contacts[0], normal: hole }] },
      supports: { supports: new Array<unknown>(1) }, restraints: { supports: [{ ...input.supports[0], restrained: new Array<unknown>(6) }] },
      'geometry nodes': { geometry: { ...input.geometry, nodes: new Array<unknown>(2) } },
    };
    expect(() => translateBeamFrictionContact({ ...input, ...changes[target] })).toThrow();
    });
});
