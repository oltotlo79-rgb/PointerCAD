import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { modalFixture } from './modal.testSupport.js';
import type { PyodideRuntime } from './runtime.js';
import { translateBeamFrictionContact, type BeamFrictionContactInput } from './frictionContactTranslation.js';
import { type FrictionSolveOptions } from './frictionContactResults.js';
import { analyzeBeamFrictionContact } from './frictionContactRuntime.js';

function input(): BeamFrictionContactInput {
  const base = modalFixture({ free: true, modes: 1, segments: 1 });
  return { schema: 'pointercad-beam-friction-contact/1', geometry: { ...base,
    materials: base.materials.map(m => ({ ...m, youngModulus: 2e11, shearModulus: 8e10 })),
    sections: base.sections.map(s => ({ ...s, area: 1e-4, iy: 1e-8, iz: 1e-8, torsionConstant: 2e-8 })) },
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] },
      { nodeId: 'node-1', restrained: [false, false, false, true, true, true] }],
    contacts: [{ kind: 'node-plane', id: 'plane', nodeId: 'node-1', normal: [0, 1, 0], gapM: 0 }], friction: { plane: .3 },
    stepLoads: [[2, -10], [5, -10], [0, 0], [-5, -10]].map(([x, y], i) => [
      { id: 'load-'+i, kind: 'nodal', nodeId: 'node-1', force: [x, y, 0], moment: [0, 0, 0] }]) };
}
const options: FrictionSolveOptions = { solver: 'newton', iterationLimit: 64 };
const programs = () => ({ contactWrapper: Buffer.from([11, 12]), coreWrapper: new Uint8Array([21, 22]),
  runtimeWrapper: new Uint8Array([31, 32]), wheelLocation: '/fixed/oofem.whl' });
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(translateBeamFrictionContact(v).input)).digest('hex');
/** Hand-written guided axial spring oracle: EA/L=2e7, N10, muN3; this is mock I/O, not native evidence. */
function reply(opt = options) {
  const ux = [0, 1e-7, 0, -1e-7], normal = [10, 10, 0, 10], tx = [-2, -3, 0, 3];
  const increments = [0, 1e-7, -1e-7, -1e-7], accumulated = [0, 1e-7, 1e-7, 0];
  return { kind: 'pointercad-internal-friction-contact-candidate', solver: opt.solver, iterationLimit: opt.iterationLimit, freeDofs: 3,
    states: ux.map((x, step) => ({ step, iterations: 1, forceScaleN: 10, gapScaleM: 1,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, frictionConeExcess: 0, slipLawResidual: 0,
      nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
        { number: 2, displacementM: [x, 0, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'plane', state: step === 0 ? 'stick' : step === 2 ? 'open' : 'slip', frictionCoefficient: .3,
        normalReactionN: normal[step], gapM: 0, frictionForceN: [tx[step], 0, 0], slipIncrementM: [increments[step], 0, 0],
        accumulatedSlipM: [accumulated[step], 0, 0], slipPathLengthM: [0, 1e-7, 1e-7, 2e-7][step],
        dissipatedWorkJ: [0, 3e-7, 3e-7, 6e-7][step] }] })) };
}
function fake(encoded: unknown) {
  const events: string[] = [], files = new Map<string, string | Uint8Array>();
  const loadPackage = vi.fn<PyodideRuntime['loadPackage']>(() => { events.push('load'); return Promise.resolve(); });
  const runPython = vi.fn<PyodideRuntime['runPython']>(() => { events.push('run'); return encoded; });
  const runtime: PyodideRuntime = { version: '0.29.3', loadPackage, runPython, FS: {
    mkdirTree: p => { events.push('mkdir:'+p); }, writeFile: (p, v) => { events.push('write:'+p); files.set(p, v); } } };
  return { runtime, events, files, loadPackage, runPython };
}
const PYTHON = `
import json
import sys
import types
sys.path.insert(0, '/pcad_fem')
for _name in ('beamContact', 'beamFrictionContact', 'beamFrictionRuntime'):
    _path = '/pcad_fem/' + _name + '.py'
    _module = types.ModuleType(_name)
    _module.__file__ = _path
    _module.__package__ = ''
    sys.modules[_name] = _module
    with open(_path, encoding='utf-8') as _source:
        exec(compile(_source.read(), _path, 'exec'), _module.__dict__)
from beamFrictionRuntime import run_beam_friction_contact
with open('/pcad_fem/friction-contact-input.json', encoding='utf-8') as _stream:
    _job = json.load(_stream)
run_beam_friction_contact(_job['plan'], _job['friction'], _job['loads'], solver=_job['solver'], max_iterations=_job['max_iterations'])
`;

