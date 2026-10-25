import { validPlacement } from '../fastening/frames.js';
import { jointOccurrencePath, type JointOccurrenceFailureCode, type JointOccurrenceInputs, type JointOccurrencePath,
  type JointOccurrenceView } from '../jointOccurrence.js';
import { resolveMateTarget, type ResolveMateTargetOptions } from '../constraints/mateTargets.js';
import type { MateResidualTargetPair } from '../constraints/mateResiduals.js';
import { solveDrivenJointSteps, type SolveDrivenJointOutcome } from '../constraints/solveMates.js';
import { RigidWorkSequence } from '../constraints/cooperativeRigid.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from '../constraints/solveRigid.js';
import type { RigidPlacement } from '../placementMath.js';
import { MAX_SUB_ASSEMBLY_DEPTH, partKeyOf, type ResolvedAssembly } from '../resolveAssembly.js';
import type { AssemblyDocument } from '../types.js';
import type { JointDriveRequest } from './driveJoint.js';
import { jointFramePairFromTargets, type JointFramePair } from './jointFrames.js';

/**
 * Flexible subassembly (EX12): drive one joint of a child assembly inside ONE placement of it.
 *
 * The parent solve keeps every subassembly rigid (resolveAssembly: one rigid body per occurrence) and the child
 * document is shared by all its placements, so this never edits the child or the parent document. It returns the
 * transient world placements of the child's components for the occurrence named by `path` (component ids from the
 * top level down to the subassembly that owns the joint). The child's joint frames are component-local, so the same
 * child document gives the same frames in every placement, while each placement keeps its own values and placements.
 */
export type SubAssemblyJointDriveFailureCode = JointOccurrenceFailureCode | 'missing-joint' | 'solve-failed';

export interface SubAssemblyJointDriveInput {
  readonly inputs: JointOccurrenceInputs;
  readonly view: JointOccurrenceView;
  /** Top-level subassembly id first; the last id is the subassembly occurrence that owns the joint. */
  readonly path: readonly string[];
  readonly request: JointDriveRequest;
  /** The child placements currently shown for this occurrence (an earlier drive); default: the resolved ones. */
  readonly initial?: ReadonlyMap<string, RigidPlacement>;
  /** Sub-shape resolution of the child's mate/joint targets (the view's body resolver); origin targets need none. */
  readonly targetOptions?: ResolveMateTargetOptions;
}

export type SubAssemblyJointDriveOutcome = {
  readonly ok: true;
  readonly path: JointOccurrencePath;
  /** Collision-free key of the occurrence (the path as JSON), shared by no other placement. */
  readonly occurrenceKey: string;
  readonly childDocument: AssemblyDocument;
  /** World placements of the child's components for this occurrence only. */
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly driven: Extract<SolveDrivenJointOutcome, { readonly ok: true }>;
} | { readonly ok: false; readonly code: SubAssemblyJointDriveFailureCode; readonly index: number };

interface SubAssemblyOccurrence {
  readonly path: JointOccurrencePath;
  readonly document: AssemblyDocument;
  readonly resolved: ResolvedAssembly;
}

function failure(code: SubAssemblyJointDriveFailureCode, index: number): { readonly ok: false; readonly code: SubAssemblyJointDriveFailureCode; readonly index: number } {
  return { ok: false, code, index };
}

function samePlacement(a: RigidPlacement, b: RigidPlacement): boolean {
  return a.position.every((value, index) => value === b.position[index]) && a.rotation.every((value, index) => value === b.rotation[index]);
}

/** Same identity checks as resolveJointOccurrence, but every path element (including the last) is a subassembly. */
export function resolveSubAssemblyOccurrence(
  inputs: JointOccurrenceInputs, view: JointOccurrenceView, ids: readonly string[],
): { readonly ok: true; readonly occurrence: SubAssemblyOccurrence } | { readonly ok: false; readonly code: JointOccurrenceFailureCode; readonly index: number } {
  return drainRigidSteps(resolveSubAssemblyOccurrenceSteps(inputs, view, ids, UNLIMITED_RIGID_WORK));
}

