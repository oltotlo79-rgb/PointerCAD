import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { modalFixture } from './modal.testSupport.js';
import type { PyodideRuntime } from './runtime.js';
import { decodeBeamWeldSpanContact, translateBeamWeldSpanContact, type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import { analyzeBeamWeldSpanContact } from './beamWeldSpanContactRuntime.js';
import { isBeamWeldSpanContactResult, beamWeldSpanContactResultMatches } from './beamWeldSpanContactBinding.js';

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
const programs = () => ({ contactWrapper: new Uint8Array(readFileSync(new URL('./beamContact.py', import.meta.url))),
  spanWrapper: new Uint8Array(readFileSync(new URL('./beamWeldSpan.py', import.meta.url))),
  spanContactWrapper: new Uint8Array(readFileSync(new URL('./beamWeldSpanContact.py', import.meta.url))), wheelLocation: '/fixed/oofem.whl' });
const hash = (value: BeamWeldSpanContactInput) => createHash('sha256').update(JSON.stringify(translateBeamWeldSpanContact(value).input)).digest('hex');
function fake(encoded: unknown) {
  const events: string[] = [], files = new Map<string, string | Uint8Array>();
  const loadPackage = vi.fn<PyodideRuntime['loadPackage']>(() => { events.push('load'); return Promise.resolve(undefined); });
  const runPython = vi.fn<PyodideRuntime['runPython']>(() => { events.push('run'); return encoded; });
  const runtime: PyodideRuntime = { version: '0.29.3', loadPackage, runPython, FS: {
    mkdirTree: path => { events.push('mkdir:'+path); }, writeFile: (path, value) => { events.push('write:'+path); files.set(path, value); } } };
  return { runtime, events, files, loadPackage, runPython };
}
const phase = (f: ReturnType<typeof fake>) => (p: string) => { f.events.push('phase:'+p); };

describe('span runtime and binding pure I/O boundary (no native execution)', () => {
  it.each([1, 2])('uses the dedicated full-mesh decoder for independent %i-element input', async segments => {
    const value = input(segments), before = structuredClone(value), f = fake(JSON.stringify(raw(segments))), bytes = programs();
    const result = await analyzeBeamWeldSpanContact(f.runtime, value, bytes, phase(f));
    expect(result.states[0].meshNodes).toHaveLength(segments === 1 ? 4 : 6);
    expect(result.inputSha256).toBe(hash(value));
    expect(result.states[0].welds[0].forceOnFirstN[0]).toBe(segments === 1 ? 12/19 : 48/97);
    expect(result.states[0].welds[0].energyJ).toBe(segments === 1 ? 3/45125 : 159/2352250);
    expect(f.events).toEqual(['phase:loading-packages', 'load', 'mkdir:/pcad_fem', 'write:/pcad_fem/weld-span-contact-input.json',
      'write:/pcad_fem/beamContact.py', 'write:/pcad_fem/beamWeldSpan.py', 'write:/pcad_fem/beamWeldSpanContact.py', 'phase:solving', 'run']);
    expect(f.loadPackage).toHaveBeenCalledExactlyOnceWith('/fixed/oofem.whl', { checkIntegrity: true });
    const actualPlan: unknown = JSON.parse(String(f.files.get('/pcad_fem/weld-span-contact-input.json')));
    expect(actualPlan).toEqual(translateBeamWeldSpanContact(value).plan);
    expect(f.files.get('/pcad_fem/beamContact.py')).toEqual(bytes.contactWrapper);
    expect(f.files.get('/pcad_fem/beamWeldSpan.py')).toEqual(bytes.spanWrapper);
    expect(f.files.get('/pcad_fem/beamWeldSpanContact.py')).toEqual(bytes.spanContactWrapper);
    expect(f.runPython).toHaveBeenCalledExactlyOnceWith(`
import sys
sys.path.insert(0, '/pcad_fem')
from beamWeldSpanContact import run_beam_weld_span_contact
run_beam_weld_span_contact()
`);
    const python = new TextDecoder().decode(bytes.spanContactWrapper);
    expect(python).toContain("with open('/pcad_fem/weld-span-contact-input.json', encoding='utf-8')");
    expect(python).toContain('from beamContact import run_beam_contact');
    expect(python).toContain('from beamWeldSpan import WeldSpanKernel, _data');
    expect(value).toEqual(before);
    expect(isBeamWeldSpanContactResult(result)).toBe(true);
    expect(await beamWeldSpanContactResultMatches(result, value, hash(value))).toBe(true);
  });
  it('owns input and all three program bytes before its first await', async () => {
    const value = input(2), before = structuredClone(value), base = programs();
    const bytes = { ...base, contactWrapper: Buffer.from(base.contactWrapper) }, original = new Uint8Array(bytes.contactWrapper);
    const f = fake(JSON.stringify(raw(2))), pending = analyzeBeamWeldSpanContact(f.runtime, value, bytes, phase(f));
    Object.assign(value.contact.geometry, { revision: 999 }); Object.assign(value.patches[0], { thicknessM: .3 });
    bytes.contactWrapper.fill(0);
    const result = await pending;
    expect(result.inputSha256).toBe(hash(before));
    expect(result.contact.analysisRevision).toBe(before.contact.geometry.revision);
    expect(f.files.get('/pcad_fem/beamContact.py')).toEqual(original);
    expect(JSON.parse(String(f.files.get('/pcad_fem/weld-span-contact-input.json')))).toEqual(translateBeamWeldSpanContact(before).plan);
  });
  it('rejects invalid input before package, phase, FS or Python', async () => {
    const value = input(); Object.assign(value, { schema: 'old' }); const f = fake('{}');
    await expect(analyzeBeamWeldSpanContact(f.runtime, value, programs(), phase(f))).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it.each([null, undefined, 1, {}, '{', ' '.repeat(4_000_001)])('refuses non-string, malformed or oversized response (%#)', async encoded => {
    const f = fake(encoded);
    await expect(analyzeBeamWeldSpanContact(f.runtime, input(), programs(), phase(f))).rejects.toThrow();
    expect(f.runPython).toHaveBeenCalledTimes(1);
  });
  it('keeps the exact 4MB boundary while measuring UTF-8 bytes too', async () => {
    const encoded = JSON.stringify(raw()), padded = encoded+' '.repeat(4_000_000-encoded.length);
    expect((await analyzeBeamWeldSpanContact(fake(padded).runtime, input(), programs(), () => undefined)).kind).toBe('oofem-beam-weld-span-contact');
    await expect(analyzeBeamWeldSpanContact(fake('"'+'あ'.repeat(1_500_000)+'"').runtime, input(), programs(), () => undefined))
      .rejects.toThrow('Invalid bounded');
  });
  it.each(['internal', 'extra', 'nonfinite', 'old-schema', 'fake-hash'] as const)('rejects %s reply corruption', async reason => {
    const reply = raw(2);
    if (reason === 'internal') reply.states[0].meshNodes.pop();
    else if (reason === 'extra') Object.assign(reply.states[0], { extra: 0 });
    else if (reason === 'nonfinite') reply.states[0].meshNodes[4].displacementM[0] = Infinity;
    else if (reason === 'old-schema') reply.schema = 'pointercad-weld-layer-result/1';
    else Object.assign(reply, { inputSha256: 'b'.repeat(64) });
    await expect(analyzeBeamWeldSpanContact(fake(JSON.stringify(reply)).runtime, input(2), programs(), () => undefined)).rejects.toThrow();
  });
  it.each(['wheel', 'solver', 'FS', 'phase'] as const)('propagates the identical %s error without fallback', async where => {
    const f = fake('{}'), failure = new Error(where);
    if (where === 'wheel') f.loadPackage.mockRejectedValue(failure);
    if (where === 'solver') f.runPython.mockImplementation(() => { throw failure; });
    if (where === 'FS') f.runtime.FS.writeFile = () => { throw failure; };
    await expect(analyzeBeamWeldSpanContact(f.runtime, input(), programs(), p => { if (where === 'phase') throw failure; f.events.push(p); })).rejects.toBe(failure);
    expect(f.runPython).toHaveBeenCalledTimes(where === 'solver' ? 1 : 0);
  });
  it.each(['hash', 'revision', 'extra-top', 'extra-contact', 'extra-node', 'sparse', 'accessor', 'hidden', 'force', 'nan'] as const)(
    'full binding refuses %s without accepting a preliminary shape as proof', async reason => {
      const value = input(2), digest = hash(value), result = await decodeBeamWeldSpanContact(raw(2), value, digest);
      let calls = 0;
      if (reason === 'hash') Object.assign(result, { inputSha256: 'b'.repeat(64) });
      else if (reason === 'revision') Object.assign(value.contact.geometry, { revision: 2 });
      else if (reason === 'extra-top') Object.assign(result, { extra: 0 });
      else if (reason === 'extra-contact') Object.assign(result.contact, { extra: 0 });
      else if (reason === 'extra-node') Object.assign(result.states[0].meshNodes[4], { extra: 0 });
      else if (reason === 'sparse') Reflect.deleteProperty(result.states[0].meshNodes, '4');
      else if (reason === 'accessor') Object.defineProperty(result.states[0], 'meshNodes', { get() { calls++; return []; }, enumerable: true });
      else if (reason === 'hidden') Object.defineProperty(result, 'extra', { value: 0 });
      else if (reason === 'force') result.states[0].welds[0].first[4][0] = 0;
      else Object.assign(result.states[0].meshNodes[4].displacementM, { 0: NaN });
      expect(await beamWeldSpanContactResultMatches(result, value, digest)).toBe(false);
      expect(calls).toBe(0);
    });
  it('does not evaluate preliminary getters and snapshots result/input before async full verification', async () => {
    let calls = 0; const getter = { get kind() { calls++; return 'oofem-beam-weld-span-contact'; } };
    expect(isBeamWeldSpanContactResult(getter)).toBe(false); expect(calls).toBe(0);
    const value = input(), digest = hash(value), result = await decodeBeamWeldSpanContact(raw(), value, digest);
    const pending = beamWeldSpanContactResultMatches(result, value, digest);
    result.states.pop(); Object.assign(value.contact.geometry, { revision: 3 });
    expect(await pending).toBe(true);
    expect(await beamWeldSpanContactResultMatches(await decodeBeamWeldSpanContact(raw(), input(), hash(input())), input(), 'b'.repeat(64))).toBe(false);
  });
});
