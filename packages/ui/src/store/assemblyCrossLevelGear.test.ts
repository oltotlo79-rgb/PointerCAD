import { beforeEach, describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  jointFramePairFromTargets, resolveAssembly, resolveMateTarget, type AssemblyComponent, type AssemblyDocument,
  type ComponentSource, type CrossLevelGearCouplingDefinition, type Joint, type JointOccurrenceInputs, type PartLibrary,
  type Placement, type PrimitiveFeature, type Quaternion,
} from '@pointercad/model';
import { currentOccurrenceDrive, jointValueKey } from './assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * Cross-level gear through the store. Written by hand: the child assembly has a fixed `base` and an `arm` on the
 * revolute `child-turn` (arm = a, base = b, aligned, so its angle starts at 0). The parent has a fixed `ground` and the
 * child placed as `A` at (10, 20, 0) (revolute `drive`, A = a, ground = b, starts at 0) and as `B` at (10, 20, 10) on the
 * slider `lift` (both satisfied as written), plus the part `wheel` on a second revolute `spare` (wheel = a, ground = b)
 * for the same-level gear check. Angles are read
 * back from the quaternions: A turns by s * thetaParent and the arm relative to its base by s * thetaChild, with one
 * shared s = +1 or -1 because both joints are defined the same way.
 */
function placement(x: number, y: number, z: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: [0, 0, 0, 1] };
}
function component(id: string, source: ComponentSource, at: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string, minValue: ExpressionValue | null = null): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue, maxValue: null, suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
const gear = (overrides: Partial<CrossLevelGearCouplingDefinition> = {}): CrossLevelGearCouplingDefinition =>
  ({ id: 'cross-gear-1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A'], childJointId: 'child-turn',
    ratio: expression('-2', -2), phaseDeg: expression('0', 0), suppressed: false, ...overrides });

let library: PartLibrary = EMPTY_PART_LIBRARY;

async function open(childLimit: ExpressionValue | null = null): Promise<AssemblyDocument> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const child: AssemblyDocument = { ...createAssemblyDocument('geared child'),
    components: [component('base', part, placement(0, 0, 0), true), component('arm', part, placement(0, 0, 0))],
    joints: [joint('child-turn', 'revolute', 'arm', 'base', childLimit)] };
  library = { ...embedded.library, assemblies: new Map([['child', child]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(10, 20, 0), true),
    component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0)),
    component('B', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 10)),
    component('wheel', part, placement(10, 20, 0)),
  ], joints: [joint('drive', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'B', 'ground'), joint('spare', 'revolute', 'wheel', 'ground')] };
  useAppStore.getState().openAssembly(document, library);
  publishView();
  return document;
}

