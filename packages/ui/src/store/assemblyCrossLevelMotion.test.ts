import { beforeEach, describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  jointFramePairFromTargets, resolveAssembly, resolveMateTarget, type Vec3, type WorkPlane, type AssemblyComponent, type AssemblyDocument,
  type ComponentSource, type CrossLevelGearCouplingDefinition, type Joint, type JointOccurrenceInputs, type PartLibrary,
  type Placement, type PresentationStep, type PrimitiveFeature, type Quaternion, type RigidPlacement,
} from '@pointercad/model';
import { crossLevelDragRefusal, currentOccurrenceDrive } from './assemblyOccurrenceDriveSlice.js';
import { attachAssemblyInteraction } from '../viewport/attachAssemblyInteraction.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * Ordinary motion that turns a coupled parent joint. Written by hand: a fixed `ground` at P = (10, 20, 0); a part `hub`
 * at P on the revolute `spin` (hub = a, ground = b); the child `childA` placed as A at P on the revolute `drive`
 * (A = a, hub = b). Driving spin turns the hub; nothing holds A to the hub's angle, and the solver keeps A where it is,
 * so drive (A relative to hub) changes by minus the spin: the coupled parent joint is turned INDIRECTLY. childA has a
 * fixed `base` and an `arm` on `child-turn` (starts at 0; limited to [-40, 40] in the limited fixture). Saved gear
 * g1: drive -> A/child-turn, ratio -2, phase 0. A second, unrelated assembly has no cross-level gear at all.
 * Relations are checked on the poses: drive's angle is A's rotation relative to the hub's, read from the quaternions.
 */
const P = [10, 20, 0] as const;
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
const G1: CrossLevelGearCouplingDefinition = { id: 'g1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A'],
  childJointId: 'child-turn', ratio: expression('-2', -2), phaseDeg: expression('0', 0), suppressed: false };
const store = () => useAppStore.getState();
let library: PartLibrary = EMPTY_PART_LIBRARY;

async function open(options: { readonly limited?: boolean; readonly coupled?: boolean; readonly steps?: readonly PresentationStep[] } = {}): Promise<void> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const limits: readonly [ExpressionValue | null, ExpressionValue | null] = options.limited === true
    ? [expression('-40', -40), expression('40', 40)] : [null, null];
  const childA: AssemblyDocument = { ...createAssemblyDocument('childA'),
    components: [component('base', part, placement(0, 0, 0), true), component('arm', part, placement(0, 0, 0))],
    joints: [joint('child-turn', 'revolute', 'arm', 'base', limits)] };
  library = { ...embedded.library, assemblies: new Map([['childA', childA]]) };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(...P), true), component('hub', part, placement(...P)),
    component('A', { kind: 'subAssembly', assemblyRef: 'childA' }, placement(...P)),
  ], joints: [joint('spin', 'revolute', 'hub', 'ground'), joint('drive', 'revolute', 'A', 'hub')], presentation: options.steps ?? [] };
  store().openAssembly(document, library);
  if (options.coupled !== false) expect(store().setAssemblyCrossLevelGears([G1])).toBe(true);
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
/** drive's angle on the shown poses (A relative to the hub), and the relation on A's child, up to one shared sign. */
function expectRelationShown(): number {
  const state = store();
  const placements = state.assemblyMotionPlacements;
  const relative = zDegrees(placements?.get('A')?.rotation) - zDegrees(placements?.get('hub')?.rotation);
  const arm = zDegrees(currentOccurrenceDrive(state, ['A'])?.placements.get('arm')?.rotation);
  // Both joints are defined the same way (moving = a, fixed = b, +z), so arm = -2 * relative with no extra sign.
  expect(arm).toBeCloseTo(-2 * relative, 6);
  return relative;
}

beforeEach(() => { resetTestStore(); });

