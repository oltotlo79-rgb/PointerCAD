import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { readAssemblyDocument, writeAssemblyDocument } from '@pointercad/io';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  jointFramePairFromTargets, resolveAssembly, resolveMateTarget, type AssemblyComponent, type AssemblyDocument,
  type ComponentSource, type CrossLevelCamCouplingDefinition, type Joint, type JointOccurrenceInputs, type PartLibrary,
  type Placement, type PresentationStep, type PrimitiveFeature, type Quaternion, type RigidPlacement,
} from '@pointercad/model';
import { AssemblyCrossLevelCamForm } from '../assembly/AssemblyCrossLevelCamForm.js';
import { AssemblyCrossLevelGearRepairs } from '../assembly/AssemblyCrossLevelGearRepairs.js';
import { deleteAssemblyComponents } from '../assembly/placeComponentActions.js';
import { t } from '../i18n/t.js';
import { crossLevelDragRefusal, currentOccurrenceDrive, jointValueKey } from './assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * The saved cross-level cam at the public store entrypoints. Written by hand: a fixed `ground` at P = (10, 20, 0); a
 * part `hub` at P on the revolute `spin` (hub = a, ground = b); the child `camChild` placed as A at P on the revolute
 * `cam` (A = a, hub = b) and as B at (10, 20, 10) on the slider `lift` (B = a, ground = b). camChild has a fixed `base`,
 * a `follower` on the slider `push` along the origin z axes (follower = a, at most 25 mm, 15 in the limited fixture; no
 * lower limit) and a `knob` on the revolute `twist`. Saved cam k1: cam -> A/push with R = 20, e = 5, r = 4, phase 0,
 * offset -10, direction +1. With phase 0 the law is even in the cam angle, so it does not depend on the joint's sign
 * convention: x(theta) = 5 cos(theta) + sqrt(24^2 - 25 sin^2(theta)) - 10, x(0) = 19, x(90) = sqrt(551) - 10 = 13.4733...,
 * x(180) = 9. A rotation about z keeps a z offset, so the follower's world position is (10, 20, x) (+10 in z for B).
 * Driving spin turns the hub while nothing holds A to it, so the cam joint is turned INDIRECTLY (as in the gear motion
 * test). k2 (for the deletion case): spin -> B/push with the same law.
 */
const P = [10, 20, 0] as const;
function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string, max: ExpressionValue | null = null): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: max, suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
const cam = (overrides: Partial<CrossLevelCamCouplingDefinition> = {}): CrossLevelCamCouplingDefinition => ({ id: 'k1', kind: 'crossLevelCam',
  camJointId: 'cam', childPath: ['A'], childJointId: 'push', discRadiusMm: expression('20', 20), eccentricityMm: expression('5', 5),
  rollerRadiusMm: expression('4', 4), phaseDeg: expression('0', 0), offsetMm: expression('-10', -10), direction: 1, suppressed: false,
  ...overrides });
const K1 = cam(), K2 = cam({ id: 'k2', camJointId: 'spin', childPath: ['B'] });
/** The hand law with phase 0 (independent of the implementation's camFollowerLift). */
const law = (degrees: number): number => {
  const theta = degrees * Math.PI / 180;
  return 5 * Math.cos(theta) + Math.sqrt(24 * 24 - 25 * Math.sin(theta) ** 2) - 10;
};
const store = () => useAppStore.getState();
let library: PartLibrary = EMPTY_PART_LIBRARY;

async function open(options: { readonly cams?: readonly CrossLevelCamCouplingDefinition[]; readonly max?: number;
  readonly steps?: readonly PresentationStep[] } = {}): Promise<AssemblyDocument | null> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const max = options.max ?? 25;
  const camChild: AssemblyDocument = { ...createAssemblyDocument('camChild'),
    components: [component('base', part, placement(0, 0, 0), true), component('follower', part, placement(0, 0, 0)),
      component('knob', part, placement(0, 0, 0))],
    joints: [joint('push', 'slider', 'follower', 'base', expression(String(max), max)), joint('twist', 'revolute', 'knob', 'base')] };
  library = { ...embedded.library, assemblies: new Map([['camChild', camChild]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(...P), true), component('hub', part, placement(...P)),
    component('A', { kind: 'subAssembly', assemblyRef: 'camChild' }, placement(...P)),
    component('B', { kind: 'subAssembly', assemblyRef: 'camChild' }, placement(10, 20, 10)),
  ], joints: [joint('spin', 'revolute', 'hub', 'ground'), joint('cam', 'revolute', 'A', 'hub'), joint('lift', 'slider', 'B', 'ground')],
    presentation: options.steps ?? [] };
  store().openAssembly(document, library);
  const opened = store().assembly;
  const cams = options.cams ?? [K1];
  if (cams.length > 0) expect(store().setAssemblyCrossLevelCams(cams)).toBe(true);
  publishView();
  return opened;
}

