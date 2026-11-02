import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bucklingFixture } from './buckling.testSupport.js';
import { decodeFrictionContact, frictionContactResultMatches } from './frictionContactResults.js';
import { translateBeamFrictionContact, type BeamFrictionContactInput } from './frictionContactTranslation.js';

const hash = 'a'.repeat(64);
const options = { solver: 'newton' as const, iterationLimit: 64 };
function input(): BeamFrictionContactInput {
  const base = bucklingFixture({ segments: 1, millimetres: false });
  const load = (id: string, x: number) => ({ id, kind: 'nodal' as const, nodeId: 'node-1',
    force: [x, 0, 0] as const, moment: [0, 0, 0] as const });
  return { schema: 'pointercad-beam-friction-contact/1', geometry: base.geometry, supports: base.supports,
    contacts: [{ kind: 'node-plane', id: 'floor', nodeId: 'node-1', normal: [0, 0, 1], gapM: 0 }],
    friction: { floor: 0.3 }, stepLoads: [[load('a', 2)], [load('b', 3)], [load('c', 0)], [load('d', -3)]] };
}
/** Hand-written contact history: N=10, mu=.3; traction -2 stick, -3 slip, open, +3 reverse.
 * Open increment -1e-7 is reported but excluded from accumulated slip and path. Work = -t dot ds.
 * This is a reader fixture, not a solve or an independent physical proof of the result. */
