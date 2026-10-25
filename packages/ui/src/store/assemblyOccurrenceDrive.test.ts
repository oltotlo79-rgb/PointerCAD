import { beforeEach, describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubAssemblyJointControls } from '../assembly/SubAssemblyJointControls.js';
import { t } from '../i18n/t.js';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  resolveAssembly, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type JointOccurrenceInputs,
  type Placement, type PrimitiveFeature, type Quaternion, type RigidPlacement,
} from '@pointercad/model';
import { currentOccurrenceDrive } from './assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * Store boundary of the flexible subassembly drive: one child (fixed base + free arm on a slider) placed twice, A turned
 * 90 degrees about z at (10, 20, 0) and B at (0, 0, 10). Positions are written by hand from those placements.
 */
const HALF = Math.SQRT1_2;
const TURN_Z: Quaternion = [0, 0, HALF, HALF];
const SLIDE = 'child-slide';

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, at: Placement = placement(0, 0, 0), fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}

async function publish(): Promise<{ readonly document: AssemblyDocument }> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-10-19T00:00:00.000Z' });
  const child: AssemblyDocument = { ...createAssemblyDocument('flexible child'),
    components: [component('base', { kind: 'part', partRef: embedded.partRef }, placement(0, 0, 0), true),
      component('arm', { kind: 'part', partRef: embedded.partRef })],
    joints: [{ id: SLIDE, name: SLIDE, kind: 'slider', a: { kind: 'origin', componentId: 'arm', element: 'z' },
      b: { kind: 'origin', componentId: 'base', element: 'z' }, minValue: null, maxValue: null, suppressed: false }] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0, TURN_Z)),
    component('B', { kind: 'subAssembly', assemblyRef: 'child' }, placement(0, 0, 10)),
  ] };
  useAppStore.getState().openAssembly(document, library);
  const source: JointOccurrenceInputs = { document, library, subAssemblies };
  useAppStore.setState({ assemblyView: { sourceDocument: document, source, resolved: resolveAssembly(document, { library, subAssemblies }),
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: new Map() } });
  return { document };
}

const z = (placements: ReadonlyMap<string, RigidPlacement> | undefined, id: string): number | undefined => placements?.get(id)?.position[2];
const valueKey = `${SLIDE}${String.fromCharCode(0)}translation`;

beforeEach(() => { resetTestStore(); });

describe('flexible subassembly drives in the store', () => {
  it('keeps each placement of the child independent, transient and out of the document and history', async () => {
    const { document } = await publish();
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 5)).toBe(true);
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['B'], SLIDE, 'translation', 7)).toBe(true);
    const state = useAppStore.getState();
    const a = currentOccurrenceDrive(state, ['A']), b = currentOccurrenceDrive(state, ['B']);
    expect(z(a?.placements, 'arm')).toBeCloseTo(5, 9);
    expect(a?.placements.get('arm')?.position[0]).toBeCloseTo(10, 9);
    expect(z(b?.placements, 'arm')).toBeCloseTo(17, 9);
    expect([a?.values.get(valueKey), b?.values.get(valueKey)].map(value => Math.round((value ?? Number.NaN) * 1e6) / 1e6)).toEqual([5, 7]);
    expect(state.assembly).toBe(document);
    expect(state.assemblyUndoStack).toBe(stack);
    // The top-level transient drive state is a separate thing and stays empty.
    expect([state.assemblyMotionPlacements, state.assemblyMotionJointValues.size]).toEqual([null, 0]);
  });

  it('continues from the shown child placements and leaves the other placement unchanged', async () => {
    await publish();
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 5)).toBe(true);
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['B'], SLIDE, 'translation', 7)).toBe(true);
    const b = currentOccurrenceDrive(useAppStore.getState(), ['B']);
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 9)).toBe(true);
    const state = useAppStore.getState();
    expect(z(currentOccurrenceDrive(state, ['A'])?.placements, 'arm')).toBeCloseTo(9, 9);
    expect(z(currentOccurrenceDrive(state, ['A'])?.placements, 'base')).toBeCloseTo(0, 9);
    expect(currentOccurrenceDrive(state, ['B'])).toBe(b);
  });

  it('refuses invalid paths and joints without changing the drives, and drops drives of a replaced view', async () => {
    await publish();
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 5)).toBe(true);
    const drives = useAppStore.getState().assemblyOccurrenceDrives;
    for (const [path, jointId] of [[[], SLIDE], [['missing'], SLIDE], [['A', 'base'], SLIDE], [['A'], 'no-such-joint']] as const) {
      expect(useAppStore.getState().driveAssemblyOccurrenceJoint(path, jointId, 'translation', 3)).toBe(false);
      expect(useAppStore.getState().assemblyOccurrenceDrives).toBe(drives);
    }
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', Number.NaN)).toBe(false);
    // A recomputed view (new object) makes the earlier drive stale: not shown, and dropped by the next drive.
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    useAppStore.setState({ assemblyView: { ...view } });
    expect(currentOccurrenceDrive(useAppStore.getState(), ['A'])).toBeUndefined();
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['B'], SLIDE, 'translation', 2)).toBe(true);
    expect([...useAppStore.getState().assemblyOccurrenceDrives.keys()]).toEqual([JSON.stringify(['B'])]);
    useAppStore.getState().clearAssemblyOccurrenceDrives();
    expect(useAppStore.getState().assemblyOccurrenceDrives.size).toBe(0);
  });
});