/** Stands in for attachAssembly's publication of the solved view of the current document (frames from its targets). */
function publishView(): void {
  const document = store().assembly;
  if (document === null) throw new Error('document');
  const subAssemblies = library.assemblies ?? new Map<string, AssemblyDocument>();
  const resolved = resolveAssembly(document, { library, subAssemblies });
  const frames = new Map(document.joints.flatMap(item => {
    const a = resolveMateTarget(item.a, resolved), b = resolveMateTarget(item.b, resolved);
    const pair = a.ok && b.ok ? jointFramePairFromTargets(item, { a: a.target, b: b.target }, resolved.placements) : null;
    return pair === null ? [] : [[item.id, pair] as const];
  }));
  const source: JointOccurrenceInputs = { document, library, subAssemblies };
  useAppStore.setState({ assemblyView: { sourceDocument: document, source, resolved, bodies: new Map(), appearances: new Map(),
    diagnosis: null, mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: frames } });
}

function zDegrees(rotation: Quaternion | undefined): number {
  const [x, y, z, w] = rotation ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) * 180 / Math.PI;
}
/** The cam angle on the shown poses (A relative to the hub, up to the sign), with the follower of A at the hand law. */
function expectLawShown(): number {
  const state = store();
  const placements = state.assemblyMotionPlacements;
  const difference = zDegrees(placements?.get('A')?.rotation) - zDegrees(placements?.get('hub')?.rotation);
  // Into (-180, 180] before the sign is dropped (each zDegrees is already in that range).
  const relative = Math.abs(difference > 180 ? difference - 360 : difference <= -180 ? difference + 360 : difference);
  const drive = currentOccurrenceDrive(state, ['A']);
  const at = drive?.placements.get('follower')?.position ?? [];
  [10, 20, law(relative)].forEach((value, axis) => expect(at[axis]).toBeCloseTo(value, 6));
  expect(drive?.values.get(jointValueKey('push', 'translation'))).toBeCloseTo(law(relative), 6);
  return relative;
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('cross-level cam lifecycle in the store', () => {
  it('creates, edits and removes a saved definition as single Undo steps', async () => {
    const opened = await open({ cams: [] });
    expect(store().setAssemblyCrossLevelCams([K1])).toBe(true);
    const created = store().assembly;
    expect(created?.crossLevelCamCouplings).toEqual([K1]);
    expect(store().setAssemblyCrossLevelCams([cam({ offsetMm: expression('-12', -12), direction: -1 })])).toBe(true);
    expect(store().assembly?.crossLevelCamCouplings?.map(c => [c.offsetMm.source, c.direction])).toEqual([['-12', -1]]);
    expect(store().setAssemblyCrossLevelCams([])).toBe(true);
    expect(store().assembly?.crossLevelCamCouplings).toEqual([]);
    store().undoAssembly();
    expect(store().assembly?.crossLevelCamCouplings?.[0]?.offsetMm.source).toBe('-12');
    store().undoAssembly();
    expect(store().assembly).toBe(created);
    store().undoAssembly();
    expect(store().assembly).toBe(opened);
    store().redoAssembly();
    expect(store().assembly).toBe(created);
  });

  it('refuses invalid definitions and conflicting relations, keeping the document and the history, with the reason', async () => {
    const opened = await open({ cams: [] });
    for (const [definitions, code] of [
      [[cam({ childJointId: 'none' })], 'missing-child-joint'],
      [[cam({ childJointId: 'twist' })], 'unsupported-child-joint'],
      [[cam({ camJointId: 'lift' })], 'unsupported-parent-joint'],
      [[cam({ eccentricityMm: expression('24', 24) })], 'invalid-cam-dimensions'],
      [[cam({ offsetMm: expression('missingParameter', 0) })], 'invalid-expression'],
      [[K1, cam({ id: 'k2', childPath: ['B'] })], 'coupled-parent-joint'],
    ] as const) {
      expect(store().setAssemblyCrossLevelCams(definitions)).toBe(false);
      expect(store().assembly).toBe(opened);
      expect(store().assemblyCrossLevelGearNotice?.code).toBe(code);
    }
    expect(store().assemblyUndoStack?.past ?? []).toHaveLength(0);
    // With k1 saved, neither a cross-level gear nor a same-level gear may take its cam joint.
    expect(store().setAssemblyCrossLevelCams([K1])).toBe(true);
    publishView();
    const withCam = store().assembly;
    expect(store().setAssemblyCrossLevelGears([{ id: 'g1', kind: 'crossLevelGear', parentJointId: 'cam', childPath: ['B'],
      childJointId: 'twist', ratio: expression('2', 2), phaseDeg: expression('0', 0), suppressed: false }])).toBe(false);
    expect(store().assemblyCrossLevelGearNotice).toEqual({ couplingId: 'k1', code: 'coupled-parent-joint' });
    expect(store().setAssemblyMechanismCouplings([{ id: 'gear-1', kind: 'gear', jointAId: 'cam', jointBId: 'spin',
      ratio: expression('1', 1), phaseDeg: expression('0', 0), referenceAngleA: 0, suppressed: false }])).toBe(false);
    expect(store().assembly).toBe(withCam);
  });
});

describe('driving a saved cross-level cam', () => {
  it('drives from the cam side to the hand-computed follower positions, as motion only', async () => {
    await open();
    const document = store().assembly, history = store().assemblyUndoStack;
    for (const [theta, x] of [[90, Math.sqrt(551) - 10], [180, 9], [0, 19]] as const) {
      expect(store().driveAssemblyCrossLevelCam('k1', 'cam', theta)).toBe(true);
      expect(expectLawShown()).toBeCloseTo(theta, 6);
      expect(currentOccurrenceDrive(store(), ['A'])?.values.get(jointValueKey('push', 'translation'))).toBeCloseTo(x, 6);
      expect(store().assemblyMotionJointValues.get(jointValueKey('cam', 'angle'))).toBeCloseTo(theta, 6);
    }
    // B, the other placement of the same child, is not driven; the document and the history are untouched.
    expect(currentOccurrenceDrive(store(), ['B'])).toBeUndefined();
    expect([store().assembly, store().assemblyUndoStack]).toEqual([document, history]);
    expect(store().assemblyCrossLevelGearNotice).toBeNull();
    // The ordinary top-level drive of the cam joint goes through the same cam drive.
    expect(store().driveAssemblyJoint('cam', 'angle', 90)).toBe(true);
    expect(expectLawShown()).toBeCloseTo(90, 6);
  });

  it('refuses the follower side before anything moves, from the cam command and from the follower slider', async () => {
    await open();
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 90)).toBe(true);
    const placements = store().assemblyMotionPlacements, drives = store().assemblyOccurrenceDrives;
    const values = store().assemblyMotionJointValues;
    expect(store().driveAssemblyCrossLevelCam('k1', 'follower', 12)).toBe(false);
    expect(store().assemblyCrossLevelGearNotice).toEqual({ couplingId: 'k1', code: 'unsupported-follower-drive' });
    expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: 'k1', code: 'unsupported-follower-drive' });
    useAppStore.setState({ assemblyCrossLevelGearNotice: null, assemblyCrossLevelMotionNotice: null });
    expect(store().driveAssemblyOccurrenceJoint(['A'], 'push', 'translation', 12)).toBe(false);
    expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: 'k1', code: 'unsupported-follower-drive' });
    expect([store().assemblyMotionPlacements, store().assemblyOccurrenceDrives, store().assemblyMotionJointValues])
      .toEqual([placements, drives, values]);
    expect(store().assemblyMotionPlacements).toBe(placements);
    expect(store().assemblyOccurrenceDrives).toBe(drives);
    // The refusal is visible in the always-shown cross-level section.
    const shown = renderToStaticMarkup(React.createElement(AssemblyCrossLevelGearRepairs));
    expect(shown).toContain(t('assembly.crossCam.reason.followerDrive'));
    // The uncoupled placement B keeps its ordinary follower drive.
    expect(store().driveAssemblyOccurrenceJoint(['B'], 'push', 'translation', 3)).toBe(true);
  });

  it('refuses atomically when the follower cannot reach the law (limited slider), keeping every pose', async () => {
    await open({ max: 15 });
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 90)).toBe(true);
    const placements = store().assemblyMotionPlacements, drives = store().assemblyOccurrenceDrives;
    // x(0) = 19 > 15 and x(45) = 5 cos 45 + sqrt(576 - 12.5) - 10 = 17.27... > 15.
    for (const theta of [0, 45]) {
      expect(law(theta)).toBeGreaterThan(15);
      expect(store().driveAssemblyCrossLevelCam('k1', 'cam', theta)).toBe(false);
      expect(store().assemblyCrossLevelGearNotice).toEqual({ couplingId: 'k1', code: 'child-at-limit' });
      expect(store().assemblyMotionPlacements).toBe(placements);
      expect(store().assemblyOccurrenceDrives).toBe(drives);
    }
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 180)).toBe(true);
    expect(expectLawShown()).toBeCloseTo(180, 6);
  });

  it('does not show or continue a drive of an older document, and refuses a drive against a stale view', async () => {
    await open();
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 90)).toBe(true);
    expect(store().setAssemblyCrossLevelCams([cam({ offsetMm: expression('-12', -12) })])).toBe(true);
    expect(currentOccurrenceDrive(store(), ['A'])).toBeUndefined();
    const document = store().assembly;
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 90)).toBe(false);
    expect(store().assemblyCrossLevelGearNotice?.code).toBe('stale-view');
    expect([store().assembly, store().assemblyMotionPlacements]).toEqual([document, null]);
    publishView();
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 90)).toBe(true);
    expect(currentOccurrenceDrive(store(), ['A'])?.values.get(jointValueKey('push', 'translation'))).toBeCloseTo(Math.sqrt(551) - 12, 6);
  });

  it('reopens a saved cam and drives it to the same hand values', async () => {
    await open();
    const saved = store().assembly;
    if (saved === null) throw new Error('document');
    const reopened = readAssemblyDocument(writeAssemblyDocument(saved, { savedAt: '2026-09-01T00:00:00.000Z' }));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.crossLevelCamCouplings).toEqual([K1]);
    resetTestStore();
    store().openAssembly(reopened.document, library);
    publishView();
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 90)).toBe(true);
    expect(currentOccurrenceDrive(store(), ['A'])?.values.get(jointValueKey('push', 'translation'))).toBeCloseTo(Math.sqrt(551) - 10, 6);
  });
});

