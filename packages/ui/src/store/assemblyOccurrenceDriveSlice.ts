import type { StateCreator } from 'zustand';
import {
  createSubShapeReferenceResolver, crossLevelCamTreeFailure, crossLevelGearTreeFailure, evaluateCrossLevelCamCouplings,
  evaluateCrossLevelGearCouplings, movedCrossLevelParentJoints, pruneCrossLevelCams, pruneCrossLevelGears, solveCrossLevelCamDriveSteps,
  solveCrossLevelCamFollowSteps, solveCrossLevelGearDriveSteps, solveCrossLevelGearFollowSteps, solveSubAssemblyJointDriveSteps, type AssemblyDocument,
  type CrossLevelCamCoupling, type CrossLevelCamCouplingDefinition, type CrossLevelCamDocumentFailureCode, type CrossLevelCamRepair,
  type CrossLevelGearChildResult, type CrossLevelGearChildState, type CrossLevelGearCoupling, type CrossLevelGearCouplingDefinition,
  type CrossLevelGearNoticeCode, type CrossLevelGearRepair, type JointCoordinate, type JointOccurrencePath, type ResolveMateTargetOptions,
  drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint, type RigidPlacement,
} from '@pointercad/model';
import { currentJointSliderValue } from '../assembly/jointSlider.js';
import type { AppState } from './appState.js';
import type { AssemblyView } from './assemblySlice.js';
import type { AssemblyDriveResult } from './assemblyJointDrive.js';

/**
 * Flexible subassembly drives (EX12): transient child-joint drives per subassembly occurrence path. Like the top-level
 * joint drive this is motion state only: it never writes the document, the Undo history or the saved file, and each
 * placement of a shared child keeps its own values and placements. An entry belongs to the document and the view it
 * was solved against; a different document or a recomputed view makes it stale (never shown, dropped on the next drive).
 *
 * Cross-level gears and cams (saved as crossLevelGearCouplings / crossLevelCamCouplings) are edited here as one Undo
 * step each. A gear is driven from either side through solveCrossLevelGearDrive with every placement of its parent; a
 * cam only from the cam side through solveCrossLevelCamDrive (its law is not invertible over a turn, so a follower
 * drive is refused before anything moves). The parent motion and every coupled placement are published together, or
 * nothing changes and the refusal is kept for the controls. The ordinary drives of a coupled joint go through the
 * same drives; any other parent-level motion that turns a coupled gear parent or a cam joint carries those placements
 * along (crossLevelMotionFollow) or is refused whole; a drag that turns one is refused (crossLevelDragRefusal).
 */
export interface AssemblyOccurrenceDrive {
  readonly path: JointOccurrencePath;
  readonly document: AssemblyDocument;
  readonly view: AssemblyView;
  /** World placements of the child's components for this occurrence. */
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  /** `${jointId}\0${coordinate}` of the child's joints -> shown value. */
  readonly values: ReadonlyMap<string, number>;
}

/** Every reason a cross-level gear or cam refusal can show. */
export type CrossLevelNoticeCode = CrossLevelGearNoticeCode | CrossLevelCamDocumentFailureCode | 'coupled-drag-mixed';

/** The last refused cross-level drive, edit or motion (null after a success). */
export interface AssemblyCrossLevelGearNotice {
  readonly couplingId: string;
  readonly code: CrossLevelNoticeCode;
}

