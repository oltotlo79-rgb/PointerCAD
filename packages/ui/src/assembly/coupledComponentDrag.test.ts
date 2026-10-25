import { beforeEach, describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, DEFAULT_RIGID_LENGTH_TOLERANCE, embedPart,
  EMPTY_PART_LIBRARY, jointFramePairFromTargets, resolveAssembly, resolveMateTarget, WORK_PLANES, type AssemblyComponent,
  type AssemblyDocument, type ComponentSource, type CrossLevelCamCouplingDefinition, type CrossLevelGearCouplingDefinition,
  type Joint, type JointOccurrenceInputs, type Mate, type MateDragOutcome, type MateTarget, type PartLibrary, type Placement,
  type PrimitiveFeature, type Quaternion, type RigidPlacement, type Vec3,
} from '@pointercad/model';
import * as actions from './dragComponentActions.js';
import { currentOccurrenceDrive, jointValueKey } from '../store/assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

/*
 * A drag that turns a cross-level coupled parent joint, through the public drag functions only (begin/move/finish/
 * cancel). Successor of the drag-r1 test (task014 drag-coverage-r1).
 *
 * Fixture, written by hand: fixed `ground` at the origin; `wheel` at the origin on the revolute `drive` (wheel = a,
 * ground = b, origin z axes); `handle` at (50, 0, 0) on the slider `handle-slide` along the wheel's x axis (handle x = a,
 * wheel x = b), so the handle can reach any point of the plane z = 0 by turning the wheel by t and sliding to the radius;
 * pulling it to PULL = 50 (cos 30, sin 30, 0) turns the wheel by 30 degrees. The child `armChild` is placed as `A` at
 * (0, 0, 100) turned +90 degrees about x (fixed): fixed `base`, `arm` on the revolute `child-turn` (arm = a, base = b) and
 * `follower` on the slider `push` (follower = a, base = b, origin z axes). A free part `loose` at (200, 0, 0) has no
 * joint; `tag` (mixed fixture only) is held to the handle origin by a coincident mate and no joint.
 * Relations, each saved alone on the parent joint `drive`:
 * - gear g1: drive -> A/child-turn, ratio -2, phase 0. Both joints are moving = a, fixed = b about +z, so the arm turns
 *   -2t; in the world its x axis is Rx(90) Rz(-2t) (1, 0, 0) = (cos 2t, 0, -sin 2t) and it stays at (0, 0, 100).
 * - cam k1: drive -> A/push, R 20, e 5, r 4, phase 0, offset -10, direction +1:
 *   x(t) = 5 cos t + sqrt(24^2 - 25 sin^2 t) - 10 (even in t), x(0) = 19, x(30) = 5 cos 30 + sqrt(569.75) - 10 = 18.199...;
 *   the leaf z axis is the world -y axis in A, so the follower is at (0, -x(t), 100) with the leaf axes Rx(90).
 * Acceptance of the reached pose (no fixed iteration count is assumed): the frames approach PULL along the circle; the
 * last frames at PULL are repeated until the solver itself reports 'targetReached', which by solveMateDrag means the
 * handle is within DEFAULT_RIGID_LENGTH_TOLERANCE (1e-9 mm) of PULL on every axis; with the handle on the wheel's x axis
 * (a satisfied hard row) that bounds the wheel angle to 30 degrees within 1e-9 / 50 rad. Every child expectation is
 * recomputed from the reached angle t read back from the published placements, not from 30.
 */
const DEG = Math.PI / 180;
const RADIUS = 50;
const at = (degrees: number): Vec3 => [RADIUS * Math.cos(degrees * DEG), RADIUS * Math.sin(degrees * DEG), 0];
const PULL = at(30);
/** The angle bound the solver's own target criterion gives at the radius (see the header). */
const REACHED_ANGLE_BOUND_DEG = (DEFAULT_RIGID_LENGTH_TOLERANCE / RADIUS) / DEG * 10;
const camLaw = (degrees: number): number => 5 * Math.cos(degrees * DEG) + Math.sqrt(24 * 24 - 25 * Math.sin(degrees * DEG) ** 2) - 10;

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, place: Placement, fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: place, fixed, visible: true, suppressed: false };
}
const origin = (componentId: string, element: 'z' | 'x' | 'origin'): MateTarget => ({ kind: 'origin', componentId, element });
function joint(id: string, kind: Joint['kind'], a: MateTarget, b: MateTarget, limits: readonly [ExpressionValue | null, ExpressionValue | null] = [null, null]): Joint {
  return { id, name: id, kind, a, b, minValue: limits[0], maxValue: limits[1], suppressed: false };
}
const expression = (source: string, value: number): ExpressionValue => ({ ...expressionValueFromNumber(value), source });
const G1: CrossLevelGearCouplingDefinition = { id: 'g1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A'],
  childJointId: 'child-turn', ratio: expression('-2', -2), phaseDeg: expression('0', 0), suppressed: false };