function raw() {
  const states = [
    { state: 'stick', n: 10, tx: -2, ux: 0, ds: 0, accum: 0, path: 0, work: 0 },
    { state: 'slip', n: 10, tx: -3, ux: 1e-7, ds: 1e-7, accum: 1e-7, path: 1e-7, work: 3e-7 },
    { state: 'open', n: 0, tx: 0, ux: 0, ds: -1e-7, accum: 1e-7, path: 1e-7, work: 3e-7 },
    { state: 'slip', n: 10, tx: 3, ux: -1e-7, ds: -1e-7, accum: 0, path: 2e-7, work: 6e-7 },
  ];
  return { kind: 'pointercad-internal-friction-contact-candidate', solver: 'newton', iterationLimit: 64,
    freeDofs: 6, states: states.map((c, step) => ({ step, iterations: 2, forceScaleN: 10, gapScaleM: 1e-5,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, frictionConeExcess: 0, slipLawResidual: 0,
      nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
        { number: 2, displacementM: [c.ux, 0, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'floor', state: c.state, frictionCoefficient: 0.3, normalReactionN: c.n, gapM: 0,
        frictionForceN: [c.tx, 0, 0], slipIncrementM: [c.ds, 0, 0], accumulatedSlipM: [c.accum, 0, 0],
        slipPathLengthM: c.path, dissipatedWorkJ: c.work }] })) };
}
const clone = () => structuredClone(raw());
describe('friction contact internal result reader', () => {
  it('binds the four independent steps and preserves open-motion history', () => {
    const source = input(), native = raw();
    const result = decodeFrictionContact(native, source, hash, options);
    expect(result.states.map(s => s.contacts[0].state)).toEqual(['stick', 'slip', 'open', 'slip']);
    expect(result.states.map(s => s.contacts[0].accumulatedSlipM[0])).toEqual([0, 1e-7, 1e-7, 0]);
    expect(result.states.map(s => s.contacts[0].slipPathLengthM)).toEqual([0, 1e-7, 1e-7, 2e-7]);
    expect(result.states[3].contacts[0].dissipatedWorkJ).toBe(6e-7);
    expect(frictionContactResultMatches(result, source, hash, options)).toBe(true);
    const retained = JSON.stringify(result);
    native.states[1].contacts[0].frictionForceN[0] = 900;
    Object.assign(source.friction, { floor: 4 });
    expect(JSON.stringify(result)).toBe(retained);
  });
  it('rejects stale digest, revision, source, load, and modified result', () => {
    const source = input(), result = decodeFrictionContact(raw(), source, hash, options);
    expect(frictionContactResultMatches(result, source, 'b'.repeat(64), options)).toBe(false);
    expect(frictionContactResultMatches(result, { ...source, geometry: { ...source.geometry,
      revision: source.geometry.revision + 1 } }, hash, options)).toBe(false);
    expect(frictionContactResultMatches(result, { ...source, geometry: { ...source.geometry,
      source: { ...source.geometry.source, documentId: 'foreign' } } }, hash, options)).toBe(false);
    expect(frictionContactResultMatches({ ...result, freeDofs: 7 }, source, hash, options)).toBe(false);
    expect(frictionContactResultMatches(result, { ...source, stepLoads: [...source.stepLoads].reverse() }, hash, options)).toBe(false);
    const ids = [...result.nodeIds]; Reflect.deleteProperty(ids, 0); Object.assign(ids, { extra: 'node-0' });
    expect(frictionContactResultMatches({ ...result, nodeIds: ids }, source, hash, options)).toBe(false);
  });
  it('rejects structural state and coefficient combinations the core cannot emit', () => {
    const closed = clone(); closed.states[0].contacts[0].state = 'closed';
    expect(() => decodeFrictionContact(closed, input(), hash, options)).toThrow('state incompatible');
    const zero = { ...input(), friction: { floor: 0 } };
    const bad = clone(); for (const row of bad.states) row.contacts[0].frictionCoefficient = 0;
    expect(() => decodeFrictionContact(bad, zero, hash, options)).toThrow('state incompatible');
  });
  it.each(['kind', 'solver', 'iterationLimit', 'freeDofs', 'states'])('rejects missing root field %s', key => {
    const value = Object.fromEntries(Object.entries(raw()).filter(([name]) => name !== key));
    expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
  });
  it.each(['step', 'iterations', 'nodes', 'contacts', 'forceScaleN', 'gapScaleM', 'equilibriumResidual',
    'penetration', 'tension', 'complementarity', 'frictionConeExcess', 'slipLawResidual'])('rejects missing step field %s', key => {
    const value = clone();
    Reflect.deleteProperty(value.states[0], key);
    expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
  });
  it.each(['id', 'state', 'frictionCoefficient', 'normalReactionN', 'gapM', 'frictionForceN', 'slipIncrementM',
    'accumulatedSlipM', 'slipPathLengthM', 'dissipatedWorkJ'])('rejects missing contact field %s', key => {
    const value = clone();
    Reflect.deleteProperty(value.states[0].contacts[0], key);
    expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
  });
  it.each(['equilibriumResidual', 'penetration', 'tension', 'complementarity', 'frictionConeExcess', 'slipLawResidual'] as const)(
    'rejects nonfinite and above-core-limit %s', key => {
      for (const number of [NaN, Infinity, -Infinity, 1.01e-9]) {
        const value = clone(); value.states[0][key] = number;
        expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
      }
    });
  it.each(['number', 'displacementM', 'rotationRad'])('rejects missing node field %s', key => {
    const value = clone(); Reflect.deleteProperty(value.states[0].nodes[0], key);
    expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
  });
  it.each(['normalReactionN', 'gapM', 'slipPathLengthM', 'dissipatedWorkJ'] as const)(
    'rejects nonfinite contact scalar %s', key => {
      for (const number of [NaN, Infinity, -Infinity]) {
        const value = clone(); value.states[0].contacts[0][key] = number;
        expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
      }
    });
  it.each(['frictionForceN', 'slipIncrementM', 'accumulatedSlipM'] as const)(
    'rejects nonfinite contact vector %s', key => {
      for (const number of [NaN, Infinity, -Infinity]) {
        const value = clone(); value.states[0].contacts[0][key][0] = number;
        expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
      }
    });
  it.each(['forceScaleN', 'gapScaleM'] as const)('rejects nonfinite reporting scale %s', key => {
    for (const number of [NaN, Infinity, -Infinity]) {
      const value = clone(); value.states[0][key] = number;
      expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
    }
  });
  it.each(['displacementM', 'rotationRad'] as const)('rejects nonfinite node vector %s', key => {
    for (const number of [NaN, Infinity, -Infinity]) {
      const value = clone(); value.states[0].nodes[0][key][0] = number;
      expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
    }
  });
  it.each(['step', 'iterations'] as const)('rejects nonfinite step integer %s', key => {
    for (const number of [NaN, Infinity, -Infinity]) {
      const value = clone(); value.states[0][key] = number;
      expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
    }
  });
  it('rejects nonfinite coefficient, free DOFs, node number and iteration budget', () => {
    for (const number of [NaN, Infinity, -Infinity]) {
      const a = clone(); a.states[0].contacts[0].frictionCoefficient = number;
      const b = clone(); b.freeDofs = number;
      const c = clone(); c.states[0].nodes[0].number = number;
      const d = clone(); d.iterationLimit = number;
      for (const value of [a, b, c, d]) expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
    }
  });
  it.each([
    ['extra root', (v: ReturnType<typeof raw>) => Object.assign(v, { extra: 1 })],
    ['extra step', (v: ReturnType<typeof raw>) => Object.assign(v.states[0], { extra: 1 })],
    ['extra node', (v: ReturnType<typeof raw>) => Object.assign(v.states[0].nodes[0], { extra: 1 })],
    ['extra contact', (v: ReturnType<typeof raw>) => Object.assign(v.states[0].contacts[0], { extra: 1 })],
    ['wrong order', (v: ReturnType<typeof raw>) => { v.states[0].step = 1; }],
    ['wrong node', (v: ReturnType<typeof raw>) => { v.states[0].nodes[0].number = 2; }],
    ['fixed DOF', (v: ReturnType<typeof raw>) => { v.states[0].nodes[0].rotationRad[0] = 1; }],
    ['wrong contact', (v: ReturnType<typeof raw>) => { v.states[0].contacts[0].id = 'wrong'; }],
    ['wrong mu', (v: ReturnType<typeof raw>) => { v.states[0].contacts[0].frictionCoefficient = 0; }],
    ['wrong solver', (v: ReturnType<typeof raw>) => { v.solver = 'nsgs'; }],
    ['wrong budget', (v: ReturnType<typeof raw>) => { v.iterationLimit = 12; }],
    ['iterations exceed budget', (v: ReturnType<typeof raw>) => { v.states[0].iterations = 65; }],
    ['sparse state', (v: ReturnType<typeof raw>) => { Reflect.deleteProperty(v.states, 1); }],
    ['sparse vector', (v: ReturnType<typeof raw>) => { Reflect.deleteProperty(v.states[0].nodes[0].displacementM, 1); }],
    ['missing state', (v: ReturnType<typeof raw>) => { v.states.pop(); }],
    ['bad accumulated', (v: ReturnType<typeof raw>) => { v.states[2].contacts[0].accumulatedSlipM[0] = 0; }],
    ['bad path', (v: ReturnType<typeof raw>) => { v.states[2].contacts[0].slipPathLengthM = 0; }],
    ['bad work', (v: ReturnType<typeof raw>) => { v.states[3].contacts[0].dissipatedWorkJ = 0; }],
    ['nonfinite force', (v: ReturnType<typeof raw>) => { v.states[0].contacts[0].normalReactionN = NaN; }],
    ['nonfinite gap', (v: ReturnType<typeof raw>) => { v.states[0].contacts[0].gapM = Infinity; }],
  ] as const)('rejects %s', (_name, change) => {
    const value = clone(); change(value);
    expect(() => decodeFrictionContact(value, input(), hash, options)).toThrow();
  });
});

