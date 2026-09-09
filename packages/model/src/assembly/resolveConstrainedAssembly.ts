import { selectMateTargetGeometry, type SolidBody } from '../kernelBridge.js';
import { jointFramePairFromTargets, type JointFramePair } from './joints/jointFrames.js';
import { resolveMateTarget } from './constraints/mateTargets.js';
import type { MateResidualTargetPair } from './constraints/mateResiduals.js';
import { diagnoseMates, solveMates } from './constraints/solveMates.js';
import { resolveAssembly, type ResolveAssemblyOptions, type ResolvedAssembly, type ResolvedSubAssembly } from './resolveAssembly.js';
import type { AssemblyDocument, MateTarget } from './types.js';

export type ConstrainedAssemblyResult = { readonly ok: true; readonly resolved: ResolvedAssembly }
  | { readonly ok: false; readonly reason: 'source' | 'constraints'; readonly messages: readonly string[] };

/** 元文書を変更せず、各階層の合致を解いてから子の配置を親へ合成する。 */
export function resolveConstrainedAssembly(document: AssemblyDocument,
  bodies: ReadonlyMap<string, readonly SolidBody[]>, options: ResolveAssemblyOptions): ConstrainedAssemblyResult {
  let resolved = resolveAssembly(document, options);
  if (resolved.errors.length > 0) return { ok: false, reason: 'source', messages: resolved.errors.map((error) => error.message) };
  const targets = new Map<string, MateResidualTargetPair>();
  const jointFrames = new Map<string, JointFramePair>();
  const resolveTarget = (target: MateTarget) => resolveMateTarget(target, resolved, {
    subShape: (key, ref) => {
      const body = bodies.get(key)?.find((item) => item.featureId === ref.bodyFeatureId);
      return body === undefined ? null : selectMateTargetGeometry(body, ref);
    },
  });
  const messages: string[] = [];
  for (const mate of document.mates.filter((item) => !item.suppressed)) {
    const a = resolveTarget(mate.a), b = resolveTarget(mate.b);
    if (!a.ok) messages.push(a.message);
    if (!b.ok) messages.push(b.message);
    if (a.ok && b.ok) targets.set(mate.id, { a: a.target, b: b.target });
  }
  for (const joint of document.joints.filter((item) => !item.suppressed)) {
    const a = resolveTarget(joint.a), b = resolveTarget(joint.b);
    if (!a.ok) messages.push(a.message);
    if (!b.ok) messages.push(b.message);
    if (a.ok && b.ok) {
      const pair = jointFramePairFromTargets(joint, { a: a.target, b: b.target }, resolved.placements);
      if (pair !== null) jointFrames.set(joint.id, pair);
    }
  }
  if (messages.length > 0) return { ok: false, reason: 'constraints', messages };
  if (document.mates.some((item) => !item.suppressed) || document.joints.some((item) => !item.suppressed)) {
    const outcome = solveMates(document, targets, resolved.placements, { jointFrames });
    const diagnosis = diagnoseMates(document, outcome);
    if (!diagnosis.converged || !diagnosis.complete) return { ok: false, reason: 'constraints', messages: [] };
    resolved = { ...resolved, placements: outcome.placements };
  }
  const subAssemblies = new Map<string, ResolvedSubAssembly>();
  for (const [id, nested] of resolved.subAssemblies ?? []) {
    const parent = resolved.placements.get(id);
    if (parent === undefined) return { ok: false, reason: 'source', messages: [] };
    const next = resolveConstrainedAssembly(nested.assembly, bodies, { ...options, parent,
      depth: (options.depth ?? 0) + 1, ancestors: [...(options.ancestors ?? []), nested.assemblyRef] });
    if (!next.ok) return next;
    subAssemblies.set(id, { ...nested, placement: parent, resolved: next.resolved });
  }
  return { ok: true, resolved: { ...resolved, subAssemblies } };
}