const K1: CrossLevelCamCouplingDefinition = { id: 'k1', kind: 'crossLevelCam', camJointId: 'drive', childPath: ['A'], childJointId: 'push',
  discRadiusMm: expression('20', 20), eccentricityMm: expression('5', 5), rollerRadiusMm: expression('4', 4),
  phaseDeg: expression('0', 0), offsetMm: expression('-10', -10), direction: 1, suppressed: false };
const store = () => useAppStore.getState();
let library: PartLibrary = EMPTY_PART_LIBRARY;

interface FixtureOptions {
  readonly relation: 'gear' | 'cam';
  /** child-turn limited to [-40, 40] degrees (gear) or push to at most 15 mm (cam). */
  readonly limited?: boolean;
  readonly tag?: boolean;
}
async function open(options: FixtureOptions): Promise<AssemblyDocument> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const limited = options.limited === true;
  const turnLimits: readonly [ExpressionValue | null, ExpressionValue | null] = limited && options.relation === 'gear'
    ? [expression('-40', -40), expression('40', 40)] : [null, null];
  const pushMax = limited && options.relation === 'cam' ? 15 : 25;
  const armChild: AssemblyDocument = { ...createAssemblyDocument('armChild'),
    components: [component('base', part, placement(0, 0, 0), true), component('arm', part, placement(0, 0, 0)),
      component('follower', part, placement(0, 0, 0))],
    joints: [joint('child-turn', 'revolute', origin('arm', 'z'), origin('base', 'z'), turnLimits),
      joint('push', 'slider', origin('follower', 'z'), origin('base', 'z'), [null, expression(String(pushMax), pushMax)])] };
  library = { ...embedded.library, assemblies: new Map([['armChild', armChild]]) };
  const tagMate: Mate = { id: 'mate-1', name: 'mate-1', kind: 'coincident', a: origin('tag', 'origin'), b: origin('handle', 'origin'),
    flipped: false, suppressed: false };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('ground', part, placement(0, 0, 0), true), component('wheel', part, placement(0, 0, 0)),
    component('handle', part, placement(RADIUS, 0, 0)),
    component('A', { kind: 'subAssembly', assemblyRef: 'armChild' }, placement(0, 0, 100, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]), true),
    component('loose', part, placement(200, 0, 0)),
    ...(options.tag === true ? [component('tag', part, placement(RADIUS, 0, 0))] : []),
  ], joints: [joint('drive', 'revolute', origin('wheel', 'z'), origin('ground', 'z')),
    joint('handle-slide', 'slider', origin('handle', 'x'), origin('wheel', 'x'))],
  mates: options.tag === true ? [tagMate] : [] };
  store().openAssembly(document, library);
  if (options.relation === 'gear') expect(store().setAssemblyCrossLevelGears([G1])).toBe(true);
  else expect(store().setAssemblyCrossLevelCams([K1])).toBe(true);
  publishView();
  // The drag runs only for the body selection with the select tool (the conditions of the viewport input).
  useAppStore.setState({ isComputing: false, selectionKind: 'body', activeTool: 'select' });
  const opened = store().assembly;
  if (opened === null) throw new Error('document');
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

function zDegrees(rotation: readonly number[] | undefined): number {
  const [x = Number.NaN, y = Number.NaN, z = Number.NaN, w = Number.NaN] = rotation ?? [];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) / DEG;
}
function rotate(rotation: readonly number[] | undefined, v: readonly [number, number, number]): readonly number[] {
  const [x = Number.NaN, y = Number.NaN, z = Number.NaN, w = Number.NaN] = rotation ?? [];
  const cross = (a: readonly number[], b: readonly number[]): readonly number[] => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];
  const t = cross([x, y, z], v), u = cross([x, y, z], t);
  return v.map((value, axis) => value + 2 * w * (t[axis] ?? 0) + 2 * (u[axis] ?? 0));
}
function expectVector(actual: readonly number[] | undefined, expected: readonly number[], digits = 6): void {
  expected.forEach((value, axis) => expect(actual?.[axis]).toBeCloseTo(value, digits));
}
type Shown = ReadonlyMap<string, RigidPlacement> | null | undefined;

