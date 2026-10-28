import { beamJointContactInputSha256, decodeBeamJointContact } from './beamJointContact.js';
import { beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain } from './beamJointInitialStrain.js';
import { initialStrainTestInput, initialStrainTestRaw } from './beamJointInitialStrain.testSupport.js';
import { recoverJointWeldThroatStress, recoverInitialStrainWeldThroatStress } from './weldThroatStress.js';
import { describe, expect, it } from 'vitest';
import type { Vector3 } from './analysisModel.js';
import { beamWeldContactInputSha256, decodeBeamWeldContact,
  type BeamWeldContactInput, type WeldLayerGeometry, type WeldLayerWrench } from './beamWeldContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';
import { recoverWeldPatchStress, recoverWeldThroatStress } from './weldThroatStress.js';

// 既存beamWeldContact.test.pyの矩形: A=8, int(s²)=8/3, int(q²)=32/3。
// 以下は合力・面積二次モーメントの閉形式。製品の求積結果から期待を作らない。
const patch: WeldLayerGeometry = { id: 'patch', centerM: [0, 0, 0], normal: [1, 0, 0], along: [0, 1, 0],
  widthM: 2, lengthM: 4, thicknessM: .2, youngPa: 1000, poisson: .25 };
const zero: Vector3 = [0, 0, 0];
function wrench(force: Vector3, moment: Vector3, energy: number): WeldLayerWrench {
  return { id: 'patch', forceOnAN: force, forceOnBN: [-force[0], -force[1], -force[2]],
    momentOnANm: moment, momentOnBNm: [-moment[0], -moment[1], -moment[2]], elasticEnergyJ: energy };
}
function near(actual: Vector3, expected: Vector3) {
  for (let i = 0; i < 3; i += 1) expect(Math.abs(actual[i]-expected[i])).toBeLessThanOrEqual(1e-6*Math.max(Math.abs(expected[i]), 1));
}
describe('矩形弾性のどの局所応力回復', () => {
  it.each([
    { name: '軸', force: [40, 0, 0] as const, energy: .02, stress: [5, 0, 0] },
    { name: '面内せん断', force: [0, 32, 0] as const, energy: .032, stress: [0, 4, 0] },
    { name: '面外せん断', force: [0, 0, -16] as const, energy: .008, stress: [0, 0, -2] },
  ])('$name: F/Aと独立energy、符号反転と無荷重', ({ force, energy, stress }) => {
    for (const factor of [-1, 0, 1]) {
      const f: Vector3 = [factor*force[0], factor*force[1], factor*force[2]];
      const result = recoverWeldPatchStress(patch, wrench(f, zero, factor*factor*energy), zero, zero);
      near(result.integralForceOnAN, f); near(result.integralMomentAtCenterNm, zero);
      for (const p of result.corners) {
        expect(p.normalPa).toBeCloseTo(factor*stress[0], 12);
        expect(p.shearAlongPa).toBeCloseTo(factor*stress[1], 12);
        expect(p.shearAcrossPa).toBeCloseTo(factor*stress[2], 12);
      }
      expect(result.structuralCertification).toBe(false);
    }
  });
  it('曲げ: sigma=-Mq*s/Is、4隅±5Paと面積分40/3Nm', () => {
    const result = recoverWeldPatchStress(patch, wrench(zero, [0, 0, 40/3], 1/150), zero, zero);
    near(result.integralForceOnAN, zero); near(result.integralMomentAtCenterNm, [0, 0, 40/3]);
    for (const p of result.corners) expect(p.normalPa).toBeCloseTo(-5*p.alongM, 12);
  });
  it('ねじり: tau_s=-2q、tau_q=2s、極二次モーメント40/3', () => {
    const result = recoverWeldPatchStress(patch, wrench(zero, [80/3, 0, 0], 1/75), zero, zero);
    near(result.integralMomentAtCenterNm, [80/3, 0, 0]);
    for (const p of result.corners) {
      expect(p.shearAlongPa).toBeCloseTo(-2*p.acrossM, 12);
      expect(p.shearAcrossPa).toBeCloseTo(2*p.alongM, 12);
    }
  });
  it('既知の回転と原点移動で局所応力不変、節点まわりのモーメントを混同しない', () => {
    // R(x,y,z)=(z,x,y), center=(4,-7,2), nodeA=(4,-7,1), nodeB=(4,-7,3)。
    const w = { ...patch, centerM: [4, -7, 2] as const, normal: [0, 1, 0] as const, along: [0, 0, 1] as const };
    const joint = { ...wrench([0, 40, 0], [-40, 0, 0], .02), momentOnBNm: [-40, 0, 0] as const };
    const result = recoverWeldPatchStress(w, joint, [4, -7, 1], [4, -7, 3]);
    for (const p of result.corners) expect(p.normalPa).toBeCloseTo(5, 12);
    near(result.integralForceOnAN, [0, 40, 0]); near(result.integralMomentAtCenterNm, zero);
  });
  it('不正有限値、寸法、frame、別patch、左右力とenergy改変を拒否し入力不変', () => {
    const good = wrench([40, 0, 0], zero, .02), before = structuredClone({ patch, good });
    for (const row of [{ ...patch, widthM: 0 }, { ...patch, poisson: .5 },
      { ...patch, youngPa: NaN }, { ...patch, normal: [2, 0, 0] as const }]) {
      expect(() => recoverWeldPatchStress(row, good, zero, zero)).toThrow('weld-stress');
    }
    for (const row of [{ ...good, id: 'foreign' }, { ...good, forceOnBN: [40, 0, 0] as const },
      { ...good, elasticEnergyJ: .03 }, { ...good, momentOnBNm: [0, 1, 0] as const }]) {
      expect(() => recoverWeldPatchStress(patch, row, zero, zero)).toThrow('weld-stress');
    }
    expect({ patch, good }).toEqual(before);
  });
  it('現在の入力に束縛した既存結果だけ回復し、古い厚さと改変応力を受理しない', async () => {
    const { geometry, supports, referenceLoads } = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
    const input: BeamWeldContactInput = { schema: 'pointercad-weld-layer/1',
      contact: { schema: 'pointercad-beam-contact/1', geometry, supports, referenceLoads,
        contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [-1, 0, 0], gapM: .001 }], loadFactors: [1] },
      welds: [{ id: 'patch', nodeIdA: 'node-0', nodeIdB: 'node-1', centerM: [1, 0, 0], normal: [1, 0, 0], along: [0, 1, 0],
        widthM: .01, lengthM: .01, thicknessM: .1, youngPa: 210e9, poisson: .3 }] };
    const u = 1000/420e6, hash = await beamWeldContactInputSha256(input);
    const result = decodeBeamWeldContact({ schema: 'pointercad-weld-layer-result/1',
      contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
        freeDofs: 1, meshNodes: 2, meshElements: 1, momentLengthM: 1, pivotLimit: 20,
        states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: .001, equilibriumResidual: 0,
          penetration: 0, tension: 0, complementarity: 0,
          nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
            { number: 2, displacementM: [u, 0, 0], rotationRad: [0, 0, 0] }],
          contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001-u }] }] },
      states: [{ loadFactor: 1, welds: [wrench([500, 0, 0], zero, 250*u)] }] }, input, hash);
    const before = structuredClone({ input, result });
    const recovered = await recoverWeldThroatStress(input, result);
    for (const corner of recovered[0].welds[0].corners) expect(corner.normalPa).toBeCloseTo(5e6, 6);
    await expect(recoverWeldThroatStress({ ...input, welds: [{ ...input.welds[0], thicknessM: .2 }] }, result)).rejects.toThrow('weld-stress-stale-result');
    const tampered = { ...result, states: result.states.map(state => ({ ...state,
      welds: state.welds.map(weld => ({ ...weld, elasticEnergyJ: 0 })) })) };
    await expect(recoverWeldThroatStress(input, tampered)).rejects.toThrow('weld-stress-stale-result');
    expect({ input, result }).toEqual(before);
  });
});

