import { describe, expect, it } from 'vitest';
import { beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain, translateBeamJointInitialStrain } from './beamJointInitialStrain.js';
import { initialStrainTestInput as input, initialStrainTestRaw as raw } from './beamJointInitialStrain.testSupport.js';
import { decodeBeamJointContact } from './beamJointContact.js';

describe('explicit stress-free shank shortening', () => {
  it('requires each exact shank identity, a finite positive rest length and no torque or force interpretation', () => {
    const source = input(), before = structuredClone(source);
    expect(translateBeamJointInitialStrain(source).plan.shortenings).toEqual(source.shortenings);
    for (const shortenings of [[], [{ boltId: 'other', shorteningM: 1e-6 }],
      [{ boltId: 'bolt', shorteningM: -1 }], [{ boltId: 'bolt', shorteningM: 1 }],
      [{ boltId: 'bolt', shorteningM: NaN }], [{ boltId: 'bolt', shorteningM: true }],
      [{ boltId: 'bolt', shorteningM: 1e-6, torqueNm: 10 }], Array(1)]) {
      expect(() => translateBeamJointInitialStrain({ ...source, shortenings })).toThrow();
    }
    expect(() => translateBeamJointInitialStrain({ ...source, preloadN: 210 })).toThrow();
    expect(source).toEqual(before);
  });
  it('keeps initial stress at zero external load and satisfies the independent three-branch equilibrium and energy', () => {
    const result = decodeBeamJointInitialStrain(raw(), input(), 'a'.repeat(64)), k = 210e6;
    for (const [i, state] of result.states.entries()) {
      const u = result.contact.states[i].nodes[1].displacementM[0], bolt = state.bolts[0];
      expect(k*u+bolt.axialForceN-state.welds[0].forceOnBN[0]).toBeCloseTo(1000*state.loadFactor, 9);
      expect(bolt.elasticEnergyJ+state.welds[0].elasticEnergyJ+k*u*u/2)
        .toBeCloseTo(3*k*u*u/2+k*1e-6*u+k*1e-12/2, 12);
    }
    expect(result.states[1].bolts[0].axialForceN).toBeCloseTo(140, 9);
    expect(result.contact.states[1].nodes[1].displacementM[0]).toBeCloseTo(-1e-6/3, 15);
    expect(result.states[2].bolts[0].axialForceN).toBeLessThan(0);
  });
  it('preserves the prior zero-shortening response and rejects a result that silently loses the initial strain', () => {
    const source = input(0), encoded = raw(0), decoded = decodeBeamJointInitialStrain(encoded, source, 'a'.repeat(64));
    const old = decodeBeamJointContact({ ...encoded, schema: 'pointercad-joint-contact-result/1',
      states: encoded.states.map(state => ({ ...state, bolts: state.bolts.map(b => ({ id: b.id,
        extensionM: b.extensionM, axialForceN: b.axialForceN, forceOnAN: b.forceOnAN, forceOnBN: b.forceOnBN })) })) }, source.joint, 'a'.repeat(64));
    expect(decoded.contact).toEqual(old.contact);
    expect(decoded.states.map(s => s.welds)).toEqual(old.states.map(s => s.welds));
    expect(() => decodeBeamJointInitialStrain(raw(0), input(), 'a'.repeat(64))).toThrow('initial-strain-constitutive');
    const bad = raw(); bad.states[1].bolts[0].elasticEnergyJ = 0;
    expect(() => decodeBeamJointInitialStrain(bad, input(), 'a'.repeat(64))).toThrow('initial-strain-constitutive');
  });
  it('binds the prescribed shortening independently of both stiffness families into the request digest', async () => {
    expect(await beamJointInitialStrainInputSha256(input())).not.toBe(await beamJointInitialStrainInputSha256(input(0)));
  });
});
