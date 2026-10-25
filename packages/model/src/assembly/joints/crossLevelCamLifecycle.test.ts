import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { runCooperative } from '../constraints/cooperativeRigid.js';
import { drainRigidSteps } from '../constraints/solveRigid.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Joint, Placement } from '../types.js';
import {
  crossLevelCamDocumentFailure, crossLevelCamTreeFailure, evaluateCrossLevelCamCouplings, pruneCrossLevelCams,
  solveCrossLevelCamFollow, solveCrossLevelCamFollowSteps, type CrossLevelCamCouplingDefinition,
} from './crossLevelCamLifecycle.js';
import type { CrossLevelGearCouplingDefinition } from './crossLevelGearDocument.js';

/*
 * Saved cross-level cams with hand-computed numbers. R = 20, e = 5, r = 4, phase = camPhase = 30 degrees,
 * offset -10, direction -1: rho(theta) = 5 cos(theta - 30) + sqrt(24^2 - 25 sin^2(theta - 30)), so rho(30) = 29,
 * rho(120) = sqrt(551) = 23.4733..., rho(210) = 19, and the follower translation x = -(rho - 10) is -19, 10 - sqrt(551)
 * and -9. The parent: fixed `ground`, subassembly placements A (revolute `cam`) and B (revolute `spin`), a part `rod` on
 * the slider `lift`. The child: fixed `base`, `follower` on the slider `push` (at most 25 mm, no lower limit, along the
 * origin z axes, so the follower's z in the child is the translation) and `knob` on the revolute `twist`. Fixture
 * times are historical fixture data.
 */
function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: kind === 'slider' ? { ...expressionValueFromNumber(25), source: '25' } : null, suppressed: false };
}
const num = (value: number): ExpressionValue => expressionValueFromNumber(value);
const source = (text: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source: text });

const CAM: CrossLevelCamCouplingDefinition = { id: 'k1', kind: 'crossLevelCam', camJointId: 'cam', childPath: ['A'], childJointId: 'push',
  discRadiusMm: num(20), eccentricityMm: num(5), rollerRadiusMm: num(4), phaseDeg: source('camPhase', 999), offsetMm: num(-10),
  direction: -1, suppressed: false };
const cam = (overrides: Partial<CrossLevelCamCouplingDefinition> = {}): CrossLevelCamCouplingDefinition => ({ ...CAM, ...overrides });
const GEAR: CrossLevelGearCouplingDefinition = { id: 'g1', kind: 'crossLevelGear', parentJointId: 'spin', childPath: ['B'],
  childJointId: 'twist', ratio: num(2), phaseDeg: num(0), suppressed: false };

async function fixture(cams: readonly CrossLevelCamCouplingDefinition[], extra: Partial<AssemblyDocument> = {}) {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const child: AssemblyDocument = { ...createAssemblyDocument('cam child'),
    components: [component('base', part, placement(0, 0, 0), true), component('follower', part, placement(0, 0, 0)),
      component('knob', part, placement(0, 0, 0))],
    joints: [joint('push', 'slider', 'follower', 'base'), joint('twist', 'revolute', 'knob', 'base')] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'),
    parameters: [{ name: 'camPhase', value: num(30), unit: 'none', description: '' }],
    components: [component('ground', part, placement(10, 20, 0), true),
      component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0)),
      component('B', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0)),
      component('rod', part, placement(10, 20, 0))],
    joints: [joint('cam', 'revolute', 'A', 'ground'), joint('spin', 'revolute', 'B', 'ground'), joint('lift', 'slider', 'rod', 'ground')],
    crossLevelCamCouplings: cams, ...extra };
  const inputs: JointOccurrenceInputs = { document, library, subAssemblies };
  const view: JointOccurrenceView = { source: inputs, resolved: resolveAssembly(document, { library, subAssemblies }) };
  return { document, inputs, view, subAssemblies };
}