export interface AssemblyOccurrenceDriveSlice {
  readonly getAssemblyCrossLevelCamOfParent: (jointId: string) => string | null;
  readonly getAssemblyCrossLevelGearOfParent: (jointId: string) => string | null;
  readonly followAssemblyCrossLevelMotion: (placements: ReadonlyMap<string, RigidPlacement>,
    values: ReadonlyMap<string, number>) => CrossLevelMotionResult;
  readonly pruneAssemblyCrossLevelCouplings: typeof pruneCrossLevelCouplings;
  readonly assemblyOccurrenceDrives: ReadonlyMap<string, AssemblyOccurrenceDrive>;
  /** Drives one joint of the child placed at `path`; false (state unchanged) when refused. A joint of a saved
   * cross-level gear is driven with its whole group; the follower of a saved cross-level cam is refused visibly. */
  readonly driveAssemblyOccurrenceJoint: (path: readonly string[], jointId: string, coordinate: JointCoordinate, value: number) => boolean;
  readonly clearAssemblyOccurrenceDrives: () => void;
  readonly assemblyCrossLevelGearNotice: AssemblyCrossLevelGearNotice | null;
  /** The last ordinary motion (drive of another joint, presentation step, drag) refused because of a cross-level relation. */
  readonly assemblyCrossLevelMotionNotice: AssemblyCrossLevelGearNotice | null;
  /** What the last document edit did to saved cross-level gears and cams (suspended or removed, with the reason). */
  readonly assemblyCrossLevelGearRepairs: readonly (CrossLevelGearRepair | CrossLevelCamRepair)[];
  /** Replaces the saved cross-level gears (create, edit, remove): one Undo step, or false and the document is kept. */
  readonly setAssemblyCrossLevelGears: (couplings: readonly CrossLevelGearCouplingDefinition[]) => boolean;
  /** Drives a saved cross-level gear (and every gear of its parent joint) from the parent or the child side
   * (degrees); false keeps every shown placement. */
  readonly driveAssemblyCrossLevelGear: (couplingId: string, side: 'parent' | 'child', value: number) => boolean;
  /** Replaces the saved cross-level cams (create, edit, remove): one Undo step, or false and the document is kept. */
  readonly setAssemblyCrossLevelCams: (cams: readonly CrossLevelCamCouplingDefinition[]) => boolean;
  /** Drives a saved cross-level cam from the cam side (degrees). The follower side is refused before anything moves. */
  readonly driveAssemblyCrossLevelCam: (couplingId: string, side: 'cam' | 'follower', value: number) => boolean;
}

type DriveState = Pick<AppState, 'assembly' | 'assemblyView' | 'assemblyOccurrenceDrives'>;

export function occurrenceDriveKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/**
 * Face/edge targets of the child's joints, re-selected on the view's current part bodies exactly like the top-level
 * targets (attachAssembly): the body of the part key with the saved feature id, matched by the shared resolver. A part
 * without a current body, or a reference that no longer matches, gives null, so the drive stays refused.
 */
export function occurrenceTargetOptions(bodies: AssemblyView['bodies']): ResolveMateTargetOptions {
  const resolveReference = createSubShapeReferenceResolver();
  return {
    subShape: (partKey, reference) => {
      const body = bodies.get(partKey)?.find((item) => item.featureId === reference.bodyFeatureId);
      const resolution = body === undefined ? null : resolveReference(body, reference);
      return resolution?.status === 'matched' ? resolution.match.geometry : null;
    },
  };
}

/** The drive shown for `path`, only while it belongs to the current document and view. */
export function currentOccurrenceDrive(state: DriveState, path: readonly string[]): AssemblyOccurrenceDrive | undefined {
  const entry = state.assemblyOccurrenceDrives.get(occurrenceDriveKey(path));
  return entry !== undefined && entry.document === state.assembly && entry.view === state.assemblyView ? entry : undefined;
}

/** Child placements of every current occurrence drive, keyed like flattenAssemblyGeometry's occurrence paths (JSON). */
export function shownOccurrencePlacements(state: DriveState): ReadonlyMap<string, ReadonlyMap<string, RigidPlacement>> {
  const shown = new Map<string, ReadonlyMap<string, RigidPlacement>>();
  for (const [key, entry] of state.assemblyOccurrenceDrives) {
    if (entry.document === state.assembly && entry.view === state.assemblyView) shown.set(key, entry.placements);
  }
  return shown;
}

/** Key of a joint value in the motion maps (top-level assemblyMotionJointValues and an occurrence's values). */
export function jointValueKey(jointId: string, coordinate: JointCoordinate): string {
  return `${jointId}${String.fromCharCode(0)}${coordinate}`;
}

