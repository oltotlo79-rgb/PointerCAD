/**
 * Native numerical material admission (AUTHOR-ONLY, UNEXECUTED candidate; GO-17 successor of nativeMaterialDomain.ts
 * be0408ad, product path packages/kernel/src/occt/nativeMaterialDomain.ts). Extracted from the Root-qualified microtrial
 * observeSameCopy (run 20261012-225024, receipt 5717298e; Astra OPUS-EXTRACTION 2f00fc0c) WITHOUT changing any predicate.
 * Call it on the SAME complete meshed copy that is published, before its owner is released.
 *
 * Conjunction (every part has an observed independent role):
 *  - complete occurrence traversal with cumulative location/orientation (TopoDS_Iterator cumulative flags) and IsSame
 *    duplicate rejection - the ONLY guard that rejects the repeated-solid case (both native checks pass there);
 *  - only COMPOUND/SOLID nodes; every solid has >= 1 shell and every shell is closed; nonempty compounds; >= 1 solid;
 *  - BRepCheck_Analyzer(copy, true, false).IsValid_2();
 *  - BRepAlgoAPI_Check on the WHOLE copy as ONE SetData_1(copy, false, true), sequential: valid, no errors, no warnings,
 *    zero results - the only guard that rejects overlapping / nested-positive solids;
 *  - BRepClass3d_SolidClassifier infinite point OUT for EVERY solid at Precision.Confusion - the only guard that rejects
 *    the reversed box (both native checks pass there); the shape is never normalized to FORWARD.
 * Unknown states, warnings and invalid tolerances are failures. Signed volume is NOT measured here (diagnostic only,
 * never an admission predicate). Result semantics: numerical native validation under the recorded tolerances only.
 * It is not exact winding, mesh-to-CAD distance, volume bound, coverage or topology; those flags stay literal false.
 *
 * Resources (GO-17, Sol findings-r1): ONE cumulative occurrence budget covers the root, every retained compound child and
 * every retained solid child (shell). Before each iterator.Value() is retained, the caller's checkpoint runs and one unit
 * is reserved; an exceeded budget throws NativeMaterialCapacityError before the excess handle exists. No array is
 * preallocated from a native count. The checkpoint also runs before and after every synchronous native call; those
 * calls are NOT interruptible from JavaScript, so a deadline is observed only at these boundaries. Checkpoint exceptions
 * (cancellation, deadline) propagate with their own identity; nothing here catches them.
 */
