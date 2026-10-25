import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { jointOccurrencePath } from '../jointOccurrence.js';
import { assemblyExpressionContext, MAX_SUB_ASSEMBLY_DEPTH } from '../resolveAssembly.js';
import type { AssemblyDocument } from '../types.js';
import type { CrossLevelGearCoupling, CrossLevelGearFailureCode } from './crossLevelGear.js';

/**
 * Saved cross-level gear (EX12): the authored definition behind CrossLevelGearCoupling (crossLevelGear.ts). Like the
 * same-level MechanismGearCoupling it stores expressions (ratio, phase) and ids only, never a solved angle or pose.
 * `childPath` is the typed occurrence path from the top-level component down to the subassembly placement that owns
 * `childJointId` (component ids, never a flattened row id), so repeated placements of one child stay distinct.
 */
export interface CrossLevelGearCouplingDefinition {
  readonly id: string;
  readonly kind: 'crossLevelGear';
  readonly parentJointId: string;
  readonly childPath: readonly string[];
  readonly childJointId: string;
  /** thetaChild = ratio * thetaParent + phaseDeg (degrees). */
  readonly ratio: ExpressionValue;
  readonly phaseDeg: ExpressionValue;
  readonly suppressed: boolean;
}

/** The saved kinds (the file reader's readLiteral list). */
export const CROSS_LEVEL_GEAR_KINDS: readonly CrossLevelGearCouplingDefinition['kind'][] = ['crossLevelGear'];

export type CrossLevelGearDocumentFailureCode = CrossLevelGearFailureCode | 'invalid-expression' | 'invalid-id';

export interface CrossLevelGearDocumentFailure {
  readonly couplingId: string;
  readonly code: CrossLevelGearDocumentFailureCode;
}

const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value);
const failure = (couplingId: string, code: CrossLevelGearDocumentFailureCode): CrossLevelGearDocumentFailure => ({ couplingId, code });

/** Evaluates the authored expressions of the active definitions; a bad expression is a refusal, never a stale number. */
export function evaluateCrossLevelGearCouplings(document: AssemblyDocument):
  { readonly ok: true; readonly couplings: readonly CrossLevelGearCoupling[] } | ({ readonly ok: false } & CrossLevelGearDocumentFailure) {
  const context = assemblyExpressionContext(document), couplings: CrossLevelGearCoupling[] = [];
  for (const c of document.crossLevelGearCouplings ?? []) {
    if (c.suppressed) continue;
    const ratio = evaluateExpression(c.ratio.source, context), phase = evaluateExpression(c.phaseDeg.source, context);
    if (!ratio.ok || !phase.ok || !finite(ratio.value.value) || !finite(phase.value.value)) {
      return { ok: false, ...failure(c.id, 'invalid-expression') };
    }
    couplings.push({ id: c.id, parentJointId: c.parentJointId, child: { path: [...c.childPath], jointId: c.childJointId },
      ratio: ratio.value.value, phaseDeg: phase.value.value });
  }
  return { ok: true, couplings };
}

/**
 * What one document can check on its own (the file reader and every edit): ids, expressions, the parent joint, the
 * first path element and the supported graph. Suppressed definitions keep their references checked but take no part
 * in the active graph, like suppressed same-level gears.
 */
export function crossLevelGearDocumentFailure(document: AssemblyDocument): CrossLevelGearDocumentFailure | null {
  const definitions = document.crossLevelGearCouplings ?? [];
  if (definitions.length === 0) return null;
  const otherIds = new Set([...(document.mechanismCouplings ?? []).map(c => c.id), ...(document.camCouplings ?? []).map(c => c.id)]);
  const coupledJoints = new Set([
    ...(document.mechanismCouplings ?? []).filter(c => !c.suppressed).flatMap(c => [c.jointAId, c.jointBId]),
    ...(document.camCouplings ?? []).filter(c => !c.suppressed).flatMap(c => [c.camJointId, c.followerJointId]),
  ]);
  const context = assemblyExpressionContext(document);
  const ids = new Set<string>(), occurrences = new Set<string>();
  for (const c of definitions) {
    if (c.id.length === 0 || otherIds.has(c.id)) return failure(c.id, 'invalid-id');
    if (ids.has(c.id)) return failure(c.id, 'duplicate-coupling');
    ids.add(c.id);
    const ratio = evaluateExpression(c.ratio.source, context), phase = evaluateExpression(c.phaseDeg.source, context);
    if (!ratio.ok || !phase.ok) return failure(c.id, 'invalid-expression');
    if (!finite(ratio.value.value) || ratio.value.value === 0) return failure(c.id, 'invalid-ratio');
    if (!finite(phase.value.value)) return failure(c.id, 'invalid-phase');
    if (!finite(1 / ratio.value.value) || !finite(-phase.value.value / ratio.value.value)) return failure(c.id, 'unrepresentable-coupling');
    const parents = document.joints.filter(joint => joint.id === c.parentJointId);
    if (parents.length === 0) return failure(c.id, 'missing-parent-joint');
    if (parents.length > 1) return failure(c.id, 'duplicate-parent-joint');
    if (parents[0]?.kind !== 'revolute') return failure(c.id, 'unsupported-parent-joint');
    const path = jointOccurrencePath(c.childPath);
    if (path === null) return failure(c.id, 'invalid-path');
    if (path.length > MAX_SUB_ASSEMBLY_DEPTH) return failure(c.id, 'depth-exceeded');
    if (c.childJointId.length === 0) return failure(c.id, 'missing-child-joint');
    const tops = document.components.filter(component => component.id === path[0]);
    if (tops.length === 0) return failure(c.id, 'missing-component');
    if (tops.length > 1) return failure(c.id, 'ambiguous-component');
    if (tops[0]?.source.kind !== 'subAssembly') return failure(c.id, 'not-subassembly');
    if (c.suppressed) continue;
    if (parents[0].suppressed) return failure(c.id, 'missing-parent-joint');
    if (coupledJoints.has(c.parentJointId)) return failure(c.id, 'coupled-parent-joint');
    const key = JSON.stringify(path);
    if (occurrences.has(key)) return failure(c.id, 'duplicate-occurrence');
    occurrences.add(key);
  }
  return null;
}