/** The active saved cross-level gear driven by `parentJointId` (the first of its group), or null. */
export function crossLevelGearOfParent(document: AssemblyDocument | null, parentJointId: string): string | null {
  return document?.crossLevelGearCouplings?.find(c => !c.suppressed && c.parentJointId === parentJointId)?.id ?? null;
}

/** The active saved cross-level gear whose child is `jointId` in the placement `path`, or null. */
export function crossLevelGearOfChild(document: AssemblyDocument | null, path: readonly string[], jointId: string): string | null {
  const key = occurrenceDriveKey(path);
  return document?.crossLevelGearCouplings?.find(c => !c.suppressed && c.childJointId === jointId
    && occurrenceDriveKey(c.childPath) === key)?.id ?? null;
}

/** The active saved cross-level cam on the cam joint `camJointId`, or null. */
export function crossLevelCamOfParent(document: AssemblyDocument | null, camJointId: string): string | null {
  return document?.crossLevelCamCouplings?.find(c => !c.suppressed && c.camJointId === camJointId)?.id ?? null;
}

/** The active saved cross-level cam whose follower is `jointId` in the placement `path`, or null. */
export function crossLevelCamOfChild(document: AssemblyDocument | null, path: readonly string[], jointId: string): string | null {
  const key = occurrenceDriveKey(path);
  return document?.crossLevelCamCouplings?.find(c => !c.suppressed && c.childJointId === jointId
    && occurrenceDriveKey(c.childPath) === key)?.id ?? null;
}

/** Every edit keeps saved cross-level gears and then cams readable (cams are checked against the kept gears). */
export function pruneCrossLevelCouplings(document: AssemblyDocument, assemblies: ReadonlyMap<string, AssemblyDocument>):
  { readonly document: AssemblyDocument; readonly repairs: readonly (CrossLevelGearRepair | CrossLevelCamRepair)[] } {
  const gears = pruneCrossLevelGears(document, assemblies);
  const cams = pruneCrossLevelCams(gears.document, assemblies);
  return { document: cams.document, repairs: [...gears.repairs, ...cams.repairs] };
}

/** The current drives of this document and view, so a new entry never revives a stale one. */
function currentDrives(state: DriveState, document: AssemblyDocument, view: AssemblyView): Map<string, AssemblyOccurrenceDrive> {
  return new Map([...state.assemblyOccurrenceDrives].filter(([, entry]) => entry.document === document && entry.view === view));
}

/** Puts every child of a solved group into `drives` (with its shown value), continuing each placement's own values. */
function storeGroup(state: DriveState, drives: Map<string, AssemblyOccurrenceDrive>, document: AssemblyDocument, view: AssemblyView,
  group: readonly CrossLevelGearChildResult[]): void {
  for (const member of group) {
    const previous = currentOccurrenceDrive(state, member.path);
    drives.set(member.outcome.occurrenceKey, { path: member.path, document, view, placements: member.outcome.placements,
      values: new Map(previous?.values ?? []).set(jointValueKey(member.jointId, 'angle'), member.angle) });
  }
}

/** The shown state of every placement coupled to `parentJointId` (earlier drives continue from where they are shown). */
function groupChildren(state: DriveState, couplings: readonly CrossLevelGearCoupling[], parentJointId: string): Map<string, CrossLevelGearChildState> {
  const children = new Map<string, CrossLevelGearChildState>();
  for (const member of couplings.filter(c => c.parentJointId === parentJointId)) {
    const previous = currentOccurrenceDrive(state, member.child.path);
    const reference = previous?.values.get(jointValueKey(member.child.jointId, 'angle'));
    children.set(occurrenceDriveKey(member.child.path), { ...(previous === undefined ? {} : { initial: previous.placements }),
      ...(reference === undefined ? {} : { referenceAngle: reference }) });
  }
  return children;
}

/** The cams in the shape movedCrossLevelParentJoints reads (it only looks at the parent joint of each relation). */
function camParents(cams: readonly CrossLevelCamCoupling[]): readonly CrossLevelGearCoupling[] {
  return cams.map(c => ({ id: c.id, parentJointId: c.camJointId, child: c.child, ratio: 1, phaseDeg: 0 }));
}

