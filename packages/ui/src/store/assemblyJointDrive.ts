import {
  solveDrivenJoint, solveDrivenJointSteps, type JointCoordinate, type SolveDrivenJointOutcome,
  type RigidWorkBudget, type RigidWorkPoint,
} from '@pointercad/model';
import { currentJointSliderValue, jointSliderBounds, jointSliderReference } from '../assembly/jointSlider.js';
import type { AssemblySlice } from './assemblySlice.js';
import type { AppState } from './appState.js';
import {
  crossLevelCamDriveSteps, crossLevelCamOfParent, crossLevelGearDriveSteps, crossLevelGearOfParent,
  crossLevelMotionFollowSteps, occurrenceJointDriveSteps, type AssemblyOccurrenceDriveSlice,
} from './assemblyOccurrenceDriveSlice.js';

type DriveSource = Pick<AssemblySlice, 'assembly' | 'assemblyView' | 'assemblyMotionJointValues'
  | 'assemblyMotionPlacements' | 'assemblyMotionSourceDocument' | 'assemblyMotionTime'>;
type DriveBounds = Extract<ReturnType<typeof jointSliderBounds>, { readonly ok: true }>['bounds'];

/** One joint drive request, built once from the store; the sync and the cooperative drive solve exactly these inputs. */
export interface PreparedJointDrive {
  readonly document: NonNullable<DriveSource['assembly']>;
  readonly view: NonNullable<DriveSource['assemblyView']>;
  readonly key: string;
  readonly bounds: DriveBounds;
  readonly args: Parameters<typeof solveDrivenJoint>;
}

export function prepareJointDrive(
  state: DriveSource, jointId: string, coordinate: JointCoordinate, value: number,
): PreparedJointDrive | null {
  const document = state.assembly;
  const view = state.assemblyView;
  if (document === null || view === null || view.sourceDocument !== document || !Number.isFinite(value)) return null;
  const joint = document.joints.find((item) => item.id === jointId && !item.suppressed);
  const frames = view.jointFrames?.get(jointId);
  if (joint === undefined || frames === undefined) return null;
  const key = `${jointId}\u0000${coordinate}`;
  const bounds = jointSliderBounds(document, joint, coordinate);
  if (!bounds.ok) return null;
  const initialReference = jointSliderReference(bounds.bounds);
  // A drive continues from the placements on screen when they are the published result of earlier joint drives of
  // this document (time 0 with driven joint values); otherwise from the document's resolved placements. Starting
  // every drive from the resolved placements put the other independently driven members back while their values
  // stayed published (host145 run 20261019-005830: member-0 from z 25 to 0 after driving the second slider).
  const base = state.assemblyMotionPlacements !== null && state.assemblyMotionSourceDocument === document
    && state.assemblyMotionTime === 0 && state.assemblyMotionJointValues.size > 0
    ? state.assemblyMotionPlacements : view.resolved.placements;
  const reference = state.assemblyMotionJointValues.get(key)
    ?? currentJointSliderValue({ document, joint, coordinate, placements: base,
      frames, referenceAngle: coordinate === 'angle' ? initialReference : undefined })
    ?? initialReference;
  return { document, view, key, bounds: bounds.bounds, args: [document, view.mateTargets ?? new Map(), base,
    { jointId, coordinate, value, ...(coordinate === 'angle' ? { referenceAngle: reference } : {}),
      ...(joint.kind === 'cylindrical' ? { bounds: { min: joint.minValue, max: joint.maxValue } } : {}) },
    { jointFrames: view.jointFrames }] };
}

/** The transient motion state published for a solved drive (never the document, the history or the saved file). */
export function jointDriveUpdate(
  values: ReadonlyMap<string, number>, prepared: PreparedJointDrive, driven: SolveDrivenJointOutcome,
): Partial<AssemblySlice> {
  if (!driven.ok) return { assemblyMotionPlaying: false, assemblyMotionNotice: { kind: 'failed' } };
  const displayed = driven.atLimit ? driven.target : driven.actual;
  return { assemblyMotionTime: 0, assemblyMotionPlaying: false,
    assemblyMotionPlacements: driven.placements, assemblyMotionSourceDocument: prepared.document,
    assemblyMotionJointValues: new Map(values).set(prepared.key, displayed),
    assemblyMotionNotice: driven.atLimit
      ? { kind: 'rangeEnd', min: prepared.bounds.min, max: prepared.bounds.max, value: displayed }
      : null };
}

/** A whole drive's private result; even failures are published only after the owner is checked. */
export interface AssemblyDriveResult {
  readonly ok: boolean;
  readonly update: Partial<AssemblySlice & AssemblyOccurrenceDriveSlice>;
}

export interface PreparedJointDriveRequest {
  readonly document: NonNullable<AppState['assembly']>;
  readonly view: NonNullable<AppState['assemblyView']>;
  readonly steps: Generator<RigidWorkPoint, AssemblyDriveResult, void>;
}

/** Parent, child and every cross-level follow stay within one cancellable sequence and one publication. */
export function prepareJointDriveRequest(state: AppState, jointId: string, coordinate: JointCoordinate, value: number,
  path: readonly string[] | undefined, budget: RigidWorkBudget): PreparedJointDriveRequest | null {
  const document = state.assembly, view = state.assemblyView;
  if (document === null || view === null || view.sourceDocument !== document || !Number.isFinite(value)) return null;
  if (path !== undefined) {
    if (path.length === 0 || view.source === undefined) return null;
    return { document, view, steps: occurrenceJointDriveSteps(state, path, jointId, coordinate, value, budget) };
  }
  const cam = crossLevelCamOfParent(document, jointId);
  if (cam !== null) return coordinate !== 'angle' ? null
    : { document, view, steps: crossLevelCamDriveSteps(state, cam, 'cam', value, budget) };
  const gear = crossLevelGearOfParent(document, jointId);
  if (gear !== null) return coordinate !== 'angle' ? null
    : { document, view, steps: crossLevelGearDriveSteps(state, gear, 'parent', value, budget) };
  const prepared = prepareJointDrive(state, jointId, coordinate, value);
  return prepared === null ? null : { document, view, steps: jointDriveSteps(state, prepared, budget) };
}

function* jointDriveSteps(state: AppState, prepared: PreparedJointDrive, budget: RigidWorkBudget):
  Generator<RigidWorkPoint, AssemblyDriveResult, void> {
  const [document, targets, initial, request, options] = prepared.args;
  const driven = yield* solveDrivenJointSteps(document, targets, initial, request, options ?? {}, budget);
  const update = jointDriveUpdate(state.assemblyMotionJointValues, prepared, driven);
  if (!driven.ok) return { ok: false, update };
  const follow = yield* crossLevelMotionFollowSteps(state, driven.placements,
    update.assemblyMotionJointValues ?? state.assemblyMotionJointValues, budget);
  if (!follow.ok) return { ok: false, update: { assemblyMotionPlaying: false, assemblyCrossLevelMotionNotice: follow.notice } };
  return { ok: true, update: { ...update, assemblyMotionJointValues: follow.values, assemblyOccurrenceDrives: follow.drives,
    assemblyCrossLevelMotionNotice: null } };
}
