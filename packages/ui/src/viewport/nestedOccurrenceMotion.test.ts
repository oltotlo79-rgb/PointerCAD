import { beforeEach, describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  jointFramePairFromTargets, resolveAssembly, resolveMateTarget, type AssemblyComponent, type AssemblyDocument,
  type ComponentSource, type Joint, type JointOccurrenceInputs, type Placement, type PrimitiveFeature, type Quaternion,
  type RigidPlacement,
} from '@pointercad/model';
import { currentOccurrenceDrive, shownOccurrencePlacements } from '../store/assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { flattenAssemblyGeometry } from './createAssemblyLayer.js';

/*
 * A moving parent with moving children (EX12). Positions are written by hand:
 * - leaf: fixed `leaf-base`, `leaf-arm` on the slider `leaf-slide` along the origin z axes (arm = a, base = b).
 * - mid: fixed `mid-base`, the leaf placed as `M` at (4, 0, 0), and the slider `mid-slide` moving M along the origin
 *   x axes (M = a, mid-base = b); driving it to 10 puts M at (10, 0, 0) in the mid frame (a relative to b, the same
 *   sign as subAssemblyJointDrive.test.ts).
 * - parent: fixed `ground` at P = (10, 20, 0), mid placed as `A` at P turned 90 degrees about z and as `B` at (0, 0, 10);
 *   the revolute `turn` (A = a, ground = b) turns A about the vertical axis through P.
 * After driving turn, A's shown rotation is a pure z rotation by phi, so a point (x, y, z) of the mid frame of A is shown
 * at (10 + x cos(phi) - y sin(phi), 20 + x sin(phi) + y cos(phi), z). The leaf arm of A/M is (10, 0, 5) in that frame
 * once mid-slide = 10 and leaf-slide = 5; the earlier composition kept only the parent's change below a driven M, so it
 * showed the arm at the undriven M (4, 0, 5) instead.
 */
const HALF = Math.SQRT1_2;
const TURN_Z: Quaternion = [0, 0, HALF, HALF];
const P = [10, 20, 0] as const;

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, at: Placement = placement(0, 0, 0), fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function slider(id: string, a: string, b: string, element: 'x' | 'z'): Joint {
  return { id, name: id, kind: 'slider', a: { kind: 'origin', componentId: a, element }, b: { kind: 'origin', componentId: b, element },
    minValue: null, maxValue: null, suppressed: false };
}

async function publish(): Promise<void> {
  const size = expressionValueFromNumber(2);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'block.pcad', 'block.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const leaf: AssemblyDocument = { ...createAssemblyDocument('leaf'),
    components: [component('leaf-base', part, placement(0, 0, 0), true), component('leaf-arm', part)],
    joints: [slider('leaf-slide', 'leaf-arm', 'leaf-base', 'z')] };
  const mid: AssemblyDocument = { ...createAssemblyDocument('mid'),
    components: [component('mid-base', part, placement(0, 0, 0), true), component('M', { kind: 'subAssembly', assemblyRef: 'leaf' }, placement(4, 0, 0))],
    joints: [slider('mid-slide', 'M', 'mid-base', 'x')] };
  const subAssemblies = new Map([['leaf', leaf], ['mid', mid]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const turn: Joint = { id: 'turn', name: 'turn', kind: 'revolute', a: { kind: 'origin', componentId: 'A', element: 'z' },
    b: { kind: 'origin', componentId: 'ground', element: 'z' }, minValue: null, maxValue: null, suppressed: false };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(...P), true),
    component('A', { kind: 'subAssembly', assemblyRef: 'mid' }, placement(...P, TURN_Z)),
    component('B', { kind: 'subAssembly', assemblyRef: 'mid' }, placement(0, 0, 10)),
  ], joints: [turn] };
  useAppStore.getState().openAssembly(document, library);
  const resolved = resolveAssembly(document, { library, subAssemblies });
  const a = resolveMateTarget(turn.a, resolved), b = resolveMateTarget(turn.b, resolved);
  if (!a.ok || !b.ok) throw new Error('fixture targets');
  const frames = jointFramePairFromTargets(turn, { a: a.target, b: b.target }, resolved.placements);
  if (frames === null) throw new Error('fixture frames');
  const source: JointOccurrenceInputs = { document, library, subAssemblies };
  useAppStore.setState({ assemblyView: { sourceDocument: document, source, resolved, bodies: new Map(), appearances: new Map(),
    diagnosis: null, mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: new Map([['turn', frames]]) } });
}