import type { OpenCascadeInstance, TopAbs_State, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { Allocations } from './allocations.js';

export type NativeState = 'IN' | 'OUT' | 'ON' | 'UNKNOWN';

export interface NativeMaterialAdmission {
  readonly schema: 'pointercad-native-material-admission/1';
  readonly analyzerValid: boolean;
  readonly advancedValid: boolean;
  readonly advancedErrors: boolean;
  readonly advancedWarnings: boolean;
  readonly advancedResultCount: number;
  readonly fuzzyValue: number;
  readonly classificationTolerance: number;
  readonly infinity: readonly NativeState[];
  readonly shells: readonly number[];
  readonly structuralProblems: readonly string[];
  /** Occurrence units reserved (root + retained compound children + retained shells); always <= the budget. */
  readonly occurrencesReserved: number;
  /** True only when the full conjunction above holds. Numerical native validation, not a certificate. */
  readonly nativeChecksPass: boolean;
  readonly globalCertified: false;
  readonly materialVolumeCertified: false;
  readonly topologyCertified: false;
}

/** The explicit traversal capacity was exceeded; the shape is refused, never truncated. */
export class NativeMaterialCapacityError extends Error {
  override readonly name = 'NativeMaterialCapacityError';
}

/**
 * Explicit traversal capacity derived from the caller's existing triangle cap: 4 occurrence units (compound children,
 * solids and shells together) per allowed triangle. This is a capacity, not a proof that every mesher-acceptable shape
 * fits: a shape needing more units (for example a deep single-child compound chain) is REFUSED with
 * NativeMaterialCapacityError. The product must be a safe integer; no limit is raised to make it fit.
 */
export function maximumOccurrencesForTriangleCap(triangleCap: number): number {
  if (!Number.isSafeInteger(triangleCap) || triangleCap < 1) throw new NativeMaterialCapacityError('native-material: invalid triangle capacity');
  const occurrences = 4 * triangleCap;
  if (!Number.isSafeInteger(occurrences)) throw new NativeMaterialCapacityError('native-material: occurrence capacity is not a safe integer');
  return occurrences;
}

function stateName(oc: OpenCascadeInstance, value: TopAbs_State): NativeState {
  if (value === oc.TopAbs_State.TopAbs_IN) return 'IN';
  if (value === oc.TopAbs_State.TopAbs_OUT) return 'OUT';
  if (value === oc.TopAbs_State.TopAbs_ON) return 'ON';
  return 'UNKNOWN';
}

/** Shared cumulative reservation: checkpoint first, then reserve, then (only then) may the caller retain a handle. */
class OccurrenceBudget {
  reserved = 0;
  constructor(private readonly maximum: number, readonly checkpoint: () => void) {}
  reserve(): void {
    this.checkpoint();
    if (this.reserved >= this.maximum) throw new NativeMaterialCapacityError('native-material: shape occurrence capacity exceeded');
    this.reserved += 1;
  }
}

function solidOccurrences(oc: OpenCascadeInstance, shape: TopoDS_Shape, owner: Allocations, problems: string[],
  budget: OccurrenceBudget): TopoDS_Shape[] {
  budget.reserve();
  const pending = [shape];
  const solids: TopoDS_Shape[] = [];
  while (pending.length > 0) {
    budget.checkpoint();
    const next = pending.pop();
    if (next === undefined || next.IsNull()) throw new Error('native-material: null native occurrence');
    if (next.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
      if (solids.some(previous => previous.IsSame(next))) problems.push('duplicate-solid-occurrence');
      solids.push(next);
    } else if (next.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND) {
      // cumOri = true, cumLoc = true: accumulated placement/orientation of every child occurrence is retained.
      const iterator = owner.keep(new oc.TopoDS_Iterator_2(next, true, true));
      let children = 0;
      for (; iterator.More(); iterator.Next()) {
        budget.reserve();
        pending.push(owner.keep(iterator.Value()));
        children += 1;
      }
      if (children === 0) problems.push('empty-compound');
    } else problems.push('unsupported-non-solid-leaf');
  }
  if (solids.length === 0) problems.push('no-solid');
  return solids;
}

/**
 * Same native calls and settings as the qualified microtrial; owner is the caller's allocation owner of the meshed copy.
 * maximumOccurrences is the cumulative budget (see maximumOccurrencesForTriangleCap); checkpoint is the caller's real
 * request deadline/cancellation check and must throw to stop.
 */
export function admitNativeMaterialDomain(oc: OpenCascadeInstance, copy: TopoDS_Shape, owner: Allocations,
  maximumOccurrences: number, checkpoint: () => void): NativeMaterialAdmission {
  if (!Number.isSafeInteger(maximumOccurrences) || maximumOccurrences < 1) throw new NativeMaterialCapacityError('native-material: invalid occurrence capacity');
  const budget = new OccurrenceBudget(maximumOccurrences, checkpoint);
  const structuralProblems: string[] = [];
  const solids = solidOccurrences(oc, copy, owner, structuralProblems, budget);
  checkpoint();
  const analyzer = owner.keep(new oc.BRepCheck_Analyzer(copy, true, false));
  checkpoint();
  const analyzerValid = analyzer.IsValid_2();
  checkpoint();
  const check = owner.keep(new oc.BRepAlgoAPI_Check_1());
  check.SetRunParallel(false);
  // One complete compound: SetData_2 would check operands separately and lose the material-union discrimination.
  check.SetData_1(copy, false, true);
  check.Perform(owner.keep(new oc.Message_ProgressRange_1()));
  checkpoint();
  const advancedValid = check.IsValid();
  const advancedErrors = check.HasErrors();
  const advancedWarnings = check.HasWarnings();
  const advancedResultCount = owner.keep(check.Result()).Size();
  const fuzzyValue = check.FuzzyValue();
  const classificationTolerance = oc.Precision.Confusion();
  if (!Number.isFinite(classificationTolerance) || !(classificationTolerance > 0)) throw new Error('native-material: invalid native confusion');
  if (!Number.isFinite(fuzzyValue) || fuzzyValue < 0) throw new Error('native-material: invalid native fuzzy value');
  const infinity: NativeState[] = [];
  const shells: number[] = [];
  for (const solid of solids) {
    checkpoint();
    const iterator = owner.keep(new oc.TopoDS_Iterator_2(solid, true, true));
    let shellCount = 0;
    for (; iterator.More(); iterator.Next()) {
      budget.reserve();
      const child = owner.keep(iterator.Value());
      if (child.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
        structuralProblems.push('non-shell-solid-child');
        continue;
      }
      shellCount += 1;
      if (!oc.BRep_Tool.IsClosed_1(child)) structuralProblems.push('open-shell');
    }
    if (shellCount === 0) structuralProblems.push('solid-without-shell');
    shells.push(shellCount);
    checkpoint();
    const classifier = owner.keep(new oc.BRepClass3d_SolidClassifier_2(solid));
    checkpoint();
    classifier.PerformInfinitePoint(classificationTolerance);
    checkpoint();
    infinity.push(stateName(oc, classifier.State()));
  }
  checkpoint();
  return {
    schema: 'pointercad-native-material-admission/1',
    analyzerValid, advancedValid, advancedErrors, advancedWarnings, advancedResultCount, fuzzyValue, classificationTolerance,
    infinity, shells, structuralProblems, occurrencesReserved: budget.reserved,
    nativeChecksPass: structuralProblems.length === 0 && analyzerValid && advancedValid && !advancedErrors
      && !advancedWarnings && advancedResultCount === 0 && infinity.length === solids.length && infinity.every(state => state === 'OUT'),
    globalCertified: false, materialVolumeCertified: false, topologyCertified: false,
  };
}
