import { describe, expect, it } from 'vitest';
import type { Vector3 } from './analysisModel.js';
import { modalFixture } from './modal.testSupport.js';
import { beamWeldSpanContactInputSha256, decodeBeamWeldSpanContact, translateBeamWeldSpanContact,
  type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';

function input(segments = 1): BeamWeldSpanContactInput {
  const base = modalFixture({ free: true, modes: 1, segments });
  return { schema: 'pointercad-weld-span/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base, nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
}
/** Independent axial coupled-system fractions, not kernel output or a native execution record.
 * K=500,C=4000/3 (one element); two-element K/C are the explicit 2x2 integral matrices. */
function raw(segments = 1) {
  const displacements = segments === 1 ? [0, 8/9500, 0, 11/9500] : [0, 76/97000, 0, 118/97000, 47/97000, 50/97000];
  const force = segments === 1 ? 12/19 : 48/97;
  const nodal = segments === 1 ? [4/19, 8/19, 0, 0] : [1/97, 29/97, 0, 0, 18/97, 0];
  const opposite = segments === 1 ? [0, 0, -4/19, -8/19] : [0, 0, -1/97, -29/97, 0, -18/97];
  const rows = displacements.map((x, i) => ({ number: i+1, displacementM: [x, 0, 0], rotationRad: [0, 0, 0] }));
  return { schema: 'pointercad-weld-span-result/1',
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: segments === 1 ? 2 : 14, meshNodes: displacements.length, meshElements: 2*segments,
      momentLengthM: 2/segments, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1, gapScaleM: .01, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0, nodes: structuredClone(rows.slice(0, 4)),
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .01-displacements[3] }] }] },
    states: [{ loadFactor: 1, meshNodes: rows, welds: [{ id: 'layer',
      first: nodal.map(f => [f, 0, 0, 0, 0, 0]), second: opposite.map(f => [f, 0, 0, 0, 0, 0]),
      forceOnFirstN: [force, 0, 0], momentAtCenterNm: [0, 0, 0], energyJ: segments === 1 ? 3/45125 : 159/2352250,
      structuralCertification: false }] }] };
}
const close = (a: number, e: number) => expect(Math.abs(a-e)).toBeLessThanOrEqual(1e-9*Math.max(Math.abs(e), .001));

