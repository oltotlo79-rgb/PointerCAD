import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { readAssemblyDocument, writeAssemblyDocument } from '@pointercad/io';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, crossLevelGearTreeFailure, embedPart,
  EMPTY_PART_LIBRARY, jointFramePairFromTargets, resolveAssembly, resolveMateTarget, type AssemblyComponent, type AssemblyDocument,
  type ComponentSource, type CrossLevelGearCouplingDefinition, type Joint, type JointOccurrenceInputs, type PartLibrary,
  type Placement, type PrimitiveFeature, type Quaternion,
} from '@pointercad/model';
import { AssemblyCrossLevelGearRepairs } from '../assembly/AssemblyCrossLevelGearRepairs.js';
import { deleteAssemblyComponents } from '../assembly/placeComponentActions.js';
import { t } from '../i18n/t.js';
import { currentOccurrenceDrive, jointValueKey } from './assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * The lifecycle closure at the public store entrypoints. Written by hand: the parent has a fixed `ground` at
 * (10, 20, 0), `childA` placed as A at the same point on the revolute `drive` (A = a, ground = b, starts at 0) and
 * `childB` placed as B at (10, 20, 10) on the slider `lift`. Each child has a fixed `base` and an `arm` on its revolute
 * `child-turn` (starts at 0); childB's is limited to [-90, 20] degrees. Saved gears: g1 drive -> A (ratio -2, phase 0)
 * and g2 drive -> B (ratio 0.5, phase 15), so one parent joint drives two placements.
 */
function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string, limits: readonly [ExpressionValue | null, ExpressionValue | null] = [null, null]): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: limits[0], maxValue: limits[1], suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
const gear = (id: string, path: string, ratio: number, phase: number): CrossLevelGearCouplingDefinition => ({ id, kind: 'crossLevelGear',
  parentJointId: 'drive', childPath: [path], childJointId: 'child-turn', ratio: expression(String(ratio), ratio),
  phaseDeg: expression(String(phase), phase), suppressed: false });
const G1 = gear('g1', 'A', -2, 0), G2 = gear('g2', 'B', 0.5, 15);

let library: PartLibrary = EMPTY_PART_LIBRARY;
const store = () => useAppStore.getState();

