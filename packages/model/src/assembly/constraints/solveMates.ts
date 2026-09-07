/** 合致を成分ごとに解く。解は文書へ書き戻さない(P7 §2.5.6、FR-603/604)。 */
import { CONFLICT_REPORT_LIMIT, remainingMessage } from '../../sketch/constraints/diagnose.js';
import { matrixRank, qrDecomposition } from '../../sketch/constraints/solve.js';
import { addVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import {
  exponentialMap, multiplyQuaternion, normalizeQuaternion, rotateVector, type RigidPlacement,
} from '../placementMath.js';
import { assemblyVariables } from '../resolveAssembly.js';
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
  type RigidSolveOptions, type RigidSolveOutcome, type RigidSolveStopReason,
} from './solveRigid.js';

export interface SolveMatesOptions extends RigidSolveOptions {
  /** 全体600とは別の、1成分の上限(既定600)。600を超える指定でも上限は広げない。 */
  readonly maxComponentVariables?: number;
  readonly parameters?: ReadonlyMap<string, number>;
  /**
   * 上流で姿勢6自由度を固定済みの部品だけを指定する。その姿勢はplacementsから読む。
   * 位置だけのdrag pinは含めない。部分的なdriverの残差はタスク18/20で接続する。
   */
  readonly anchors?: ReadonlyMap<string, 'origin' | 'driver'>;
}

export interface MateVariableLimit {
  readonly scope: 'assembly' | 'component';
  readonly componentIds: readonly string[];
  readonly variables: number;
  readonly maximum: number;
}

export interface MateComponentDiagnosis {
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
  /** rowsと同じ行順、gauge固定後のvariablesと同じ列順。 */
  readonly scaledJacobian: readonly (readonly number[])[];
  readonly rowTolerances: readonly number[];
  readonly constantRows: readonly boolean[];
}

export type MateRowDependency = 'independent' | 'dependent' | 'noVariable' | 'singular' | 'unknown';

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

export interface MateDiagnosis {
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
  readonly status: RigidSolveStopReason | 'variableLimit';
  readonly components: readonly MateComponentDiagnosis[];
  readonly limits: readonly MateVariableLimit[];
  readonly constantConflicts: readonly string[];
  /** ジョイントの残差はタスク19。未対応を黙って収束に数えない。 */
  readonly unsupportedJointIds: readonly string[];
}

