/** 部品の差し替えを予告してから一度に適用する純関数(FR-614、P7 §2.11)。 */
import { resolveReplacementSubShapeReference, type SolidBody, type SubShapeReferenceResolution } from '../kernelBridge.js';
import { fingerprintKeyText, type SubShapeRef } from '../geometry/subShapeRef.js';
import { replaceComponent as replaceComponentRecord } from './assemblyEdit.js';
import type {
  AssemblyDocument, ComponentSource, Joint, Mate, MateTarget,
} from './types.js';

/** 新しい部品を再計算した結果。形の作成は呼び出し側が先に済ませる。 */
export interface ReplacementResolvedData {
  readonly bodies: readonly SolidBody[];
}

/** 予告と確定の間で持つ、不変な差し替え計画。 */
export interface ReplacementPlan {
  readonly before: AssemblyDocument;
  readonly after: AssemblyDocument;
  readonly componentId: string;
  readonly nextSource: ComponentSource;
  readonly matchedCount: number;
  readonly unmatchedCount: number;
  readonly affectedCount: number;
  /** 選び直せず、古い指紋を残した合致・ジョイント。 */
  readonly unresolvedIds: readonly string[];
}

interface RematchedTarget {
  readonly target: MateTarget;
  readonly affected: boolean;
  readonly matched: boolean;
}

type ResolveReplacementReference = (reference: SubShapeRef) => SubShapeReferenceResolution;

function rematchTarget(
  target: MateTarget,
  componentId: string,
  resolveReference: ResolveReplacementReference,
): RematchedTarget {
  if (target.componentId !== componentId) {
    return { target, affected: false, matched: true };
  }
  if (target.kind === 'origin') {
    return { target, affected: true, matched: true };
  }
  const resolution = resolveReference(target.ref);
  return resolution.status !== 'matched'
    ? { target, affected: true, matched: false }
    : { target: { ...target, ref: resolution.match.reference }, affected: true, matched: true };
}

function rematchMate(
  item: Mate,
  componentId: string,
  resolveReference: ResolveReplacementReference,
): { readonly item: Mate; readonly affected: boolean; readonly matched: boolean } {
  const a = rematchTarget(item.a, componentId, resolveReference);
  const b = rematchTarget(item.b, componentId, resolveReference);
  return {
    item: a.target === item.a && b.target === item.b ? item : { ...item, a: a.target, b: b.target },
    affected: a.affected || b.affected,
    matched: a.matched && b.matched,
  };
}

function rematchJoint(
  item: Joint,
  componentId: string,
  resolveReference: ResolveReplacementReference,
): { readonly item: Joint; readonly affected: boolean; readonly matched: boolean } {
  const a = rematchTarget(item.a, componentId, resolveReference);
  const b = rematchTarget(item.b, componentId, resolveReference);
  return {
    item: a.target === item.a && b.target === item.b ? item : { ...item, a: a.target, b: b.target },
    affected: a.affected || b.affected,
    matched: a.matched && b.matched,
  };
}

/**
 * 差し替え後の文書と、指紋を選び直せた本数を作る。元の文書は一切書き換えない。
 * 部品が無ければ `null`。選び直せなかった参照は消さず、古い指紋のまま残す。
 */
export function planReplacement(
  assembly: AssemblyDocument,
  componentId: string,
  nextPart: ComponentSource,
  resolved: ReplacementResolvedData,
): ReplacementPlan | null {
  const component = assembly.components.find((candidate) => candidate.id === componentId);
  if (component === undefined) return null;

  const references = new Map<string, SubShapeReferenceResolution>();
  const resolveReference: ResolveReplacementReference = (reference) => {
    const key = fingerprintKeyText(reference), cached = references.get(key);
    if (cached !== undefined) return { ...cached, originalReference: reference };
    const resolution = resolveReplacementSubShapeReference(resolved.bodies, reference);
    references.set(key, resolution);
    return resolution;
  };

  let matchedCount = 0;
  let unmatchedCount = 0;
  const unresolvedIds: string[] = [];
  const count = (id: string, affected: boolean, matched: boolean): void => {
    if (!affected) return;
    if (matched) matchedCount += 1;
    else {
      unmatchedCount += 1;
      unresolvedIds.push(id);
    }
  };
  const mates = assembly.mates.map((mate) => {
    const result = rematchMate(mate, componentId, resolveReference);
    count(mate.id, result.affected, result.matched);
    return result.item;
  });
  const joints = assembly.joints.map((joint) => {
    const result = rematchJoint(joint, componentId, resolveReference);
    count(joint.id, result.affected, result.matched);
    return result.item;
  });
  const replaced = replaceComponentRecord(assembly, componentId, { ...component, source: nextPart });
  const after = { ...replaced, mates, joints };
  return {
    before: assembly,
    after,
    componentId,
    nextSource: nextPart,
    matchedCount,
    unmatchedCount,
    affectedCount: matchedCount + unmatchedCount,
    unresolvedIds,
  };
}

/** 予告済みの差し替えを Undo 1 段へ渡せる 1 文書として確定する。 */
export function applyReplacement(plan: ReplacementPlan): AssemblyDocument {
  return plan.after;
}