describe('a drive of another joint that turns a coupled parent joint', () => {
  it('carries the coupled placement along in the same update (sync and requested drives)', async () => {
    await open();
    expect(store().driveAssemblyJoint('spin', 'angle', 15)).toBe(true);
    // The parent joint really turned through the linkage (A stayed, the hub turned).
    expect(Math.abs(expectRelationShown())).toBeGreaterThan(1);
    expect(store().requestAssemblyJointDrive('spin', 'angle', -10)).toBe(true);
    // The requested drive runs in cooperative slices; wait until it has published (it clears assemblyJointDrive).
    for (let tries = 0; tries < 500 && store().assemblyJointDrive !== null; tries += 1) {
      await new Promise(resolve => { setTimeout(resolve, 10); });
    }
    expect(store().assemblyJointDrive).toBeNull();
    expectRelationShown();
  });

  it('refuses the whole motion when the coupled placement cannot follow, leaving every pose as it was', async () => {
    await open({ limited: true });
    expect(store().driveAssemblyJoint('spin', 'angle', 5)).toBe(true);
    const placements = store().assemblyMotionPlacements, drives = store().assemblyOccurrenceDrives;
    // Spin 30 would turn drive by about 30 and ask the child for about 60, beyond its 40 limit.
    expect(store().driveAssemblyJoint('spin', 'angle', 30)).toBe(false);
    expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: 'g1', code: 'child-at-limit' });
    expect(store().assemblyMotionPlacements).toBe(placements);
    expect(store().assemblyOccurrenceDrives).toBe(drives);
  });

  it('leaves assemblies without a cross-level gear moving exactly as before', async () => {
    await open({ coupled: false });
    expect(store().driveAssemblyJoint('spin', 'angle', 15)).toBe(true);
    expect(store().assemblyOccurrenceDrives.size).toBe(0);
    expect(store().assemblyCrossLevelMotionNotice).toBeNull();
  });
});

type RequestedRoute = 'gear-parent' | 'gear-child' | 'gear-follow' | 'cam-parent' | 'cam-follow';
const REQUESTED_ROUTES: readonly RequestedRoute[] = ['gear-parent', 'gear-child', 'gear-follow', 'cam-parent', 'cam-follow'];

async function openRequestedRoute(route: RequestedRoute): Promise<void> {
  await open();
  if (route.startsWith('cam')) {
    const document = store().assembly, child = library.assemblies?.get('childA');
    if (document === null || child === undefined) throw new Error('fixture');
    library = { ...library, assemblies: new Map([['childA', { ...child,
      joints: [joint('child-turn', 'slider', 'arm', 'base')] }]]) };
    store().openAssembly({ ...document, crossLevelGearCouplings: [], crossLevelCamCouplings: [{
      id: 'cam-1', kind: 'crossLevelCam', camJointId: 'drive', childPath: ['A'], childJointId: 'child-turn',
      discRadiusMm: expression('20', 20), eccentricityMm: expression('5', 5), rollerRadiusMm: expression('4', 4),
      phaseDeg: expression('0', 0), offsetMm: expression('-10', -10), direction: 1, suppressed: false,
    }] }, library);
    publishView();
  }
}

function requestRoute(route: RequestedRoute, value: number): boolean {
  return route === 'gear-child' ? store().requestAssemblyJointDrive('child-turn', 'angle', value, ['A'])
    : store().requestAssemblyJointDrive(route.endsWith('follow') ? 'spin' : 'drive', 'angle', value);
}

function driveRoute(route: RequestedRoute, value: number): boolean {
  return route === 'gear-child' ? store().driveAssemblyOccurrenceJoint(['A'], 'child-turn', 'angle', value)
    : store().driveAssemblyJoint(route.endsWith('follow') ? 'spin' : 'drive', 'angle', value);
}

function expectRequestedGeometry(route: RequestedRoute): void {
  if (route.startsWith('gear')) { expectRelationShown(); return; }
  const poses = store().assemblyMotionPlacements;
  const theta = (zDegrees(poses?.get('A')?.rotation) - zDegrees(poses?.get('hub')?.rotation)) * Math.PI / 180;
  const height = 5 * Math.cos(theta) + Math.sqrt(24 ** 2 - 25 * Math.sin(theta) ** 2) - 10;
  expect(currentOccurrenceDrive(store(), ['A'])?.placements.get('arm')?.position).toEqual([
    expect.closeTo(10, 6), expect.closeTo(20, 6), expect.closeTo(height, 6),
  ]);
}