type MotionState = Pick<AppState, 'assembly' | 'assemblyView' | 'assemblyOccurrenceDrives' | 'assemblyMotionPlacements'
  | 'assemblyMotionSourceDocument'>;

/** The parent placements on screen now (the published motion of this document, or the resolved ones). */
function shownParentPlacements(state: MotionState, view: AssemblyView): ReadonlyMap<string, RigidPlacement> {
  return state.assemblyMotionSourceDocument === state.assembly && state.assemblyMotionPlacements !== null
    ? state.assemblyMotionPlacements : view.resolved.placements;
}

const active = (document: AssemblyDocument): boolean => (document.crossLevelGearCouplings ?? []).some(c => !c.suppressed)
  || (document.crossLevelCamCouplings ?? []).some(c => !c.suppressed);

/**
 * A parent-level motion (from the shown parent placements to `placements`) with every cross-level relation it
 * turns: for each coupled gear parent or cam joint whose members moved relative to each other, the reached angle is
 * read from `placements` and every coupled placement is solved to its relation. Returns the drives and joint values to
 * publish with the motion, or a refusal (then nothing may be published). A document without active cross-level
 * relations, or a motion that turns none of their joints, passes unchanged.
 */
export type CrossLevelMotionResult =
  { readonly ok: true; readonly drives: ReadonlyMap<string, AssemblyOccurrenceDrive>; readonly values: ReadonlyMap<string, number> }
  | { readonly ok: false; readonly notice: AssemblyCrossLevelGearNotice };

export function crossLevelMotionFollow(state: MotionState, placements: ReadonlyMap<string, RigidPlacement>,
  values: ReadonlyMap<string, number>, alreadySolvedParent?: string): CrossLevelMotionResult {
  return drainRigidSteps(crossLevelMotionFollowSteps(state, placements, values, UNLIMITED_RIGID_WORK, alreadySolvedParent));
}

/** The same atomic follow for requested drives, yielding inside every child solve. */
export function* crossLevelMotionFollowSteps(state: MotionState, placements: ReadonlyMap<string, RigidPlacement>,
  values: ReadonlyMap<string, number>, budget: RigidWorkBudget, alreadySolvedParent?: string):
  Generator<RigidWorkPoint, CrossLevelMotionResult, void> {
  const document = state.assembly, view = state.assemblyView;
  const unchanged = { ok: true as const, drives: state.assemblyOccurrenceDrives, values };
  if (document === null || !active(document)) return unchanged;
  const anyId = document.crossLevelGearCouplings?.[0]?.id ?? document.crossLevelCamCouplings?.[0]?.id ?? '';
  if (view === null || view.sourceDocument !== document || view.source === undefined) {
    return { ok: false, notice: { couplingId: anyId, code: 'stale-view' } };
  }
  const gears = evaluateCrossLevelGearCouplings(document);
  if (!gears.ok) return { ok: false, notice: { couplingId: gears.couplingId, code: gears.code } };
  const cams = evaluateCrossLevelCamCouplings(document);
  if (!cams.ok) return { ok: false, notice: { couplingId: cams.couplingId, code: cams.code } };
  const before = shownParentPlacements(state, view);
  const movedGears = movedCrossLevelParentJoints(document, gears.couplings, before, placements).filter(id => id !== alreadySolvedParent);
  const movedCams = movedCrossLevelParentJoints(document, camParents(cams.cams), before, placements).filter(id => id !== alreadySolvedParent);
  if (movedGears.length === 0 && movedCams.length === 0) return unchanged;
  const drives = currentDrives(state, document, view);
  const nextValues = new Map(values);
  const source = view.source, resolved = { source, resolved: view.resolved }, targetOptions = occurrenceTargetOptions(view.bodies);
  const angleOf = (jointId: string): number | null => {
    const joint = document.joints.find(item => item.id === jointId);
    return joint === undefined ? null : currentJointSliderValue({ document, joint, coordinate: 'angle', placements,
      frames: view.jointFrames?.get(jointId), referenceAngle: values.get(jointValueKey(jointId, 'angle')) ?? 0 });
  };
  for (const parentJointId of movedGears) {
    const angle = angleOf(parentJointId);
    const first = gears.couplings.find(c => c.parentJointId === parentJointId);
    if (angle === null) return { ok: false, notice: { couplingId: first?.id ?? parentJointId, code: 'parent-solve-failed' } };
    const follow = yield* solveCrossLevelGearFollowSteps({ inputs: source, view: resolved, couplings: gears.couplings, parentJointId, parentAngle: angle,
      children: groupChildren(state, gears.couplings, parentJointId), targetOptions }, budget);
    if (!follow.ok) return { ok: false, notice: { couplingId: follow.couplingId, code: follow.code } };
    storeGroup(state, drives, document, view, follow.group);
    nextValues.set(jointValueKey(parentJointId, 'angle'), angle);
  }
  for (const camJointId of movedCams) {
    const angle = angleOf(camJointId);
    const cam = cams.cams.find(c => c.camJointId === camJointId);
    if (cam === undefined) continue;
    if (angle === null) return { ok: false, notice: { couplingId: cam.id, code: 'parent-solve-failed' } };
    const previous = currentOccurrenceDrive(state, cam.child.path);
    const follow = yield* solveCrossLevelCamFollowSteps({ inputs: source, view: resolved, cams: cams.cams, couplingId: cam.id, camAngle: angle,
      ...(previous === undefined ? {} : { initial: previous.placements }), targetOptions }, budget);
    if (!follow.ok) return { ok: false, notice: { couplingId: follow.couplingId, code: follow.code } };
    drives.set(follow.outcome.occurrenceKey, { path: follow.path, document, view, placements: follow.outcome.placements,
      values: new Map(previous?.values ?? []).set(jointValueKey(cam.child.jointId, 'translation'), follow.translation) });
    nextValues.set(jointValueKey(camJointId, 'angle'), angle);
  }
  return { ok: true, drives, values: nextValues };
}