describe('ordinary motion that turns a cam joint', () => {
  const step = (to: number): PresentationStep => ({ id: 'step-1', name: 'turn', start: 0, end: 1,
    body: { kind: 'joint', jointId: 'spin', from: expression('0', 0), to: expression(String(to), to), coordinate: 'angle' } });

  it('carries the follower along a drive of another joint and a presentation step', async () => {
    await open();
    expect(store().driveAssemblyJoint('spin', 'angle', 15)).toBe(true);
    expect(expectLawShown()).toBeGreaterThan(1);
    resetTestStore();
    await open({ steps: [step(20)] });
    expect(store().setAssemblyMotionTime(1)).toBe(true);
    expect(expectLawShown()).toBeGreaterThan(1);
  });

  it('refuses the whole motion when the follower cannot follow, leaving every pose as it was', async () => {
    // Limited to 15: the start (cam 0) already asks 19, so any spin that turns the cam joint near 0 is refused.
    await open({ max: 15 });
    expect(store().driveAssemblyJoint('spin', 'angle', 5)).toBe(false);
    expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: 'k1', code: 'child-at-limit' });
    expect([store().assemblyMotionPlacements, store().assemblyOccurrenceDrives.size]).toEqual([null, 0]);
  });

  it('refuses a drag that turns the cam joint (the remaining limitation), and lets one that keeps it pass', () => {
    const at = (degrees: number): RigidPlacement => ({ position: [...P], rotation: [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)] });
    const before = new Map([['ground', at(0)], ['hub', at(0)], ['A', at(0)]]);
    const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [],
      joints: [joint('spin', 'revolute', 'hub', 'ground'), joint('cam', 'revolute', 'A', 'hub')], crossLevelCamCouplings: [K1] };
    expect(crossLevelDragRefusal({ assembly: document }, before, new Map(before).set('A', at(10))))
      .toEqual({ couplingId: 'k1', code: 'coupled-motion' });
    expect(crossLevelDragRefusal({ assembly: document }, before, new Map(before).set('A', at(10)).set('hub', at(10)))).toBeNull();
    expect(crossLevelDragRefusal({ assembly: { ...document, crossLevelCamCouplings: [{ ...K1, suppressed: true }] } }, before,
      new Map(before).set('A', at(10)))).toBeNull();
  });
});

