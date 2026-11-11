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


import { readFrameBoltContact, frameBoltEndActions, assessFrameBoltSection, decodeFrameBoltContact, frameBoltContactInputSha256 } from './beamBoltContact.js';
const frameSource = { kind: 'user-supplied', reference: 'Independent W25/W26 synthetic verification', condition: 'linear Timoshenko, explicit centroidal end coupling; no design certification' } as const;
const fq = (role: string, value: number) => ({ role, value, source: frameSource });
function frameInput(extra = 0, shortening = 0) {
  const base = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
  return { schema: 'pointercad-frame-bolt-contact/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base.geometry, nodes: [{ id: 'node-0', position: [0, 0, 0] }, { id: 'node-1', position: [0.1, 0, 0] }],
      materials: base.geometry.materials.map(m => ({ ...m, youngModulus: 200e9, shearModulus: 80e9 })),
      sections: base.geometry.sections.map(s => ({ ...s, area: 1e-4, iy: 1e-8, iz: 1e-8, torsionConstant: 2e-8, shearFactor: 5 / 6 })) },
    supports: [base.supports[0]], referenceLoads: base.referenceLoads,
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [1, 0, 0], gapM: 0.001 }], loadFactors: [1] },
    bolt: { id: 'frame-bolt', memberId: 'member-0', model: 'centroidal-frame-shank-explicit-end-coupling', couplingSource: frameSource,
      shorteningM: fq('shortening-m', shortening), threadCompliance: fq('thread-compliance-m-per-n', extra), headCompliance: fq('head-compliance-m-per-n', 0), bearingCompliance: fq('bearing-compliance-m-per-n', 0),
      section: { materialConditionId: 'synthetic-material-condition', tensileArea: fq('tensile-area-m2', 8e-5), shearArea: fq('plain-shank-shear-area-m2', 1e-4),
        modulusY: fq('section-modulus-y-m3', 2e-6), modulusZ: fq('section-modulus-z-m3', 2e-6), fibreYM: fq('extreme-y-m', 0.005), fibreZM: fq('extreme-z-m', 0.005), limits: null } } };
}
const zero3 = [0, 0, 0] as const;
describe('explicit centroidal frame bolt candidate (pure, not native proof)', () => {
  it('uses separately declared zero/nonzero series compliance; independent u=P*c and U=P²*c/2', () => {
    for (const [extra, u, energy] of [[0, 5e-6, 0.0025], [5e-9, 1e-5, 0.005]]) {
      const source = frameInput(extra), before = structuredClone(source), prepared = readFrameBoltContact(source);
      const force = frameBoltEndActions(prepared.plan, zero3, zero3, [u, 0, 0], zero3);
      expect(force.axialForceN).toBeCloseTo(1000, 8); expect(force.elasticEnergyJ).toBeCloseTo(energy, 12);
      expect(Math.hypot(...force.forceOnAN.map((x, i) => x - [1000, 0, 0][i]))).toBeLessThanOrEqual(1e-8); expect(Math.hypot(...force.forceOnBN.map((x, i) => x - [-1000, 0, 0][i]))).toBeLessThanOrEqual(1e-8); expect(source).toEqual(before);
    }
  });
  it('recovers transverse shear and same-origin moment with independent Timoshenko tip values', () => {
    const p = readFrameBoltContact(frameInput());
    // V=1000,L=.1,E*I=2000, kappa*G*A=(5/6)*80e9*1e-4.
    const a = frameBoltEndActions(p.plan, zero3, zero3, [0, 109 / 600000, 0], [0, 0, 1 / 400]);
    expect(a.forceOnAN[1]).toBeCloseTo(1000, 7); expect(a.forceOnBN[1]).toBeCloseTo(-1000, 7);
    expect(a.momentOnANm[2]).toBeCloseTo(100, 8); expect(a.momentOnBNm[2]).toBeCloseTo(0, 8);
    expect(Math.abs(a.momentOnANm[2] + a.momentOnBNm[2] + 0.1 * a.forceOnBN[1])).toBeLessThanOrEqual(1e-8);
    expect(a.elasticEnergyJ).toBeCloseTo(109 / 1200, 10);
  });
  it('recovers a pure end moment without converting it into an axial tie force', () => {
    const a = frameBoltEndActions(readFrameBoltContact(frameInput()).plan, zero3, zero3, [0, 1 / 40000, 0], [0, 0, 1 / 2000]);
    expect(a.axialForceN).toBe(0); expect(Math.hypot(...a.forceOnAN)).toBeLessThanOrEqual(1e-8);
    expect(a.momentOnANm[2]).toBeCloseTo(10, 9); expect(a.momentOnBNm[2]).toBeCloseTo(-10, 9);
    expect(a.elasticEnergyJ).toBeCloseTo(0.0025, 12);
  });
  it('rotates end forces and preserves energy under a proper coordinate rotation', () => {
    const v = frameInput(); v.contact.geometry.nodes[1].position = [0, 0.1, 0];
    v.contact.geometry.members = v.contact.geometry.members.map(m => ({ ...m, localYHint: [-1, 0, 0] as const }));
    const a = frameBoltEndActions(readFrameBoltContact(v).plan, zero3, zero3, [0, 5e-6, 0], zero3);
    expect(Math.hypot(...a.forceOnAN.map((x, i) => x - [0, 1000, 0][i]))).toBeLessThanOrEqual(1e-8); expect(a.elasticEnergyJ).toBeCloseTo(.0025, 12);
  });
  it('has zero rigid-body increments while retaining the same prescribed shortening', () => {
    const p = readFrameBoltContact(frameInput(5e-9, 4e-5));
    const before = frameBoltEndActions(p.plan, zero3, zero3, zero3, zero3);
    // t=[.001,.002,.003], omega=[0,0,.001]; uB=t+omega cross [.1,0,0].
    const after = frameBoltEndActions(p.plan, [.001, .002, .003], [0, 0, .001], [.001, .0021, .003], [0, 0, .001]);
    expect(after.axialForceN).toBeCloseTo(4000, 8); expect(after.elasticEnergyJ).toBeCloseTo(.08, 10);
    expect(Math.hypot(...after.forceOnAN.map((v, i) => v - before.forceOnAN[i]))).toBeLessThanOrEqual(1e-8);
    expect(Math.hypot(...after.momentOnANm)).toBeLessThanOrEqual(1e-8);
    expect(frameBoltEndActions(readFrameBoltContact(frameInput()).plan, [.001, .002, .003], zero3, [.001, .002, .003], zero3).elasticEnergyJ).toBe(0);
  });
  it('refuses unsupported coupling, unknown/accessor/finite/quantity/section/member/subdivision mistakes', () => {
    for (const patch of [{ model: 'ordinary-bolt-clamped-by-default' }, { friction: 0 }, { memberId: 'missing' }, { couplingSource: { ...frameSource, reference: '' } }, { shorteningM: fq('shortening-m', NaN) }, { threadCompliance: fq('thread-compliance-m-per-n', -1) }]) {
      const v = frameInput(); expect(() => readFrameBoltContact({ ...v, bolt: { ...v.bolt, ...patch } })).toThrow();
    }
    const mixed = frameInput(); mixed.bolt.section.shearArea = fq('tensile-area-m2', 8e-5); expect(() => readFrameBoltContact(mixed)).toThrow('frame-quantity-role');
    const badW = frameInput(); badW.bolt.section.modulusY.value = 4e-6; expect(() => readFrameBoltContact(badW)).toThrow('frame-section-mismatch');
    const subdivided = frameInput(); subdivided.contact.geometry.modal = { modeCount: 1, segmentsPerMember: 2 }; expect(() => readFrameBoltContact(subdivided)).toThrow('frame-subdivision');
    const accessor = frameInput(); Object.defineProperty(accessor.bolt, 'id', { get() { throw new Error('getter executed'); }, enumerable: true }); expect(() => readFrameBoltContact(accessor)).toThrow('frame-accessor');
    const duplicate = frameInput(); duplicate.contact.geometry.members = [...duplicate.contact.geometry.members, { ...duplicate.contact.geometry.members[0], id: 'duplicate' }]; expect(() => readFrameBoltContact(duplicate)).toThrow();
  });
  it('assesses independent F/As, V/A, M/W and all three explicit status branches without certification', () => {
    const prepared = readFrameBoltContact(frameInput()), section = prepared.input.bolt.section;
    const action = frameBoltEndActions(prepared.plan, zero3, zero3, [2e-5, 0, 0], zero3);
    expect(assessFrameBoltSection(section, action).tension).toEqual({ status: 'unevaluated', stressPa: 50e6, ratio: null });
    const limits = { classId: 'synthetic-class-only', materialConditionId: section.materialConditionId, tensionPa: 100e6, shearPa: 40e6, bendingPa: 20e6, source: frameSource };
    const checked = { ...section, limits };
    const result = assessFrameBoltSection(checked, { ...action, shearYN: 1000, shearZN: 0, bendingYNm: 10, bendingZNm: 0 });
    expect(result.tension).toEqual({ status: 'compared', stressPa: 50e6, ratio: 2 });
    expect(result.shear).toEqual({ status: 'compared', stressPa: 10e6, ratio: 4 });
    expect(result.bending).toEqual({ status: 'compared', stressPa: 5e6, ratio: 4 });
    expect(assessFrameBoltSection(checked, { ...action, axialForceN: 0 }).tension).toEqual({ status: 'zero-demand', stressPa: 0, ratio: null });
    expect(assessFrameBoltSection({ ...checked, limits: { ...limits, materialConditionId: 'foreign-condition' } }, action).tension.status).toBe('unevaluated');
  });
  it('binds source/revision and per-case compliance into a distinct digest', async () => {
    const v = frameInput(); const hash = await frameBoltContactInputSha256(v);
    expect(await frameBoltContactInputSha256(frameInput(5e-9))).not.toBe(hash);
    v.contact.geometry.revision += 1; expect(await frameBoltContactInputSha256(v)).not.toBe(hash);
    expect(() => translateBeamBoltContact(frameInput())).toThrow();
  });
  it('strictly decodes a handwritten axial result; rejects digest, stage, identity, force, moment and energy corruption', () => {
    const v = frameInput(), hash = 'a'.repeat(64), old = raw();
    const result = { schema: 'pointercad-frame-bolt-contact-result/1', inputSha256: hash,
      contact: { ...old.contact, freeDofs: 6, momentLengthM: .1, states: [{ ...old.contact.states[0],
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] }, { number: 2, displacementM: [5e-6, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001005 }] }] },
      states: [{ loadFactor: 1, boltId: 'frame-bolt', member: 1, forceOnAN: [1000, 0, 0], forceOnBN: [-1000, 0, 0], momentOnANm: [0, 0, 0], momentOnBNm: [0, 0, 0], axialForceN: 1000, shearYN: 0, shearZN: 0, bendingYNm: 0, bendingZNm: 0, elasticEnergyJ: .0025, transverseEnergyJ: 0 }] };
    expect(decodeFrameBoltContact(result, v, hash).states[0].assessment.tension.status).toBe('unevaluated');
    for (const patch of [{ boltId: 'foreign' }, { loadFactor: 0 }, { member: 2 }, { forceOnBN: [1000, 0, 0] }, { momentOnANm: [1, 0, 0] }, { elasticEnergyJ: .005 }]) {
      expect(() => decodeFrameBoltContact({ ...result, states: [{ ...result.states[0], ...patch }] }, v, hash)).toThrow();
    }
    expect(() => decodeFrameBoltContact({ ...result, inputSha256: 'b'.repeat(64) }, v, hash)).toThrow('frame-result-identity');
    expect(() => decodeFrameBoltContact({ ...result, unknown: 1 }, v, hash)).toThrow();
  });
});

