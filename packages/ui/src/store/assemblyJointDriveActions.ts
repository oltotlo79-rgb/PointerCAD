import { runCooperative, solveDrivenJoint, type CooperativeRun, type JointCoordinate, type SolveDrivenJointOutcome } from '@pointercad/model';
import { assemblyMotionPlacements } from '../assembly/animation.js';
import { jointDriveUpdate, prepareJointDrive, prepareJointDriveRequest, type AssemblyDriveResult } from './assemblyJointDrive.js';
import type { AssemblyJointDrive } from './assemblySlice.js';
import type { AppState } from './appState.js';

export interface AssemblyJointDriveSlice {
  readonly setAssemblyMotionTime: (time: number) => boolean;
  readonly setAssemblyMotionPlaying: (playing: boolean) => void;
  readonly driveAssemblyJoint: (jointId: string, coordinate: JointCoordinate, value: number) => boolean;
  /**
   * スライダー・数の入力からの駆動。画面を止めずに区切って解き、同じ持ち主のまま解けた時だけ 1 回反映する。
   * 文書の差し替え・Undo/Redo・取消・次の要求の後に終わった結果は反映しない。取消は失敗として示さない。
   */
  readonly requestAssemblyJointDrive: (jointId: string, coordinate: JointCoordinate, value: number, path?: readonly string[]) => boolean;
  /** 待ちの駆動を止める(owner を渡すとその持ち主の時だけ)。動きの表示・文書・履歴は変えない。 */
  readonly cancelAssemblyJointDrive: (owner?: AssemblyJointDrive) => void;
}

/** 1 区切りの数え上げの単位と、1 回の setTimeout で進める区切りの数。速さの主張ではない(Root の実測待ち)。 */
const JOINT_DRIVE_WORK = { units: 512 };
const JOINT_DRIVE_POINTS_PER_SLICE = 1;