/**
 * The parent invariants of any accepted pose (hard rows of the two joints), and the wheel angle t they leave free:
 * the handle lies on the wheel's turned x axis in the plane z = 0 and turns with the wheel.
 */
function reachedAngle(parent: Shown): number {
  const t = zDegrees(parent?.get('wheel')?.rotation);
  const handle = parent?.get('handle');
  const radial = rotate(parent?.get('wheel')?.rotation, [1, 0, 0]);
  const position = handle?.position ?? [Number.NaN, Number.NaN, Number.NaN];
  // Perpendicular distance from the wheel's x axis and height above z = 0, within 1e-6 mm.
  expect(Math.abs((position[0] ?? Number.NaN) * (radial[1] ?? Number.NaN) - (position[1] ?? Number.NaN) * (radial[0] ?? Number.NaN))).toBeLessThan(1e-6);
  expect(Math.abs(position[2] ?? Number.NaN)).toBeLessThan(1e-6);
  expect(zDegrees(handle?.rotation)).toBeCloseTo(t, 6);
  return t;
}
/** The coupled child at the reached angle t (world frame), recomputed by hand from t. */
function expectChild(relation: 'gear' | 'cam', t: number): void {
  const drive = currentOccurrenceDrive(store(), ['A']);
  if (relation === 'gear') {
    const arm = drive?.placements.get('arm');
    expectVector(rotate(arm?.rotation, [1, 0, 0]), [Math.cos(2 * t * DEG), 0, -Math.sin(2 * t * DEG)]);
    expectVector(arm?.position, [0, 0, 100]);
    // The shown child joint value is the ratio times the parent angle (its sign convention is the joint's own).
    expect(Math.abs(drive?.values.get(jointValueKey('child-turn', 'angle')) ?? Number.NaN)).toBeCloseTo(2 * Math.abs(t), 6);
  } else {
    const follower = drive?.placements.get('follower');
    expectVector(follower?.position, [0, -camLaw(t), 100]);
    expectVector(rotate(follower?.rotation, [0, 0, 1]), [0, -1, 0]);
    expect(drive?.values.get(jointValueKey('push', 'translation'))).toBeCloseTo(camLaw(t), 6);
  }
}
const pull = (): boolean => actions.beginComponentDrag('handle', WORK_PLANES.xy, [RADIUS, 0, 0]);
/** One preview frame with the default frame budget; a frame request must never be rejected as invalid input. */
function frame(point: Vec3): MateDragOutcome | null {
  const result = actions.moveComponentDrag(point);
  expect(result?.stop).not.toBe('invalidInput');
  return result;
}
/** Frames along the circle to PULL, then repeated at PULL until the solver reports the target reached (bounded). */
function pullToTarget(): MateDragOutcome {
  for (let degrees = 3; degrees <= 30; degrees += 3) expect(frame(at(degrees))?.hardSatisfied).toBe(true);
  let last = frame(PULL);
  for (let repeat = 0; repeat < 20 && last?.stop !== 'targetReached'; repeat += 1) last = frame(PULL);
  if (last === null) throw new Error('refused');
  expect(last.stop).toBe('targetReached');
  expect(last.driverError).toBeLessThan(DEFAULT_RIGID_LENGTH_TOLERANCE);
  return last;
}

beforeEach(() => { resetTestStore(); });

