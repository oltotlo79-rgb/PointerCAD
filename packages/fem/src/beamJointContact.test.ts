import { describe, expect, it } from 'vitest';
import { beamJointContactInputSha256, decodeBeamJointContact, translateBeamJointContact } from './beamJointContact.js';
import { jointTestInput as input, jointTestRaw as raw } from './beamJointContact.testSupport.js';

describe('mixed elastic shank and weld contact boundary', () => {
  it('retains both connector families on one canonical physical geometry in m and mm', () => {
    const source = input(), before = structuredClone(source), a = translateBeamJointContact(source), b = translateBeamJointContact(input(true));
    expect(a.plan.bolts).toEqual([{ id: 'bolt', nodeA: 1, nodeB: 2, youngPa: 210e9, areaM2: .001 }]);
    expect(a.plan.welds[0]).toMatchObject({ id: 'weld', nodeA: 1, nodeB: 2, centerM: [1, 0, 0] });
    expect(b.plan.bolts).toEqual(a.plan.bolts);
    expect(b.plan.welds).toEqual(a.plan.welds);
    expect(b.plan.contact.nodes.map(n => n.positionM)).toEqual(a.plan.contact.nodes.map(n => n.positionM));
    expect(source).toEqual(before);
  });
  it('requires both explicit families, rejects cross-family aliases and keeps prior unsupported-physics refusal', () => {
    const source = input();
    for (const patch of [{ bolts: [] }, { welds: [] }, { preloadN: 10 },
      { bolts: [{ ...source.bolts[0], id: 'weld' }] }, { welds: [{ ...source.welds[0], friction: .2 }] }]) {
      expect(() => translateBeamJointContact({ ...source, ...patch })).toThrow();
    }
  });
  it('binds changes in either family into the same input digest', async () => {
    const source = input(), hash = await beamJointContactInputSha256(source);
    expect(await beamJointContactInputSha256({ ...source, bolts: [{ ...source.bolts[0], areaM2: .002 }] })).not.toBe(hash);
    expect(await beamJointContactInputSha256({ ...source, welds: [{ ...source.welds[0], thicknessM: .5 }] })).not.toBe(hash);
  });
  it('decodes the independent one-third load split and rejects combining separate single-family answers', () => {
    const source = input(), hash = 'a'.repeat(64), decoded = decodeBeamJointContact(raw(), source, hash);
    expect(decoded.states[0].bolts[0].axialForceN).toBeCloseTo(1000/3, 9);
    expect(decoded.states[0].welds[0].forceOnBN[0]).toBeCloseTo(-1000/3, 9);
    const independentBolt = raw(); independentBolt.states[0].bolts[0].axialForceN = 500;
    expect(() => decodeBeamJointContact(independentBolt, source, hash)).toThrow('bolt-constitutive');
    const independentWeld = raw(); independentWeld.states[0].welds[0].forceOnBN[0] = -500;
    expect(() => decodeBeamJointContact(independentWeld, source, hash)).toThrow('weld-constitutive');
    const badResidual = raw(); badResidual.contact.states[0].equilibriumResidual = 2e-9;
    expect(() => decodeBeamJointContact(badResidual, source, hash)).toThrow('Invalid contact result');
    const lostWeld = raw(); lostWeld.states[0].welds = [];
    expect(() => decodeBeamJointContact(lostWeld, source, hash)).toThrow('weld-state-identity');
  });
});
