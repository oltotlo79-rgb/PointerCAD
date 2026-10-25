/**
 * 締結の計画を組立文書へ足す(EX-06)。成功した時だけ新しい文書を1つ返す(Undo 1段)。
 *
 * 計画の後に部品の出どころや配置が変わっていたら足さずに断る(古い計画で別の位置へ置かない)。
 * 足すのは既存の規格部品の出どころ(`createStandardPartSource`)と配置だけで、形は保存しない。
 * 足した部品は固定しない(構造の支えとして自動で接地しない)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import { addComponent, createComponentFor, findComponent } from '../assemblyEdit.js';
import { composePlacement, normalizeQuaternion } from '../placementMath.js';
import { joinRigidGroup } from '../rigidGroups.js';
import { buildStandardPartFromSource, createStandardPartSource } from '../standard/buildStandardPart.js';
import type { AssemblyDocument } from '../types.js';
import { cleanZeroVec3 } from '../../sketch/vec3.js';
import { componentSourceKey, placementFingerprint, rigidPlacementOf } from './frames.js';
import type { BoltedJointPlan, BoltedJointRejection } from './types.js';

export type ApplyBoltedJointResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly document: AssemblyDocument; readonly rejections: readonly BoltedJointRejection[] };

function identityRejections(
  document: AssemblyDocument, plan: BoltedJointPlan, partRevisions: ReadonlyMap<string, string>,
): BoltedJointRejection[] {
  const out: BoltedJointRejection[] = [];
  for (const [componentId, expected] of Object.entries(plan.sourceIdentities)) {
    const component = findComponent(document, componentId);
    if (component === undefined) {
      out.push({ code: 'componentMissing', detail: { componentId } });
      continue;
    }
    if (component.suppressed) {
      out.push({ code: 'componentSuppressed', detail: { componentId } });
      continue;
    }
    const key = componentSourceKey(component, partRevisions);
    if (key === null || `${key}|${placementFingerprint(component.placement)}` !== expected) {
      out.push({ code: 'staleSource', detail: { componentId } });
    }
  }
  for (const [componentId, expected] of Object.entries(plan.alignment.placementFingerprints)) {
    const component = findComponent(document, componentId);
    if (component === undefined || placementFingerprint(component.placement) !== expected) {
      out.push({ code: 'staleSource', detail: { componentId } });
    }
  }
  return out;
}

/** 整列の変位を、動かす組の全部品の保存形の配置へ一度に掛ける(組を 2 重に動かさない)。 */
function alignedDocument(document: AssemblyDocument, plan: BoltedJointPlan): AssemblyDocument {
  const moved = new Set(plan.alignment.movedComponentIds);
  if (moved.size === 0) return document;
  return {
    ...document,
    components: document.components.map((component) => {
      if (!moved.has(component.id)) return component;
      const target = composePlacement(plan.alignment.delta, rigidPlacementOf(component.placement));
      const position = cleanZeroVec3(target.position);
      return { ...component, placement: {
        position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]), expressionValueFromNumber(position[2])],
        rotation: normalizeQuaternion(target.rotation),
      } };
    }),
  };
}

/**
 * 整列・規格部品の追加・互いの固定を 1 つの新しい文書で行う(Undo 1段)。
 * 板と足した部品は同じ組(`rigidGroupId`)に入り、組ごと動く。全体の固定(`fixed`)は変えない。
 */
export function applyBoltedJoint(
  document: AssemblyDocument,
  plan: BoltedJointPlan,
  partRevisions: ReadonlyMap<string, string> = new Map(),
): ApplyBoltedJointResult {
  const stale = identityRejections(document, plan, partRevisions);
  if (stale.length > 0) return { ok: false, document, rejections: stale };
  let next = alignedDocument(document, plan);
  const componentIds: string[] = [];
  for (const operation of plan.operations) {
    const source = createStandardPartSource(operation.catalog, operation.size, operation.options);
    const part = buildStandardPartFromSource(source);
    if (part === null) {
      const code = operation.role === 'nut' ? 'nutRowMissing' : operation.role === 'bolt' ? 'boltRowMissing' : 'washerRowMissing';
      return { ok: false, document, rejections: [{ code, detail: { rowKey: operation.rowKey } }] };
    }
    const component = createComponentFor(next, source, { partName: part.name, placement: operation.placement });
    next = addComponent(next, component);
    componentIds.push(component.id);
  }
  next = joinRigidGroup(next, [plan.headSideComponentId, plan.farSideComponentId, ...componentIds]);
  return { ok: true, document: next, componentIds };
}