describe.each(['gear', 'cam'] as const)('a drag that turns the parent joint of a cross-level %s', (relation) => {
  it('previews the parent and the coupled child together, then releases them as joint motion without a document edit', async () => {
    const document = await open({ relation });
    const history = store().assemblyUndoStack, generation = store().requestedGeneration;
    expect(pull()).toBe(true);
    pullToTarget();
    const t = reachedAngle(store().assemblyDragOverlay?.placements);
    expect(Math.abs(t - 30)).toBeLessThan(REACHED_ANGLE_BOUND_DEG);
    expectChild(relation, t);
    expect([store().assembly, store().assemblyUndoStack, store().requestedGeneration]).toEqual([document, history, generation]);
    expect(actions.finishComponentDrag(PULL)).toBe(true);
    expect([store().assemblyDrag, store().assemblyDragOverlay]).toEqual([null, null]);
    const released = reachedAngle(store().assemblyMotionPlacements);
    expect(Math.abs(released - 30)).toBeLessThan(REACHED_ANGLE_BOUND_DEG);
    expectChild(relation, released);
    expect(store().assembly).toBe(document);
    expect(store().assemblyUndoStack).toBe(history);
    expect(Math.abs(store().assemblyMotionJointValues.get(jointValueKey('drive', 'angle')) ?? Number.NaN)).toBeCloseTo(Math.abs(released), 6);
    expect(store().assemblyCrossLevelMotionNotice).toBeNull();
    expectVector(store().assemblyMotionPlacements?.get('loose')?.position, [200, 0, 0]);
  });

  it('keeps every intermediate preview coupled: each frame shows the child of that frame', async () => {
    await open({ relation });
    expect(pull()).toBe(true);
    for (const degrees of [6, 12, 18]) {
      expect(frame(at(degrees))?.hardSatisfied).toBe(true);
      expectChild(relation, reachedAngle(store().assemblyDragOverlay?.placements));
    }
    actions.cancelComponentDrag();
  });

  it('refuses the whole drag when the coupled child cannot follow, publishing nothing', async () => {
    // gear: 30 asks -60, beyond 40; cam: x(t) >= 19 - 1 > 15 for every small t.
    const document = await open({ relation, limited: true });
    const history = store().assemblyUndoStack, drives = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    const overlay = store().assemblyDragOverlay;
    let refused = false;
    for (let degrees = 3; degrees <= 30 && !refused; degrees += 3) refused = actions.moveComponentDrag(at(degrees)) === null;
    // Frames may lag behind the pointer (five iterations each): keep pulling at PULL until the limit is met (bounded).
    for (let repeat = 0; repeat < 20 && !refused; repeat += 1) refused = actions.moveComponentDrag(PULL) === null;
    expect(refused).toBe(true);
    expect(store().assemblyDragNotice).toBe('failed');
    expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: relation === 'gear' ? 'g1' : 'k1', code: 'child-at-limit' });
    // The child never shows a partial pose: either the start drives or the drives of the last accepted frame (gear
    // frames below 20 degrees are allowed), and then the matching parent overlay.
    const shown = store().assemblyDragOverlay;
    expect(shown === overlay ? store().assemblyOccurrenceDrives === drives : currentOccurrenceDrive(store(), ['A']) !== undefined).toBe(true);
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect([store().assembly, store().assemblyUndoStack, store().assemblyMotionPlacements]).toEqual([document, history, null]);
    expect(store().assemblyOccurrenceDrives).toBe(drives);
  });

  it('refuses a drag that also moves a part no joint connects (an ambiguous mixed edit), with the reason', async () => {
    const document = await open({ relation, tag: true });
    const history = store().assemblyUndoStack, drives = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    expect(actions.moveComponentDrag(at(3))).toBeNull();
    expect(store().assemblyCrossLevelMotionNotice).toEqual({ couplingId: relation === 'gear' ? 'g1' : 'k1', code: 'coupled-drag-mixed' });
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect([store().assembly, store().assemblyUndoStack, store().assemblyMotionPlacements]).toEqual([document, history, null]);
    expect(store().assemblyOccurrenceDrives).toBe(drives);
  });
});