/**
 * A drag preview or release that turns a coupled gear parent or a cam joint: the refusal to show (null when it turns
 * none). The coupled placements cannot follow a drag, because its release is a document edit (the transient drives end).
 */
export function crossLevelDragRefusal(state: Pick<AppState, 'assembly'>, before: ReadonlyMap<string, RigidPlacement>,
  after: ReadonlyMap<string, RigidPlacement>): AssemblyCrossLevelGearNotice | null {
  const document = state.assembly;
  if (document === null || !active(document)) return null;
  const gears = evaluateCrossLevelGearCouplings(document);
  if (!gears.ok) return { couplingId: gears.couplingId, code: gears.code };
  const cams = evaluateCrossLevelCamCouplings(document);
  if (!cams.ok) return { couplingId: cams.couplingId, code: cams.code };
  const relations = [...gears.couplings, ...camParents(cams.cams)];
  const moved = movedCrossLevelParentJoints(document, relations, before, after);
  const first = relations.find(c => moved.includes(c.parentJointId));
  return first === undefined ? null : { couplingId: first.id, code: 'coupled-motion' };
}

export function* occurrenceJointDriveSteps(state: AppState, path: readonly string[], jointId: string, coordinate: JointCoordinate, value: number, budget: RigidWorkBudget):
  Generator<RigidWorkPoint, AssemblyDriveResult, void> {
  const document = state.assembly, view = state.assemblyView;
  // A coupled child joint never moves alone: its whole cross-level group follows (or nothing moves).
  const coupled = crossLevelGearOfChild(document, path, jointId);
  if (coupled !== null) {
    if (coordinate === 'angle') return yield* crossLevelGearDriveSteps(state, coupled, 'child', value, budget);
    return { ok: false, update: { assemblyCrossLevelGearNotice: { couplingId: coupled, code: 'invalid-value' } } };
  }
  // A cam follower cannot be driven: the cam law gives no single cam angle for a follower position.
  const follower = crossLevelCamOfChild(document, path, jointId);
  if (follower !== null) return yield* crossLevelCamDriveSteps(state, follower, 'follower', value, budget);
  if (document === null || view === null || view.sourceDocument !== document || view.source === undefined
      || !Number.isFinite(value)) return { ok: false, update: {} };
  const previous = currentOccurrenceDrive(state, path);
  const valueKey = jointValueKey(jointId, coordinate);
  const reference = coordinate === 'angle' ? previous?.values.get(valueKey) : undefined;
  const outcome = yield* solveSubAssemblyJointDriveSteps({ inputs: view.source, view: { source: view.source, resolved: view.resolved }, path,
    ...(previous === undefined ? {} : { initial: previous.placements }), targetOptions: occurrenceTargetOptions(view.bodies),
    request: { jointId, coordinate, value, ...(reference === undefined ? {} : { referenceAngle: reference }) } }, budget);
  if (!outcome.ok) return { ok: false, update: {} };
  const shown = outcome.driven.atLimit ? outcome.driven.target : outcome.driven.actual;
  const drives = currentDrives(state, document, view);
  drives.set(outcome.occurrenceKey, { path: outcome.path, document, view, placements: outcome.placements,
    values: new Map(previous?.values ?? []).set(valueKey, shown) });
  return { ok: true, update: { assemblyOccurrenceDrives: drives } };
}

