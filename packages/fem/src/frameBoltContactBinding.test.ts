import { describe, expect, it, vi } from 'vitest';
import { decodeFrameBoltContact, frameBoltContactInputSha256, type FrameBoltContactInput } from './beamBoltContact.js';
import { isFrameBoltContactResult, frameBoltContactResultMatches } from './frameBoltContactBinding.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';

const source = { kind: 'user-supplied', reference: 'Independent synthetic frame fixture', condition: 'Linear centroidal Timoshenko shank only' } as const;
const quantity = (role: string, value: number) => ({ role, value, source });
function input(): FrameBoltContactInput {
  const base = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
  return { schema: 'pointercad-frame-bolt-contact/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base.geometry, nodes: [{ id: 'node-0', position: [0, 0, 0] }, { id: 'node-1', position: [0.1, 0, 0] }],
      materials: base.geometry.materials.map(m => ({ ...m, youngModulus: 200e9, shearModulus: 80e9 })),
      sections: base.geometry.sections.map(s => ({ ...s, area: 1e-4, iy: 1e-8, iz: 1e-8, torsionConstant: 2e-8, shearFactor: 5 / 6 })) },
    supports: [base.supports[0]], referenceLoads: base.referenceLoads,
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [1, 0, 0], gapM: 0.001 }], loadFactors: [1] },
    bolt: { id: 'frame-bolt', memberId: 'member-0', model: 'centroidal-frame-shank-explicit-end-coupling', couplingSource: source,
      shorteningM: quantity('shortening-m', 0), threadCompliance: quantity('thread-compliance-m-per-n', 0),
      headCompliance: quantity('head-compliance-m-per-n', 0), bearingCompliance: quantity('bearing-compliance-m-per-n', 0),
      section: { materialConditionId: 'synthetic', tensileArea: quantity('tensile-area-m2', 8e-5), shearArea: quantity('plain-shank-shear-area-m2', 1e-4),
        modulusY: quantity('section-modulus-y-m3', 2e-6), modulusZ: quantity('section-modulus-z-m3', 2e-6),
        fibreYM: quantity('extreme-y-m', 0.005), fibreZM: quantity('extreme-z-m', 0.005), limits: null } } };
}
/** 手計算: EA/L=200e6 N/m、F=1000 N、u=5e-6 m、U=Fu/2=.0025 J。nativeの再生ではない。 */
function raw(hash: string) {
  return { schema: 'pointercad-frame-bolt-contact-result/1', inputSha256: hash,
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 6, meshNodes: 2, meshElements: 1, momentLengthM: 0.1, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: 0.001, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0,
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
          { number: 2, displacementM: [5e-6, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: 0.001005 }] }] },
    states: [{ loadFactor: 1, boltId: 'frame-bolt', member: 1, forceOnAN: [1000, 0, 0], forceOnBN: [-1000, 0, 0],
      momentOnANm: [0, 0, 0], momentOnBNm: [0, 0, 0], axialForceN: 1000, shearYN: 0, shearZN: 0,
      bendingYNm: 0, bendingZNm: 0, elasticEnergyJ: 0.0025, transverseEnergyJ: 0 }] };
}