describe('the lifecycle of a coupled drag', () => {
  it('gives back the start drives when cancelled, and publishes nothing for a release after the cancel', async () => {
    await open({ relation: 'gear' });
    const before = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    frame(at(9));
    expect(currentOccurrenceDrive(store(), ['A'])).toBeDefined();
    actions.cancelComponentDrag();
    expect(store().assemblyOccurrenceDrives).toBe(before);
    expect([store().assemblyMotionPlacements, store().assemblyDragOverlay, store().assemblyDrag]).toEqual([null, null, null]);
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect(store().assemblyMotionPlacements).toBeNull();
  });

  it.each(['document', 'version', 'generation'] as const)('drops a drag whose %s became stale, without partial motion', async (stale) => {
    await open({ relation: 'gear' });
    const before = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    frame(at(9));
    if (stale === 'document') expect(store().setAssemblyCrossLevelGears([{ ...G1, phaseDeg: expression('5', 5) }])).toBe(true);
    else if (stale === 'version') useAppStore.setState({ documentVersion: store().documentVersion + 1 });
    else useAppStore.setState({ requestedGeneration: store().requestedGeneration + 1 });
    const document = store().assembly, history = store().assemblyUndoStack;
    const replacement = store();
    expect(actions.moveComponentDrag(at(12))).toBeNull();
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect([store().assemblyDrag, store().assemblyDragOverlay, store().assemblyMotionPlacements]).toEqual([null, null, null]);
    expect(store().assemblyOccurrenceDrives).toBe(stale === 'version' ? replacement.assemblyOccurrenceDrives : before);
    expect(store().assemblyLibrary).toBe(replacement.assemblyLibrary);
    expect(store().activeDocumentId).toBe(replacement.activeDocumentId);
    expect(store().documentVersion).toBe(replacement.documentVersion);
    expect(store().requestedGeneration).toBe(replacement.requestedGeneration);
    expect([store().assembly, store().assemblyUndoStack]).toEqual([document, history]);
  });

  it('refuses a second drag while one is active and ignores a frame that arrives after the release', async () => {
    await open({ relation: 'gear' });
    expect(pull()).toBe(true);
    frame(at(9));
    const overlay = store().assemblyDragOverlay, session = store().assemblyDrag;
    expect(actions.beginComponentDrag('loose', WORK_PLANES.xy, [200, 0, 0])).toBe(false);
    expect([store().assemblyDragOverlay, store().assemblyDrag]).toEqual([overlay, session]);
    pullToTarget();
    expect(actions.finishComponentDrag(PULL)).toBe(true);
    const motion = store().assemblyMotionPlacements, drives = store().assemblyOccurrenceDrives;
    expect(actions.moveComponentDrag(at(20))).toBeNull();
    expect(store().assemblyMotionPlacements).toBe(motion);
    expect(store().assemblyOccurrenceDrives).toBe(drives);
    expect(store().assemblyDragOverlay).toBeNull();
  });

  it('shows the start drives again when the handle is pulled back to the start', async () => {
    await open({ relation: 'gear' });
    const before = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    frame(at(9));
    for (let repeat = 0; repeat < 20; repeat += 1) {
      const result = frame(at(0));
      if (result?.stop === 'targetReached') break;
    }
    const t = reachedAngle(store().assemblyDragOverlay?.placements);
    expect(Math.abs(t)).toBeLessThan(REACHED_ANGLE_BOUND_DEG);
    // Back at the start within CROSS_LEVEL_RELATIVE_POSE_TOLERANCE the start drives are shown again; a remaining
    // turn (beyond that tolerance) shows the child of that turn. Never a child left at the earlier frame's turn.
    const arm = currentOccurrenceDrive(store(), ['A'])?.placements.get('arm');
    const armX = arm === undefined ? null : rotate(arm.rotation, [1, 0, 0]);
    expect(armX === null ? store().assemblyOccurrenceDrives === before
      : [Math.cos(2 * t * DEG), 0, -Math.sin(2 * t * DEG)].every((value, axis) => Math.abs((armX[axis] ?? Number.NaN) - value) < 1e-6)).toBe(true);
    actions.cancelComponentDrag();
    expect(store().assemblyOccurrenceDrives).toBe(before);
  });
});

describe('an unavailable child and an ordinary drag', () => {
  it('suspends the relation when its child joint is gone, so the drag is ordinary and nothing coupled is published', async () => {
    const document = await open({ relation: 'gear' });
    const child = library.assemblies?.get('armChild');
    if (child === undefined) throw new Error('fixture child');
    const without = { ...library, assemblies: new Map([['armChild', { ...child,
      joints: child.joints.map(item => item.id === 'child-turn' ? { ...item, suppressed: true } : item) }]]) };
    store().applyAssembly(document, without);
    library = without;
    expect(store().assembly?.crossLevelGearCouplings).toEqual([{ ...G1, suppressed: true }]);
    expect(store().assemblyCrossLevelGearRepairs.map(repair => [repair.couplingId, repair.action])).toEqual([['g1', 'suspended']]);
    publishView();
    useAppStore.setState({ isComputing: false, selectionKind: 'body', activeTool: 'select' });
    const drives = store().assemblyOccurrenceDrives, suspended = store().assembly;
    expect(pull()).toBe(true);
    frame(at(9));
    expect(store().assemblyOccurrenceDrives).toBe(drives);
    expect(actions.finishComponentDrag(at(9))).toBe(true);
    // The ordinary path: one document edit, no motion, no child drive.
    expect(store().assembly).not.toBe(suspended);
    expect(store().assemblyMotionPlacements).toBeNull();
    expect(store().assemblyOccurrenceDrives).toBe(drives);
  });

  it('keeps an ordinary drag of a free part one document edit with one Undo step', async () => {
    const document = await open({ relation: 'gear' });
    const drives = store().assemblyOccurrenceDrives;
    expect(actions.beginComponentDrag('loose', WORK_PLANES.xy, [200, 0, 0])).toBe(true);
    actions.moveComponentDrag([210, 0, 0]);
    expect(store().assemblyOccurrenceDrives).toBe(drives);
    expect(actions.finishComponentDrag([210, 0, 0])).toBe(true);
    expect(store().assembly?.components.find(c => c.id === 'loose')?.placement.position[0].value).toBeCloseTo(210, 9);
    expect(store().assemblyUndoStack?.past).toHaveLength(2);
    expect(store().assemblyMotionPlacements).toBeNull();
    store().undoAssembly();
    expect(store().assembly).toBe(document);
  });
});