/** Scan occurrence identity in bounded steps, including wide documents at every path element. */
export function* resolveSubAssemblyOccurrenceSteps(
  inputs: JointOccurrenceInputs, view: JointOccurrenceView, ids: readonly string[], budget: RigidWorkBudget,
): Generator<RigidWorkPoint, ReturnType<typeof resolveSubAssemblyOccurrence>, void> {
  const work = new RigidWorkSequence(budget);
  if (typeof ids[0] !== 'string' || ids[0].length === 0) return { ok: false, code: 'invalid-path', index: 0 };
  for (const id of ids) {
    yield* work.checkpoint();
    if (typeof id !== 'string' || id.length === 0) return { ok: false, code: 'invalid-path', index: 0 };
  }
  if (inputs.document !== view.source.document || inputs.library !== view.source.library
      || inputs.subAssemblies !== view.source.subAssemblies) return { ok: false, code: 'stale-view', index: 0 };
  if (ids.length > MAX_SUB_ASSEMBLY_DEPTH) return { ok: false, code: 'depth-exceeded', index: MAX_SUB_ASSEMBLY_DEPTH };
  const path = jointOccurrencePath(ids);
  if (path === null) return { ok: false, code: 'invalid-path', index: 0 };
  let document = inputs.document;
  let resolved = view.resolved;
  const ancestors = new Set<string>();
  for (const [index, id] of path.entries()) {
    const matches: AssemblyDocument['components'][number][] = [];
    for (const component of document.components) {
      yield* work.checkpoint();
      if (component.id === id) matches.push(component);
    }
    const component = matches[0];
    if (component === undefined) return { ok: false, code: 'missing-component', index };
    if (matches.length !== 1) return { ok: false, code: 'ambiguous-component', index };
    if (component.suppressed) return { ok: false, code: 'suppressed-component', index };
    if (!validPlacement(component.placement)) return { ok: false, code: 'invalid-placement', index };
    const placement = resolved.placements.get(id);
    if (placement === undefined) return { ok: false, code: 'inconsistent-tree', index };
    if (component.source.kind !== 'subAssembly') return { ok: false, code: 'not-subassembly', index };
    const ref = component.source.assemblyRef;
    if (ancestors.has(ref)) return { ok: false, code: 'cyclic-path', index };
    const child = inputs.subAssemblies.get(ref);
    if (child === undefined) return { ok: false, code: 'missing-subassembly', index };
    const libraryChild = inputs.library.assemblies?.get(ref);
    if (libraryChild !== undefined && libraryChild !== child) return { ok: false, code: 'inconsistent-tree', index };
    const nested = resolved.subAssemblies?.get(id);
    if (nested === undefined || nested.componentId !== id || nested.assemblyRef !== ref || nested.assembly !== child
        || !samePlacement(nested.placement, placement) || resolved.partKeys.get(id) !== partKeyOf(component.source)) {
      return { ok: false, code: 'inconsistent-tree', index };
    }
    if (resolved.errors.length > 0 || nested.resolved.errors.length > 0) return { ok: false, code: 'unresolved-view', index };
    ancestors.add(ref);
    document = child;
    resolved = nested.resolved;
  }
  return { ok: true, occurrence: { path, document, resolved } };
}

/** The child's mate targets and joint frames from its own resolved placements (frames are component-local). */
function* childConstraintsSteps(document: AssemblyDocument, resolved: ResolvedAssembly,
  options: ResolveMateTargetOptions | undefined, work: RigidWorkSequence): Generator<RigidWorkPoint,
  { readonly targets: Map<string, MateResidualTargetPair>; readonly jointFrames: Map<string, JointFramePair> } | null, void> {
  const targets = new Map<string, MateResidualTargetPair>();
  const jointFrames = new Map<string, JointFramePair>();
  for (const mate of document.mates) {
    yield* work.checkpoint();
    if (mate.suppressed) continue;
    const a = resolveMateTarget(mate.a, resolved, options), b = resolveMateTarget(mate.b, resolved, options);
    if (!a.ok || !b.ok) return null;
    targets.set(mate.id, { a: a.target, b: b.target });
  }
  for (const joint of document.joints) {
    yield* work.checkpoint();
    if (joint.suppressed) continue;
    const a = resolveMateTarget(joint.a, resolved, options), b = resolveMateTarget(joint.b, resolved, options);
    if (!a.ok || !b.ok) return null;
    const pair = jointFramePairFromTargets(joint, { a: a.target, b: b.target }, resolved.placements);
    if (pair === null) return null;
    jointFrames.set(joint.id, pair);
  }
  return { targets, jointFrames };
}

/** Shared accounting with the same-level solver; retained under the existing helper name. */
export { RigidWorkSequence as JointDriveWork } from '../constraints/cooperativeRigid.js';

export function solveSubAssemblyJointDrive(input: SubAssemblyJointDriveInput): SubAssemblyJointDriveOutcome {
  return drainRigidSteps(solveSubAssemblyJointDriveSteps(input, UNLIMITED_RIGID_WORK));
}

/** The caller owns cancellation (runCooperative); only a fully drained child produces an outcome. */
export function* solveSubAssemblyJointDriveSteps(input: SubAssemblyJointDriveInput,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, SubAssemblyJointDriveOutcome, void> {
  const work = new RigidWorkSequence(budget);
  yield* work.boundary();
  const found = yield* work.forward(resolveSubAssemblyOccurrenceSteps(input.inputs, input.view, input.path, budget));
  if (!found.ok) return found;
  const { path, document, resolved } = found.occurrence;
  const last = path.length - 1;
  let joint: AssemblyDocument['joints'][number] | undefined;
  for (const item of document.joints) {
    yield* work.checkpoint();
    if (item.id === input.request.jointId && !item.suppressed) { joint = item; break; }
  }
  if (joint === undefined) return failure('missing-joint', last);
  const constraints = yield* childConstraintsSteps(document, resolved, input.targetOptions, work);
  if (constraints === null) return failure('unsupported-geometry', last);
  const initial = input.initial ?? resolved.placements;
  // Every child component must have a shown placement; a foreign or partial map is refused, never mixed.
  for (const id of resolved.placements.keys()) {
    yield* work.checkpoint();
    if (!initial.has(id)) return failure('inconsistent-tree', last);
  }
  if (initial.size !== resolved.placements.size) return failure('inconsistent-tree', last);
  yield* work.boundary();
  const driven = yield* work.forward(solveDrivenJointSteps(document, constraints.targets, initial, input.request,
    { jointFrames: constraints.jointFrames }, budget));
  yield* work.boundary();
  if (!driven.ok) return failure('solve-failed', last);
  return { ok: true, path, occurrenceKey: JSON.stringify(path), childDocument: document, placements: driven.placements, driven };
}