export function* crossLevelGearDriveSteps(state: AppState, couplingId: string, side: 'parent' | 'child', value: number, budget: RigidWorkBudget):
  Generator<RigidWorkPoint, AssemblyDriveResult, void> {
  const document = state.assembly, view = state.assemblyView;
  const refuse = (failed: string, code: CrossLevelNoticeCode): AssemblyDriveResult => ({
    ok: false, update: { assemblyCrossLevelGearNotice: { couplingId: failed, code } },
  });
  if (document === null || view === null || view.sourceDocument !== document || view.source === undefined) return refuse(couplingId, 'stale-view');
  const evaluated = evaluateCrossLevelGearCouplings(document);
  if (!evaluated.ok) return refuse(evaluated.couplingId, evaluated.code);
  const coupling = evaluated.couplings.find(c => c.id === couplingId);
  if (coupling === undefined) return refuse(couplingId, 'missing-coupling');
  const motionCurrent = state.assemblyMotionSourceDocument === document && state.assemblyMotionPlacements !== null;
  const parentKey = jointValueKey(coupling.parentJointId, 'angle');
  const parentReference = motionCurrent ? state.assemblyMotionJointValues.get(parentKey) : undefined;
  const outcome = yield* solveCrossLevelGearDriveSteps({ inputs: view.source, view: { source: view.source, resolved: view.resolved },
    couplings: evaluated.couplings, couplingId, drive: { side, value },
    children: groupChildren(state, evaluated.couplings, coupling.parentJointId), targetOptions: occurrenceTargetOptions(view.bodies),
    parent: { targets: view.mateTargets ?? new Map(), options: { jointFrames: view.jointFrames ?? new Map() },
      initial: motionCurrent && state.assemblyMotionPlacements !== null ? state.assemblyMotionPlacements : view.resolved.placements,
      ...(parentReference === undefined ? {} : { referenceAngle: parentReference }) } }, budget);
  if (!outcome.ok) return refuse(outcome.couplingId, outcome.code);
  // The parent motion may turn OTHER coupled joints through a linkage: their placements follow in the same update.
  const values = new Map(motionCurrent ? state.assemblyMotionJointValues : []).set(parentKey, outcome.parentAngle);
  const others = yield* crossLevelMotionFollowSteps({ ...state, assemblyOccurrenceDrives: currentDrives(state, document, view) },
    outcome.parent.placements, values, budget, coupling.parentJointId);
  if (!others.ok) return refuse(others.notice.couplingId, others.notice.code);
  const drives = new Map(others.drives);
  storeGroup(state, drives, document, view, outcome.group);
  return { ok: true, update: { assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: outcome.parent.placements,
    assemblyMotionSourceDocument: document, assemblyMotionJointValues: new Map(others.values).set(parentKey, outcome.parentAngle),
    assemblyMotionNotice: null, assemblyJointDrive: null, assemblyOccurrenceDrives: drives, assemblyCrossLevelGearNotice: null,
    assemblyCrossLevelMotionNotice: null } };
}