describe('explicit span contact translation and full-mesh result boundary', () => {
  it.each([1, 2])('decodes independent %i-element coupled displacements and unequal nodal forces', async segments => {
    const source = input(segments), before = structuredClone(source), expected = raw(segments);
    const translated = translateBeamWeldSpanContact(source);
    expect(translated.plan.schema).toBe('pointercad-weld-span-plan/1');
    expect(translated.plan.contact.originalNodeCount).toBe(4);
    expect(translated.plan.contact.nodes).toHaveLength(segments === 1 ? 4 : 6);
    expect(translated.plan.patches[0].first).toEqual({ kind: 'span', memberId: 'a' });
    const hash = await beamWeldSpanContactInputSha256(source), result = await decodeBeamWeldSpanContact(expected, source, hash);
    expect(result).toMatchObject({ kind: 'oofem-beam-weld-span-contact', inputSha256: hash, structuralCertification: false });
    result.states[0].meshNodes.forEach((n, i) => close(n.displacementM[0], expected.states[0].meshNodes[i].displacementM[0]));
    const weld = result.states[0].welds[0];
    weld.first.forEach((n, i) => n.forEach((v, axis) => close(v, expected.states[0].welds[0].first[i][axis])));
    close(weld.forceOnFirstN[0], segments === 1 ? 12/19 : 48/97);
    close(weld.energyJ, segments === 1 ? 3/45125 : 159/2352250);
    if (segments === 2) {
      expect(result.states[0].meshNodes[4].displacementM[0]).toBe(47/97000);
      expect(result.states[0].meshNodes[5].displacementM[0]).toBe(50/97000);
      expect(result.states[0].meshNodes[4].displacementM[0]).not.toBe(0);
      expect(result.states[0].meshNodes[4].displacementM[0]).not.toBe(38/97000);
    }
    expect(source).toEqual(before);
  });
  it('maps a section only to its actual owning member endpoint', () => {
    const source = input(), patch = source.patches[0];
    const section = { ...source, patches: [{ ...patch, first: { kind: 'section-node', memberId: 'a', nodeId: 'n1' } }] };
    expect(translateBeamWeldSpanContact(section).plan.patches[0].first).toEqual({ kind: 'section', node: 2 });
    for (const first of [{ kind: 'section-node', memberId: 'a', nodeId: 'n3' }, { kind: 'section-node', memberId: 'a' },
      { kind: 'member-span', memberId: 'a', nodeId: 'n1' }, { kind: 'unknown', memberId: 'a' }, { kind: 'member-span', memberId: 'missing' }]) {
      expect(() => translateBeamWeldSpanContact({ ...source, patches: [{ ...patch, first }] })).toThrow();
    }
  });
  it('rejects unknown fields, duplicate/self/overlapping patches, sparse/accessor data and nonfinite inputs', () => {
    const source = input(), p = source.patches[0];
    const accessor = structuredClone(source); let calls = 0;
    Object.defineProperty(accessor.patches[0], 'widthM', { get() { calls++; return 2; }, enumerable: true });
    const hidden = structuredClone(source); Object.defineProperty(hidden, 'extra', { value: 1 });
    const sparse = [p, p]; Reflect.deleteProperty(sparse, '0');
    for (const bad of [{ ...source, unknown: 1 }, { ...source, schema: 'pointercad-weld-layer/1' },
      { ...source, patches: [p, p] }, { ...source, patches: [p, { ...p, id: 'other' }] },
      { ...source, patches: [{ ...p, second: p.first }] }, { ...source, patches: [{ ...p, widthM: NaN }] },
      { ...source, patches: sparse }, accessor, hidden, { ...source, patches: Array.from({ length: 65 }, () => p) }]) {
      expect(() => translateBeamWeldSpanContact(bad)).toThrow();
    }
    expect(calls).toBe(0);
  });
  it('enforces 32 elements per member and 128 total nodes', () => {
    expect(() => translateBeamWeldSpanContact(input(33))).toThrow();
    const source = input(32), g = source.contact.geometry;
    const geometry = { ...g, nodes: [...g.nodes, ...[0, 2, 0, 2].map((x, i) => ({ id: `extra${i}`, position: [x, 0, 0] as Vector3 }))],
      members: [...g.members, ...['c', 'd'].map((id, i) => ({ ...g.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `extra${2*i}`, endNodeId: `extra${2*i+1}` }))] };
    expect(() => translateBeamWeldSpanContact({ ...source, contact: { ...source.contact, geometry } })).toThrow();
  });
  it.each(['missing', 'zero', 'swap', 'support', 'factor', 'original', 'force', 'nodal', 'moment', 'energy', 'schema', 'extra', 'residual', 'status', 'gap', 'nan', 'certification', 'dofs'])(
    'rejects concrete %s result corruption', async corruption => {
      const source = input(2), reply = raw(2), s = reply.states[0], c = reply.contact.states[0], w = s.welds[0];
      switch (corruption) {
        case 'missing': s.meshNodes.pop(); break;
        case 'zero': s.meshNodes[4].displacementM[0] = 0; break;
        case 'swap': [s.meshNodes[4].number, s.meshNodes[5].number] = [6, 5]; break;
        case 'support': s.meshNodes[0].rotationRad[0] = .001; break;
        case 'factor': s.loadFactor = 2; break;
        case 'original': c.nodes[1].displacementM[0] = 0; break;
        case 'force': w.forceOnFirstN[0] = 12/19; break;
        case 'nodal': w.first[4][0] = 0; break;
        case 'moment': w.momentAtCenterNm[1] = .01; break;
        case 'energy': w.energyJ = 3/45125; break;
        case 'schema': reply.schema = 'pointercad-weld-layer-result/1'; break;
        case 'extra': Object.assign(s.meshNodes[4], { extra: 0 }); break;
        case 'residual': c.equilibriumResidual = 2e-9; break;
        case 'status': c.contacts[0].normalReactionN = 1; break;
        case 'gap': c.contacts[0].gapM = .01; break;
        case 'nan': s.meshNodes[4].displacementM[0] = NaN; break;
        case 'certification': w.structuralCertification = true; break;
        case 'dofs': reply.contact.freeDofs = 2; break;
      }
      await expect(decodeBeamWeldSpanContact(reply, source, await beamWeldSpanContactInputSha256(source))).rejects.toThrow();
    });
  it('rejects a stale digest and binds revision, source and normalized patch input', async () => {
    const source = input(), hash = await beamWeldSpanContactInputSha256(source);
    const revised = { ...source, contact: { ...source.contact, geometry: { ...source.contact.geometry, revision: 2 } } };
    await expect(decodeBeamWeldSpanContact(raw(), revised, hash)).rejects.toThrow();
    expect(await beamWeldSpanContactInputSha256(revised)).not.toBe(hash);
    const changed = input(); Object.assign(changed.patches[0], { thicknessM: .3 });
    await expect(decodeBeamWeldSpanContact(raw(), changed, hash)).rejects.toThrow();
  });
  it('refuses executable or sparse replies without evaluating their accessors', async () => {
    const source = input(), hash = await beamWeldSpanContactInputSha256(source), reply = raw(); let calls = 0;
    Object.defineProperty(reply.states[0], 'meshNodes', { get() { calls++; return []; }, enumerable: true });
    await expect(decodeBeamWeldSpanContact(reply, source, hash)).rejects.toThrow();
    expect(calls).toBe(0);
    const sparse = raw(); Reflect.deleteProperty(sparse.states[0].meshNodes, '1');
    await expect(decodeBeamWeldSpanContact(sparse, source, hash)).rejects.toThrow();
  });
  it('uses explicit SI patch vectors without substituting a saved node or changing legacy input', () => {
    const source = input(), normal: Vector3 = [0, 1, 0];
    expect(translateBeamWeldSpanContact(source).input.patches[0].normal).toEqual(normal);
  });
  it('snapshots both input and reply before the asynchronous hash verification', async () => {
    const source = input(), reply = raw(), hash = await beamWeldSpanContactInputSha256(source);
    const pending = decodeBeamWeldSpanContact(reply, source, hash);
    Object.assign(source.patches[0], { thicknessM: .3 });
    reply.states[0].meshNodes.pop();
    const result = await pending;
    expect(result.states[0].meshNodes).toHaveLength(4);
    close(result.states[0].welds[0].energyJ, 3/45125);
  });
});