describe.each(REQUESTED_ROUTES)('owned cooperative cross-level request: %s', (route) => {
  afterEach(() => { store().cancelAssemblyJointDrive(); vi.useRealTimers(); });

  it.each(['cancel', 'document', 'undo', 'redo', 'later'] as const)(
    'discards a solved result when %s changes its owner before publication', async (invalidate) => {
      await openRequestedRoute(route);
      const original = store().assembly;
      if (original === null) throw new Error('document');
      store().applyAssembly({ ...original, name: 'edited' });
      if (invalidate === 'redo') store().undoAssembly();
      publishView();
      expect(driveRoute(route, 4)).toBe(true);
      const before = store();
      const borrowed = structuredClone({ document: before.assembly, children: library.assemblies });
      vi.useFakeTimers();
      expect(requestRoute(route, 12)).toBe(true);
      const owner = store().assemblyJointDrive;
      expect(owner).not.toBeNull();
      expect(store().assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
      expect(store().assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
      // Deliberately leave the resolved result's microtask pending, exercising the publication guard itself.
      vi.runAllTimers();
      expect(store().assemblyJointDrive).toBe(owner);
      if (invalidate === 'cancel') store().cancelAssemblyJointDrive();
      if (invalidate === 'document') store().applyAssembly({ ...original, name: 'replacement' });
      if (invalidate === 'undo') store().undoAssembly();
      if (invalidate === 'redo') store().redoAssembly();
      if (invalidate === 'later') {
        expect(requestRoute(route, 18)).toBe(true);
        expect(store().assemblyJointDrive?.generation).toBeGreaterThan(owner?.generation ?? Infinity);
        const newer = store().assemblyJointDrive;
        if (owner !== null) store().cancelAssemblyJointDrive(owner);
        expect(store().assemblyJointDrive).toBe(newer);
      }
      const accepted = store();
      const publications: number[] = [];
      const off = useAppStore.subscribe((state, previous) => {
        if (state.assemblyMotionPlacements !== previous.assemblyMotionPlacements
          || state.assemblyOccurrenceDrives !== previous.assemblyOccurrenceDrives) {
          const key = `${route === 'gear-child' ? 'child-turn' : route.endsWith('follow') ? 'spin' : 'drive'}${String.fromCharCode(0)}angle`;
          publications.push((route === 'gear-child' ? currentOccurrenceDrive(state, ['A'])?.values
            : state.assemblyMotionJointValues)?.get(key) ?? Number.NaN);
        }
      });
      try { await vi.runAllTimersAsync(); } finally { off(); }
      expect(publications).toHaveLength(invalidate === 'later' ? 1 : 0);
      if (invalidate === 'later') { expect(publications[0]).toBeCloseTo(18, 6); expectRequestedGeometry(route); }
      else {
        expect(store().assemblyMotionPlacements).toBe(accepted.assemblyMotionPlacements);
        expect(store().assemblyOccurrenceDrives).toBe(accepted.assemblyOccurrenceDrives);
        expect(store().assemblyMotionJointValues).toBe(accepted.assemblyMotionJointValues);
      }
      expect(store().assembly).toBe(accepted.assembly);
      expect(store().assemblyUndoStack).toBe(accepted.assemblyUndoStack);
      expect(store().assemblyJointDrive).toBeNull();
      expect({ document: before.assembly, children: library.assemblies }).toEqual(borrowed);
      if (invalidate === 'cancel') {
        expect(store().assembly).toBe(before.assembly);
        expect(store().assemblyUndoStack).toBe(before.assemblyUndoStack);
        expect(store().assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
        expect(store().assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
      }
    },
  );

  it('publishes parent and child atomically once, matching the synchronous geometry', async () => {
    await openRequestedRoute(route);
    const before = store();
    expect(driveRoute(route, 12)).toBe(true);
    const expected = store();
    expectRequestedGeometry(route);
    useAppStore.setState(before);
    vi.useFakeTimers();
    let publications = 0;
    const off = useAppStore.subscribe((state, previous) => {
      if (state.assemblyMotionPlacements !== previous.assemblyMotionPlacements
        || state.assemblyOccurrenceDrives !== previous.assemblyOccurrenceDrives) {
        publications += 1;
        expect(state.assemblyMotionPlacements).toEqual(expected.assemblyMotionPlacements);
        expect(state.assemblyOccurrenceDrives).toEqual(expected.assemblyOccurrenceDrives);
      }
    });
    try {
      expect(requestRoute(route, 12)).toBe(true);
      expect(publications).toBe(0);
      store().setCommandLineFocused(true);
      expect(store().commandLineFocused).toBe(true);
      expect(store().assemblyJointDrive).not.toBeNull();
      await vi.runAllTimersAsync();
    } finally { off(); }
    expect(publications).toBe(1);
    expectRequestedGeometry(route);
    expect(store().assembly).toBe(before.assembly);
    expect(store().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });
});

describe('presentation and drag paths', () => {
  const step = (to: number): PresentationStep => ({ id: 'step-1', name: 'turn', start: 0, end: 1,
    body: { kind: 'joint', jointId: 'spin', from: expression('0', 0), to: expression(String(to), to), coordinate: 'angle' } });

  it('carries the coupled placement through a presentation step, or refuses the step whole', async () => {
    await open({ steps: [step(20)] });
    expect(store().setAssemblyMotionTime(1)).toBe(true);
    expectRelationShown();
    resetTestStore();
    await open({ limited: true, steps: [step(30)] });
    expect(store().setAssemblyMotionTime(1)).toBe(false);
    expect(store().assemblyCrossLevelMotionNotice?.code).toBe('child-at-limit');
    expect([store().assemblyMotionPlacements, store().assemblyOccurrenceDrives.size]).toEqual([null, 0]);
  });

  it('refuses a drag that turns the coupled parent joint, and lets a drag that keeps it pass', () => {
    const at = (degrees: number): RigidPlacement => ({ position: [...P], rotation: [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)] });
    const before = new Map([['ground', at(0)], ['hub', at(0)], ['A', at(0)]]);
    const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [],
      joints: [joint('spin', 'revolute', 'hub', 'ground'), joint('drive', 'revolute', 'A', 'hub')], crossLevelGearCouplings: [G1] };
    // A turned against the hub: drive changed -> refused with the coupling named.
    expect(crossLevelDragRefusal({ assembly: document }, before, new Map(before).set('A', at(10))))
      .toEqual({ couplingId: 'g1', code: 'coupled-motion' });
    // Hub and A turned together: drive unchanged -> the drag may continue.
    expect(crossLevelDragRefusal({ assembly: document }, before, new Map(before).set('A', at(10)).set('hub', at(10)))).toBeNull();
    // No cross-level gear: never refused.
    expect(crossLevelDragRefusal({ assembly: { ...document, crossLevelGearCouplings: [] } }, before, new Map(before).set('A', at(10)))).toBeNull();
  });
});

describe('coupled pointer drag after a refused release', () => {
  it('releases ownership after 30 degrees, accepts 12 degrees on the camera plane, and keeps an ordinary drag one Undo', async () => {
    await open({ limited: true });
    const original = store().assembly, source = original?.components[0]?.source;
    if (original === null || source === undefined) throw new Error('fixture document');
    const slider: Joint = { ...joint('handle-slide', 'slider', 'handle', 'wheel'),
      a: { kind: 'origin', componentId: 'handle', element: 'x' },
      b: { kind: 'origin', componentId: 'wheel', element: 'x' } };
    const document: AssemblyDocument = { ...original, components: [
      component('ground', source, placement(0, 0, 0), true), component('wheel', source, placement(0, 0, 0)),
      component('handle', source, placement(50, 0, 0)), component('loose', source, placement(0, -60, 0)),
      component('A', { kind: 'subAssembly', assemblyRef: 'childA' },
        { ...placement(0, 0, 100), rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }, true),
    ], joints: [joint('drive', 'revolute', 'wheel', 'ground'), slider] };
    store().openAssembly(document, library);
    publishView();
    useAppStore.setState({ isComputing: false, selectionKind: 'body', activeTool: 'select' });
    // Home camera normal. Unlike an XY-only action test, its pin asks for a blocked Z component.
    const normal: Vec3 = [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const callbacks = new Map<number, () => void>();
    let sequence = 0, picked = 'handle';
    const canvas = Object.assign(new EventTarget(), { focus: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    canvas.releasePointerCapture.mockImplementation((pointerId: number) => {
      canvas.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId }));
    });
    const scene = { pickComponent: () => picked, pickAssemblyFace: () => null,
      worldToScreen: (point: Vec3): readonly [number, number] => [point[0], point[1]],
      screenToPlanePoint: (x: number, y: number, plane: WorkPlane): Vec3 => [x, y, plane.origin[2]
        - ((x - plane.origin[0]) * plane.normal[0] + (y - plane.origin[1]) * plane.normal[1]) / plane.normal[2]] };
    const input = attachAssemblyInteraction(canvas, scene, { viewDirection: () => normal,
      requestFrame: callback => { sequence += 1; callbacks.set(sequence, callback); return sequence; },
      cancelFrame: id => { callbacks.delete(id); } });
    const send = (type: string, x: number, y: number): void => {
      canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }),
        { button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, altKey: false, clientX: x, clientY: y }));
    };
    const before = store();
    try {
      for (const degrees of [30, 12]) {
        send('pointerdown', 50, 0);
        expect(store().assemblyDrag).not.toBeNull();
        const x = 50 * Math.cos(degrees * Math.PI / 180), y = 50 * Math.sin(degrees * Math.PI / 180);
        for (let step = 1; step <= 12; step += 1) {
          send('pointermove', 50 + (x - 50) * step / 12, y * step / 12);
          const ready = [...callbacks.values()]; callbacks.clear();
          for (const callback of ready) callback();
        }
        send('pointerup', x, y);
        expect(store().assemblyDrag).toBeNull();
        expect(store().assemblyDragOverlay).toBeNull();
        expect(store().assembly).toBe(document);
        expect(store().assemblyUndoStack).toBe(before.assemblyUndoStack);
        expect(store().documentVersion).toBe(before.documentVersion);
        expect(store().requestedGeneration).toBe(before.requestedGeneration);
        if (degrees === 30) {
          expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: 'g1', code: 'child-at-limit' });
          expect(store().assemblyMotionPlacements).toBeNull();
          expect(store().assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
        } else expect(store().assemblyMotionPlacements).not.toBeNull();
      }
      const shown = store().assemblyMotionPlacements;
      const angle = zDegrees(shown?.get('wheel')?.rotation), radians = angle * Math.PI / 180;
      expect(Math.abs(angle)).toBeGreaterThan(6);
      expect(Math.abs(angle - 12)).toBeLessThan(1);
      const handle = shown?.get('handle')?.position;
      if (handle === undefined) throw new Error('shown handle');
      expect(Math.abs(handle[0] * Math.sin(radians) - handle[1] * Math.cos(radians))).toBeLessThan(1e-6);
      expect(Math.abs(handle[2])).toBeLessThan(1e-9);
      expect(shown?.get('A')).toEqual(before.assemblyView?.resolved.placements.get('A'));
      const arm = currentOccurrenceDrive(store(), ['A'])?.placements.get('arm');
      if (arm === undefined) throw new Error('coupled arm');
      const [qx, qy, qz, qw] = arm.rotation;
      const armX = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw)];
      [Math.cos(2 * radians), 0, -Math.sin(2 * radians)].forEach((value, axis) => expect(armX[axis]).toBeCloseTo(value, 6));
      [0, 0, 100].forEach((value, axis) => expect(arm.position[axis]).toBeCloseTo(value, 6));
      expect(canvas.setPointerCapture).toHaveBeenCalledTimes(2);
      expect(canvas.releasePointerCapture).toHaveBeenCalledTimes(2);
      expect(callbacks.size).toBe(0);

      picked = 'loose';
      send('pointerdown', 0, -60);
      send('pointermove', 15, -60);
      send('pointerup', 15, -60);
      expect(store().assembly).not.toBe(document);
      expect(store().assemblyUndoStack?.past).toHaveLength(1);
      store().undoAssembly();
      expect(store().assembly).toBe(document);
    } finally { input.detach(); }
  });
});
