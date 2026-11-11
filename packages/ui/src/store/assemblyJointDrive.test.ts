import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createAssemblyDocument, createComponentFor, resolveAssembly,
  type AssemblyDocument, type JointFrame, type RigidPlacement,
} from '@pointercad/model';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

const FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const ANGLE_KEY = `joint-1${String.fromCharCode(0)}angle`;

function viewOf(document: AssemblyDocument): NonNullable<ReturnType<typeof useAppStore.getState>['assemblyView']> {
  return { sourceDocument: document,
    resolved: resolveAssembly(document), bodies: new Map(), appearances: new Map(), diagnosis: null,
    mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: new Map([['joint-1', { a: FRAME, b: FRAME }]]) };
}

function publishJoint(): AssemblyDocument {
  let document = createAssemblyDocument('drive');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, { partName: 'A' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'b' }, { partName: 'B' }));
  const a = document.components[0].id, b = document.components[1].id;
  document = { ...document, joints: [{ id: 'joint-1', name: 'joint1', kind: 'revolute',
    a: { kind: 'origin', componentId: a, element: 'z' },
    b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false }] };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ assemblyView: viewOf(document) });
  return document;
}

/** Independent of the solver: v' = v + 2w(q x v) + 2 q x (q x v) for a unit quaternion [x, y, z, w]. */
function rotate(placement: RigidPlacement, v: readonly [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = placement.rotation;
  const norm = Math.hypot(qx, qy, qz, qw);
  const x = qx / norm, y = qy / norm, z = qz / norm, w = qw / norm;
  const cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
  const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + dx), v[1] + 2 * (w * cy + dy), v[2] + 2 * (w * cz + dz)];
}

/**
 * Geometry of a committed revolute drive about the shared z axis at the origin, from the placements alone.
 * Signed like the declared joint angle (driveJoint.ts: atan2((a.x x b.x) . b.z, a.x . b.x)), so a drive in the
 * wrong direction fails instead of matching |angle|.
 */
function expectRevoluteAt(placements: ReadonlyMap<string, RigidPlacement> | null, document: AssemblyDocument, degrees: number): void {
  expect(placements).not.toBeNull();
  const a = placements?.get(document.components[0].id);
  const b = placements?.get(document.components[1].id);
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  if (a === undefined || b === undefined) return;
  const za = rotate(a, [0, 0, 1]), zb = rotate(b, [0, 0, 1]);
  expect(za[0] * zb[0] + za[1] * zb[1] + za[2] * zb[2]).toBeCloseTo(1, 9);
  expect(Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2])).toBeCloseTo(0, 9);
  const xa = rotate(a, [1, 0, 0]), xb = rotate(b, [1, 0, 0]);
  const cos = xa[0] * xb[0] + xa[1] * xb[1] + xa[2] * xb[2];
  const sin = zb[0] * (xa[1] * xb[2] - xa[2] * xb[1]) + zb[1] * (xa[2] * xb[0] - xa[0] * xb[2]) + zb[2] * (xa[0] * xb[1] - xa[1] * xb[0]);
  expect(Math.atan2(sin, cos) * 180 / Math.PI).toBeCloseTo(degrees, 6);
}