export function* crossLevelCamDriveSteps(state: AppState, couplingId: string, side: 'cam' | 'follower', value: number, budget: RigidWorkBudget):
  Generator<RigidWorkPoint, AssemblyDriveResult, void> {
  const document = state.assembly, view = state.assemblyView;
  const refuse = (failed: string, code: CrossLevelNoticeCode): AssemblyDriveResult => ({
    ok: false, update: { assemblyCrossLevelGearNotice: { couplingId: failed, code } },
  });
  // Refused before anything else: a follower position does not give one cam angle. Also shown as a refused motion,
  // so the reason is visible whichever control (the cam form or the follower's own joint slider) asked.
  if (side === 'follower') {
    const notice: AssemblyCrossLevelGearNotice = { couplingId, code: 'unsupported-follower-drive' };
    return { ok: false, update: { assemblyCrossLevelGearNotice: notice, assemblyCrossLevelMotionNotice: notice } };
  }
  if (document === null || view === null || view.sourceDocument !== document || view.source === undefined) return refuse(couplingId, 'stale-view');
  const cams = evaluateCrossLevelCamCouplings(document);
  if (!cams.ok) return refuse(cams.couplingId, cams.code);
  const gears = evaluateCrossLevelGearCouplings(document);
  if (!gears.ok) return refuse(gears.couplingId, gears.code);
  const cam = cams.cams.find(c => c.id === couplingId);
  if (cam === undefined) return refuse(couplingId, 'missing-coupling');
  const motionCurrent = state.assemblyMotionSourceDocument === document && state.assemblyMotionPlacements !== null;
  const camKey = jointValueKey(cam.camJointId, 'angle');
  const reference = motionCurrent ? state.assemblyMotionJointValues.get(camKey) : undefined;
  const previous = currentOccurrenceDrive(state, cam.child.path);
  const outcome = yield* solveCrossLevelCamDriveSteps({ inputs: view.source, view: { source: view.source, resolved: view.resolved },
    cams: cams.cams, gears: gears.couplings, couplingId, drive: { side: 'cam', value },
    parent: { targets: view.mateTargets ?? new Map(), options: { jointFrames: view.jointFrames ?? new Map() },
      initial: motionCurrent && state.assemblyMotionPlacements !== null ? state.assemblyMotionPlacements : view.resolved.placements,
      ...(reference === undefined ? {} : { referenceAngle: reference }) },
    child: { ...(previous === undefined ? {} : { initial: previous.placements }), targetOptions: occurrenceTargetOptions(view.bodies) } }, budget);
  if (!outcome.ok) return refuse(outcome.couplingId, outcome.code);
  const values = new Map(motionCurrent ? state.assemblyMotionJointValues : []).set(camKey, outcome.camAngle);
  const others = yield* crossLevelMotionFollowSteps({ ...state, assemblyOccurrenceDrives: currentDrives(state, document, view) },
    outcome.parent.placements, values, budget, cam.camJointId);
  if (!others.ok) return refuse(others.notice.couplingId, others.notice.code);
  const drives = new Map(others.drives);
  drives.set(outcome.child.occurrenceKey, { path: outcome.path, document, view, placements: outcome.child.placements,
    values: new Map(previous?.values ?? []).set(jointValueKey(cam.child.jointId, 'translation'), outcome.followerTranslation) });
  return { ok: true, update: { assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: outcome.parent.placements,
    assemblyMotionSourceDocument: document, assemblyMotionJointValues: new Map(others.values).set(camKey, outcome.camAngle),
    assemblyMotionNotice: null, assemblyJointDrive: null, assemblyOccurrenceDrives: drives, assemblyCrossLevelGearNotice: null,
    assemblyCrossLevelMotionNotice: null } };
}