// Three independent parallel branches k=EA/L=E*A/t=210e6, external F=1000*f.
// With prescribed bolt shortening s: u=(F-k*s)/(3*k); the weld has no imposed strain.
describe('combined results keep their actual input identity before throat recovery', () => {
  it.each([false, true])('three independent force/zero/reversed states, initial strain=%s', async initial => {
    const source = initialStrainTestInput(initial ? 1e-6 : 0), raw = initialStrainTestRaw(initial ? 1e-6 : 0);
    const recovered = initial
      ? await recoverInitialStrainWeldThroatStress(source, decodeBeamJointInitialStrain(raw, source, await beamJointInitialStrainInputSha256(source)))
      : await recoverJointWeldThroatStress(source.joint, decodeBeamJointContact({ ...raw, schema: 'pointercad-joint-contact-result/1',
        states: raw.states.map(state => ({ ...state, bolts: state.bolts.map(b => ({ id: b.id, extensionM: b.extensionM,
          axialForceN: b.axialForceN, forceOnAN: b.forceOnAN, forceOnBN: b.forceOnBN })) })) }, source.joint, await beamJointContactInputSha256(source.joint)));
    for (const [i, factor] of [1, 0, -1].entries()) {
      const u = (1000*factor-210e6*(initial ? 1e-6 : 0))/(3*210e6), force = 210e6*u;
      const weld = recovered[i].welds[0];
      expect(recovered[i].loadFactor).toBe(factor);
      for (const axis of [0, 1, 2]) {
        expect(Math.abs(weld.integralForceOnAN[axis]-(axis === 0 ? force : 0))).toBeLessThanOrEqual(1e-8);
        expect(Math.abs(weld.integralMomentAtCenterNm[axis])).toBeLessThanOrEqual(1e-8);
      }
      const energy = 210e6*u*u/2;
      expect(Math.abs(weld.elasticEnergyJ-energy)).toBeLessThanOrEqual(1e-9*Math.max(energy, 1e-300));
      for (const corner of weld.corners) expect(corner.normalPa).toBeCloseTo(force/.001, 6);
    }
    if (initial) expect(recovered[1].welds[0].corners[0].normalPa).toBeCloseTo(-70_000, 8);
  });
  it('joint source/material/location/thickness and bolt stiffness changes refuse old results without mutation', async () => {
    const source = initialStrainTestInput(0).joint, encoded = initialStrainTestRaw(0);
    const raw = { ...encoded, schema: 'pointercad-joint-contact-result/1', states: encoded.states.map(state => ({ ...state,
      bolts: state.bolts.map(b => ({ id: b.id, extensionM: b.extensionM, axialForceN: b.axialForceN, forceOnAN: b.forceOnAN, forceOnBN: b.forceOnBN })) })) };
    const result = decodeBeamJointContact(raw, source, await beamJointContactInputSha256(source));
    const before = structuredClone({ source, result });
    for (const changed of [
      { ...source, contact: { ...source.contact, geometry: { ...source.contact.geometry, revision: source.contact.geometry.revision+1 } } },
      ...[{ youngPa: 200e9 }, { thicknessM: .5 }, { centerM: [1, .001, 0] as const }].map(patch => ({ ...source, welds: [{ ...source.welds[0], ...patch }] })),
      { ...source, bolts: [{ ...source.bolts[0], areaM2: .002 }] },
    ]) await expect(recoverJointWeldThroatStress(changed, result)).rejects.toThrow('weld-stress-stale-result');
    await expect(Reflect.apply(recoverJointWeldThroatStress, undefined, [source, { ...result, kind: 'oofem-beam-weld-layer-contact' }])).rejects.toThrow('weld-stress-stale-result');
    expect({ source, result }).toEqual(before);
  });
  it('initial shortening and altered forces/energy/hash cannot borrow the weld-only result contract', async () => {
    const source = initialStrainTestInput(), result = decodeBeamJointInitialStrain(initialStrainTestRaw(), source, await beamJointInitialStrainInputSha256(source));
    const before = structuredClone({ source, result });
    await expect(recoverInitialStrainWeldThroatStress(initialStrainTestInput(2e-6), result)).rejects.toThrow('weld-stress-stale-result');
    for (const changed of [{ ...result, inputSha256: '0'.repeat(64) }, { ...result,
      states: result.states.map(state => ({ ...state, welds: state.welds.map(w => ({ ...w, elasticEnergyJ: 0 })) })) }]) {
      await expect(recoverInitialStrainWeldThroatStress(source, changed)).rejects.toThrow('weld-stress-stale-result');
    }
    expect({ source, result }).toEqual(before);
  });
});