describe('frame bolt結果の軽い識別と元input/hashによる完全照合', () => {
  it('独立した軸剛性fixtureを完全照合し、入力と結果を変更しない', async () => {
    const value = input(), hash = await frameBoltContactInputSha256(value), result = decodeFrameBoltContact(raw(hash), value, hash);
    const before = structuredClone({ value, result });
    expect(result.states[0].axialForceN).toBeCloseTo(1000, 8); expect(result.states[0].assessment.tension.stressPa).toBeCloseTo(12_500_000, 5);
    expect(isFrameBoltContactResult(result)).toBe(true); expect(frameBoltContactResultMatches(result, value, hash)).toBe(true);
    expect({ value, result }).toEqual(before);
    // 属性挿入順だけは結果を変えない。
    expect(frameBoltContactResultMatches(Object.fromEntries(Object.entries(result).reverse()), value, hash)).toBe(true);
  });
  it('識別だけでは力改変を認証せず、全照合は微小な改変も拒否する', async () => {
    const value = input(), hash = await frameBoltContactInputSha256(value), result = decodeFrameBoltContact(raw(hash), value, hash);
    const changed = { ...result, states: [{ ...result.states[0], axialForceN: result.states[0].axialForceN + 1e-7 }] };
    expect(isFrameBoltContactResult(changed)).toBe(true); expect(frameBoltContactResultMatches(changed, value, hash)).toBe(false);
  });
  it.each(['root-extra', 'state-extra', 'contact-extra', 'assessment', 'sparse', 'symbol', 'nonfinite', 'prototype'] as const)('余剰/導出改変/疎配列/不正dataを拒否する(%s)', async reason => {
    const value = input(), hash = await frameBoltContactInputSha256(value), result = decodeFrameBoltContact(raw(hash), value, hash);
    if (reason === 'root-extra') Object.defineProperty(result, 'extra', { value: 1 });
    if (reason === 'state-extra') Object.defineProperty(result.states[0], 'extra', { value: 1 });
    if (reason === 'contact-extra') Object.defineProperty(result.contact, 'extra', { value: 1 });
    if (reason === 'assessment') Object.defineProperty(result.states[0].assessment.tension, 'stressPa', { value: 12_500_001 });
    if (reason === 'sparse') Reflect.deleteProperty(result.states[0].forceOnAN, '1');
    if (reason === 'symbol') Object.defineProperty(result, Symbol('extra'), { value: 1 });
    if (reason === 'nonfinite') Object.defineProperty(result.states[0], 'axialForceN', { value: NaN });
    if (reason === 'prototype') Object.setPrototypeOf(result, { inherited: 1 });
    expect(frameBoltContactResultMatches(result, value, hash)).toBe(false);
  });
  it.each(['kind', 'contact', 'state', 'array'] as const)('accessorを実行せず拒否する(%s)', async boundary => {
    const value = input(), hash = await frameBoltContactInputSha256(value), result = decodeFrameBoltContact(raw(hash), value, hash);
    const getter = vi.fn(() => { throw new Error('getter must not execute'); });
    if (boundary === 'kind') Object.defineProperty(result, 'kind', { get: getter });
    if (boundary === 'contact') Object.defineProperty(result.contact, 'states', { get: getter });
    if (boundary === 'state') Object.defineProperty(result.states[0], 'axialForceN', { get: getter });
    if (boundary === 'array') Object.defineProperty(result.states[0].forceOnAN, 0, { get: getter });
    expect(frameBoltContactResultMatches(result, value, hash)).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
  it('旧schema・hash・source/revision・変更された元入力への転用を拒否する', async () => {
    const value = input(), hash = await frameBoltContactInputSha256(value), result = decodeFrameBoltContact(raw(hash), value, hash);
    expect(isFrameBoltContactResult({ ...result, kind: 'oofem-beam-axial-bolt-contact', schema: 'pointercad-bolt-contact-result/1' })).toBe(false);
    expect(frameBoltContactResultMatches(result, value, 'b'.repeat(64))).toBe(false);
    expect(frameBoltContactResultMatches({ ...result, inputSha256: 'b'.repeat(64) }, value, hash)).toBe(false);
    expect(frameBoltContactResultMatches({ ...result, analysisRevision: result.analysisRevision + 1 }, value, hash)).toBe(false);
    const changed = { ...value, contact: { ...value.contact, geometry: { ...value.contact.geometry, revision: value.contact.geometry.revision + 1 } } };
    expect(frameBoltContactResultMatches(result, changed, await frameBoltContactInputSha256(changed))).toBe(false);
    const compliance = { ...value, bolt: { ...value.bolt, threadCompliance: { ...value.bolt.threadCompliance, value: 5e-9 } } };
    expect(frameBoltContactResultMatches(result, compliance, await frameBoltContactInputSha256(compliance))).toBe(false);
  });
});
