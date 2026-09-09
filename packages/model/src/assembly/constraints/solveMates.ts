/** 合致を成分ごとに解く。解は文書へ書き戻さない(P7 §2.5.6、FR-603/604)。 */
import { CONFLICT_REPORT_LIMIT, remainingMessage } from '../../sketch/constraints/diagnose.js';
import { matrixRank, qrDecomposition } from '../../sketch/constraints/solve.js';
import { addVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import {
  exponentialMap, multiplyQuaternion, normalizeQuaternion, rotateVector, type RigidPlacement,
} from '../placementMath.js';
import { assemblyExpressionContext } from '../resolveAssembly.js';
import type { AssemblyDocument } from '../types.js';
import {
  buildMateResidualReport, prepareMateResiduals, type MateResidualTargetPair,
  type MateResidualReport, type MateResidualRow, type PreparedMateResidual, type SkippedMateResidual,
} from './mateResiduals.js';
import {
  collectMateVariables, mateComponentGroups, MAX_ASSEMBLY_VARIABLES, type MateVariableSet,
} from './mateVariables.js';
import {
  DEFAULT_RIGID_ANGLE_TOLERANCE, DEFAULT_RIGID_CHARACTERISTIC_LENGTH,
  rigidRowTolerance, scaledRigidJacobian, solveRigid, type RigidEvaluation, type RigidResidualRow,
  type RigidSolveInput, type RigidSolveOptions, type RigidSolveOutcome, type RigidSolveStopReason,
} from './solveRigid.js';

import type { JointFramePair } from '../joints/jointFrames.js';
import {
  buildJointResidualReport, prepareJointResiduals, type JointResidualReport, type JointResidualRow,
  type PreparedJointResidual, type SkippedJointResidual,
} from '../joints/jointResiduals.js';
import {
  driveJointRows, jointValue, prepareJointDrive, type JointDriveFailureReason, type JointDriveRequest,
  type PreparedJointDrive,
} from '../joints/driveJoint.js';
import {
  finiteDragVector, hardDragSatisfied, validDragPlacement, validDragEvaluation, type PreparedMateDrag,
} from './mateDrag.js';
export { solveMateDrag, type MateDragOptions, type MateDragOutcome, type PreparedMateDrag } from './mateDrag.js';
export type AssemblyConstraintRef = { readonly kind: 'mate' | 'joint'; readonly id: string };
/** Internal keys never escape into document IDs or user-facing diagnosis. */
function constraintKey(ref: AssemblyConstraintRef): string { return JSON.stringify([ref.kind, ref.id]); }
const EMPTY_JOINT_REPORT: JointResidualReport = { rows: [], skipped: [], branchViolations: [] };

export interface SolveMatesOptions extends RigidSolveOptions {
  /** Omitted preserves legacy unsupported-joint behavior; an empty map means missingFrame. */
  readonly jointFrames?: ReadonlyMap<string, JointFramePair>;
  /** 全体600とは別の、1成分の上限(既定600)。600を超える指定でも上限は広げない。 */
  readonly maxComponentVariables?: number;
  readonly parameters?: ReadonlyMap<string, number>;
  readonly exactVariables?: ReadonlyMap<string, string>;
  /** 合致・joint driverの式に使う。省略時はassembly.parametersの単位から導出する。 */
  readonly nonLengthVariables?: ReadonlySet<string>;
  /**
   * 上流で姿勢6自由度を固定済みの部品だけを指定する。その姿勢はplacementsから読む。
   * 位置だけのdrag pinは含めない。部分的なdriverの残差はタスク18/20で接続する。
   */
  readonly anchors?: ReadonlyMap<string, 'origin' | 'driver'>;
}

function constraintExpressionContext(assembly: AssemblyDocument, options: Pick<SolveMatesOptions,
  'parameters' | 'exactVariables' | 'nonLengthVariables'>) {
  const context = assemblyExpressionContext(assembly);
  return {
    parameters: options.parameters ?? context.variables,
    // 外部の数値表を渡す呼出元には、文書の古い十進値を優先させない。
    exactVariables: options.exactVariables ?? (options.parameters === undefined ? context.exactVariables : undefined),
    nonLengthVariables: options.nonLengthVariables ?? context.nonLengthVariables,
  };
}

export interface MateVariableLimit {
  readonly scope: 'assembly' | 'component';
  readonly componentIds: readonly string[];
  readonly variables: number;
  readonly maximum: number;
}

export interface MateComponentDiagnosis {
  readonly jointIds?: readonly string[];
  readonly jointRows?: readonly JointResidualRow[];
  /** Rigid driverの内部keyを公開しない。種類を失わない分岐の参照。 */
  readonly constraintBranchViolations?: readonly AssemblyConstraintRef[];
  readonly componentIds: readonly string[];
  readonly mateIds: readonly string[];
  /** タスク16が合致ごとの残差を示すための、最終配置の行(mateId/scale付き)。 */
  readonly rows: readonly MateResidualRow[];
  readonly gauge: { readonly kind: 'fixed' | 'origin' | 'driver' | 'firstComponent' | 'constant';
    readonly componentId: string | null; readonly removed: number };
  /** gauge固定後の変数数と、W/列尺度を適用したJacobianのrank。上限時のrankはnull。 */
  readonly variables: number;
  readonly rank: number | null;
  readonly remainingDegreesOfFreedom: number | null;
  readonly status: RigidSolveStopReason | 'variableLimit';
  readonly result: RigidSolveOutcome<ReadonlyMap<string, RigidPlacement>> | null;
  /** 最終rankの材料。旧呼出側が組み立てた結果との互換のため省略可。保存しない。 */
  readonly linearization?: MateLinearizationSnapshot | null;
}

export interface MateLinearizationSnapshot {
  /** Full mate-then-joint row order. Omission is supported only for legacy mate-only snapshots. */
  readonly rowSources?: readonly AssemblyConstraintRef[];
  /** rowsと同じ行順、gauge固定後のvariablesと同じ列順。 */
  readonly scaledJacobian: readonly (readonly number[])[];
  readonly rowTolerances: readonly number[];
  readonly constantRows: readonly boolean[];
}

export type MateRowDependency = 'independent' | 'dependent' | 'noVariable' | 'singular' | 'unknown';

export interface JointRowDiagnosis extends Omit<MateRowDiagnosis, 'mateId'> { readonly jointId: string }

export interface MateRowDiagnosis {
  readonly componentIndex: number;
  readonly rowIndex: number;
  readonly mateId: string;
  readonly residual: number | null;
  readonly tolerance: number | null;
  readonly normalizedResidual: number | null;
  readonly satisfied: boolean | null;
  readonly constant: boolean;
  readonly dependency: MateRowDependency;
}

export interface MateDiagnosisComponent {
  readonly jointIds?: readonly string[];
  readonly jointRows?: readonly JointRowDiagnosis[];
  readonly componentIds: MateComponentDiagnosis['componentIds'];
  readonly mateIds: MateComponentDiagnosis['mateIds'];
  readonly gauge: MateComponentDiagnosis['gauge'];
  readonly variables: number;
  readonly rank: number | null;
  readonly remainingDegreesOfFreedom: number | null;
  readonly status: MateComponentDiagnosis['status'];
  readonly limit: RigidSolveOutcome<ReadonlyMap<string, RigidPlacement>>['limit'];
  readonly rows: readonly MateRowDiagnosis[];
  readonly redundancyComplete: boolean;
}

export type MateDiagnosisMessageCode =
  | 'remainingDegreesOfFreedom' | 'fullyConstrained' | 'redundant' | 'noVariable'
  | 'provenConstantConflict' | 'suspectedConflict' | 'iterationLimit' | 'timeLimit'
  | 'stalled' | 'variableLimit' | 'skippedTarget' | 'unsupportedJoint' | 'incompleteDiagnosis';

export interface MateDiagnosisMessage {
  readonly jointIds?: readonly string[];
  readonly code: MateDiagnosisMessageCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly mateIds: readonly string[];
  readonly text: string;
}

export interface MateDiagnosisCandidate {
  readonly mateId: string;
  readonly kind: 'provenConflict' | 'suspectedConflict' | 'unresolved';
  readonly normalizedResidual: number | null;
}

export interface ConstraintDiagnosisCandidate {
  readonly constraint: AssemblyConstraintRef;
  readonly kind: MateDiagnosisCandidate['kind'];
  readonly normalizedResidual: number | null;
}

export interface MateDiagnosis {
  readonly jointRows?: readonly JointRowDiagnosis[];
  readonly redundantJointIds?: readonly string[];
  readonly provenConflictJointIds?: readonly string[];
  readonly suspectedConflictJointIds?: readonly string[];
  readonly unresolvedJointIds?: readonly string[];
  readonly skippedJoints?: readonly SkippedJointResidual[];
  readonly jointBranchViolations?: readonly string[];
  readonly constraintCauseCandidates?: readonly ConstraintDiagnosisCandidate[];
  readonly status: MateSolveDiagnosis['status'];
  readonly converged: boolean;
  /** 全対象の評価・階数・行分類が揃ったこと。収束とは別。 */
  readonly complete: boolean;
  readonly remainingDegreesOfFreedom: number | null;
  readonly components: readonly MateDiagnosisComponent[];
  readonly rows: readonly MateRowDiagnosis[];
  readonly redundantRowCount: number;
  /** 収束済み成分で全有効行が局所的に従属する合致。大域的な削除可能性は保証しない。 */
  readonly redundantMateIds: readonly string[];
  readonly provenConflictMateIds: readonly string[];
  readonly suspectedConflictMateIds: readonly string[];
  readonly unresolvedMateIds: readonly string[];
  /** 証明済みを優先し、残差比・文書順で最大3件。 */
  readonly causeCandidates: readonly MateDiagnosisCandidate[];
  readonly skipped: SolveMatesOutcome['skipped'];
  readonly unsupportedJointIds: MateSolveDiagnosis['unsupportedJointIds'];
  readonly limits: MateSolveDiagnosis['limits'];
  readonly branchViolations: SolveMatesOutcome['branchViolations'];
  readonly messages: readonly MateDiagnosisMessage[];
}

export interface MateSolveDiagnosis {
  readonly constantJointConflicts?: readonly string[];
  readonly status: RigidSolveStopReason | 'variableLimit';
  readonly components: readonly MateComponentDiagnosis[];
  readonly limits: readonly MateVariableLimit[];
  readonly constantConflicts: readonly string[];
  /** ジョイントの残差はタスク19。未対応を黙って収束に数えない。 */
  readonly unsupportedJointIds: readonly string[];
}

export interface SolveMatesOutcome {
  readonly skippedJoints?: readonly SkippedJointResidual[];
  readonly jointBranchViolations?: readonly string[];
  readonly placements: Map<string, RigidPlacement>;
  readonly converged: boolean;
  /** 各成分の反復数の最大。候補数/各成分の反復はdiagnosis.components内。 */
  readonly iterations: number;
  readonly residualNorm: number;
  readonly maxResidual: number;
  readonly diagnosis: MateSolveDiagnosis;
  readonly skipped: readonly SkippedMateResidual[];
  readonly branchViolations: readonly string[];
}

export type SolveDrivenJointOutcome = {
  readonly ok: true;
  readonly placements: Map<string, RigidPlacement>;
  readonly outcome: SolveMatesOutcome;
  readonly requested: number;
  readonly target: number;
  readonly actual: number;
  readonly referenceAngle?: number;
  readonly atLimit: boolean;
  readonly outOfRange: boolean;
} | {
  readonly ok: false;
  readonly reason: JointDriveFailureReason | 'solveFailed';
  readonly placements: Map<string, RigidPlacement>;
  readonly outcome: SolveMatesOutcome | null;
};

/** 一時driverの成否と配置を原子的に返す。保存・履歴・恒久DOFを変更しない。 */
export function solveDrivenJoint(
  assembly: AssemblyDocument, targets: ReadonlyMap<string, MateResidualTargetPair>,
  initial: ReadonlyMap<string, RigidPlacement>, request: JointDriveRequest, options: SolveMatesOptions = {},
): SolveDrivenJointOutcome {
  const now = options.now ?? (() => performance.now());
  const start = options.maxTimeMs === undefined ? 0 : now();
  const failure = (reason: JointDriveFailureReason | 'solveFailed', outcome: SolveMatesOutcome | null = null): SolveDrivenJointOutcome => {
    const placements = new Map(initial);
    return { ok: false, reason, placements, outcome: outcome === null ? null : { ...outcome, placements } };
  };
  const matches = assembly.joints.filter((joint) => joint.id === request.jointId);
  if (matches.length > 1) return failure('duplicateJoint');
  const activeIds = new Set(assembly.components.filter((component) => !component.suppressed).map((component) => component.id));
  const prepared = prepareJointDrive({ joint: matches[0], frames: options.jointFrames?.get(request.jointId),
    placements: new Map([...initial].filter(([id]) => activeIds.has(id))), request,
    ...constraintExpressionContext(assembly, options) });
  if (!prepared.ok) return failure(prepared.reason);
  const remaining = options.maxTimeMs === undefined ? undefined : Math.max(0, options.maxTimeMs - (now() - start));
  const { drivenValue, ...outcome } = solveMatesCore(assembly, targets, initial,
    { ...options, maxTimeMs: remaining, now }, prepared.drive);
  if (!outcome.converged || drivenValue === undefined || !Number.isFinite(drivenValue)) return failure('solveFailed', outcome);
  return { ok: true, placements: outcome.placements, outcome, requested: prepared.drive.requested,
    target: prepared.drive.target, actual: drivenValue,
    referenceAngle: request.coordinate === 'angle' ? drivenValue : undefined,
    atLimit: prepared.drive.atLimit, outOfRange: prepared.drive.outOfRange };
}

interface DrivenState {
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly referenceAngle?: number;
}

/** unwrap参照は受理済みBaseの一部。evaluateの順序で動くクロージャ状態を持たない。 */
function solveDrivenGroup(input: RigidSolveInput<ReadonlyMap<string, RigidPlacement>>,
  variableSet: MateVariableSet, drive: PreparedJointDrive): {
    readonly result: RigidSolveOutcome<ReadonlyMap<string, RigidPlacement>>;
    readonly actual?: number;
  } {
  const valueInput = (state: DrivenState, increments?: readonly number[]) => ({ joint: drive.joint,
    coordinate: drive.coordinate, placements: state.placements, referenceAngle: state.referenceAngle,
    variableSet, increments, characteristicLength: input.options?.characteristicLength });
  const solved = solveRigid<DrivenState>({
    initial: { placements: input.initial, referenceAngle: drive.referenceAngle }, variables: input.variables,
    options: input.options,
    evaluate: (state, increments) => {
      const permanent = input.evaluate(state.placements, increments);
      const driver = driveJointRows({ ...valueInput(state, increments), target: drive.target });
      if (!driver.ok) return { ...permanent, valid: false };
      // 公開角度値(deg)も1e-9以内で合わせる。永久行のrad許容は変えない。
      const rows = driver.rows.map((row) => drive.coordinate === 'angle'
        ? { ...row, tolerance: Math.min(input.options?.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE, 1e-9 * Math.PI / 180) } : row);
      return { ...permanent, rows: [...permanent.rows, ...rows] };
    },
    retract: (state, increments) => {
      const current = jointValue(valueInput(state, increments));
      return { placements: input.retract(state.placements, increments),
        referenceAngle: drive.coordinate === 'angle' && current.ok ? current.value : state.referenceAngle };
    },
    branchCandidates: input.branchCandidates === undefined ? undefined
      : (state, violations) => input.branchCandidates?.(state.placements, violations) ?? [],
  });
  const current = jointValue(valueInput(solved.base));
  return { result: { ...solved, base: solved.base.placements }, actual: current.ok ? current.value : undefined };
}

/** Δtは世界並進へ足す。composePlacement(delta,base)はここでは使わない。 */
export function applyMateIncrements(
  placements: ReadonlyMap<string, RigidPlacement>, variableSet: MateVariableSet,
  increments: readonly number[],
): ReadonlyMap<string, RigidPlacement> {
  const next = new Map(placements);
  for (const id of variableSet.movableComponentIds) {
    const placement = placements.get(id);
    if (placement === undefined) continue;
    // collectMateVariablesは各部品をtx,ty,tz,rx,ry,rzの連続6列にする。
    // 反復ごとに同じMapを6回引かず、先頭列だけを取得する。
    const column = variableSet.columnOf(id, 'tx');
    if (column === null) continue;
    const translation: Vec3 = [increments[column] ?? 0, increments[column + 1] ?? 0, increments[column + 2] ?? 0];
    const rotation: Vec3 = [increments[column + 3] ?? 0, increments[column + 4] ?? 0, increments[column + 5] ?? 0];
    next.set(id, { position: addVec3(placement.position, translation),
      rotation: normalizeQuaternion(multiplyQuaternion(exponentialMap(rotation), placement.rotation)) });
  }
  return next;
}

function rowUnits(mate: PreparedMateResidual): readonly ('length' | 'angle')[] {
  switch (mate.kind) {
    case 'parallel': return ['angle', 'angle'];
    case 'concentric': return ['angle', 'angle', 'length', 'length'];
    case 'tangent': return ['angle', 'length'];
    case 'angle': return ['angle'];
    case 'distance': return ['length'];
    case 'coincident': return mate.a.kind === 'plane' ? ['angle', 'angle', 'length']
      : mate.b.kind === 'point' ? ['length', 'length', 'length'] : ['length'];
  }
}

function rigidEvaluation(
  report: MateResidualReport, mates: ReadonlyMap<string, PreparedMateResidual>,
  variableSet: MateVariableSet, options: SolveMatesOptions,
  jointReport: JointResidualReport = EMPTY_JOINT_REPORT,
  joints: ReadonlyMap<string, PreparedJointResidual> = new Map(),
): RigidEvaluation {
  const indices = new Map<string, number>();
  const constantIds = new Set<string>();
  const rows: RigidResidualRow[] = report.rows.map((row) => {
    const mate = mates.get(row.mateId);
    const index = indices.get(row.mateId) ?? 0;
    indices.set(row.mateId, index + 1);
    const constant = mate !== undefined && variableSet.columnOf(mate.componentA, 'tx') === null
      && variableSet.columnOf(mate.componentB, 'tx') === null;
    if (constant) constantIds.add(constraintKey({ kind: 'mate', id: row.mateId }));
    const unit = mate === undefined ? 'length' : rowUnits(mate)[index];
    if (mate?.kind === 'angle') {
      const tolerance = options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE;
      // cos(a)-cos(b)を直接引く桁落ちを避ける。radの許容の両側で小さい方を使う。
      const difference = 2 * Math.sin(tolerance / 2) * Math.min(
        Math.abs(Math.sin(mate.value - tolerance / 2)), Math.abs(Math.sin(mate.value + tolerance / 2)));
      return { ...row, unit, constant, tolerance: difference };
    }
    return { ...row, unit, constant };
  });
  for (const row of jointReport.rows) {
    const joint = joints.get(row.jointId);
    const constant = joint !== undefined && variableSet.columnOf(joint.componentA, 'tx') === null
      && variableSet.columnOf(joint.componentB, 'tx') === null;
    if (constant) constantIds.add(constraintKey({ kind: 'joint', id: row.jointId }));
    rows.push({ ...row, unit: row.measure === 'length' ? 'length' : 'angle', constant,
      ...(row.measure === 'rotation' ? { tolerance: options.angleTolerance ?? DEFAULT_RIGID_ANGLE_TOLERANCE } : {}) });
  }
  const branches = [...report.branchViolations.map((id) => constraintKey({ kind: 'mate', id })),
    ...jointReport.branchViolations.map((id) => constraintKey({ kind: 'joint', id }))];
  return { rows, valid: report.skipped.length === 0 && jointReport.skipped.length === 0, branchViolations: branches,
    constantConflict: branches.some((id) => constantIds.has(id)) };
}

/** 明示された反転の候補。局所基底を選び直さず、対象点の位置を保った半回転を試す。 */
interface BranchGeometry {
  readonly componentA: string;
  readonly componentB: string;
  readonly a: { readonly point: Vec3; readonly frame: { readonly t: Vec3 } | null };
  readonly b: { readonly point: Vec3; readonly frame: { readonly t: Vec3 } | null };
}
function branchCandidates(
  placements: ReadonlyMap<string, RigidPlacement>, violations: readonly string[],
  mates: ReadonlyMap<string, BranchGeometry>, variables: MateVariableSet,
): readonly (readonly number[])[] {
  const candidates: number[][] = [];
  for (const id of violations) {
    const mate = mates.get(id);
    if (mate === undefined) continue;
    for (const [componentId, target] of [[mate.componentA, mate.a], [mate.componentB, mate.b]] as const) {
      const placement = placements.get(componentId);
      if (placement === undefined || target.frame === null || variables.columnOf(componentId, 'tx') === null) continue;
      const axis = rotateVector(placement.rotation, target.frame.t);
      const omega = scaleVec3(axis, Math.PI);
      const arm = rotateVector(placement.rotation, target.point);
      const translation = subVec3(arm, rotateVector(exponentialMap(omega), arm));
      const step = new Array<number>(variables.variables.length).fill(0);
      for (const [axisName, value] of [
        ['tx', translation[0]], ['ty', translation[1]], ['tz', translation[2]],
        ['rx', omega[0]], ['ry', omega[1]], ['rz', omega[2]],
      ] as const) {
        const column = variables.columnOf(componentId, axisName);
        if (column !== null) step[column] = value;
      }
      candidates.push(step);
    }
  }
  return candidates;
}

export type PrepareMateDragOptions = Pick<SolveMatesOptions,
  'characteristicLength' | 'lengthTolerance' | 'angleTolerance' | 'linearSolver'
  | 'maxComponentVariables' | 'parameters' | 'exactVariables' | 'nonLengthVariables' | 'jointFrames'>;
export type PrepareMateDragOutcome = { readonly ok: true; readonly drag: PreparedMateDrag }
  | { readonly ok: false; readonly reason: 'invalidInput' | 'unavailableComponent'
    | 'variableLimit' | 'unresolvedConstraint' | 'initialUnsatisfied' };

/** Prepare once against the drag-start world geometry. No first-component gauge is applied. */
export function prepareMateDrag(
  assembly: AssemblyDocument, targets: ReadonlyMap<string, MateResidualTargetPair>,
  initial: ReadonlyMap<string, RigidPlacement>, componentId: string, options: PrepareMateDragOptions = {},
): PrepareMateDragOutcome {
  const positive = [options.characteristicLength, options.lengthTolerance, options.angleTolerance];
  if (positive.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0))
    || (options.maxComponentVariables !== undefined && (!Number.isInteger(options.maxComponentVariables) || options.maxComponentVariables < 0))
    || (options.linearSolver !== undefined && !['auto', 'normal', 'qr'].includes(options.linearSolver))) return { ok: false, reason: 'invalidInput' };
  const selected = assembly.components.find((component) => component.id === componentId);
  if (selected === undefined || selected.fixed || selected.suppressed || !selected.visible) return { ok: false, reason: 'unavailableComponent' };
  const allVariables = collectMateVariables(assembly);
  const group = mateComponentGroups(allVariables, assembly.mates, assembly.joints)
    .find((entry) => entry.componentIds.includes(componentId));
  const maximum = Math.min(MAX_ASSEMBLY_VARIABLES, options.maxComponentVariables ?? MAX_ASSEMBLY_VARIABLES);
  if (allVariables.tooMany || (group !== undefined && group.componentIds.length * 6 > maximum)) return { ok: false, reason: 'variableLimit' };
  if (group === undefined) return { ok: false, reason: 'unavailableComponent' };
  const ids = new Set(group.componentIds);
  const placements = new Map<string, RigidPlacement>();
  for (const component of assembly.components) {
    const placement = initial.get(component.id);
    if (placement === undefined) {
      if (component.suppressed) continue;
      return { ok: false, reason: 'invalidInput' };
    }
    if (!validDragPlacement(placement)) return { ok: false, reason: 'invalidInput' };
    placements.set(component.id, { position: [...placement.position],
      rotation: ids.has(component.id) ? normalizeQuaternion(placement.rotation) : [...placement.rotation] });
  }
  const mates = assembly.mates.filter((mate) => !mate.suppressed && (ids.has(mate.a.componentId) || ids.has(mate.b.componentId)));
  const joints = assembly.joints.filter((joint) => !joint.suppressed && (ids.has(joint.a.componentId) || ids.has(joint.b.componentId)));
  const active = new Set(assembly.components.filter((component) => !component.suppressed).map((component) => component.id));
  if ([...mates, ...joints].some((entry) => !active.has(entry.a.componentId) || !active.has(entry.b.componentId))) return { ok: false, reason: 'unresolvedConstraint' };
  for (const mate of mates) {
    const pair = targets.get(mate.id);
    if (pair === undefined || [pair.a, pair.b].some((target) => !finiteDragVector(target.point, 3)
      || (target.direction !== null && !finiteDragVector(target.direction, 3))
      || (target.axisOrigin !== undefined && !finiteDragVector(target.axisOrigin, 3)))) return { ok: false, reason: 'unresolvedConstraint' };
  }
  const prepared = prepareMateResiduals({ mates, targets, placements, ...constraintExpressionContext(assembly, options) });
  if (prepared.skipped.length > 0 || (joints.length > 0 && options.jointFrames === undefined)) return { ok: false, reason: 'unresolvedConstraint' };
  const preparedJoints = options.jointFrames === undefined ? { joints: [], skipped: [] }
    : prepareJointResiduals({ joints, frames: options.jointFrames, placements });
  if (preparedJoints.skipped.length > 0) return { ok: false, reason: 'unresolvedConstraint' };
  // 選択した連結成分が全可動部品なら、上限判定用に作った同じ変数表を再利用する。
  // 切り離された成分だけを動かす場合は従来どおりその成分専用の連続列を作る。
  const coversAllMovable = group.componentIds.length === allVariables.movableComponentIds.length
    && group.componentIds.every((id, index) => id === allVariables.movableComponentIds[index]);
  const variableSet = coversAllMovable ? allVariables
    : collectMateVariables({ ...assembly, components: assembly.components.filter((component) => ids.has(component.id)) });
  const variables = variableSet.variables.map((variable) => variable.axis.startsWith('t') ? 'length' as const : 'angle' as const);
  const length = options.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  const numericOptions: RigidSolveOptions = { characteristicLength: length,
    lengthTolerance: options.lengthTolerance, angleTolerance: options.angleTolerance,
    // The drag solve always has a positive LM damping diagonal, including exact null columns.
    // Its normal system is therefore nonsingular. Keep the per-frame default on that O(n^3)
    // path instead of rebuilding an augmented QR matrix for every projection iteration.
    // Callers and numerical regression tests can still request auto/qr explicitly.
    linearSolver: options.linearSolver ?? 'normal' };
  const byId = new Map(prepared.mates.map((mate) => [mate.mateId, mate]));
  const jointsById = new Map(preparedJoints.joints.map((joint) => [joint.jointId, joint]));
  const branches = new Map<string, BranchGeometry>(prepared.mates.map((mate) => [constraintKey({ kind: 'mate', id: mate.mateId }), mate]));
  for (const joint of preparedJoints.joints) branches.set(constraintKey({ kind: 'joint', id: joint.jointId }), {
    componentA: joint.componentA, componentB: joint.componentB,
    a: { point: joint.frames.a.origin, frame: { t: joint.frames.a.x } },
    b: { point: joint.frames.b.origin, frame: { t: joint.frames.b.x } },
  });
  const evaluate = (base: ReadonlyMap<string, RigidPlacement>, increments: readonly number[]) => rigidEvaluation(
    buildMateResidualReport({ mates: prepared.mates, placements: base, variableSet, increments, characteristicLength: length }),
    byId, variableSet, numericOptions,
    buildJointResidualReport({ joints: preparedJoints.joints, placements: base, variableSet, increments, characteristicLength: length }), jointsById);
  const initialEvaluation = evaluate(placements, new Array<number>(variables.length).fill(0));
  if (!validDragEvaluation(initialEvaluation, variables, numericOptions)) return { ok: false, reason: 'invalidInput' };
  if (!hardDragSatisfied(initialEvaluation, numericOptions)) return { ok: false, reason: 'initialUnsatisfied' };
  return { ok: true, drag: { componentId, initial: placements, initialEvaluation, variableSet, variables, options: numericOptions, evaluate,
    retract: (base, step) => applyMateIncrements(base, variableSet, step),
    branchCandidates: (base, violations) => branchCandidates(base, violations, branches, variableSet) } };
}