/** Stands in for attachAssembly's publication of the solved view of the current document (frames from its targets). */
function publishView(): void {
  const document = useAppStore.getState().assembly;
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
/** The shown pair against the relation, read from the poses (parent motion and the child placement drive). */
function expectShown(parentAngle: number, childAngle: number): void {
  const state = useAppStore.getState();
  const turned = zDegrees(state.assemblyMotionPlacements?.get('A')?.rotation);
  const sign = Math.sign(turned) * Math.sign(parentAngle);
  expect(Math.abs(sign)).toBe(1);
  expect(turned).toBeCloseTo(sign * parentAngle, 6);
  const drive = currentOccurrenceDrive(state, ['A']);
  expect(zDegrees(drive?.placements.get('base')?.rotation)).toBeCloseTo(0, 9);
  expect(zDegrees(drive?.placements.get('arm')?.rotation)).toBeCloseTo(sign * childAngle, 6);
  expect(state.assemblyMotionJointValues.get(jointValueKey('drive', 'angle'))).toBeCloseTo(parentAngle, 6);
  expect(drive?.values.get(jointValueKey('child-turn', 'angle'))).toBeCloseTo(childAngle, 6);
  // B, the other placement of the same child, is not driven.
  expect(currentOccurrenceDrive(state, ['B'])).toBeUndefined();
}

beforeEach(() => { resetTestStore(); });

describe('cross-level gear lifecycle in the store', () => {
  it('creates, edits and removes a saved definition as single Undo steps', async () => {
    const opened = await open();
    const store = () => useAppStore.getState();
    expect(store().setAssemblyCrossLevelGears([gear()])).toBe(true);
    const created = store().assembly;
    expect(created?.crossLevelGearCouplings).toEqual([gear()]);
    expect(store().setAssemblyCrossLevelGears([gear({ ratio: expression('0.5', 0.5), phaseDeg: expression('15', 15) })])).toBe(true);
    expect(store().assembly?.crossLevelGearCouplings?.[0]?.ratio.source).toBe('0.5');
    expect(store().setAssemblyCrossLevelGears([])).toBe(true);
    expect(store().assembly?.crossLevelGearCouplings).toEqual([]);
    store().undoAssembly();
    expect(store().assembly?.crossLevelGearCouplings?.[0]?.ratio.source).toBe('0.5');
    store().undoAssembly();
    expect(store().assembly).toBe(created);
    store().undoAssembly();
    expect(store().assembly).toBe(opened);
    store().redoAssembly();
    expect(store().assembly).toBe(created);
  });

  it('refuses invalid definitions and keeps the document, with the reason for the controls', async () => {
    const opened = await open();
    const store = () => useAppStore.getState();
    for (const [definition, code] of [
      [gear({ childJointId: 'none' }), 'missing-child-joint'],
      [gear({ childPath: ['A', 'base'] }), 'not-subassembly'],
      [gear({ parentJointId: 'lift' }), 'unsupported-parent-joint'],
      [gear({ ratio: expression('0', 0) }), 'invalid-ratio'],
    ] as const) {
      expect(store().setAssemblyCrossLevelGears([definition])).toBe(false);
      expect(store().assembly).toBe(opened);
      expect(store().assemblyCrossLevelGearNotice?.code).toBe(code);
    }
    expect(store().assemblyUndoStack?.past ?? []).toHaveLength(0);
  });

  it('keeps the existing same-level gear from taking a cross-level parent joint', async () => {
    await open();
    const store = () => useAppStore.getState();
    expect(store().setAssemblyCrossLevelGears([gear()])).toBe(true);
    publishView();
    const withCross = store().assembly;
    expect(store().setAssemblyMechanismCouplings([{ id: 'gear-1', kind: 'gear', jointAId: 'drive', jointBId: 'spare',
      ratio: expression('1', 1), phaseDeg: expression('0', 0), referenceAngleA: 0, suppressed: false }])).toBe(false);
    expect(store().assembly).toBe(withCross);
  });

  it('drives from the parent side and from the child side, publishing parent motion and child drive together', async () => {
    await open();
    const store = () => useAppStore.getState();
    expect(store().setAssemblyCrossLevelGears([gear()])).toBe(true);
    publishView();
    const document = store().assembly, history = store().assemblyUndoStack;
    expect(store().driveAssemblyCrossLevelGear('cross-gear-1', 'parent', 30)).toBe(true);
    expectShown(30, -60);
    expect(store().driveAssemblyCrossLevelGear('cross-gear-1', 'child', 40)).toBe(true);
    expectShown(-20, 40);
    // Motion only: the document and the history are untouched by both drives.
    expect([store().assembly, store().assemblyUndoStack]).toEqual([document, history]);
    expect(store().assemblyCrossLevelGearNotice).toBeNull();
  });

  it('refuses atomically: a child that cannot follow leaves every shown placement as it was', async () => {
    await open(expression('-10', -10));
    const store = () => useAppStore.getState();
    expect(store().setAssemblyCrossLevelGears([gear()])).toBe(true);
    publishView();
    expect(store().driveAssemblyCrossLevelGear('cross-gear-1', 'parent', 30)).toBe(false);
    expect(store().assemblyCrossLevelGearNotice).toEqual({ couplingId: 'cross-gear-1', code: 'child-at-limit' });
    expect([store().assemblyMotionPlacements, store().assemblyOccurrenceDrives.size]).toEqual([null, 0]);
    // A view that does not belong to the current document refuses before solving.
    expect(store().setAssemblyCrossLevelGears([gear({ phaseDeg: expression('5', 5) })])).toBe(true);
    expect(store().driveAssemblyCrossLevelGear('cross-gear-1', 'parent', 10)).toBe(false);
    expect(store().assemblyCrossLevelGearNotice?.code).toBe('stale-view');
    expect(store().driveAssemblyCrossLevelGear('absent', 'parent', 10)).toBe(false);
  });
});
