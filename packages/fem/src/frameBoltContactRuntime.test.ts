import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readFrameBoltContact, type FrameBoltContactInput } from './beamBoltContact.js';
import { analyzeFrameBoltContact } from './frameBoltContactRuntime.js';
import type { PyodideRuntime } from './runtime.js';
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

const programs = { contactWrapper: Uint8Array.of(1, 2), boltWrapper: Uint8Array.of(3, 4), wheelLocation: '/fixed/oofem.whl' };
function expectedHash(value: FrameBoltContactInput): string {
  return createHash('sha256').update(JSON.stringify(readFrameBoltContact(value).input)).digest('hex');
}
function fake(encoded: unknown) {
  const events: string[] = [], files = new Map<string, string | Uint8Array>();
  const runPython = vi.fn<PyodideRuntime['runPython']>(() => { events.push('run'); return encoded; });
  const loadPackage = vi.fn<PyodideRuntime['loadPackage']>(() => { events.push('load'); return Promise.resolve(undefined); });
  const runtime: PyodideRuntime = { version: '0.29.3', loadPackage, runPython,
    FS: { mkdirTree: path => { events.push(`mkdir:${path}`); }, writeFile: (path, value) => { events.push(`write:${path}`); files.set(path, value); } } };
  return { runtime, events, files, runPython, loadPackage };
}

describe('frame bolt runtimeの実I/O契約（fakeでありnative試験ではない）', () => {
  it('元inputのhashとplan、2program bytes、integrityとphase順、専用Python入口を保持する', async () => {
    const value = input(), before = structuredClone(value), hash = expectedHash(value), f = fake(JSON.stringify(raw(hash)));
    const result = await analyzeFrameBoltContact(f.runtime, value, programs, phase => { f.events.push(`phase:${phase}`); });
    expect(f.events).toEqual(['phase:loading-packages', 'load', 'mkdir:/pcad_fem', 'write:/pcad_fem/frame-bolt-input.json',
      'write:/pcad_fem/beam_contact.py', 'write:/pcad_fem/beam_bolt_contact.py', 'phase:solving', 'run']);
    expect(f.loadPackage).toHaveBeenCalledExactlyOnceWith('/fixed/oofem.whl', { checkIntegrity: true });
    const envelope: unknown = JSON.parse(String(f.files.get('/pcad_fem/frame-bolt-input.json')));
    expect(envelope).toEqual({ inputSha256: hash, plan: readFrameBoltContact(value).plan });
    expect(f.files.get('/pcad_fem/beam_contact.py')).toBe(programs.contactWrapper);
    expect(f.files.get('/pcad_fem/beam_bolt_contact.py')).toBe(programs.boltWrapper);
    expect(f.runPython).toHaveBeenCalledExactlyOnceWith(`
import sys
sys.path.insert(0, '/pcad_fem')
from beam_bolt_contact import run_frame_bolt_contact
run_frame_bolt_contact()
`);
    expect(result.kind).toBe('frame-bolt-contact'); expect(result.inputSha256).toBe(hash);
    expect(result.states[0].axialForceN).toBeCloseTo(1000, 8); expect(result.states[0].elasticEnergyJ).toBeCloseTo(0.0025, 12);
    expect(value).toEqual(before);
  });
  it('不正入力はpackage/FS/Python/phaseより先に拒否する', async () => {
    const value = input(); Object.defineProperty(value, 'schema', { value: 'pointercad-bolt-contact/1' });
    const f = fake('{}');
    await expect(analyzeFrameBoltContact(f.runtime, value, programs, phase => { f.events.push(phase); })).rejects.toThrow('frame-schema');
    expect(f.events).toEqual([]); expect(f.files.size).toBe(0);
  });
  it.each([undefined, null, 42, {}, '{', ' '.repeat(4_000_001)])('非文字列・壊れJSON・上限超過を拒否する(%#)', async encoded => {
    const f = fake(encoded);
    await expect(analyzeFrameBoltContact(f.runtime, input(), programs, () => undefined)).rejects.toThrow();
    expect(f.runPython).toHaveBeenCalledTimes(1);
  });
  it('4,000,000文字ちょうどの有効JSONは境界内であり、超過とは混同しない', async () => {
    const value = input(), text = JSON.stringify(raw(expectedHash(value)));
    const f = fake(text + ' '.repeat(4_000_000 - text.length));
    expect((await analyzeFrameBoltContact(f.runtime, value, programs, () => undefined)).kind).toBe('frame-bolt-contact');
  });
  it.each(['schema', 'hash', 'old-axial'] as const)('異schema・hash・旧axialを新frame成功にしない(%s)', async reason => {
    const value = input(), response = raw(expectedHash(value));
    const encoded = reason === 'hash' ? { ...response, inputSha256: 'b'.repeat(64) }
      : { ...response, schema: reason === 'old-axial' ? 'pointercad-bolt-contact-result/1' : 'unknown' };
    await expect(analyzeFrameBoltContact(fake(JSON.stringify(encoded)).runtime, value, programs, () => undefined)).rejects.toThrow();
  });
  it.each(['wheel', 'solver'] as const)('%sの同じ例外を呼出し側へ渡す', async boundary => {
    const f = fake('{}'), failure = new Error(boundary), phases: string[] = [];
    if (boundary === 'wheel') f.loadPackage.mockRejectedValue(failure);
    else f.runPython.mockImplementation(() => { throw failure; });
    await expect(analyzeFrameBoltContact(f.runtime, input(), programs, phase => { phases.push(phase); })).rejects.toBe(failure);
    expect(phases).toEqual(boundary === 'wheel' ? ['loading-packages'] : ['loading-packages', 'solving']);
    expect(f.runPython).toHaveBeenCalledTimes(boundary === 'wheel' ? 0 : 1);
  });
});