describe('frame bolt numerical order regressions', () => {
  it('keeps common-origin moment under an exactly representable geometry translation', () => {
    const V = 1000 / 3, L = 1 / 8, u = V * (L ** 3 / 6000 + L / ((5 / 6) * 80e9 * 1e-4)), theta = V * L * L / 4000;
    const decoded = [0, 2 ** 29].map(origin => {
      const v = frameInput(); v.contact.geometry.nodes[0].position = [origin, 0, 0]; v.contact.geometry.nodes[1].position = [origin + L, 0, 0];
      v.contact.referenceLoads = [{ ...v.contact.referenceLoads[0], force: [0, V, 0] }];
      const before = raw();
      const result = { schema: 'pointercad-frame-bolt-contact-result/1', inputSha256: 'a'.repeat(64),
        contact: { ...before.contact, freeDofs: 6, momentLengthM: L, states: [{ ...before.contact.states[0], forceScaleN: V,
          nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] }, { number: 2, displacementM: [0, u, 0], rotationRad: [0, 0, theta] }],
          contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001 }] }] },
        states: [{ loadFactor: 1, boltId: 'frame-bolt', member: 1, forceOnAN: [0, V, 0], forceOnBN: [0, -V, 0], momentOnANm: [0, 0, V * L], momentOnBNm: [0, 0, 0], axialForceN: 0, shearYN: V, shearZN: 0, bendingYNm: 0, bendingZNm: V * L, elasticEnergyJ: V * u / 2, transverseEnergyJ: V * u / 2 }] };
      return decodeFrameBoltContact(result, v, 'a'.repeat(64)).states[0];
    });
    expect(decoded[1].forceOnAN).toEqual(decoded[0].forceOnAN);
    expect(decoded[1].momentOnANm).toEqual(decoded[0].momentOnANm);
    expect(decoded[1].elasticEnergyJ).toBe(decoded[0].elasticEnergyJ);
  });
  it('retains a tiny transverse energy beside larger axial energy without subtractive cancellation', () => {
    const v = 1e-6 * 109 / 600000000, theta = 1e-6 / 400000;
    const action = frameBoltEndActions(readFrameBoltContact(frameInput()).plan, zero3, zero3, [5e-6, v, 0], [0, 0, theta]);
    const expected = 1e-12 * 109 / 1200000000;
    expect(action.transverseEnergyJ).toBeGreaterThan(0);
    expect(Math.abs(action.transverseEnergyJ - expected) / expected).toBeLessThanOrEqual(1e-9);
    expect(action.axialForceN).toBeCloseTo(1000, 8);
  });
});