describe('coupled preview restoration ownership', () => {
  it.each(['document', 'library', 'documentId', 'version'] as const)('a stale %s cannot restore old child drives into replacement state', async (identity) => {
    const document = await open({ relation: 'gear' });
    const before = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    expect(frame(at(9))?.hardSatisfied).toBe(true);
    const published = store().assemblyOccurrenceDrives;
    expect(published).not.toBe(before);
    expect(currentOccurrenceDrive(store(), ['A'])).toBeDefined();
    // Model a replacement publication while the old drag is still awaiting its next request.
    // No newer drive map is installed: map-reference equality alone must not authorize rollback.
    if (identity === 'document') useAppStore.setState({ assembly: { ...document } });
    else if (identity === 'library') useAppStore.setState({ assemblyLibrary: { ...library } });
    else if (identity === 'documentId') useAppStore.setState({ activeDocumentId: crypto.randomUUID() });
    else useAppStore.setState({ documentVersion: store().documentVersion + 1 });
    useAppStore.setState({ requestedGeneration: store().requestedGeneration + 1 });
    const replaced = store();
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect(store().assemblyDrag).toBeNull();
    expect(store().assemblyDragOverlay).toBeNull();
    expect(store().assemblyOccurrenceDrives).toBe(published);
    expect(store().assembly).toBe(replaced.assembly);
    expect(store().assemblyLibrary).toBe(replaced.assemblyLibrary);
    expect(store().activeDocumentId).toBe(replaced.activeDocumentId);
    expect(store().documentVersion).toBe(replaced.documentVersion);
    expect(store().requestedGeneration).toBe(replaced.requestedGeneration);
    expect(store().assemblyUndoStack).toBe(replaced.assemblyUndoStack);
  });
});