export const createAssemblyOccurrenceDriveSlice: StateCreator<AppState, [], [], AssemblyOccurrenceDriveSlice> = (set, get) => ({
  getAssemblyCrossLevelCamOfParent: jointId => crossLevelCamOfParent(get().assembly, jointId),
  getAssemblyCrossLevelGearOfParent: jointId => crossLevelGearOfParent(get().assembly, jointId),
  followAssemblyCrossLevelMotion: (placements, values) => crossLevelMotionFollow(get(), placements, values),
  pruneAssemblyCrossLevelCouplings: pruneCrossLevelCouplings,
  assemblyOccurrenceDrives: new Map(),
  assemblyCrossLevelGearNotice: null,
  assemblyCrossLevelMotionNotice: null,
  assemblyCrossLevelGearRepairs: [],
  driveAssemblyOccurrenceJoint: (path, jointId, coordinate, value) => {
    const result = drainRigidSteps(occurrenceJointDriveSteps(get(), path, jointId, coordinate, value, UNLIMITED_RIGID_WORK));
    if (result.ok) get().cancelAssemblyJointDrive();
    if (Object.keys(result.update).length > 0) set(result.update);
    return result.ok;
  },
  clearAssemblyOccurrenceDrives: () => {
    get().cancelAssemblyJointDrive();
    if (get().assemblyOccurrenceDrives.size > 0) set({ assemblyOccurrenceDrives: new Map() });
  },
  setAssemblyCrossLevelGears: (couplings) => {
    const state = get(), document = state.assembly;
    if (document === null) return false;
    if (couplings.length === 0 && (document.crossLevelGearCouplings?.length ?? 0) === 0) return true;
    const next: AssemblyDocument = { ...document, crossLevelGearCouplings: couplings.map(c => ({ ...c, childPath: [...c.childPath],
      ratio: { ...c.ratio }, phaseDeg: { ...c.phaseDeg } })) };
    // The same admission as the file reader: the document itself, the embedded subassembly tree, and the saved cams
    // (a gear may not take a cam joint or a cam's placement).
    const assemblies = state.assemblyLibrary.assemblies ?? new Map<string, AssemblyDocument>();
    const failure = crossLevelGearTreeFailure(next, assemblies) ?? crossLevelCamTreeFailure(next, assemblies);
    if (failure !== null) {
      set({ assemblyCrossLevelGearNotice: failure });
      return false;
    }
    get().applyAssembly(next);
    set({ assemblyCrossLevelGearNotice: null });
    return true;
  },
  driveAssemblyCrossLevelGear: (couplingId, side, value) => {
    const result = drainRigidSteps(crossLevelGearDriveSteps(get(), couplingId, side, value, UNLIMITED_RIGID_WORK));
    if (result.ok) get().cancelAssemblyJointDrive();
    if (Object.keys(result.update).length > 0) set(result.update);
    return result.ok;
  },
  setAssemblyCrossLevelCams: (cams) => {
    const state = get(), document = state.assembly;
    if (document === null) return false;
    if (cams.length === 0 && (document.crossLevelCamCouplings?.length ?? 0) === 0) return true;
    const next: AssemblyDocument = { ...document, crossLevelCamCouplings: cams.map(c => ({ ...c, childPath: [...c.childPath],
      discRadiusMm: { ...c.discRadiusMm }, eccentricityMm: { ...c.eccentricityMm }, rollerRadiusMm: { ...c.rollerRadiusMm },
      phaseDeg: { ...c.phaseDeg }, offsetMm: { ...c.offsetMm } })) };
    const failure = crossLevelCamTreeFailure(next, state.assemblyLibrary.assemblies ?? new Map());
    if (failure !== null) {
      set({ assemblyCrossLevelGearNotice: failure });
      return false;
    }
    get().applyAssembly(next);
    set({ assemblyCrossLevelGearNotice: null });
    return true;
  },
  driveAssemblyCrossLevelCam: (couplingId, side, value) => {
    const result = drainRigidSteps(crossLevelCamDriveSteps(get(), couplingId, side, value, UNLIMITED_RIGID_WORK));
    if (result.ok) get().cancelAssemblyJointDrive();
    if (Object.keys(result.update).length > 0) set(result.update);
    return result.ok;
  },
});