describe('friction runtime owned bounded I/O (mock runtime; no native execution)', () => {
  it.each(['newton', 'nsgs'] as const)('uses explicit %s and four ordered steps with exact zero unloading', async solver => {
    const opt = { solver, iterationLimit: 77 }, v = input(), p = programs(), f = fake(JSON.stringify(reply(opt)));
    const r = await analyzeBeamFrictionContact(f.runtime, v, p, opt, phase => { f.events.push('phase:'+phase); });
    expect(r.inputSha256).toBe(hash(v)); expect(r.states).toHaveLength(4);
    expect(r.states.map(s => s.nodes[1].displacementM[0])).toEqual([0, 1e-7, 0, -1e-7]);
    expect(r.states.map(s => s.contacts[0].frictionForceN[0])).toEqual([-2, -3, 0, 3]);
    expect(f.events).toEqual(['phase:loading-packages', 'load', 'mkdir:/pcad_fem', 'write:/pcad_fem/friction-contact-input.json',
      'write:/pcad_fem/beamContact.py', 'write:/pcad_fem/beamFrictionContact.py', 'write:/pcad_fem/beamFrictionRuntime.py', 'phase:solving', 'run']);
    expect(f.loadPackage).toHaveBeenCalledExactlyOnceWith('/fixed/oofem.whl', { checkIntegrity: true });
    const data: unknown = JSON.parse(String(f.files.get('/pcad_fem/friction-contact-input.json')));
    const t = translateBeamFrictionContact(v);
    expect(data).toEqual({ plan: t.plan, friction: { plane: .3 }, loads: [
      [0,0,0,0,0,0,2,-10,0,0,0,0], [0,0,0,0,0,0,5,-10,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,-5,-10,0,0,0,0]], solver, max_iterations: 77 });
    expect(f.runPython).toHaveBeenCalledExactlyOnceWith(PYTHON);
  });
  it('owns input options and all byte buffers before await, including a Node Buffer', async () => {
    const v = input(), before = structuredClone(v), opt = { ...options }, p = programs();
    const original = [new Uint8Array(p.contactWrapper), new Uint8Array(p.coreWrapper), new Uint8Array(p.runtimeWrapper)];
    const f = fake(JSON.stringify(reply())), pending = analyzeBeamFrictionContact(f.runtime, v, p, opt, () => undefined);
    Object.assign(v.geometry, { revision: 999 }); Object.assign(v.friction, { plane: 9 });
    Object.assign(v.stepLoads[0][0], { force: [999, 0, 0] }); opt.iterationLimit = 999;
    p.contactWrapper.fill(0); p.coreWrapper.fill(0); p.runtimeWrapper.fill(0); p.wheelLocation = 'changed';
    const r = await pending;
    expect(r.inputSha256).toBe(hash(before)); expect(r.iterationLimit).toBe(64);
    expect(f.loadPackage).toHaveBeenCalledExactlyOnceWith('/fixed/oofem.whl', { checkIntegrity: true });
    for (const [i, name] of ['beamContact.py', 'beamFrictionContact.py', 'beamFrictionRuntime.py'].entries())
      expect(f.files.get('/pcad_fem/'+name)).toEqual(original[i]);
  });
  it('rejects invalid input before any phase or native preparation', async () => {
    const f = fake('{}'); await expect(analyzeBeamFrictionContact(f.runtime, {}, programs(), options, () => undefined)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it.each([undefined, null, {}, { solver: 'newton', iterationLimit: 1, extra: 0 },
    { solver: 'other', iterationLimit: 1 }, { solver: 'newton', iterationLimit: 0 },
    { solver: 'newton', iterationLimit: 1.5 }, { solver: 'newton', iterationLimit: Infinity },
    { solver: 'newton', iterationLimit: Number.MAX_SAFE_INTEGER + 1 }, { solver: 'newton', iterationLimit: true }])(
    'rejects invalid explicit options before package loading (%#)', async bad => {
      const f = fake('{}');
      await expect(analyzeBeamFrictionContact(f.runtime, input(), programs(), bad as FrictionSolveOptions, () => undefined)).rejects.toThrow();
      expect(f.events).toEqual([]);
    });
  it('refuses options getters without evaluating them', async () => {
    let calls = 0; const bad = { get solver() { calls++; return 'newton'; }, iterationLimit: 1 }, f = fake('{}');
    await expect(analyzeBeamFrictionContact(f.runtime, input(), programs(), bad as FrictionSolveOptions, () => undefined)).rejects.toThrow();
    expect(calls).toBe(0); expect(f.events).toEqual([]);
  });
  it('rejects empty program bytes before package loading', async () => {
    const f = fake('{}'); await expect(analyzeBeamFrictionContact(f.runtime, input(), { ...programs(), coreWrapper: new Uint8Array() }, options, () => undefined)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it.each([null, undefined, 1, {}, '{', ' '.repeat(4_000_001), '"'+'あ'.repeat(1_500_000)+'"'])('rejects invalid bounded response (%#)', async encoded => {
    const f = fake(encoded); await expect(analyzeBeamFrictionContact(f.runtime, input(), programs(), options, () => undefined)).rejects.toThrow();
    expect(f.runPython).toHaveBeenCalledTimes(1);
  });
  it('accepts the exact four-million-byte boundary', async () => {
    const encoded = JSON.stringify(reply()), padded = encoded+' '.repeat(4_000_000-encoded.length);
    expect((await analyzeBeamFrictionContact(fake(padded).runtime, input(), programs(), options, () => undefined)).states).toHaveLength(4);
  });
  it.each(['step', 'solver', 'extra', 'missing', 'support'] as const)('rejects malformed %s via the actual decoder', async issue => {
    const raw = reply();
    if (issue === 'step') raw.states[1].step = 0;
    if (issue === 'solver') raw.solver = 'nsgs';
    if (issue === 'extra') Object.assign(raw, { extra: 0 });
    if (issue === 'missing') raw.states.pop();
    if (issue === 'support') raw.states[0].nodes[0].displacementM[0] = 1;
    await expect(analyzeBeamFrictionContact(fake(JSON.stringify(raw)).runtime, input(), programs(), options, () => undefined)).rejects.toThrow();
  });
  it.each(['loader', 'solver', 'FS', 'phase'] as const)('propagates identical %s failure', async issue => {
    const f = fake('{}'), error = new Error(issue);
    if (issue === 'loader') f.loadPackage.mockRejectedValue(error);
    if (issue === 'solver') f.runPython.mockImplementation(() => { throw error; });
    if (issue === 'FS') f.runtime.FS.writeFile = () => { throw error; };
    await expect(analyzeBeamFrictionContact(f.runtime, input(), programs(), options, () => { if (issue === 'phase') throw error; })).rejects.toBe(error);
    expect(f.runPython).toHaveBeenCalledTimes(issue === 'solver' ? 1 : 0);
  });
});