/** targetsはmate.id→初期世界座標の対象対。prepareを1回だけ呼び、全候補で同じ局所幾何を使う。 */
export function solveMates(
  assembly: AssemblyDocument, targets: ReadonlyMap<string, MateResidualTargetPair>,
  initial: ReadonlyMap<string, RigidPlacement>, options: SolveMatesOptions = {},
): SolveMatesOutcome {
  return solveMatesCore(assembly, targets, initial, options);
}

function solveMatesCore(
  assembly: AssemblyDocument, targets: ReadonlyMap<string, MateResidualTargetPair>,
  initial: ReadonlyMap<string, RigidPlacement>, options: SolveMatesOptions,
  drive?: PreparedJointDrive,
): SolveMatesOutcome & { readonly drivenValue?: number } {
  const now = options.now ?? (() => performance.now());
  const start = options.maxTimeMs === undefined ? 0 : now();
  const remainingTime = () => options.maxTimeMs === undefined ? undefined
    : Math.max(0, options.maxTimeMs - (now() - start));
  const length = options.characteristicLength ?? DEFAULT_RIGID_CHARACTERISTIC_LENGTH;
  const activeIds = new Set(assembly.components.filter((component) => !component.suppressed).map((component) => component.id));
  const activePlacements = new Map([...initial].filter(([id]) => activeIds.has(id)));
  const effective = { ...assembly, components: assembly.components.map((component) => ({ ...component,
    fixed: component.fixed || options.anchors?.has(component.id) === true })) };
  const allVariables = collectMateVariables(effective);
  const prepared = prepareMateResiduals({ mates: assembly.mates, targets, placements: activePlacements,
    ...constraintExpressionContext(assembly, options) });
  const preparedById = new Map(prepared.mates.map((mate) => [mate.mateId, mate]));
  const activeMates = assembly.mates.filter((mate) => preparedById.has(mate.id));
  const preparedJoints = options.jointFrames === undefined ? { joints: [], skipped: [] }
    : prepareJointResiduals({ joints: assembly.joints, frames: options.jointFrames, placements: activePlacements });
  const jointsById = new Map(preparedJoints.joints.map((joint) => [joint.jointId, joint]));
  const activeJoints = assembly.joints.filter((joint) => jointsById.has(joint.id));
  const branchGeometry = new Map<string, BranchGeometry>(prepared.mates.map((mate) =>
    [constraintKey({ kind: 'mate', id: mate.mateId }), mate]));
  for (const joint of preparedJoints.joints) branchGeometry.set(constraintKey({ kind: 'joint', id: joint.jointId }), {
    componentA: joint.componentA, componentB: joint.componentB,
    a: { point: joint.frames.a.origin, frame: { t: joint.frames.a.x } },
    b: { point: joint.frames.b.origin, frame: { t: joint.frames.b.x } },
  });
  const groups = mateComponentGroups(allVariables, activeMates, activeJoints);
  const components: MateComponentDiagnosis[] = [];
  const limits: MateVariableLimit[] = [];
  const placements = new Map(initial);
  const skipped: SkippedMateResidual[] = [...prepared.skipped];
  const branchViolations: string[] = [];
  const skippedJoints: SkippedJointResidual[] = [...preparedJoints.skipped];
  const jointBranchViolations: string[] = [];
  const constantJointConflicts: string[] = [];
  const constantConflicts: string[] = [];
  const unsupportedJointIds = options.jointFrames === undefined ? assembly.joints.filter((joint) => !joint.suppressed).map((joint) => joint.id) : [];
  const componentLimit = Math.max(0, Math.min(MAX_ASSEMBLY_VARIABLES,
    Math.trunc(options.maxComponentVariables ?? MAX_ASSEMBLY_VARIABLES)));
  if (allVariables.tooMany) limits.push({ scope: 'assembly', componentIds: allVariables.movableComponentIds,
    variables: allVariables.variables.length, maximum: MAX_ASSEMBLY_VARIABLES });
  const groupedMateIds = new Set(groups.flatMap((group) => group.mateIds));
  const constantMates = prepared.mates.filter((mate) => !groupedMateIds.has(mate.mateId));
  const groupedJointIds = new Set(groups.flatMap((group) => group.jointIds));
  const constantJoints = preparedJoints.joints.filter((joint) => !groupedJointIds.has(joint.jointId));
  const solveGroups = [...groups, ...(constantMates.length === 0 && constantJoints.length === 0 ? []
    : [{ componentIds: [], mateIds: constantMates.map((mate) => mate.mateId), jointIds: constantJoints.map((joint) => joint.jointId) }])];
  let residualSquare = 0;
  let maxResidual = 0;
  let iterations = 0;
  let drivenValue: number | undefined;

  for (const group of solveGroups) {
    const groupIds = new Set(group.componentIds);
    const mates = group.mateIds.flatMap((id) => { const mate = preparedById.get(id); return mate === undefined ? [] : [mate]; });
    const joints = group.jointIds.flatMap((id) => { const joint = jointsById.get(id); return joint === undefined ? [] : [joint]; });
    const involvedIds = new Set([...mates, ...joints].flatMap((entry) => [entry.componentA, entry.componentB]));
    const fixed = effective.components.find((component) => !component.suppressed && component.fixed && involvedIds.has(component.id));
    const first = group.componentIds[0];
    const gauge: MateComponentDiagnosis['gauge'] = fixed !== undefined
      ? { kind: options.anchors?.get(fixed.id) ?? 'fixed', componentId: fixed.id, removed: 0 }
      : first === undefined ? { kind: 'constant', componentId: null, removed: 0 }
        : { kind: 'firstComponent', componentId: first, removed: 6 };
    const variableSet = collectMateVariables({ ...effective, components: effective.components
      .filter((component) => groupIds.has(component.id))
      .map((component) => ({ ...component, fixed: gauge.kind === 'firstComponent' && component.id === first })) });
    const variables = variableSet.variables.map((variable) => variable.axis.startsWith('t') ? 'length' as const : 'angle' as const);
    const evaluateReport = (base: ReadonlyMap<string, RigidPlacement>, increments?: readonly number[]) =>
      buildMateResidualReport({ mates, placements: base, variableSet, increments, characteristicLength: length });
    const evaluateJointReport = (base: ReadonlyMap<string, RigidPlacement>, increments?: readonly number[]) =>
      buildJointResidualReport({ joints, placements: base, variableSet, increments, characteristicLength: length });
    const evaluate = (base: ReadonlyMap<string, RigidPlacement>, increments: readonly number[]) =>
      rigidEvaluation(evaluateReport(base, increments), preparedById, variableSet, options,
        evaluateJointReport(base, increments), jointsById);
    // 上限はgaugeで引く前の実際の可動変数数で判定する。上限回避のために6を引かない。
    const tooLarge = group.componentIds.length * 6 > componentLimit;
    if (tooLarge) limits.push({ scope: 'component', componentIds: group.componentIds,
      variables: group.componentIds.length * 6, maximum: componentLimit });
    // 可動側が上限でも、固定同士の診断(変数0)は計算量を増やさず証明できる。
    const limited = group.componentIds.length > 0 && (allVariables.tooMany || tooLarge);
    const solveInput: RigidSolveInput<ReadonlyMap<string, RigidPlacement>> | null = limited ? null : {
      initial: new Map(placements), variables, evaluate,
      retract: (base, step) => applyMateIncrements(base, variableSet, step),
      branchCandidates: (base, violations) => branchCandidates(base, violations, branchGeometry, variableSet),
      options: { ...options, maxTimeMs: remainingTime(), now },
    };
    const driven = solveInput === null || drive === undefined || !group.jointIds.includes(drive.joint.jointId)
      ? null : solveDrivenGroup(solveInput, variableSet, drive);
    const result = solveInput === null ? null : driven?.result ?? solveRigid(solveInput);
    if (driven !== null) drivenValue = driven.actual;
    if (result !== null) {
      for (const id of group.componentIds) {
        const placement = result.base.get(id);
        if (placement !== undefined) placements.set(id, placement);
      }
      iterations = Math.max(iterations, result.iterations);
    }
    const report = evaluateReport(placements);
    const jointReport = evaluateJointReport(placements);
    const evaluation = rigidEvaluation(report, preparedById, variableSet, options, jointReport, jointsById);
    skippedJoints.push(...jointReport.skipped);
    jointBranchViolations.push(...jointReport.branchViolations);
    skipped.push(...report.skipped);
    branchViolations.push(...report.branchViolations);
    for (const row of [...report.rows, ...jointReport.rows]) {
      residualSquare += row.value * row.value;
      maxResidual = Math.max(maxResidual, Math.abs(row.value));
    }
    if (result?.stop === 'provenConstantConflict') {
      for (const mate of mates) {
        if (variableSet.columnOf(mate.componentA, 'tx') === null && variableSet.columnOf(mate.componentB, 'tx') === null) {
          const single = solveRigid({ initial: placements, variables: [], retract: (base) => base,
            evaluate: () => rigidEvaluation({ rows: report.rows.filter((row) => row.mateId === mate.mateId),
              skipped: [], branchViolations: report.branchViolations.filter((id) => id === mate.mateId) },
            preparedById, variableSet, options), options });
          if (single.stop === 'provenConstantConflict') constantConflicts.push(mate.mateId);
        }
      }
    }
    if (result?.stop === 'provenConstantConflict') {
      for (const joint of joints) {
        if (variableSet.columnOf(joint.componentA, 'tx') !== null || variableSet.columnOf(joint.componentB, 'tx') !== null) continue;
        if (jointReport.branchViolations.includes(joint.jointId) || evaluation.rows.some((row) =>
          'jointId' in row && row.jointId === joint.jointId && Math.abs(row.value) >= rigidRowTolerance(row, options))) {
          constantJointConflicts.push(joint.jointId);
        }
      }
    }
    const linearization: MateLinearizationSnapshot | null = limited || remainingTime() === 0 ? null : {
      scaledJacobian: scaledRigidJacobian(evaluation.rows, variables, options),
      rowTolerances: evaluation.rows.map((row) => rigidRowTolerance(row, options)),
      constantRows: evaluation.rows.map((row) => row.constant === true),
      rowSources: [...report.rows.map((row): AssemblyConstraintRef => ({ kind: 'mate', id: row.mateId })),
        ...jointReport.rows.map((row): AssemblyConstraintRef => ({ kind: 'joint', id: row.jointId }))],
    };
    const rank = linearization === null ? null : matrixRank(linearization.scaledJacobian, variables.length);
    const constraintBranchViolations: AssemblyConstraintRef[] = [
      ...report.branchViolations.map((id): AssemblyConstraintRef => ({ kind: 'mate', id })),
      ...jointReport.branchViolations.map((id): AssemblyConstraintRef => ({ kind: 'joint', id })),
    ];
    // 旧result.evaluation.branchViolationsはmate IDだけ。jointは型付き参照で返す。
    const publicResult = result === null ? null : { ...result,
      evaluation: { ...result.evaluation, branchViolations: report.branchViolations } };
    components.push({ componentIds: group.componentIds, mateIds: group.mateIds, rows: report.rows,
      jointIds: group.jointIds, jointRows: jointReport.rows, constraintBranchViolations, gauge,
      variables: variables.length, rank, remainingDegreesOfFreedom: rank === null ? null : variables.length - rank,
      status: result?.stop ?? 'variableLimit', result: publicResult, linearization });
  }
  const priority: readonly MateSolveDiagnosis['status'][] = [
    'provenConstantConflict', 'variableLimit', 'iterationLimit', 'suspectedConflict', 'stalled',
  ];
  const status = priority.find((value) => components.some((component) => component.status === value))
    ?? (limits.length > 0 ? 'variableLimit' : skipped.length > 0 || skippedJoints.length > 0 || unsupportedJointIds.length > 0 ? 'stalled' : 'converged');
  return { placements, converged: status === 'converged', iterations,
    residualNorm: Math.sqrt(residualSquare), maxResidual,
    diagnosis: { status, components, limits, constantConflicts, constantJointConflicts, unsupportedJointIds },
    skipped, branchViolations, skippedJoints, jointBranchViolations,
    ...(drive === undefined ? {} : { drivenValue }) };
}

