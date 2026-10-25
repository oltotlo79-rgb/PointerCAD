import { RigidWorkSequence } from './constraints/cooperativeRigid.js';
import { drainRigidSteps, UNLIMITED_RIGID_WORK, type RigidWorkBudget, type RigidWorkPoint } from './constraints/solveRigid.js';
import { createSubShapeReferenceResolver, type SolidBody } from '../kernelBridge.js';
import { jointFramePairFromTargets, type JointFramePair } from './joints/jointFrames.js';
import { resolveMateTarget } from './constraints/mateTargets.js';
import type { MateResidualTargetPair } from './constraints/mateResiduals.js';
import { diagnoseMatesSteps, solveMatesSteps } from './constraints/solveMates.js';
import { resolveAssembly, type ResolveAssemblyOptions, type ResolvedAssembly, type ResolvedSubAssembly } from './resolveAssembly.js';
import type { AssemblyDocument, MateTarget } from './types.js';

export type ConstrainedAssemblyResult = { readonly ok: true; readonly resolved: ResolvedAssembly }
  | { readonly ok: false; readonly reason: 'source' | 'constraints'; readonly messages: readonly string[] };

/** 元文書を変更せず、各階層の合致を解いてから子の配置を親へ合成する。 */
export function resolveConstrainedAssembly(document: AssemblyDocument,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, options: ResolveAssemblyOptions): ConstrainedAssemblyResult;
/** A supplied work budget selects cooperative steps through the existing public entry point. */
export function resolveConstrainedAssembly(document: AssemblyDocument,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, options: ResolveAssemblyOptions,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, ConstrainedAssemblyResult, void>;
export function resolveConstrainedAssembly(document: AssemblyDocument,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, options: ResolveAssemblyOptions,
  budget?: RigidWorkBudget): ConstrainedAssemblyResult | Generator<RigidWorkPoint, ConstrainedAssemblyResult, void> {
  const steps = resolveConstrainedAssemblySteps(document, bodies, options, budget ?? UNLIMITED_RIGID_WORK);
  return budget === undefined ? drainRigidSteps(steps) : steps;
}

function* resolveConstrainedAssemblySteps(document: AssemblyDocument,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, options: ResolveAssemblyOptions,
  budget: RigidWorkBudget): Generator<RigidWorkPoint, ConstrainedAssemblyResult, void> {
  const work = new RigidWorkSequence(budget);
  yield* work.boundary();
  let resolved = resolveAssembly(document, options);
  if (resolved.errors.length > 0) return { ok: false, reason: 'source', messages: resolved.errors.map((error) => error.message) };
  const targets = new Map<string, MateResidualTargetPair>();
  const jointFrames = new Map<string, JointFramePair>();
  const resolveReference = createSubShapeReferenceResolver();
  const resolveTarget = (target: MateTarget) => resolveMateTarget(target, resolved, {
    subShape: (key, ref) => {
      const body = bodies.get(key)?.find((item) => item.featureId === ref.bodyFeatureId);
      const resolution = body === undefined ? null : resolveReference(body, ref);
      return resolution?.status === 'matched' ? resolution.match.geometry : null;
    },
  });
  const messages: string[] = [];
  for (const mate of document.mates.filter((item) => !item.suppressed)) {
    const a = resolveTarget(mate.a), b = resolveTarget(mate.b);
    if (!a.ok) messages.push(a.message);
    if (!b.ok) messages.push(b.message);
    if (a.ok && b.ok) targets.set(mate.id, { a: a.target, b: b.target });
    yield* work.checkpoint();
  }
  for (const joint of document.joints.filter((item) => !item.suppressed)) {
    const a = resolveTarget(joint.a), b = resolveTarget(joint.b);
    if (!a.ok) messages.push(a.message);
    if (!b.ok) messages.push(b.message);
    if (a.ok && b.ok) {
      const pair = jointFramePairFromTargets(joint, { a: a.target, b: b.target }, resolved.placements);
      if (pair !== null) jointFrames.set(joint.id, pair);
    }
    yield* work.checkpoint();
  }
  if (messages.length > 0) return { ok: false, reason: 'constraints', messages };
  if (document.mates.some((item) => !item.suppressed) || document.joints.some((item) => !item.suppressed)) {
    const outcome = yield* work.forward(solveMatesSteps(document, targets, resolved.placements, { jointFrames }, budget));
    const diagnosis = yield* work.forward(diagnoseMatesSteps(document, outcome, budget));
    if (!diagnosis.converged || !diagnosis.complete) return { ok: false, reason: 'constraints', messages: [] };
    resolved = { ...resolved, placements: outcome.placements };
  }
  const subAssemblies = new Map<string, ResolvedSubAssembly>();
  for (const [id, nested] of resolved.subAssemblies ?? []) {
    const parent = resolved.placements.get(id);
    if (parent === undefined) return { ok: false, reason: 'source', messages: [] };
    const next = yield* work.forward(resolveConstrainedAssemblySteps(nested.assembly, bodies, { ...options, parent,
      depth: (options.depth ?? 0) + 1, ancestors: [...(options.ancestors ?? []), nested.assemblyRef] }, budget));
    if (!next.ok) return next;
    subAssemblies.set(id, { ...nested, placement: parent, resolved: next.resolved });
  }
  yield* work.boundary();
  return { ok: true, resolved: { ...resolved, subAssemblies } };
}