function expectNoMotion(): void {
  const state = useAppStore.getState();
  expect(state.assemblyJointDrive).toBeNull();
  expect(state.assemblyMotionPlacements).toBeNull();
  expect(state.assemblyMotionJointValues.size).toBe(0);
  expect(state.assemblyMotionNotice).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTestStore();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('task113 owned cooperative joint drive', () => {
  it('returns before solving, then cancel leaves the document, history and motion state untouched and is not a failure', async () => {
    const document = publishJoint();
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    expect(useAppStore.getState().assemblyJointDrive).toMatchObject({ jointId: 'joint-1', coordinate: 'angle', value: 30, document });
    expect(useAppStore.getState().assemblyMotionPlacements).toBeNull();
    useAppStore.getState().cancelAssemblyJointDrive();
    await vi.runAllTimersAsync();
    expectNoMotion();
    expect(useAppStore.getState().assembly).toBe(document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(stack);
  });

  it.each([
    ['applyAssembly replaces the document', (document: AssemblyDocument) => {
      useAppStore.getState().applyAssembly({ ...document, name: 'renamed' });
    }],
    ['Undo returns to an earlier history entry', (document: AssemblyDocument) => {
      useAppStore.getState().applyAssembly({ ...document, name: 'renamed' });
      useAppStore.getState().undoAssembly();
    }],
    ['closing the assembly', () => {
      useAppStore.getState().closeAssembly();
    }],
    ['a new view object for the same document (review r118 item 1)', (document: AssemblyDocument) => {
      useAppStore.setState({ assemblyView: viewOf(document) });
    }],
  ])('a drive whose owner went stale (%s) never publishes and leaves no pending state', async (_title, invalidate) => {
    const document = publishJoint();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    invalidate(document);
    await vi.runAllTimersAsync();
    expectNoMotion();
  });

  it('after a same-document view replacement the next drive commits once with the checked geometry', async () => {
    const document = publishJoint();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 10)).toBe(true);
    useAppStore.setState({ assemblyView: viewOf(document) });
    await vi.runAllTimersAsync();
    expectNoMotion();
    let commits = 0;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.assemblyMotionPlacements !== previous.assemblyMotionPlacements) commits += 1;
    });
    try {
      expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
      await vi.runAllTimersAsync();
    } finally {
      unsubscribe();
    }
    expect(commits).toBe(1);
    expect(useAppStore.getState().assemblyJointDrive).toBeNull();
    expectRevoluteAt(useAppStore.getState().assemblyMotionPlacements, document, 30);
  });

  it('a later request replaces the earlier one; only the later result commits, once, equal to the sync drive', async () => {
    const reference = publishJoint();
    expect(useAppStore.getState().driveAssemblyJoint('joint-1', 'angle', 30)).toBe(true);
    const expected = useAppStore.getState().assemblyMotionPlacements;
    expectRevoluteAt(expected, reference, 30);
    resetTestStore();
    const document = publishJoint();
    const stack = useAppStore.getState().assemblyUndoStack;
    let commits = 0;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.assemblyMotionPlacements !== previous.assemblyMotionPlacements) commits += 1;
    });
    try {
      expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 10)).toBe(true);
      const first = useAppStore.getState().assemblyJointDrive;
      expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
      const second = useAppStore.getState().assemblyJointDrive;
      expect(second?.generation).toBeGreaterThan(first?.generation ?? Number.POSITIVE_INFINITY);
      await vi.runAllTimersAsync();
    } finally {
      unsubscribe();
    }
    const state = useAppStore.getState();
    expect(commits).toBe(1);
    expect(state.assemblyJointDrive).toBeNull();
    expect(state.assemblyMotionSourceDocument).toBe(document);
    expect(state.assemblyMotionPlacements).toEqual(expected);
    expectRevoluteAt(state.assemblyMotionPlacements, document, 30);
    expect(state.assemblyMotionJointValues.get(ANGLE_KEY)).toBeCloseTo(30, 9);
    expect(state.assembly).toBe(document);
    expect(state.assemblyUndoStack).toBe(stack);
  });

  it('an applied timeline position after a request keeps its time and placements (review r118 item 2)', async () => {
    publishJoint();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    expect(useAppStore.getState().setAssemblyMotionTime(0.5)).toBe(true);
    const chosen = useAppStore.getState();
    expect(chosen.assemblyJointDrive).toBeNull();
    await vi.runAllTimersAsync();
    const state = useAppStore.getState();
    expect(state.assemblyJointDrive).toBeNull();
    expect(state.assemblyMotionTime).toBe(0.5);
    expect(state.assemblyMotionPlacements).toBe(chosen.assemblyMotionPlacements);
    expect(state.assemblyMotionJointValues.size).toBe(0);
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().assemblyMotionJointValues.get(ANGLE_KEY)).toBeCloseTo(30, 9);
  });

  it('a playback started while a drive is pending keeps playing and the late result is dropped (review r118 item 2)', async () => {
    const first = publishJoint();
    useAppStore.setState({ selection: [first.components[1].id] });
    expect(useAppStore.getState().beginAssemblyExplode()).toBe(true);
    expect(useAppStore.getState().commitAssemblyExplode('10', 'step')).toBe(true);
    const document = useAppStore.getState().assembly;
    expect(document?.presentation.length).toBeGreaterThan(0);
    if (document === null) return;
    useAppStore.setState({ assemblyView: viewOf(document) });
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    useAppStore.getState().setAssemblyMotionPlaying(true);
    expect(useAppStore.getState().assemblyMotionPlaying).toBe(true);
    expect(useAppStore.getState().assemblyJointDrive).toBeNull();
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().assemblyMotionPlaying).toBe(true);
    expect(useAppStore.getState().assemblyMotionJointValues.size).toBe(0);
    useAppStore.getState().setAssemblyMotionPlaying(false);
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    await vi.runAllTimersAsync();
    expectRevoluteAt(useAppStore.getState().assemblyMotionPlacements, document, 30);
  });

  it('a negative target drives the other way and matches the signed joint angle', async () => {
    const document = publishJoint();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', -30)).toBe(true);
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().assemblyJointDrive).toBeNull();
    expect(useAppStore.getState().assemblyMotionJointValues.get(ANGLE_KEY)).toBeCloseTo(-30, 9);
    expectRevoluteAt(useAppStore.getState().assemblyMotionPlacements, document, -30);
  });

  it('an owner-scoped cancel of an older owner leaves the newer request running (review r118 item 3)', async () => {
    const document = publishJoint();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 10)).toBe(true);
    const older = useAppStore.getState().assemblyJointDrive;
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    const newer = useAppStore.getState().assemblyJointDrive;
    expect(older).not.toBeNull();
    if (older !== null) useAppStore.getState().cancelAssemblyJointDrive(older);
    expect(useAppStore.getState().assemblyJointDrive).toBe(newer);
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().assemblyJointDrive).toBeNull();
    expectRevoluteAt(useAppStore.getState().assemblyMotionPlacements, document, 30);
  });

  it.each(['version', 'generation', 'cancel-count', 'library', 'session'] as const)(
    'does not publish a completed drive after its %s ownership changes', async (change) => {
      publishJoint();
      expect(useAppStore.getState().driveAssemblyJoint('joint-1', 'angle', 5)).toBe(true);
      const before = useAppStore.getState();
      expect(before.requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
      vi.runAllTimers();
      if (change === 'version') useAppStore.setState({ documentVersion: before.documentVersion + 1 });
      if (change === 'generation') useAppStore.setState({ requestedGeneration: before.requestedGeneration + 1 });
      if (change === 'cancel-count') useAppStore.setState({ cancelRequestCount: before.cancelRequestCount + 1 });
      if (change === 'library') useAppStore.setState({ assemblyLibrary: { ...before.assemblyLibrary } });
      if (change === 'session') useAppStore.setState({ activeDocumentId: `${before.activeDocumentId}-next` });
      let publishes = 0;
      const off = useAppStore.subscribe((state, previous) => {
        if (state.assemblyMotionPlacements !== previous.assemblyMotionPlacements) publishes += 1;
      });
      try { await vi.runAllTimersAsync(); } finally { off(); }
      expect(publishes).toBe(0);
      expect(useAppStore.getState().assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
      expect(useAppStore.getState().assemblyMotionJointValues).toBe(before.assemblyMotionJointValues);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(useAppStore.getState().assemblyJointDrive).toBeNull();
    },
  );

  it('accepts an ordinary numeric field edit while the joint solve is pending', async () => {
    const document = publishJoint();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'angle', 30)).toBe(true);
    const owner = useAppStore.getState().assemblyJointDrive;
    const step = expressionValueFromNumber(15);
    useAppStore.getState().setSphereGridStep(step);
    expect(useAppStore.getState().sphereGridStep).toEqual(step);
    expect(useAppStore.getState().assemblyJointDrive).toBe(owner);
    expect(useAppStore.getState().assemblyMotionPlacements).toBeNull();
    await vi.runAllTimersAsync();
    expectRevoluteAt(useAppStore.getState().assemblyMotionPlacements, document, 30);
    expect(useAppStore.getState().sphereGridStep).toEqual(step);
  });
});