/** The same inputs ViewportCanvas assemblyBundleOf passes to flattenAssemblyGeometry (drag preview aside). */
function shown(): ReadonlyMap<string, RigidPlacement> {
  const state = useAppStore.getState();
  const view = state.assemblyView, document = state.assembly;
  if (view === null || document === null) throw new Error('view');
  const root = (state.assemblyMotionSourceDocument === document ? state.assemblyMotionPlacements : null) ?? view.resolved.placements;
  return flattenAssemblyGeometry(document, view.resolved, root, shownOccurrencePlacements(state)).placements;
}
/** phi of a pure z rotation [0, 0, sin(phi/2), cos(phi/2)]; x and y must stay 0. */
function zAngle(rotation: Quaternion | undefined): number {
  const [x, y, z, w] = rotation ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w);
}
function expectAt(placements: ReadonlyMap<string, RigidPlacement>, id: string, expected: readonly [number, number, number]): void {
  const position = placements.get(id)?.position ?? [Number.NaN, Number.NaN, Number.NaN];
  expected.forEach((value, axis) => expect(position[axis], `${id}[${String(axis)}]`).toBeCloseTo(value, 9));
}
const drive = {
  parent: () => expect(useAppStore.getState().driveAssemblyJoint('turn', 'angle', 30)).toBe(true),
  mid: () => expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], 'mid-slide', 'translation', 10)).toBe(true),
  leaf: () => expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A', 'M'], 'leaf-slide', 'translation', 5)).toBe(true),
};

/** Checks the shown leaves against the hand-written mid-frame points and returns them for the order comparison. */
function expectFollowsParent(): ReadonlyMap<string, RigidPlacement> {
  const state = useAppStore.getState();
  const parent = state.assemblyMotionPlacements?.get('A');
  expect(parent?.position).toEqual([expect.closeTo(P[0], 9), expect.closeTo(P[1], 9), expect.closeTo(P[2], 9)]);
  const phi = zAngle(parent?.rotation);
  // The parent really turned away from its written 90 degrees.
  expect(Math.abs(phi - Math.PI / 2)).toBeGreaterThan(1e-3);
  const at = (x: number, y: number, z: number): readonly [number, number, number] =>
    [P[0] + x * Math.cos(phi) - y * Math.sin(phi), P[1] + x * Math.sin(phi) + y * Math.cos(phi), z];
  const placements = shown();
  expectAt(placements, 'A/mid-base', at(0, 0, 0));
  expectAt(placements, 'A/M/leaf-base', at(10, 0, 0));
  expectAt(placements, 'A/M/leaf-arm', at(10, 0, 5));
  for (const id of ['A/mid-base', 'A/M/leaf-base', 'A/M/leaf-arm']) {
    expect(zAngle(placements.get(id)?.rotation), id).toBeCloseTo(phi, 9);
  }
  // The sibling placement of the same child shows its written placement: B at (0, 0, 10), M at (4, 0, 0) in it.
  expectAt(placements, 'B/mid-base', [0, 0, 10]);
  expectAt(placements, 'B/M/leaf-base', [4, 0, 10]);
  expectAt(placements, 'B/M/leaf-arm', [4, 0, 10]);
  expectAt(placements, 'ground', [...P]);
  // Each child keeps its own child-relative joint value; the parent's drive did not reset or rewrite them.
  const value = (path: readonly string[], key: string): number =>
    Math.round((currentOccurrenceDrive(state, path)?.values.get(`${key}${String.fromCharCode(0)}translation`) ?? Number.NaN) * 1e6) / 1e6;
  expect([value(['A'], 'mid-slide'), value(['A', 'M'], 'leaf-slide')]).toEqual([10, 5]);
  expect(currentOccurrenceDrive(state, ['B'])).toBeUndefined();
  return placements;
}

beforeEach(() => { resetTestStore(); });

describe('nested children follow their moving parent', () => {
  it('shows driven children of a driven parent at the composed placements, child drives first', async () => {
    await publish();
    const document = useAppStore.getState().assembly;
    const history = useAppStore.getState().assemblyUndoStack;
    drive.mid(); drive.leaf(); drive.parent();
    expectFollowsParent();
    // Motion only: the document and the Undo history are the ones that were opened.
    expect(useAppStore.getState().assembly).toBe(document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(history);
  });

  it('gives the same shown placements when the parent is driven first (order cannot fake the result)', async () => {
    await publish();
    drive.mid(); drive.leaf(); drive.parent();
    const childFirst = expectFollowsParent();
    resetTestStore();
    await publish();
    drive.parent(); drive.leaf(); drive.mid();
    const parentFirst = expectFollowsParent();
    expect([...parentFirst.keys()].sort()).toEqual([...childFirst.keys()].sort());
    for (const [id, placement] of childFirst) {
      placement.position.forEach((value, axis) => expect(parentFirst.get(id)?.position[axis], id).toBeCloseTo(value, 9));
    }
  });

  it('keeps the earlier composition when only one level moves', async () => {
    await publish();
    // Child drive only: no parent motion, the driven M carries the leaf.
    drive.mid();
    expectAt(shown(), 'A/M/leaf-base', [P[0], P[1] + 10, 0]);
    // Parent motion only: the undriven M keeps its written place in the turned frame.
    resetTestStore();
    await publish();
    drive.parent();
    const phi = zAngle(useAppStore.getState().assemblyMotionPlacements?.get('A')?.rotation);
    expectAt(shown(), 'A/M/leaf-arm', [P[0] + 4 * Math.cos(phi), P[1] + 4 * Math.sin(phi), 0]);
  });
});