describe('owned requests for a child occurrence', () => {
  afterEach(() => { useAppStore.getState().cancelAssemblyJointDrive(); vi.useRealTimers(); });

  it.each(['cancel', 'document', 'undo', 'redo', 'later'] as const)(
    'drops a completed but unpublished child result after %s', async (route) => {
      await publish();
      const initial = useAppStore.getState();
      if (initial.assembly === null || initial.assemblyView === null) throw new Error('fixture');
      initial.applyAssembly({ ...initial.assembly, name: 'edited' });
      if (route === 'redo') useAppStore.getState().undoAssembly();
      const document = useAppStore.getState().assembly;
      if (document === null) throw new Error('document');
      useAppStore.setState({ assemblyView: { ...initial.assemblyView, sourceDocument: document,
        source: { document, library: initial.assemblyLibrary, subAssemblies: initial.assemblyLibrary.assemblies ?? new Map() } } });
      expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['B'], SLIDE, 'translation', 7)).toBe(true);
      const before = useAppStore.getState();
      const borrowed = structuredClone({ document, children: before.assemblyLibrary.assemblies });
      vi.useFakeTimers();
      expect(before.requestAssemblyJointDrive(SLIDE, 'translation', 5, ['A'])).toBe(true);
      const owner = useAppStore.getState().assemblyJointDrive;
      expect(owner).toMatchObject({ path: ['A'], jointId: SLIDE, value: 5 });
      expect(useAppStore.getState().assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
      // Finish the generator without flushing its Promise callback: cancel alone cannot revoke this outcome.
      vi.runAllTimers();
      expect(useAppStore.getState().assemblyJointDrive).toBe(owner);
      if (route === 'cancel') useAppStore.getState().cancelAssemblyJointDrive();
      if (route === 'document') useAppStore.getState().applyAssembly({ ...document, name: 'replacement' });
      if (route === 'undo') useAppStore.getState().undoAssembly();
      if (route === 'redo') useAppStore.getState().redoAssembly();
      if (route === 'later') {
        expect(useAppStore.getState().requestAssemblyJointDrive(SLIDE, 'translation', 9, ['A'])).toBe(true);
        const newer = useAppStore.getState().assemblyJointDrive;
        expect(newer?.generation).toBeGreaterThan(owner?.generation ?? Infinity);
        if (owner !== null) useAppStore.getState().cancelAssemblyJointDrive(owner);
        expect(useAppStore.getState().assemblyJointDrive).toBe(newer);
      }
      const accepted = useAppStore.getState();
      const published: number[] = [];
      const off = useAppStore.subscribe((state, previous) => {
        if (state.assemblyOccurrenceDrives !== previous.assemblyOccurrenceDrives) {
          published.push(currentOccurrenceDrive(state, ['A'])?.values.get(valueKey) ?? Number.NaN);
        }
      });
      try { await vi.runAllTimersAsync(); } finally { off(); }
      const after = useAppStore.getState();
      expect(published).toHaveLength(route === 'later' ? 1 : 0);
      if (route === 'later') expect(published[0]).toBeCloseTo(9, 9);
      else expect(after.assemblyOccurrenceDrives).toBe(accepted.assemblyOccurrenceDrives);
      expect(after.assembly).toBe(accepted.assembly);
      expect(after.assemblyUndoStack).toBe(accepted.assemblyUndoStack);
      expect(after.assemblyMotionPlacements).toBe(accepted.assemblyMotionPlacements);
      expect(after.assemblyMotionJointValues).toBe(accepted.assemblyMotionJointValues);
      expect(after.assemblyJointDrive).toBeNull();
      expect({ document, children: before.assemblyLibrary.assemblies }).toEqual(borrowed);
      if (route === 'cancel') {
        expect(after.assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
        expect(after.assembly).toBe(before.assembly);
        expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
      }
    },
  );

  it('copies the requested path, accepts another field while pending and publishes exactly once', async () => {
    await publish();
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['B'], SLIDE, 'translation', 7)).toBe(true);
    const before = useAppStore.getState();
    vi.useFakeTimers();
    const path = ['A'];
    const step = expressionValueFromNumber(15);
    const commits: number[] = [];
    const off = useAppStore.subscribe((state, previous) => {
      if (state.assemblyOccurrenceDrives !== previous.assemblyOccurrenceDrives) commits.push(state.assemblyOccurrenceDrives.size);
    });
    try {
      expect(before.requestAssemblyJointDrive(SLIDE, 'translation', 5, path)).toBe(true);
      path[0] = 'B';
      const owner = useAppStore.getState().assemblyJointDrive;
      useAppStore.getState().setAssemblyMotionPlaying(false);
      useAppStore.getState().setSphereGridStep(step);
      expect(useAppStore.getState().sphereGridStep).toEqual(step);
      expect(useAppStore.getState().assemblyJointDrive).toBe(owner);
      expect(owner?.path).toEqual(['A']);
      expect(commits).toHaveLength(0);
      await vi.runAllTimersAsync();
    } finally { off(); }
    const after = useAppStore.getState();
    expect(commits).toEqual([2]);
    expect(z(currentOccurrenceDrive(after, ['A'])?.placements, 'arm')).toBeCloseTo(5, 9);
    expect(currentOccurrenceDrive(after, ['B'])).toBe(currentOccurrenceDrive(before, ['B']));
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.sphereGridStep).toEqual(step);
    expect(after.assemblyJointDrive).toBeNull();
  });

  it('cancels between child work slices without publishing partial placements', async () => {
    await publish();
    const before = useAppStore.getState();
    vi.useFakeTimers();
    expect(before.requestAssemblyJointDrive(SLIDE, 'translation', 5, ['A'])).toBe(true);
    vi.advanceTimersToNextTimer();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    useAppStore.getState().cancelAssemblyJointDrive();
    await vi.runAllTimersAsync();
    const after = useAppStore.getState();
    expect(after.assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
    expect(after.assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyJointDrive).toBeNull();
  });

  it('shows the requested value and existing cancel control only at the owning occurrence', async () => {
    await publish();
    vi.useFakeTimers();
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    try {
      expect(useAppStore.getState().requestAssemblyJointDrive(SLIDE, 'translation', 5, ['A'])).toBe(true);
      const own = renderToStaticMarkup(React.createElement(SubAssemblyJointControls, { path: ['A'] }));
      const other = renderToStaticMarkup(React.createElement(SubAssemblyJointControls, { path: ['B'] }));
      expect(own).toContain('value="5"');
      expect(own).toContain(t('assembly.motion.cancelTooltip'));
      expect(own).toContain(t('assembly.motion.pending').replace('{coordinate}', t('assembly.motion.translation')));
      expect(other).not.toContain(t('assembly.motion.cancelTooltip'));
      useAppStore.getState().cancelAssemblyJointDrive();
      const cancelled = renderToStaticMarkup(React.createElement(SubAssemblyJointControls, { path: ['A'] }));
      expect(cancelled).not.toContain(t('assembly.motion.cancelTooltip'));
      expect(cancelled).not.toContain(t('assembly.subJoint.refused'));
      await vi.runAllTimersAsync();
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['view', 'clear', 'sync-drive'] as const)('does not overwrite a later %s operation', async (change) => {
    await publish();
    const before = useAppStore.getState();
    vi.useFakeTimers();
    expect(before.requestAssemblyJointDrive(SLIDE, 'translation', 5, ['A'])).toBe(true);
    vi.runAllTimers();
    if (change === 'view') {
      if (before.assemblyView === null) throw new Error('view');
      useAppStore.setState({ assemblyView: { ...before.assemblyView } });
    }
    if (change === 'clear') useAppStore.getState().clearAssemblyOccurrenceDrives();
    if (change === 'sync-drive') expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['B'], SLIDE, 'translation', 7)).toBe(true);
    const accepted = useAppStore.getState();
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().assemblyOccurrenceDrives).toBe(accepted.assemblyOccurrenceDrives);
    expect(currentOccurrenceDrive(useAppStore.getState(), ['A'])).toBeUndefined();
    expect(useAppStore.getState().assemblyJointDrive).toBeNull();
  });
});