export function createAssemblyJointDriveActions(set: (patch: Partial<AppState>) => void, get: () => AppState): AssemblyJointDriveSlice {
  let jointDriveGeneration = 0;
  let jointDriveRun: { readonly owner: AssemblyJointDrive; readonly run: CooperativeRun<AssemblyDriveResult> } | null = null;
  function ownsJointDrive(owner: AssemblyJointDrive, source: AppState): boolean {
    const state = get();
    return state.assemblyJointDrive === owner && state.assembly === owner.document
      && owner.generation === jointDriveGeneration && state.assemblyView === source.assemblyView
      && state.activeDocumentId === owner.documentId && state.assemblyLibrary === source.assemblyLibrary
      && state.documentVersion === source.documentVersion && state.requestedGeneration === source.requestedGeneration
      && state.cancelRequestCount === source.cancelRequestCount
      && state.assemblyMotionPlacements === source.assemblyMotionPlacements
      && state.assemblyMotionJointValues === source.assemblyMotionJointValues
      && state.assemblyOccurrenceDrives === source.assemblyOccurrenceDrives;
  }
  /** A solved top-level drive is published with every cross-level group it turns, or refused whole. */
  function publishJointDrive(values: ReadonlyMap<string, number>, prepared: NonNullable<ReturnType<typeof prepareJointDrive>>,
    driven: SolveDrivenJointOutcome): boolean {
    const update = jointDriveUpdate(values, prepared, driven);
    if (!driven.ok) {
      set({ ...update, assemblyJointDrive: null });
      return false;
    }
    const follow = get().followAssemblyCrossLevelMotion(driven.placements, update.assemblyMotionJointValues ?? values);
    if (!follow.ok) {
      set({ assemblyJointDrive: null, assemblyMotionPlaying: false, assemblyCrossLevelMotionNotice: follow.notice });
      return false;
    }
    set({ ...update, assemblyJointDrive: null, assemblyMotionJointValues: follow.values, assemblyOccurrenceDrives: follow.drives,
      assemblyCrossLevelMotionNotice: null });
    return true;
  }
  function stopJointDrive(): void {
    const current = jointDriveRun;
    jointDriveRun = null;
    current?.run.cancel();
  }
  /** 古くなった持ち主の待ちを消す。新しい持ち主の待ちには触れない。 */
  function dropJointDrive(owner: AssemblyJointDrive): void {
    if (jointDriveRun?.owner === owner) stopJointDrive();
    if (get().assemblyJointDrive === owner) set({ assemblyJointDrive: null });
  }
  return {
    setAssemblyMotionTime: (time) => {
      const state = get();
      const view = state.assemblyView;
      if (state.assembly === null || view === null || view.sourceDocument !== state.assembly) return false;
      const motion = assemblyMotionPlacements({ document: state.assembly, resolved: view.resolved,
        mateTargets: view.mateTargets, jointFrames: view.jointFrames, time });
      if (!motion.ok) {
        set({ assemblyMotionPlaying: false, assemblyMotionNotice: { kind: 'failed' } });
        return false;
      }
      stopJointDrive();
      // A presentation step that turns a coupled parent joint carries its cross-level group, or is refused whole.
      const follow = get().followAssemblyCrossLevelMotion(motion.placements, state.assemblyMotionJointValues);
      if (!follow.ok) {
        set({ assemblyMotionPlaying: false, assemblyCrossLevelMotionNotice: follow.notice });
        return false;
      }
      set({ assemblyMotionTime: time, assemblyMotionPlacements: motion.placements,
        assemblyMotionSourceDocument: state.assembly, assemblyMotionNotice: null, assemblyJointDrive: null, assemblyOccurrenceDrives: follow.drives, assemblyCrossLevelMotionNotice: null });
      return true;
    },
    setAssemblyMotionPlaying: (playing) => {
      if (!playing) {
        set({ assemblyMotionPlaying: false });
        return;
      }
      const state = get();
      const ready = state.assembly !== null && state.assembly.presentation.length > 0
        && state.assemblyView?.sourceDocument === state.assembly;
      if (ready) stopJointDrive();
      set(ready ? { assemblyMotionPlaying: true, assemblyJointDrive: null } : { assemblyMotionPlaying: false });
    },
    driveAssemblyJoint: (jointId, coordinate, value) => {
      // The cam joint of a saved cross-level cam moves with its follower placement (one atomic cam drive).
      const crossCam = get().getAssemblyCrossLevelCamOfParent(jointId);
      if (crossCam !== null) return coordinate === 'angle' && get().driveAssemblyCrossLevelCam(crossCam, 'cam', value);
      // A parent joint of a saved cross-level gear moves with all its coupled placements (one atomic group drive).
      const crossLevel = get().getAssemblyCrossLevelGearOfParent(jointId);
      if (crossLevel !== null) return coordinate === 'angle' && get().driveAssemblyCrossLevelGear(crossLevel, 'parent', value);
      const state = get();
      const prepared = prepareJointDrive(state, jointId, coordinate, value);
      if (prepared === null) return false;
      stopJointDrive();
      const driven = solveDrivenJoint(...prepared.args);
      const published = publishJointDrive(state.assemblyMotionJointValues, prepared, driven);
      return published;
    },
    requestAssemblyJointDrive: (jointId, coordinate, value, path) => {
      stopJointDrive();
      const state = get();
      const requestedPath = path === undefined ? undefined : [...path];
      const prepared = prepareJointDriveRequest(state, jointId, coordinate, value, requestedPath, JOINT_DRIVE_WORK);
      if (prepared === null) {
        if (state.assemblyJointDrive !== null) set({ assemblyJointDrive: null });
        return false;
      }
      jointDriveGeneration += 1;
      const owner: AssemblyJointDrive = { generation: jointDriveGeneration, documentId: state.activeDocumentId,
        document: prepared.document, jointId, coordinate, value, ...(requestedPath === undefined ? {} : { path: requestedPath }) };
      const run = runCooperative(prepared.steps, {
        pointsPerSlice: JOINT_DRIVE_POINTS_PER_SLICE,
        schedule: (slice) => {
          setTimeout(() => {
            if (ownsJointDrive(owner, state)) slice();
            else dropJointDrive(owner);
          }, 0);
        },
      });
      jointDriveRun = { owner, run };
      set({ assemblyJointDrive: owner, assemblyMotionPlaying: false,
        ...(state.assemblyMotionNotice?.kind === 'internal' ? { assemblyMotionNotice: null } : {}) });
      const release = (): void => {
        if (jointDriveRun?.owner === owner) jointDriveRun = null;
      };
      void run.result.then((result) => {
        release();
        if (result.status === 'cancelled' || !ownsJointDrive(owner, state)) {
          dropJointDrive(owner);
          return;
        }
        const { ok, update } = result.value;
        set({ assemblyMotionNotice: ok ? null : { kind: 'failed' }, ...update, assemblyJointDrive: null });
      }, () => {
        release();
        if (!ownsJointDrive(owner, state)) {
          dropJointDrive(owner);
          return;
        }
        set({ assemblyJointDrive: null, assemblyMotionPlaying: false, assemblyMotionNotice: { kind: 'failed' } });
      });
      return true;
    },
    cancelAssemblyJointDrive: (owner) => {
      const current = get().assemblyJointDrive;
      if (owner !== undefined && current !== owner) return;
      stopJointDrive();
      if (current !== null) set({ assemblyJointDrive: null });
    },
  };
}