describe('saved cross-level cam: evaluation and the authored law', () => {
  it('follows cooperatively with the same result and discards a cancelled solve of the shared child', async () => {
    const f = await fixture([CAM]);
    const before = structuredClone(f);
    const evaluated = evaluateCrossLevelCamCouplings(f.document);
    if (!evaluated.ok) throw new Error(evaluated.code);
    const input = { inputs: f.inputs, view: f.view, cams: evaluated.cams, couplingId: 'k1', camAngle: 120 };
    const expected = solveCrossLevelCamFollow(input);
    expect(expected.ok).toBe(true);
    expect(drainRigidSteps(solveCrossLevelCamFollowSteps(input, { units: 1 }))).toEqual(expected);
    for (const cancel of [true, false]) {
      const queue: (() => void)[] = [];
      const run = runCooperative(solveCrossLevelCamFollowSteps(input, { units: 1 }),
        { pointsPerSlice: 1, schedule: slice => { queue.push(slice); } });
      let published = 0;
      const result = run.result.then(value => { if (value.status === 'completed') published += 1; return value; });
      queue.shift()?.();
      queue.shift()?.();
      if (cancel) run.cancel();
      while (queue.length > 0) queue.shift()?.();
      expect(await result).toEqual(cancel ? { status: 'cancelled', progress: run.progress() }
        : { status: 'completed', value: expected });
      expect(published).toBe(cancel ? 0 : 1);
      expect(f).toEqual(before);
    }
  });

  it('evaluates the authored sources (a parameter phase, not the stale stored number) and places the follower by hand', async () => {
    const f = await fixture([CAM]);
    const evaluated = evaluateCrossLevelCamCouplings(f.document);
    if (!evaluated.ok) throw new Error(evaluated.code);
    expect(evaluated.cams).toEqual([{ id: 'k1', camJointId: 'cam', child: { path: ['A'], jointId: 'push' }, discRadiusMm: 20,
      eccentricityMm: 5, rollerRadiusMm: 4, phaseDeg: 30, direction: -1, offsetMm: -10 }]);
    for (const [theta, x] of [[30, -19], [120, 10 - Math.sqrt(551)], [210, -9]] as const) {
      const follow = solveCrossLevelCamFollow({ inputs: f.inputs, view: f.view, cams: evaluated.cams, couplingId: 'k1', camAngle: theta });
      if (!follow.ok) throw new Error(`refused ${follow.code}`);
      expect(follow.path).toEqual(['A']);
      expect(follow.translation).toBeCloseTo(x, 6);
      const at = follow.outcome.placements.get('follower')?.position ?? [];
      [10, 20, x].forEach((value, axis) => expect(at[axis]).toBeCloseTo(value, 6));
    }
  });

  it('refuses a law value beyond the child range instead of stopping the follower at its limit', async () => {
    // direction +1, offset +10: 29 + 10 = 39 at 30 degrees, beyond the slider maximum 25; 19 + 10 = 29 at 210 too.
    const f = await fixture([cam({ direction: 1, offsetMm: num(10) })]);
    const evaluated = evaluateCrossLevelCamCouplings(f.document);
    if (!evaluated.ok) throw new Error(evaluated.code);
    for (const theta of [30, 210]) {
      expect(solveCrossLevelCamFollow({ inputs: f.inputs, view: f.view, cams: evaluated.cams, couplingId: 'k1', camAngle: theta }))
        .toEqual({ ok: false, couplingId: 'k1', code: 'child-at-limit' });
    }
    // direction +1, offset -10: 9 at 210 (rho 19) is inside [.., 25]; 19 at 30 also.
    const inside = await fixture([cam({ direction: 1 })]);
    const ok = evaluateCrossLevelCamCouplings(inside.document);
    if (!ok.ok) throw new Error(ok.code);
    const follow = solveCrossLevelCamFollow({ inputs: inside.inputs, view: inside.view, cams: ok.cams, couplingId: 'k1', camAngle: 210 });
    expect(follow.ok && follow.translation).toBeCloseTo(9, 6);
  });
});