/** 転置QRは行の独立集合だけに使う。rank/gaugeはsolverの結果を上書きしない。 */
function diagnoseMateComponent(component: MateComponentDiagnosis, componentIndex: number): MateDiagnosisComponent {
  const snapshot = component.linearization;
  const allRows = [...component.rows, ...component.jointRows ?? []];
  const sources: AssemblyConstraintRef[] = allRows.map((row) => 'mateId' in row
    ? { kind: 'mate', id: row.mateId } : { kind: 'joint', id: row.jointId });
  const sourceOrderValid = snapshot?.rowSources === undefined ? (component.jointRows?.length ?? 0) === 0
    : snapshot.rowSources.length === sources.length && snapshot.rowSources.every((ref, i) =>
      ref.kind === sources[i].kind && ref.id === sources[i].id);
  const m = allRows.length;
  const n = component.variables;
  const valid = sourceOrderValid && snapshot != null && component.rank !== null
    && snapshot.scaledJacobian.length === m && snapshot.rowTolerances.length === m
    && snapshot.constantRows.length === m
    && snapshot.scaledJacobian.every((row) => row.length === n && row.every(Number.isFinite))
    && snapshot.rowTolerances.every((tolerance) => Number.isFinite(tolerance) && tolerance > 0)
    && allRows.every((row) => Number.isFinite(row.value));
  let redundancyComplete = false;
  const independent = new Set<number>();
  if (valid) {
    const transposed = Array.from({ length: n }, (_, column) => snapshot.scaledJacobian.map((row) => row[column]));
    const qr = qrDecomposition(transposed, m);
    redundancyComplete = qr.rank === component.rank;
    if (redundancyComplete) {
      // QRの交換順で完全重複の後続行を選んでも、同じ先行行へ戻す。近似判定は加えない。
      const firstRows = new Map<string, number>();
      const canonical = snapshot.scaledJacobian.map((row, index) => {
        const key = JSON.stringify(row);
        const first = firstRows.get(key);
        if (first !== undefined) return first;
        firstRows.set(key, index);
        return index;
      });
      for (const index of qr.columnOrder.slice(0, qr.rank)) independent.add(canonical[index]);
    }
  }
  const classified = allRows.map((row, rowIndex): MateRowDiagnosis | JointRowDiagnosis => {
    const rawTolerance = sourceOrderValid ? snapshot?.rowTolerances[rowIndex] : undefined;
    const tolerance = rawTolerance !== undefined && Number.isFinite(rawTolerance) && rawTolerance > 0 ? rawTolerance : null;
    const residual = Number.isFinite(row.value) ? row.value : null;
    const ratio = residual === null || tolerance === null ? null : Math.abs(residual) / tolerance;
    const constant = snapshot?.constantRows[rowIndex] === true;
    const dependency: MateRowDependency = !redundancyComplete ? 'unknown' : constant ? 'noVariable'
      : snapshot?.scaledJacobian[rowIndex].every((value) => value === 0) === true ? 'singular'
        : independent.has(rowIndex) ? 'independent' : 'dependent';
    const values = { componentIndex, rowIndex, residual, tolerance,
      normalizedResidual: ratio !== null && Number.isFinite(ratio) ? ratio : null,
      satisfied: residual === null || tolerance === null ? null : Math.abs(residual) < tolerance,
      constant, dependency };
    return 'mateId' in row ? { ...values, mateId: row.mateId } : { ...values, jointId: row.jointId };
  });
  return { componentIds: component.componentIds, mateIds: component.mateIds, gauge: component.gauge,
    variables: n, rank: component.rank, remainingDegreesOfFreedom: component.remainingDegreesOfFreedom,
    status: component.status, limit: component.result?.limit ?? null,
    rows: classified.filter((row): row is MateRowDiagnosis => 'mateId' in row),
    jointIds: component.jointIds ?? [], jointRows: classified.filter((row): row is JointRowDiagnosis => 'jointId' in row), redundancyComplete };
}