describe('edits keep saved cross-level cams readable in the same Undo step', () => {
  it('removes the cam of a deleted placement, keeps the other, explains it, and undoes both together', async () => {
    await open({ cams: [K1, K2] });
    const before = store().assembly;
    deleteAssemblyComponents(['B']);
    const after = store().assembly;
    expect(after?.components.map(c => c.id)).toEqual(['ground', 'hub', 'A']);
    expect(after?.crossLevelCamCouplings).toEqual([K1]);
    expect(store().assemblyCrossLevelGearRepairs).toEqual([{ couplingId: 'k2', code: 'missing-component', action: 'removed' }]);
    const shown = renderToStaticMarkup(React.createElement(AssemblyCrossLevelGearRepairs));
    expect(shown).toContain(t('assembly.crossGear.repairRemoved').replace('{id}', 'k2').split('{reason}')[0] ?? '');
    if (after === null) throw new Error('document');
    const reopened = readAssemblyDocument(writeAssemblyDocument(after, { savedAt: '2026-09-01T00:00:00.000Z' }));
    expect(reopened.ok && reopened.document.crossLevelCamCouplings).toEqual([K1]);
    store().undoAssembly();
    expect(store().assembly).toBe(before);
    store().redoAssembly();
    expect(store().assembly?.crossLevelCamCouplings).toEqual([K1]);
  });

  it('suspends a cam whose cam joint is suppressed and keeps its definition', async () => {
    await open();
    const document = store().assembly;
    if (document === null) throw new Error('document');
    store().applyAssembly({ ...document, joints: document.joints.map(j => j.id === 'cam' ? { ...j, suppressed: true } : j) });
    expect(store().assembly?.crossLevelCamCouplings).toEqual([{ ...K1, suppressed: true }]);
    expect(store().assemblyCrossLevelGearRepairs).toEqual([{ couplingId: 'k1', code: 'missing-parent-joint', action: 'suspended' }]);
  });
});

describe('the public cam form', () => {
  it('offers the slider placements, labels the authored law, and shows the cam drive and the follower result', async () => {
    await open({ cams: [] });
    const created = renderToStaticMarkup(React.createElement(AssemblyCrossLevelCamForm, { jointId: 'cam' }));
    expect(created).toContain(t('assembly.crossCam.title'));
    expect(created).toContain(t('assembly.crossCam.authoredLaw'));
    expect(created).toContain('A : push');
    expect(created).toContain('B : push');
    expect(created).not.toContain('twist');
    expect(created).toContain(t('assembly.crossCam.create'));
    expect(store().setAssemblyCrossLevelCams([K1])).toBe(true);
    publishView();
    expect(store().driveAssemblyCrossLevelCam('k1', 'cam', 180)).toBe(true);
    const saved = renderToStaticMarkup(React.createElement(AssemblyCrossLevelCamForm, { jointId: 'cam', cam: K1 }));
    expect(saved).toContain(t('assembly.crossCam.camAngle').replace('{joint}', 'cam'));
    expect(saved).toContain(t('assembly.crossCam.remove'));
    expect(saved).toContain('9.000 mm');
  });
});