describe('saved cross-level cam: document and tree admission', () => {
  it('admits a valid cam beside a gear on another placement and refuses each broken reference explicitly', async () => {
    const f = await fixture([CAM], { crossLevelGearCouplings: [GEAR] });
    expect(crossLevelCamTreeFailure(f.document, f.subAssemblies)).toBeNull();
    const code = (cams: readonly CrossLevelCamCouplingDefinition[], extra: Partial<AssemblyDocument> = {}) =>
      crossLevelCamTreeFailure({ ...f.document, crossLevelCamCouplings: cams, ...extra }, f.subAssemblies)?.code;
    expect(code([cam({ discRadiusMm: source('missingParameter', 20) })])).toBe('invalid-expression');
    expect(code([cam({ eccentricityMm: num(24) })])).toBe('invalid-cam-dimensions');
    expect(code([cam({ rollerRadiusMm: num(-1) })])).toBe('invalid-cam-dimensions');
    expect(code([cam({ discRadiusMm: num(0) })])).toBe('invalid-cam-dimensions');
    expect(code([cam({ camJointId: 'absent' })])).toBe('missing-parent-joint');
    expect(code([cam({ camJointId: 'lift' })])).toBe('unsupported-parent-joint');
    expect(code([cam({ childPath: [] })])).toBe('invalid-path');
    expect(code([cam({ childPath: ['ground'] })])).toBe('not-subassembly');
    expect(code([cam({ childPath: ['nowhere'] })])).toBe('missing-component');
    expect(code([cam({ childJointId: 'twist' })])).toBe('unsupported-child-joint');
    expect(code([cam({ childJointId: 'none' })])).toBe('missing-child-joint');
    expect(code([CAM, cam()])).toBe('duplicate-coupling');
    expect(code([cam({ id: 'g1' })])).toBe('invalid-id');
    expect(code([cam({ id: '' })])).toBe('invalid-id');
    // One relation per placement and per parent joint, across gears and cams (B already carries g1).
    expect(code([cam({ childPath: ['B'], camJointId: 'cam' })])).toBe('duplicate-occurrence');
    expect(code([cam({ camJointId: 'spin' })])).toBe('coupled-parent-joint');
    expect(code([CAM, cam({ id: 'k2', childPath: ['B'] })], { crossLevelGearCouplings: [] })).toBe('coupled-parent-joint');
    expect(code([CAM], { mechanismCouplings: [{ id: 'same', kind: 'gear', jointAId: 'cam', jointBId: 'spin', ratio: num(1),
      phaseDeg: num(0), referenceAngleA: 0, suppressed: false }], crossLevelGearCouplings: [] })).toBe('coupled-parent-joint');
    // A suppressed definition keeps its references checked but takes neither the joint nor the placement.
    expect(code([cam({ suppressed: true, childPath: ['B'] }), cam({ id: 'k2' })])).toBeUndefined();
    expect(crossLevelCamDocumentFailure({ ...f.document, crossLevelCamCouplings: [] })).toBeNull();
  });

  it('suspends a cam whose cam joint was suppressed and removes one whose follower joint is gone, in order', async () => {
    const f = await fixture([CAM, cam({ id: 'k2', camJointId: 'spin', childPath: ['B'] })]);
    const suppressedCam = { ...f.document, joints: f.document.joints.map(item => item.id === 'cam' ? { ...item, suppressed: true } : item) };
    const suspended = pruneCrossLevelCams(suppressedCam, f.subAssemblies);
    expect(suspended.repairs).toEqual([{ couplingId: 'k1', code: 'missing-parent-joint', action: 'suspended' }]);
    expect(suspended.document.crossLevelCamCouplings?.map(c => [c.id, c.suppressed])).toEqual([['k1', true], ['k2', false]]);
    const child = f.subAssemblies.get('child');
    if (child === undefined) throw new Error('fixture child');
    const withoutPush = new Map([['child', { ...child, joints: child.joints.filter(item => item.id !== 'push') }]]);
    const removed = pruneCrossLevelCams(f.document, withoutPush);
    expect(removed.repairs).toEqual([{ couplingId: 'k1', code: 'missing-child-joint', action: 'removed' },
      { couplingId: 'k2', code: 'missing-child-joint', action: 'removed' }]);
    expect(removed.document.crossLevelCamCouplings).toEqual([]);
    const unchanged = pruneCrossLevelCams(f.document, f.subAssemblies);
    expect(unchanged.document).toBe(f.document);
    expect(unchanged.repairs).toEqual([]);
  });
});