interface ConstraintRowSummary extends Omit<MateRowDiagnosis, 'mateId'> { readonly id: string }
function summarizeConstraints(documentIds: readonly string[], rows: readonly ConstraintRowSummary[],
  components: readonly { readonly ids: readonly string[]; readonly status: MateComponentDiagnosis['status'] }[],
  branchViolations: readonly string[], constantConflicts: readonly string[]) {
  const order = new Map(documentIds.map((id, index) => [id, index]));
  const documentOrder = (a: string, b: string): number => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)
    || (a < b ? -1 : a > b ? 1 : 0);
  const sortedIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(documentOrder);
  const rowsById = new Map<string, ConstraintRowSummary[]>();
  const severity = new Map<string, number>();
  for (const row of rows) {
    const list = rowsById.get(row.id) ?? [];
    list.push(row);
    rowsById.set(row.id, list);
    if (row.normalizedResidual !== null) severity.set(row.id, Math.max(severity.get(row.id) ?? 0, row.normalizedResidual));
  }
  const branches = new Set(branchViolations);
  const provenConflictIds = sortedIds(constantConflicts);
  const proven = new Set(provenConflictIds);
  const violated = (id: string) => branches.has(id) || rowsById.get(id)?.some((row) => row.satisfied === false) === true;
  const suspectedConflictIds = sortedIds(components.filter((component) => component.status === 'suspectedConflict')
    .flatMap((component) => component.ids.filter((id) => !proven.has(id) && violated(id))));
  const suspected = new Set(suspectedConflictIds);
  const unresolvedIds = sortedIds(components.filter((component) => component.status !== 'converged')
    .flatMap((component) => component.ids.filter((id) => !proven.has(id) && !suspected.has(id) && violated(id))));
  const convergedIds = new Set(components.filter((component) => component.status === 'converged').flatMap((component) => component.ids));
  const redundantIds = sortedIds([...rowsById].filter(([id, constraintRows]) => convergedIds.has(id) && !branches.has(id)
    && constraintRows.every((row) => row.dependency === 'dependent' && row.satisfied === true)).map(([id]) => id));
  const candidates: { id: string; kind: MateDiagnosisCandidate['kind']; normalizedResidual: number | null }[] = [
    ...provenConflictIds.map((id) => ({ id, kind: 'provenConflict' as const, normalizedResidual: severity.get(id) ?? null })),
    ...suspectedConflictIds.map((id) => ({ id, kind: 'suspectedConflict' as const, normalizedResidual: severity.get(id) ?? null })),
    ...unresolvedIds.map((id) => ({ id, kind: 'unresolved' as const, normalizedResidual: severity.get(id) ?? null })),
  ];
  candidates.sort((a, b) => Number(b.kind === 'provenConflict') - Number(a.kind === 'provenConflict')
    || (b.normalizedResidual ?? -1) - (a.normalizedResidual ?? -1) || documentOrder(a.id, b.id));
  return { redundantIds: redundantIds, provenIds: provenConflictIds,
    suspectedIds: suspectedConflictIds, unresolvedIds: unresolvedIds, candidates,
    noVariable: sortedIds(rows.filter((row) => row.dependency === 'noVariable' && row.satisfied === true).map((row) => row.id)) };
}