async function open(): Promise<void> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const child = (name: string, limits?: readonly [ExpressionValue | null, ExpressionValue | null]): AssemblyDocument => ({
    ...createAssemblyDocument(name), components: [component('base', part, placement(0, 0, 0), true), component('arm', part, placement(0, 0, 0))],
    joints: [joint('child-turn', 'revolute', 'arm', 'base', limits)] });
  library = { ...embedded.library, assemblies: new Map([['childA', child('childA')], ['childB', child('childB', [expression('-90', -90), expression('20', 20)])]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(10, 20, 0), true),
    component('A', { kind: 'subAssembly', assemblyRef: 'childA' }, placement(10, 20, 0)),
    component('B', { kind: 'subAssembly', assemblyRef: 'childB' }, placement(10, 20, 10)),
  ], joints: [joint('drive', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'B', 'ground')] };
  store().openAssembly(document, library);
  expect(store().setAssemblyCrossLevelGears([G1, G2])).toBe(true);
  publishView();
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
/** Both saved relations hold on the shown poses for the parent angle theta (one shared sign s). */
function expectGroupShown(theta: number): void {
  const state = store();
  const turned = zDegrees(state.assemblyMotionPlacements?.get('A')?.rotation);
  const sign = Math.sign(turned) * Math.sign(theta);
  expect(Math.abs(sign)).toBe(1);
  expect(turned).toBeCloseTo(sign * theta, 6);
  expect(zDegrees(currentOccurrenceDrive(state, ['A'])?.placements.get('arm')?.rotation)).toBeCloseTo(sign * -2 * theta, 6);
  expect(zDegrees(currentOccurrenceDrive(state, ['B'])?.placements.get('arm')?.rotation)).toBeCloseTo(sign * (0.5 * theta + 15), 6);
  expect(state.assemblyMotionJointValues.get(jointValueKey('drive', 'angle'))).toBeCloseTo(theta, 6);
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('ordinary drives of coupled joints move the whole group', () => {
  it('routes the top-level drive of the parent joint, both synchronous and requested, to both placements', async () => {
    await open();
    expect(store().driveAssemblyJoint('drive', 'angle', 2)).toBe(true);
    expectGroupShown(2);
    expect(store().requestAssemblyJointDrive('drive', 'angle', -3)).toBe(true);
    await vi.waitFor(() => { expect(store().assemblyJointDrive).toBeNull(); });
    expectGroupShown(-3);
  });

  it('routes the occurrence drive of a coupled child joint to the parent and the other placement', async () => {
    await open();
    expect(store().driveAssemblyOccurrenceJoint(['B'], 'child-turn', 'angle', 16)).toBe(true);
    expectGroupShown(2);
  });

  it('refuses the whole group, from either entrypoint, when one placement cannot follow, changing nothing', async () => {
    await open();
    expect(store().driveAssemblyJoint('drive', 'angle', 30)).toBe(false);
    expect(store().assemblyCrossLevelGearNotice).toEqual({ couplingId: 'g2', code: 'child-at-limit' });
    expect([store().assemblyMotionPlacements, store().assemblyOccurrenceDrives.size]).toEqual([null, 0]);
    expect(store().driveAssemblyOccurrenceJoint(['A'], 'child-turn', 'angle', -60)).toBe(false);
    expect([store().assemblyMotionPlacements, store().assemblyOccurrenceDrives.size]).toEqual([null, 0]);
  });

  // Not claimed here: a drive of another joint that changes the coupled parent joint's value through a linkage
  // (handoff: remaining condition). This only checks that such a drive is not rerouted and leaves the drives alone.
  it('does not reroute drives of joints outside every cross-level gear', async () => {
    await open();
    expect(store().driveAssemblyJoint('drive', 'angle', 2)).toBe(true);
    const drives = store().assemblyOccurrenceDrives;
    store().driveAssemblyJoint('lift', 'translation', 5);
    expect(store().assemblyCrossLevelGearNotice).toBeNull();
    expect(store().assemblyOccurrenceDrives).toBe(drives);
  });
});

describe('edits keep saved cross-level gears readable in the same Undo step', () => {
  it('removes the gear of a deleted placement, keeps the sibling, explains it, and undoes both together', async () => {
    await open();
    const before = store().assembly;
    deleteAssemblyComponents(['B']);
    const after = store().assembly;
    expect(after?.components.map(c => c.id)).toEqual(['ground', 'A']);
    expect(after?.crossLevelGearCouplings).toEqual([G1]);
    expect(store().assemblyCrossLevelGearRepairs).toEqual([{ couplingId: 'g2', code: 'missing-component', action: 'removed' }]);
    const shown = renderToStaticMarkup(React.createElement(AssemblyCrossLevelGearRepairs));
    expect(shown).toContain(t('assembly.crossGear.repairTitle'));
    expect(shown).toContain(t('assembly.crossGear.repairRemoved').replace('{id}', 'g2').split('{reason}')[0] ?? '');
    // Saved and reopened, the edited document is readable and still consistent with its subassemblies.
    if (after === null) throw new Error('document');
    const reopened = readAssemblyDocument(writeAssemblyDocument(after, { savedAt: '2026-09-01T00:00:00.000Z' }));
    expect(reopened.ok && reopened.document.crossLevelGearCouplings).toEqual([G1]);
    expect(crossLevelGearTreeFailure(after, library.assemblies ?? new Map())).toBeNull();
    // One Undo step brings back the placement and its gear together; Redo removes both again.
    store().undoAssembly();
    expect(store().assembly).toBe(before);
    store().redoAssembly();
    expect(store().assembly?.crossLevelGearCouplings).toEqual([G1]);
  });

  it('suspends a gear whose parent joint is suppressed and keeps its definition for later', async () => {
    await open();
    const document = store().assembly;
    if (document === null) throw new Error('document');
    store().applyAssembly({ ...document, joints: document.joints.map(j => j.id === 'drive' ? { ...j, suppressed: true } : j) });
    expect(store().assembly?.crossLevelGearCouplings).toEqual([{ ...G1, suppressed: true }, { ...G2, suppressed: true }]);
    expect(store().assemblyCrossLevelGearRepairs.map(r => [r.couplingId, r.action])).toEqual([['g1', 'suspended'], ['g2', 'suspended']]);
    expect(store().assemblyUndoStack?.past.length).toBe(2);
    // An edit that breaks nothing (on the repaired document) reports nothing.
    const repaired = store().assembly;
    if (repaired === null) throw new Error('document');
    store().applyAssembly({ ...repaired, name: 'renamed' });
    expect(store().assemblyCrossLevelGearRepairs).toEqual([]);
  });
});