describe('a coupled preview ended by an edit or Undo of its own document', () => {
  it('gives back the start drives when an edit of the current document ends the drag, and Undo shows no abandoned preview', async () => {
    const document = await open({ relation: 'gear' });
    const before = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    expect(frame(at(9))?.hardSatisfied).toBe(true);
    expect(store().assemblyOccurrenceDrives).not.toBe(before);
    expect(store().setAssemblyCrossLevelGears([{ ...G1, phaseDeg: expression('5', 5) }])).toBe(true);
    // The edit itself ends the drag (applyAssembly): the preview the drag published must not outlive it.
    expect([store().assemblyDrag, store().assemblyDragOverlay]).toEqual([null, null]);
    expect(store().assembly).not.toBe(document);
    expect(store().assemblyOccurrenceDrives).toBe(before);
    store().undoAssembly();
    // Back on the dragged document with its unchanged view: the abandoned 9 degree child pose is not shown again.
    expect(store().assembly).toBe(document);
    expect(currentOccurrenceDrive(store(), ['A'])).toBeUndefined();
    expect(store().assemblyOccurrenceDrives).toBe(before);
  });

  it('gives back the start drives when Undo ends the drag', async () => {
    await open({ relation: 'gear' });
    expect(store().setAssemblyCrossLevelGears([{ ...G1, phaseDeg: expression('5', 5) }])).toBe(true);
    const edited = store().assembly;
    publishView();
    useAppStore.setState({ isComputing: false, selectionKind: 'body', activeTool: 'select' });
    const before = store().assemblyOccurrenceDrives;
    expect(pull()).toBe(true);
    expect(frame(at(9))?.hardSatisfied).toBe(true);
    expect(store().assemblyOccurrenceDrives).not.toBe(before);
    store().undoAssembly();
    expect(store().assembly).not.toBe(edited);
    expect([store().assemblyDrag, store().assemblyDragOverlay]).toEqual([null, null]);
    expect(store().assemblyOccurrenceDrives).toBe(before);
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect(store().assemblyMotionPlacements).toBeNull();
  });

  it('gives back the start drives when Undo with nothing to undo cancels the drag', async () => {
    const document = await open({ relation: 'gear' });
    // open() saves the gear through setAssemblyCrossLevelGears, which is one Undo step. Reopen that prepared document
    // through the public openAssembly so the history really is empty, then publish its view like open() does.
    store().openAssembly(document, library);
    publishView();
    useAppStore.setState({ isComputing: false, selectionKind: 'body', activeTool: 'select' });
    expect(store().assembly).toBe(document);
    expect(store().assembly?.crossLevelGearCouplings).toEqual([G1]);
    const before = store().assemblyOccurrenceDrives, history = store().assemblyUndoStack;
    expect(history?.past).toHaveLength(0);
    expect(pull()).toBe(true);
    expect(frame(at(9))?.hardSatisfied).toBe(true);
    expect(store().assemblyOccurrenceDrives).not.toBe(before);
    store().undoAssembly();
    expect([store().assemblyDrag, store().assemblyDragOverlay]).toEqual([null, null]);
    expect([store().assembly, store().assemblyUndoStack]).toEqual([document, history]);
    expect(store().assemblyOccurrenceDrives).toBe(before);
  });

  it('keeps a drive map with the same content but another identity: content does not make it the drag preview', async () => {
    await open({ relation: 'gear' });
    expect(pull()).toBe(true);
    expect(frame(at(9))?.hardSatisfied).toBe(true);
    const copy = new Map(store().assemblyOccurrenceDrives);
    useAppStore.setState({ assemblyOccurrenceDrives: copy });
    actions.cancelComponentDrag();
    expect(store().assemblyDrag).toBeNull();
    expect(store().assemblyOccurrenceDrives).toBe(copy);
  });

  it('keeps the exact drive map an external replacement document supplies', async () => {
    const document = await open({ relation: 'gear' });
    expect(pull()).toBe(true);
    expect(frame(at(9))?.hardSatisfied).toBe(true);
    const supplied = new Map(store().assemblyOccurrenceDrives);
    useAppStore.setState({ assembly: { ...document }, assemblyOccurrenceDrives: supplied });
    expect(actions.finishComponentDrag(PULL)).toBe(false);
    expect(store().assemblyDrag).toBeNull();
    expect(store().assemblyOccurrenceDrives).toBe(supplied);
    expect(store().assemblyMotionPlacements).toBeNull();
  });
});

describe('joint-frame ownership at the public drag boundary', () => {
  it('uses published joint frames and refuses absent or unresolved frames without changing state', async () => {
    const document = await open({ relation: 'gear' });
    const before = store();
    const view = before.assemblyView;
    if (view === null || view.jointFrames === undefined) throw new Error('published joint frames required');
    expect(view.jointFrames.size).toBe(document.joints.length);
    const unresolvedFrames = new Map(view.jointFrames);
    unresolvedFrames.clear();
    for (const jointFrames of [undefined, unresolvedFrames] as const) {
      useAppStore.setState({ assemblyView: { ...view, jointFrames } });
      expect(pull()).toBe(false);
      expect(store().assemblyDragNotice).toBe('unavailable');
      expect(store().assemblyDrag).toBeNull();
      expect(store().assemblyDragOverlay).toBeNull();
      expect(store().assembly).toBe(document);
      expect(store().assemblyLibrary).toBe(before.assemblyLibrary);
      expect(store().documentVersion).toBe(before.documentVersion);
      expect(store().requestedGeneration).toBe(before.requestedGeneration);
      expect(store().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(store().assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
    }
    useAppStore.setState({ assemblyView: view });
    expect(pull()).toBe(true);
    expect(store().assemblyDrag?.prepared.initialEvaluation.rows.length).toBeGreaterThan(0);
    actions.cancelComponentDrag();
    expect(store().assembly).toBe(document);
    expect(store().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(store().assemblyOccurrenceDrives).toBe(before.assemblyOccurrenceDrives);
  });
});