/**
 * 最終solve結果から表示用診断を作る純関数(P7訂正0.68、FR-604)。
 * 再求解・再配置・再gaugeはしない。線形従属や未収束は大域的矛盾の証明ではない。
 */
export function diagnoseMates(assembly: AssemblyDocument, outcome: SolveMatesOutcome): MateDiagnosis {
  const components = outcome.diagnosis.components.map(diagnoseMateComponent);
  const rows = components.flatMap((component) => component.rows);
  const complete = components.every((component) => component.redundancyComplete)
    && outcome.skipped.length === 0 && (outcome.skippedJoints?.length ?? 0) === 0 && outcome.diagnosis.unsupportedJointIds.length === 0;
  const remainingDegreesOfFreedom = components.some((component) => component.remainingDegreesOfFreedom === null)
    ? null : components.reduce((sum, component) => sum + (component.remainingDegreesOfFreedom ?? 0), 0);
  const jointRows = components.flatMap((component) => component.jointRows ?? []);
  const mateSummary = summarizeConstraints(assembly.mates.map((mate) => mate.id), rows.map((row) => ({ ...row, id: row.mateId })),
    components.map((component) => ({ ids: component.mateIds, status: component.status })), outcome.branchViolations, outcome.diagnosis.constantConflicts);
  const jointSummary = summarizeConstraints(assembly.joints.map((joint) => joint.id), jointRows.map((row) => ({ ...row, id: row.jointId })),
    components.map((component) => ({ ids: component.jointIds ?? [], status: component.status })), outcome.jointBranchViolations ?? [], outcome.diagnosis.constantJointConflicts ?? []);
  const order = new Map([...assembly.mates.map((entry): AssemblyConstraintRef => ({ kind: 'mate', id: entry.id })),
    ...assembly.joints.map((entry): AssemblyConstraintRef => ({ kind: 'joint', id: entry.id }))].map((ref, index) => [constraintKey(ref), index]));
  const candidates: ConstraintDiagnosisCandidate[] = [
    ...mateSummary.candidates.map((candidate): ConstraintDiagnosisCandidate => ({ constraint: { kind: 'mate', id: candidate.id }, kind: candidate.kind, normalizedResidual: candidate.normalizedResidual })),
    ...jointSummary.candidates.map((candidate): ConstraintDiagnosisCandidate => ({ constraint: { kind: 'joint', id: candidate.id }, kind: candidate.kind, normalizedResidual: candidate.normalizedResidual })),
  ];
  candidates.sort((a, b) => Number(b.kind === 'provenConflict') - Number(a.kind === 'provenConflict')
    || (b.normalizedResidual ?? -1) - (a.normalizedResidual ?? -1)
    || (order.get(constraintKey(a.constraint)) ?? Infinity) - (order.get(constraintKey(b.constraint)) ?? Infinity)
    || (constraintKey(a.constraint) < constraintKey(b.constraint) ? -1 : constraintKey(a.constraint) > constraintKey(b.constraint) ? 1 : 0));
  const constraintCauseCandidates = candidates.slice(0, CONFLICT_REPORT_LIMIT);
  const causeCandidates = constraintCauseCandidates.filter((candidate) => candidate.constraint.kind === 'mate')
    .map((candidate) => ({ mateId: candidate.constraint.id, kind: candidate.kind, normalizedResidual: candidate.normalizedResidual }));
  const redundantMateIds = mateSummary.redundantIds, provenConflictMateIds = mateSummary.provenIds;
  const suspectedConflictMateIds = mateSummary.suspectedIds, unresolvedMateIds = mateSummary.unresolvedIds;
  const messages: MateDiagnosisMessage[] = [];
  const add = (code: MateDiagnosisMessageCode, severity: MateDiagnosisMessage['severity'], text: string,
    mateIds: readonly string[] = [], jointIds: readonly string[] = []) => {
    messages.push({ code, severity, text, mateIds, ...(jointIds.length > 0 ? { jointIds } : {}) });
  };
  if (remainingDegreesOfFreedom !== null && remainingDegreesOfFreedom > 0) {
    add('remainingDegreesOfFreedom', 'info', remainingMessage(remainingDegreesOfFreedom));
  } else if (remainingDegreesOfFreedom === 0 && complete && outcome.converged) {
    add('fullyConstrained', 'info', remainingMessage(0));
  }
  for (const candidate of constraintCauseCandidates) {
    if (candidate.constraint.kind === 'joint') {
      if (candidate.kind === 'provenConflict') add('provenConstantConflict', 'error',
        'このジョイントは同時には成り立ちません。固定した対象や取り付け位置を見直してください。', [], [candidate.constraint.id]);
      else if (candidate.kind === 'suspectedConflict') add('suspectedConflict', 'warning',
        'このジョイントがほかの条件と両立しない可能性があります。対象や取り付け位置を見直してください。', [], [candidate.constraint.id]);
      continue;
    }
    if (candidate.kind === 'provenConflict') add('provenConstantConflict', 'error',
      'この合致は同時には成り立ちません。固定した対象や合致の値を見直してください。', [candidate.constraint.id]);
    else if (candidate.kind === 'suspectedConflict') add('suspectedConflict', 'warning',
      'この合致がほかの条件と両立しない可能性があります。対象や値を見直してください。', [candidate.constraint.id]);
  }
  if (redundantMateIds.length > 0 || jointSummary.redundantIds.length > 0) {
    add('redundant', 'info', '同じ条件が重なっています。', redundantMateIds, jointSummary.redundantIds);
  }
  const noVariable = mateSummary.noVariable;
  if (noVariable.length > 0 || jointSummary.noVariable.length > 0) {
    add('noVariable', 'info', '固定した対象間の条件です。', noVariable, jointSummary.noVariable);
  }
  const stopped = components.filter((component) => component.status === 'iterationLimit');
  if (stopped.some((component) => component.limit === 'time')) add('timeLimit', 'warning', '計算時間の上限に達しました。合致はまだ解けていません。');
  if (stopped.some((component) => component.limit !== 'time')) add('iterationLimit', 'warning', '計算回数の上限に達しました。合致はまだ解けていません。');
  if (components.some((component) => component.status === 'stalled')) add('stalled', 'warning', '計算が進まなくなりました。配置や合致の対象を見直してください。');
  if (outcome.diagnosis.limits.length > 0) add('variableLimit', 'warning', '動かせる部品の数が計算の上限を超えています。');
  for (const skipped of outcome.skipped) add('skippedTarget', 'warning', skipped.message, [skipped.mateId]);
  for (const skipped of outcome.skippedJoints ?? []) add('skippedTarget', 'warning', skipped.message, [], [skipped.jointId]);
  if (outcome.diagnosis.unsupportedJointIds.length > 0) add('unsupportedJoint', 'warning', 'まだ計算に対応していないジョイントがあります。');
  if (!complete) add('incompleteDiagnosis', 'warning', '診断に必要な情報が揃っていません。未確定の条件があります。');
  return { status: outcome.diagnosis.status, converged: outcome.converged, complete, remainingDegreesOfFreedom,
    components, rows, redundantRowCount: [...rows, ...jointRows].filter((row) => row.dependency === 'dependent').length,
    jointRows, redundantJointIds: jointSummary.redundantIds, provenConflictJointIds: jointSummary.provenIds,
    suspectedConflictJointIds: jointSummary.suspectedIds, unresolvedJointIds: jointSummary.unresolvedIds,
    skippedJoints: outcome.skippedJoints ?? [], jointBranchViolations: outcome.jointBranchViolations ?? [], constraintCauseCandidates,
    redundantMateIds, provenConflictMateIds, suspectedConflictMateIds, unresolvedMateIds, causeCandidates,
    skipped: outcome.skipped, unsupportedJointIds: outcome.diagnosis.unsupportedJointIds,
    limits: outcome.diagnosis.limits, branchViolations: outcome.branchViolations, messages };
}