/**
 * The rest, which needs the embedded child assemblies (file reader after the subassemblies are collected): every
 * path element is one subassembly component of the document it walks through, without cycles, and the child joint is
 * one revolute joint of the last child (not suppressed while the coupling is active).
 */
export function crossLevelGearTreeFailure(document: AssemblyDocument,
  assemblies: ReadonlyMap<string, AssemblyDocument>): CrossLevelGearDocumentFailure | null {
  const local = crossLevelGearDocumentFailure(document);
  if (local !== null) return local;
  for (const c of document.crossLevelGearCouplings ?? []) {
    let current = document;
    const ancestors = new Set<string>();
    for (const id of c.childPath) {
      const matches = current.components.filter(component => component.id === id);
      const component = matches[0];
      if (component === undefined) return failure(c.id, 'missing-component');
      if (matches.length > 1) return failure(c.id, 'ambiguous-component');
      if (component.source.kind !== 'subAssembly') return failure(c.id, 'not-subassembly');
      const ref = component.source.assemblyRef;
      if (ancestors.has(ref)) return failure(c.id, 'cyclic-path');
      ancestors.add(ref);
      const child = assemblies.get(ref);
      if (child === undefined) return failure(c.id, 'missing-subassembly');
      current = child;
    }
    const joints = current.joints.filter(joint => joint.id === c.childJointId);
    const joint = joints[0];
    if (joint === undefined || joints.length > 1 || (!c.suppressed && joint.suppressed)) return failure(c.id, 'missing-child-joint');
    if (joint.kind !== 'revolute') return failure(c.id, 'unsupported-child-joint');
  }
  return null;
}

/** What an edit did to one saved cross-level gear: made inactive (kept, can be re-activated) or removed. */
export interface CrossLevelGearRepair extends CrossLevelGearDocumentFailure {
  readonly action: 'suspended' | 'removed';
}

/**
 * Keeps the saved cross-level gears of an edited document readable (every edit commits through this, in the same Undo
 * step). Each definition is checked in order together with those already kept: a valid one is kept unchanged; one
 * that is valid only when inactive (a suppressed joint, a parent now in a same-level gear, a second relation on one
 * placement) is kept suppressed; one whose references no longer exist (a removed joint, component or subassembly, a
 * changed joint kind, a broken expression) is removed. Every change is reported; a document that needs none is
 * returned as the same object.
 */
export function pruneCrossLevelGears(document: AssemblyDocument, assemblies: ReadonlyMap<string, AssemblyDocument>):
  { readonly document: AssemblyDocument; readonly repairs: readonly CrossLevelGearRepair[] } {
  const definitions = document.crossLevelGearCouplings;
  if (definitions === undefined || definitions.length === 0) return { document, repairs: [] };
  const kept: CrossLevelGearCouplingDefinition[] = [], repairs: CrossLevelGearRepair[] = [];
  const check = (candidate: CrossLevelGearCouplingDefinition) =>
    crossLevelGearTreeFailure({ ...document, crossLevelGearCouplings: [...kept, candidate] }, assemblies);
  for (const c of definitions) {
    const problem = check(c);
    if (problem === null) { kept.push(c); continue; }
    const inactive: CrossLevelGearCouplingDefinition = { ...c, suppressed: true };
    if (!c.suppressed && check(inactive) === null) {
      kept.push(inactive);
      repairs.push({ couplingId: c.id, code: problem.code, action: 'suspended' });
      continue;
    }
    repairs.push({ couplingId: c.id, code: problem.code, action: 'removed' });
  }
  return repairs.length === 0 ? { document, repairs } : { document: { ...document, crossLevelGearCouplings: kept }, repairs };
}
