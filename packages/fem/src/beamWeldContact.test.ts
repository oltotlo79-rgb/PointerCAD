import { describe, expect, it } from 'vitest';
import { beamWeldContactInputSha256, decodeBeamWeldContact, translateBeamWeldContact, type BeamWeldContactInput } from './beamWeldContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';

function input(millimetres = false): BeamWeldContactInput {
  const { geometry, supports, referenceLoads } = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]), { millimetres });
  return { schema: 'pointercad-weld-layer/1',
    contact: { schema: 'pointercad-beam-contact/1', geometry, supports, referenceLoads,
      contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [-1, 0, 0], gapM: .001 }], loadFactors: [1] },
    welds: [{ id: 'patch', nodeIdA: 'node-0', nodeIdB: 'node-1', centerM: [1, 0, 0], normal: [1, 0, 0], along: [0, 1, 0],
      widthM: .01, lengthM: .01, thicknessM: .1, youngPa: 210e9, poisson: .3 }] };
}
function raw() {
  // Independent parallel axial springs: native beam EA/L=210e6, layer E*A/t=210e6.
  const u = 1000 / 420e6;
  return { schema: 'pointercad-weld-layer-result/1',
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 1, meshNodes: 2, meshElements: 1, momentLengthM: 1, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: .001, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0,
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
          { number: 2, displacementM: [u, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001-u }] }] },
    states: [{ loadFactor: 1, welds: [{ id: 'patch', forceOnAN: [500, 0, 0], forceOnBN: [-500, 0, 0],
      momentOnANm: [0, 0, 0], momentOnBNm: [0, 0, 0], elasticEnergyJ: 250*u }] }] };
}
describe('effective weld layer public boundary', () => {
  it('accepts disjoint same-pair intervals but refuses positive overlap and noncollinear frames', () => {
    const source = input(), original = source.welds[0];
    const left = { ...original, id: 'left', widthM: .005, centerM: [1, -.01, 0] as const };
    const right = { ...original, id: 'right', widthM: .005, centerM: [1, .01, 0] as const };
    expect(translateBeamWeldContact({ ...source, welds: [left, right] }).plan.welds.map(w => w.id)).toEqual(['left', 'right']);
    // Tiny allowed frame tilt has positive projected transverse extent at touching ends.
    const boundary = { ...right, centerM: [1, -.005, 0], along: [0, 1, 5e-11] };
    expect(() => translateBeamWeldContact({ ...source, welds: [left, boundary] })).toThrow('weld-duplicate');
    for (const patch of [{ centerM: [1, -.009, 0] }, { centerM: [1, .01, .001] },
      { centerM: [1.001, .01, 0] }, { normal: [0, 0, 1] }]) {
      expect(() => translateBeamWeldContact({ ...source, welds: [left, { ...right, ...patch }] })).toThrow(/^weld/u);
    }
  });
  it('decodes each interval wrench independently and binds gap changes into ownership', async () => {
    const source = input(), patch = source.welds[0], u = 1000/420e6;
    const welds = [-1, 1].map(sign => ({ ...patch, id: sign < 0 ? 'left' : 'right',
      widthM: .005, centerM: [1, sign*.01, 0] as const }));
    const paired = { ...source, welds }, hash = await beamWeldContactInputSha256(paired);
    const base = raw();
    const result = { ...base, states: [{ loadFactor: 1, welds: [-1, 1].map(sign => ({
      id: sign < 0 ? 'left' : 'right', forceOnAN: [250, 0, 0], forceOnBN: [-250, 0, 0],
      momentOnANm: [0, 0, -sign*2.5], momentOnBNm: [0, 0, sign*2.5], elasticEnergyJ: 125*u })) }] };
    expect(decodeBeamWeldContact(result, paired, hash).states[0].welds).toHaveLength(2);
    expect(await beamWeldContactInputSha256({ ...paired,
      welds: welds.map(w => ({ ...w, centerM: [1, w.centerM[1]*2, 0] })) })).not.toBe(hash);
    const tampered = structuredClone(result); tampered.states[0].welds[1].momentOnBNm[2] = 0;
    expect(() => decodeBeamWeldContact(tampered, paired, hash)).toThrow('weld-constitutive-wrench');
  });
  it('maps original node ownership and SI patch geometry without changing m/mm input', () => {
    const source = input(), before = structuredClone(source);
    const prepared = translateBeamWeldContact(source), mm = translateBeamWeldContact(input(true));
    expect(prepared.plan.welds[0]).toMatchObject({ nodeA: 1, nodeB: 2, centerM: [1, 0, 0], thicknessM: .1 });
    expect(mm.plan.welds).toEqual(prepared.plan.welds);
    expect(mm.plan.contact.nodes.map(n => n.positionM)).toEqual(prepared.plan.contact.nodes.map(n => n.positionM));
    expect(source).toEqual(before);
  });
  it('refuses unsupported physics, invalid frames/materials, absent nodes and duplicate or sparse patches', () => {
    const source = input();
    for (const patch of [{ yieldPa: 250e6 }, { rigid: true }, { thicknessM: 0 }, { youngPa: true },
      { widthM: NaN }, { poisson: .5 }, { nodeIdA: 'missing' }, { nodeIdB: 'node-0' },
      { along: [1, 0, 0] }, { normal: [2, 0, 0] }]) {
      expect(() => translateBeamWeldContact({ ...source, welds: [{ ...source.welds[0], ...patch }] })).toThrow(/^weld/u);
    }
    expect(() => translateBeamWeldContact({ ...source, welds: [source.welds[0],
      { ...source.welds[0], id: 'second', nodeIdA: 'node-1', nodeIdB: 'node-0' }] })).toThrow('weld-duplicate');
    const sparse = new Array<unknown>(2); sparse[1] = source.welds[0];
    expect(() => translateBeamWeldContact({ ...source, welds: sparse })).toThrow('weld-count');
  });
  it('binds geometry and compliance into the digest for stale-result ownership', async () => {
    const source = input(), hash = await beamWeldContactInputSha256(source);
    expect(await beamWeldContactInputSha256({ ...source, welds: [{ ...source.welds[0], thicknessM: .2 }] })).not.toBe(hash);
    expect(await beamWeldContactInputSha256({ ...source, welds: [{ ...source.welds[0], centerM: [1, 1, 0] }] })).not.toBe(hash);
  });
  it('checks independent force and energy and refuses force, moment, identity and residual tampering', () => {
    const source = input(), hash = 'b'.repeat(64);
    const result = decodeBeamWeldContact(raw(), source, hash);
    expect(result.states[0].welds[0].forceOnAN[0]).toBeCloseTo(500, 9);
    expect(result.structuralCertification).toBe(false);
    const force = raw(); force.states[0].welds[0].forceOnBN[0] = 500;
    expect(() => decodeBeamWeldContact(force, source, hash)).toThrow('weld-constitutive-wrench');
    const moment = raw(); moment.states[0].welds[0].momentOnANm[1] = .001;
    expect(() => decodeBeamWeldContact(moment, source, hash)).toThrow('weld-constitutive-wrench');
    const energy = raw(); energy.states[0].welds[0].elasticEnergyJ = 0;
    expect(() => decodeBeamWeldContact(energy, source, hash)).toThrow('weld-constitutive-energy');
    const identity = raw(); identity.states[0].welds[0].id = 'foreign';
    expect(() => decodeBeamWeldContact(identity, source, hash)).toThrow('weld-node-identity');
    const residual = raw(); residual.contact.states[0].equilibriumResidual = 2e-9;
    expect(() => decodeBeamWeldContact(residual, source, hash)).toThrow('Invalid contact result');
  });
});
