import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addComponent, createAssemblyDocument, createComponentFor, resolveAssembly,
  type AssemblyDocument, type JointFrame, type RigidPlacement,
} from '@pointercad/model';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * Two independent slider groups (fixed anchor + free member each), as in the EX12 host fixture. Driving the second
 * slider must keep the first member where the first drive put it, because that drive's value stays published.
 * Regression of host145 run 20261019-005830 (assembly1000HostFlow.ts line 83): every drive started from the document's
 * resolved placements, so member-0 went back from z 25 to 0 while its joint value still said 25.
 * The drives stay transient motion state: the document and the Undo history are not touched.
 */
const FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const key = (jointId: string): string => `${jointId}${String.fromCharCode(0)}translation`;

interface Groups { readonly document: AssemblyDocument; readonly ids: Readonly<Record<'anchor0' | 'member0' | 'anchor1' | 'member1', string>> }

function publishTwoSliders(): Groups {
  let document = createAssemblyDocument('two sliders');
  for (const name of ['anchor-0', 'member-0', 'anchor-1', 'member-1']) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: name }, { name }));
  }
  const [anchor0, member0, anchor1, member1] = document.components.map(component => component.id);
  if (anchor0 === undefined || member0 === undefined || anchor1 === undefined || member1 === undefined) throw new Error('components');
  const slider = (id: string, member: string, anchor: string) => ({ id, name: id, kind: 'slider' as const,
    a: { kind: 'origin' as const, componentId: member, element: 'z' as const },
    b: { kind: 'origin' as const, componentId: anchor, element: 'z' as const },
    minValue: null, maxValue: null, suppressed: false });
  document = { ...document,
    components: document.components.map(component => ({ ...component, fixed: component.id === anchor0 || component.id === anchor1 })),
    joints: [slider('joint-0', member0, anchor0), slider('joint-1', member1, anchor1)] };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ assemblyView: { sourceDocument: document, resolved: resolveAssembly(document), bodies: new Map(),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), mateTargets: new Map(),
    jointFrames: new Map([['joint-0', { a: FRAME, b: FRAME }], ['joint-1', { a: FRAME, b: FRAME }]]) } });
  return { document, ids: { anchor0, member0, anchor1, member1 } };
}

function z(placements: ReadonlyMap<string, RigidPlacement> | null, id: string): number | undefined {
  return placements?.get(id)?.position[2];
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTestStore();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('independent joint drives keep each other', () => {
  it('the second slider drive keeps the first member at its driven position (synchronous drive)', () => {
    const { document, ids } = publishTwoSliders();
    const stack = useAppStore.getState().assemblyUndoStack;
    expect(useAppStore.getState().driveAssemblyJoint('joint-0', 'translation', 25)).toBe(true);
    expect(z(useAppStore.getState().assemblyMotionPlacements, ids.member0)).toBeCloseTo(25, 9);
    expect(useAppStore.getState().driveAssemblyJoint('joint-1', 'translation', 40)).toBe(true);
    const state = useAppStore.getState();
    expect(z(state.assemblyMotionPlacements, ids.member1)).toBeCloseTo(40, 9);
    expect(z(state.assemblyMotionPlacements, ids.member0)).toBeCloseTo(25, 9);
    expect(z(state.assemblyMotionPlacements, ids.anchor0)).toBeCloseTo(0, 12);
    expect(z(state.assemblyMotionPlacements, ids.anchor1)).toBeCloseTo(0, 12);
    expect(state.assemblyMotionJointValues.get(key('joint-0'))).toBeCloseTo(25, 9);
    expect(state.assemblyMotionJointValues.get(key('joint-1'))).toBeCloseTo(40, 9);
    expect([state.assembly, state.assemblyUndoStack]).toEqual([document, stack]);
    expect(state.assembly).toBe(document);
  });

  it('the cooperative drive used by the host input keeps the first member too, and driving it again moves only it', async () => {
    const { ids } = publishTwoSliders();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-0', 'translation', 25)).toBe(true);
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-1', 'translation', 40)).toBe(true);
    await vi.runAllTimersAsync();
    let placements = useAppStore.getState().assemblyMotionPlacements;
    expect([z(placements, ids.member0), z(placements, ids.member1)].map(value => Math.round((value ?? Number.NaN) * 1e6) / 1e6)).toEqual([25, 40]);
    expect(useAppStore.getState().requestAssemblyJointDrive('joint-0', 'translation', 10)).toBe(true);
    await vi.runAllTimersAsync();
    placements = useAppStore.getState().assemblyMotionPlacements;
    expect(z(placements, ids.member0)).toBeCloseTo(10, 9);
    expect(z(placements, ids.member1)).toBeCloseTo(40, 9);
    expect(useAppStore.getState().assemblyMotionJointValues.get(key('joint-0'))).toBeCloseTo(10, 9);
  });

  it('a different document starts again from its own resolved placements', () => {
    const first = publishTwoSliders();
    expect(useAppStore.getState().driveAssemblyJoint('joint-0', 'translation', 25)).toBe(true);
    resetTestStore();
    const second = publishTwoSliders();
    expect(second.document).not.toBe(first.document);
    expect(useAppStore.getState().assemblyMotionPlacements).toBeNull();
    expect(useAppStore.getState().driveAssemblyJoint('joint-1', 'translation', 40)).toBe(true);
    const placements = useAppStore.getState().assemblyMotionPlacements;
    expect(z(placements, second.ids.member0)).toBeCloseTo(0, 9);
    expect(z(placements, second.ids.member1)).toBeCloseTo(40, 9);
  });
});
