import { describe, expect, it } from 'vitest';
import { translateBeamBoltContact, decodeBeamBoltContact, beamBoltContactInputSha256, type BeamBoltContactInput } from './beamBoltContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';

function input(millimetres = false): BeamBoltContactInput {
  const { geometry, supports, referenceLoads } = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]), { millimetres });
  return { schema: 'pointercad-bolt-contact/1',
    contact: { schema: 'pointercad-beam-contact/1', geometry, supports, referenceLoads,
      contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [-1, 0, 0], gapM: 0.001 }], loadFactors: [1] },
    bolts: [{ id: 'bolt', nodeIdA: 'node-0', nodeIdB: 'node-1', youngPa: 210e9, areaM2: 0.001 }] };
}
function raw() {
  // Independent two-parallel-springs calculation: both EA/L=210e6 N/m, F=1000 N.
  const u = 1000 / (2 * 210e6);
  return { schema: 'pointercad-bolt-contact-result/1',
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 1, meshNodes: 2, meshElements: 1, momentLengthM: 1, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: 0.001, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0,
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
          { number: 2, displacementM: [u, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: 0.001 - u }] }] },
    states: [{ loadFactor: 1, bolts: [{ id: 'bolt', extensionM: u, axialForceN: 500,
      forceOnAN: [500, 0, 0], forceOnBN: [-500, 0, 0] }] }] };
}
describe('explicit axial bolt contact public boundary', () => {
  it('maps original nodes, preserves input and normalizes m/mm geometry without changing SI bolt data', () => {
    const source = input(), before = structuredClone(source);
    const translated = translateBeamBoltContact(source);
    expect(translated.plan.bolts).toEqual([{ id: 'bolt', nodeA: 1, nodeB: 2, youngPa: 210e9, areaM2: 0.001 }]);
    const millimetres = translateBeamBoltContact(input(true)).plan;
    expect(millimetres.bolts).toEqual(translated.plan.bolts);
    expect(millimetres.contact.nodes.map(node => node.positionM)).toEqual(translated.plan.contact.nodes.map(node => node.positionM));
    expect(source).toEqual(before);
  });
  it('refuses unsupported physics, bad nodes, duplicate reversed pairs and sparse rows', () => {
    for (const patch of [{ preloadN: 10 }, { friction: 0.2 }, { youngPa: true }, { areaM2: 0 },
      { youngPa: NaN }, { nodeIdB: 'missing' }, { nodeIdB: 'node-0' }]) {
      const source = input();
      expect(() => translateBeamBoltContact({ ...source, bolts: [{ ...source.bolts[0], ...patch }] })).toThrow(/^bolt/u);
    }
    const source = input();
    expect(() => translateBeamBoltContact({ ...source, bolts: [source.bolts[0],
      { ...source.bolts[0], id: 'other', nodeIdA: 'node-1', nodeIdB: 'node-0' }] })).toThrow('bolt-duplicate');
    const sparse = new Array<unknown>(2); sparse[1] = source.bolts[0];
    expect(() => translateBeamBoltContact({ ...source, bolts: sparse })).toThrow('bolt-count');
  });
  it('binds bolt properties into the input digest', async () => {
    const source = input();
    const hash = await beamBoltContactInputSha256(source);
    expect(await beamBoltContactInputSha256({ ...source, bolts: [{ ...source.bolts[0], areaM2: 0.002 }] })).not.toBe(hash);
  });
  it('checks the independent constitutive answer and refuses force, identity and equilibrium tampering', () => {
    const source = input(), hash = 'a'.repeat(64);
    expect(decodeBeamBoltContact(raw(), source, hash).states[0].bolts[0].axialForceN).toBeCloseTo(500, 9);
    const changedForce = raw(); changedForce.states[0].bolts[0].axialForceN = 501;
    expect(() => decodeBeamBoltContact(changedForce, source, hash)).toThrow('bolt-constitutive');
    const changedEnd = raw(); changedEnd.states[0].bolts[0].forceOnBN[0] = 500;
    expect(() => decodeBeamBoltContact(changedEnd, source, hash)).toThrow('bolt-force');
    const changedId = raw(); changedId.states[0].bolts[0].id = 'foreign';
    expect(() => decodeBeamBoltContact(changedId, source, hash)).toThrow('bolt-node-identity');
    const changedResidual = raw(); changedResidual.contact.states[0].equilibriumResidual = 2e-9;
    expect(() => decodeBeamBoltContact(changedResidual, source, hash)).toThrow('Invalid contact result');
  });
});