export interface SolveMatesOutcome {
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

/** Δtは世界並進へ足す。composePlacement(delta,base)はここでは使わない。 */
export function applyMateIncrements(
  placements: ReadonlyMap<string, RigidPlacement>, variableSet: MateVariableSet,
  increments: readonly number[],
): ReadonlyMap<string, RigidPlacement> {
  const next = new Map(placements);
  for (const id of variableSet.movableComponentIds) {
    const placement = placements.get(id);
    if (placement === undefined) continue;
    const value = (axis: 'tx' | 'ty' | 'tz' | 'rx' | 'ry' | 'rz'): number => {
      const column = variableSet.columnOf(id, axis);
      return column === null ? 0 : (increments[column] ?? 0);
    };
    const translation: Vec3 = [value('tx'), value('ty'), value('tz')];
    const rotation: Vec3 = [value('rx'), value('ry'), value('rz')];
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
): RigidEvaluation {
  const indices = new Map<string, number>();
  const constantIds = new Set<string>();
  const rows: RigidResidualRow[] = report.rows.map((row) => {
    const mate = mates.get(row.mateId);
    const index = indices.get(row.mateId) ?? 0;
    indices.set(row.mateId, index + 1);
    const constant = mate !== undefined && variableSet.columnOf(mate.componentA, 'tx') === null
      && variableSet.columnOf(mate.componentB, 'tx') === null;
    if (constant) constantIds.add(row.mateId);
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
  return { rows, valid: report.skipped.length === 0, branchViolations: report.branchViolations,
    constantConflict: report.branchViolations.some((id) => constantIds.has(id)) };
}

/** 明示された反転の候補。局所基底を選び直さず、対象点の位置を保った半回転を試す。 */
function branchCandidates(
  placements: ReadonlyMap<string, RigidPlacement>, violations: readonly string[],
  mates: ReadonlyMap<string, PreparedMateResidual>, variables: MateVariableSet,
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

/** targetsはmate.id→初期世界座標の対象対。prepareを1回だけ呼び、全候補で同じ局所幾何を使う。 */
export function solveMates(
  assembly: AssemblyDocument, targets: ReadonlyMap<string, MateResidualTargetPair>,
  initial: ReadonlyMap<string, RigidPlacement>, options: SolveMatesOptions = {},
): SolveMatesOutcome {
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
    parameters: options.parameters ?? assemblyVariables(assembly) });
  const preparedById = new Map(prepared.mates.map((mate) => [mate.mateId, mate]));
  const activeMates = assembly.mates.filter((mate) => preparedById.has(mate.id));
  const groups = mateComponentGroups(allVariables, activeMates, []);
  const components: MateComponentDiagnosis[] = [];
  const limits: MateVariableLimit[] = [];
  const placements = new Map(initial);
  const skipped: SkippedMateResidual[] = [...prepared.skipped];
  const branchViolations: string[] = [];
  const constantConflicts: string[] = [];
  const unsupportedJointIds = assembly.joints.filter((joint) => !joint.suppressed).map((joint) => joint.id);
  const componentLimit = Math.max(0, Math.min(MAX_ASSEMBLY_VARIABLES,
    Math.trunc(options.maxComponentVariables ?? MAX_ASSEMBLY_VARIABLES)));
  if (allVariables.tooMany) limits.push({ scope: 'assembly', componentIds: allVariables.movableComponentIds,
    variables: allVariables.variables.length, maximum: MAX_ASSEMBLY_VARIABLES });
  const groupedMateIds = new Set(groups.flatMap((group) => group.mateIds));
  const constantMates = prepared.mates.filter((mate) => !groupedMateIds.has(mate.mateId));
  const solveGroups = [...groups, ...(constantMates.length === 0 ? []
    : [{ componentIds: [], mateIds: constantMates.map((mate) => mate.mateId), jointIds: [] }])];
  let residualSquare = 0;
  let maxResidual = 0;
  let iterations = 0;

  for (const group of solveGroups) {
    const groupIds = new Set(group.componentIds);
    const mates = group.mateIds.flatMap((id) => { const mate = preparedById.get(id); return mate === undefined ? [] : [mate]; });
    const involvedIds = new Set(mates.flatMap((mate) => [mate.componentA, mate.componentB]));
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
    const evaluate = (base: ReadonlyMap<string, RigidPlacement>, increments: readonly number[]) =>
      rigidEvaluation(evaluateReport(base, increments), preparedById, variableSet, options);
    // 上限はgaugeで引く前の実際の可動変数数で判定する。上限回避のために6を引かない。
    const tooLarge = group.componentIds.length * 6 > componentLimit;
    if (tooLarge) limits.push({ scope: 'component', componentIds: group.componentIds,
      variables: group.componentIds.length * 6, maximum: componentLimit });
    // 可動側が上限でも、固定同士の診断(変数0)は計算量を増やさず証明できる。
    const limited = group.componentIds.length > 0 && (allVariables.tooMany || tooLarge);
    const result = limited ? null : solveRigid<ReadonlyMap<string, RigidPlacement>>({
      initial: new Map(placements), variables, evaluate,
      retract: (base, step) => applyMateIncrements(base, variableSet, step),
      branchCandidates: (base, violations) => branchCandidates(base, violations, preparedById, variableSet),
      options: { ...options, maxTimeMs: remainingTime(), now },
    });
    if (result !== null) {
      for (const id of group.componentIds) {
        const placement = result.base.get(id);
        if (placement !== undefined) placements.set(id, placement);
      }
      iterations = Math.max(iterations, result.iterations);
    }
    const report = evaluateReport(placements);
    const evaluation = rigidEvaluation(report, preparedById, variableSet, options);
    skipped.push(...report.skipped);
    branchViolations.push(...report.branchViolations);
    for (const row of report.rows) {
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
    const linearization: MateLinearizationSnapshot | null = limited || remainingTime() === 0 ? null : {
      scaledJacobian: scaledRigidJacobian(evaluation.rows, variables, options),
      rowTolerances: evaluation.rows.map((row) => rigidRowTolerance(row, options)),
      constantRows: evaluation.rows.map((row) => row.constant === true),
    };
    const rank = linearization === null ? null : matrixRank(linearization.scaledJacobian, variables.length);
    components.push({ componentIds: group.componentIds, mateIds: group.mateIds, rows: report.rows, gauge,
      variables: variables.length, rank, remainingDegreesOfFreedom: rank === null ? null : variables.length - rank,
      status: result?.stop ?? 'variableLimit', result, linearization });
  }
  const priority: readonly MateSolveDiagnosis['status'][] = [
    'provenConstantConflict', 'variableLimit', 'iterationLimit', 'suspectedConflict', 'stalled',
  ];
  const status = priority.find((value) => components.some((component) => component.status === value))
    ?? (limits.length > 0 ? 'variableLimit' : skipped.length > 0 || unsupportedJointIds.length > 0 ? 'stalled' : 'converged');
  return { placements, converged: status === 'converged', iterations,
    residualNorm: Math.sqrt(residualSquare), maxResidual,
    diagnosis: { status, components, limits, constantConflicts, unsupportedJointIds },
    skipped, branchViolations };
}

/** 転置QRは行の独立集合だけに使う。rank/gaugeはsolverの結果を上書きしない。 */
function diagnoseMateComponent(component: MateComponentDiagnosis, componentIndex: number): MateDiagnosisComponent {
  const snapshot = component.linearization;
  const m = component.rows.length;
  const n = component.variables;
  const valid = snapshot != null && component.rank !== null
    && snapshot.scaledJacobian.length === m && snapshot.rowTolerances.length === m
    && snapshot.constantRows.length === m
    && snapshot.scaledJacobian.every((row) => row.length === n && row.every(Number.isFinite))
    && snapshot.rowTolerances.every((tolerance) => Number.isFinite(tolerance) && tolerance > 0)
    && component.rows.every((row) => Number.isFinite(row.value));
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
  const rows = component.rows.map((row, rowIndex): MateRowDiagnosis => {
    const rawTolerance = snapshot?.rowTolerances[rowIndex];
    const tolerance = rawTolerance !== undefined && Number.isFinite(rawTolerance) && rawTolerance > 0 ? rawTolerance : null;
    const residual = Number.isFinite(row.value) ? row.value : null;
    const ratio = residual === null || tolerance === null ? null : Math.abs(residual) / tolerance;
    const constant = snapshot?.constantRows[rowIndex] === true;
    const dependency: MateRowDependency = !redundancyComplete ? 'unknown' : constant ? 'noVariable'
      : snapshot?.scaledJacobian[rowIndex].every((value) => value === 0) === true ? 'singular'
        : independent.has(rowIndex) ? 'independent' : 'dependent';
    return { componentIndex, rowIndex, mateId: row.mateId, residual, tolerance,
      normalizedResidual: ratio !== null && Number.isFinite(ratio) ? ratio : null,
      satisfied: residual === null || tolerance === null ? null : Math.abs(residual) < tolerance,
      constant, dependency };
  });
  return { componentIds: component.componentIds, mateIds: component.mateIds, gauge: component.gauge,
    variables: n, rank: component.rank, remainingDegreesOfFreedom: component.remainingDegreesOfFreedom,
    status: component.status, limit: component.result?.limit ?? null, rows, redundancyComplete };
}

/**
 * 最終solve結果から表示用診断を作る純関数(P7訂正0.68、FR-604)。
 * 再求解・再配置・再gaugeはしない。線形従属や未収束は大域的矛盾の証明ではない。
 */
export function diagnoseMates(assembly: AssemblyDocument, outcome: SolveMatesOutcome): MateDiagnosis {
  const components = outcome.diagnosis.components.map(diagnoseMateComponent);
  const rows = components.flatMap((component) => component.rows);
  const complete = components.every((component) => component.redundancyComplete)
    && outcome.skipped.length === 0 && outcome.diagnosis.unsupportedJointIds.length === 0;
  const remainingDegreesOfFreedom = components.some((component) => component.remainingDegreesOfFreedom === null)
    ? null : components.reduce((sum, component) => sum + (component.remainingDegreesOfFreedom ?? 0), 0);
  const order = new Map(assembly.mates.map((mate, index) => [mate.id, index]));
  const documentOrder = (a: string, b: string): number => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)
    || (a < b ? -1 : a > b ? 1 : 0);
  const sortedIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(documentOrder);
  const rowsByMate = new Map<string, MateRowDiagnosis[]>();
  const severity = new Map<string, number>();
  for (const row of rows) {
    const list = rowsByMate.get(row.mateId) ?? [];
    list.push(row);
    rowsByMate.set(row.mateId, list);
    if (row.normalizedResidual !== null) severity.set(row.mateId, Math.max(severity.get(row.mateId) ?? 0, row.normalizedResidual));
  }
  const branches = new Set(outcome.branchViolations);
  const provenConflictMateIds = sortedIds(outcome.diagnosis.constantConflicts);
  const proven = new Set(provenConflictMateIds);
  const violated = (id: string) => branches.has(id) || rowsByMate.get(id)?.some((row) => row.satisfied === false) === true;
  const suspectedConflictMateIds = sortedIds(components.filter((component) => component.status === 'suspectedConflict')
    .flatMap((component) => component.mateIds.filter((id) => !proven.has(id) && violated(id))));
  const suspected = new Set(suspectedConflictMateIds);
  const unresolvedMateIds = sortedIds(components.filter((component) => component.status !== 'converged')
    .flatMap((component) => component.mateIds.filter((id) => !proven.has(id) && !suspected.has(id) && violated(id))));
  const convergedMateIds = new Set(components.filter((component) => component.status === 'converged').flatMap((component) => component.mateIds));
  const redundantMateIds = sortedIds([...rowsByMate].filter(([id, mateRows]) => convergedMateIds.has(id) && !branches.has(id)
    && mateRows.every((row) => row.dependency === 'dependent' && row.satisfied === true)).map(([id]) => id));
  const candidates: MateDiagnosisCandidate[] = [
    ...provenConflictMateIds.map((mateId) => ({ mateId, kind: 'provenConflict' as const, normalizedResidual: severity.get(mateId) ?? null })),
    ...suspectedConflictMateIds.map((mateId) => ({ mateId, kind: 'suspectedConflict' as const, normalizedResidual: severity.get(mateId) ?? null })),
    ...unresolvedMateIds.map((mateId) => ({ mateId, kind: 'unresolved' as const, normalizedResidual: severity.get(mateId) ?? null })),
  ];
  candidates.sort((a, b) => Number(b.kind === 'provenConflict') - Number(a.kind === 'provenConflict')
    || (b.normalizedResidual ?? -1) - (a.normalizedResidual ?? -1) || documentOrder(a.mateId, b.mateId));
  const causeCandidates = candidates.slice(0, CONFLICT_REPORT_LIMIT);
  const messages: MateDiagnosisMessage[] = [];
  const add = (code: MateDiagnosisMessageCode, severity: MateDiagnosisMessage['severity'], text: string,
    mateIds: readonly string[] = []) => { messages.push({ code, severity, text, mateIds }); };
  if (remainingDegreesOfFreedom !== null && remainingDegreesOfFreedom > 0) {
    add('remainingDegreesOfFreedom', 'info', remainingMessage(remainingDegreesOfFreedom));
  } else if (remainingDegreesOfFreedom === 0 && complete && outcome.converged) {
    add('fullyConstrained', 'info', remainingMessage(0));
  }
  for (const candidate of causeCandidates) {
    if (candidate.kind === 'provenConflict') add('provenConstantConflict', 'error',
      'この合致は同時には成り立ちません。固定した対象や合致の値を見直してください。', [candidate.mateId]);
    else if (candidate.kind === 'suspectedConflict') add('suspectedConflict', 'warning',
      'この合致がほかの条件と両立しない可能性があります。対象や値を見直してください。', [candidate.mateId]);
  }
  if (redundantMateIds.length > 0) add('redundant', 'info', '同じ条件が重なっています。', redundantMateIds);
  const noVariable = sortedIds(rows.filter((row) => row.dependency === 'noVariable' && row.satisfied === true).map((row) => row.mateId));
  if (noVariable.length > 0) add('noVariable', 'info', '固定した対象間の条件です。', noVariable);
  const stopped = components.filter((component) => component.status === 'iterationLimit');
  if (stopped.some((component) => component.limit === 'time')) add('timeLimit', 'warning', '計算時間の上限に達しました。合致はまだ解けていません。');
  if (stopped.some((component) => component.limit !== 'time')) add('iterationLimit', 'warning', '計算回数の上限に達しました。合致はまだ解けていません。');
  if (components.some((component) => component.status === 'stalled')) add('stalled', 'warning', '計算が進まなくなりました。配置や合致の対象を見直してください。');
  if (outcome.diagnosis.limits.length > 0) add('variableLimit', 'warning', '動かせる部品の数が計算の上限を超えています。');
  for (const skipped of outcome.skipped) add('skippedTarget', 'warning', skipped.message, [skipped.mateId]);
  if (outcome.diagnosis.unsupportedJointIds.length > 0) add('unsupportedJoint', 'warning', 'まだ計算に対応していないジョイントがあります。');
  if (!complete) add('incompleteDiagnosis', 'warning', '診断に必要な情報が揃っていません。未確定の条件があります。');
  return { status: outcome.diagnosis.status, converged: outcome.converged, complete, remainingDegreesOfFreedom,
    components, rows, redundantRowCount: rows.filter((row) => row.dependency === 'dependent').length,
    redundantMateIds, provenConflictMateIds, suspectedConflictMateIds, unresolvedMateIds, causeCandidates,
    skipped: outcome.skipped, unsupportedJointIds: outcome.diagnosis.unsupportedJointIds,
    limits: outcome.diagnosis.limits, branchViolations: outcome.branchViolations, messages };
}