describe('saved actual native output compatibility', () => {
  const dir = new URL('./fixtures/friction-native/', import.meta.url);
  const files = { 'input.json': '54738dd57ca9580d096cbc35aa0d70debaf2a526795d496ce9055b07b72a1432',
    'newton-raw.json': '89cb51b614ae667c0ac349f2595661acc3a0ed4e754197c95d7fd5dd8ac2a003',
    'nsgs-raw.json': '43cb660f39ebcbf7d93bbf5e27f4d6a8788274962cbb25ee0dab677bf2bb06d2' } as const;
  function checked(name: keyof typeof files): unknown {
    const bytes = readFileSync(new URL(name, dir));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(files[name]);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }
  it.each([['newton', 64, 'newton-raw.json'], ['nsgs', 20000, 'nsgs-raw.json']] as const)(
    'reads the unchanged %s native raw with the independently matched input', (solver, iterationLimit, file) => {
      const base = input(), geometry = base.geometry;
      const loads = [[2, -10, 0], [5, -10, 0], [0, 0, 0], [-5, -10, 0]] as const;
      const request: BeamFrictionContactInput = { ...base,
        geometry: { ...geometry,
          materials: geometry.materials.map(m => ({ ...m, youngModulus: 200e9, shearModulus: 80e9 })),
          sections: geometry.sections.map(s => ({ ...s, area: 1e-4, iy: 1e-8, iz: 1e-8, torsionConstant: 2e-8 })) },
        supports: [...base.supports, { nodeId: 'node-1', restrained: [false, false, false, true, true, true] }],
        contacts: [{ kind: 'node-plane', id: 'tip-plane', nodeId: 'node-1', normal: [0, 1, 0], gapM: 0 }],
        friction: { 'tip-plane': 0.3 },
        stepLoads: loads.map((force, i) => [{ id: 'load-' + i, kind: 'nodal' as const, nodeId: 'node-1',
          force, moment: [0, 0, 0] as const }]) };
      const translated = translateBeamFrictionContact(request);
      const saved = checked('input.json') as { plan: typeof translated.plan; friction: typeof translated.friction;
        loads: typeof translated.loads };
      expect(translated.plan.members.map(({ id, componentId, occurrencePath }) => ({ id, componentId, occurrencePath })))
        .toEqual([{ id: 'member-0', componentId: 'component-0', occurrencePath: ['component-0'] }]);
      const planWithUnloadedNodes = { ...translated.plan, nodes: translated.plan.nodes.map(node => ({
        ...node, load: [0, 0, 0, 0, 0, 0] })), members: translated.plan.members.map(member => ({
        number: member.number, nodes: member.nodes, material: member.material, section: member.section, frame: member.frame,
      })) };
      expect(planWithUnloadedNodes).toEqual(saved.plan);
      expect(translated.friction).toEqual(saved.friction);
      expect(translated.loads).toEqual(saved.loads);
      const result = decodeFrictionContact(checked(file), request, hash, { solver, iterationLimit });
      expect(result.states).toHaveLength(4);
      expect(result.states.map(s => s.contacts[0].state)).toEqual(['stick', 'slip', 'open', 'slip']);
    });
});
