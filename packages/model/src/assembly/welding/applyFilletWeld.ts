/**
 * すみ肉溶接の計画を1つの新しい組立の文書として足す(Undo の1段)。計画の後に出どころ・配置が変わった、置き換える
 * 区間が無くなった計画は、文書を変えずに断る。ビードの区間ごとに、生成した `filletWeld` の部品・明示した材質・
 * 溶接線の座標系での配置を持つ部品を足し、溶接した2部品と全ビードを1つの互いに固定した組にする(ボルト締結と
 * 同じく溶接が部品をつなぐ)。何も新しく固定しない。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import { cleanZeroVec3, addVec3, scaleVec3 } from '../../sketch/vec3.js';
import { addComponent, createComponentFor, findComponent, removeComponent } from '../assemblyEdit.js';
import { nextComponentId } from '../createAssemblyDocument.js';
import { quaternionFromBasis } from '../placementMath.js';
import { joinRigidGroup } from '../rigidGroups.js';
import type { AssemblyDocument, Placement } from '../types.js';
import { componentSourceKey, placementFingerprint } from '../fastening/frames.js';
import { buildFilletWeldPart, createFilletWeldSource } from './filletWeldPart.js';
import { type FilletWeldPlan, type FilletWeldRejection, WELD_DIRECTION_TOLERANCE, type WeldFrame } from './types.js';

export type ApplyFilletWeldResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly document: AssemblyDocument; readonly rejections: readonly FilletWeldRejection[] };

/** 線に沿って `station` mm から始まる区間の配置。局所 X・Y = 脚、局所 Z = 線。 */
export function weldSegmentPlacement(frame: WeldFrame, station: number): Placement | null {
  const rotation = quaternionFromBasis(frame.xAxis, frame.yAxis, frame.zAxis, WELD_DIRECTION_TOLERANCE * 10);
  const position = cleanZeroVec3(addVec3(frame.origin, scaleVec3(frame.zAxis, station)));
  if (rotation === null || !position.every((value) => Number.isFinite(value))) return null;
  return {
    position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]), expressionValueFromNumber(position[2])],
    rotation,
  };
}

export function applyFilletWeld(
  document: AssemblyDocument, plan: FilletWeldPlan, partRevisions: ReadonlyMap<string, string> = new Map(),
): ApplyFilletWeldResult {
  const stale: FilletWeldRejection[] = [];
  for (const [componentId, expected] of Object.entries(plan.sourceIdentities)) {
    const component = findComponent(document, componentId);
    if (component === undefined) { stale.push({ code: 'componentMissing', detail: { componentId } }); continue; }
    if (component.suppressed) { stale.push({ code: 'componentSuppressed', detail: { componentId } }); continue; }
    if (`${componentSourceKey(component, partRevisions) ?? ''}|${placementFingerprint(component.placement)}` !== expected) {
      stale.push({ code: 'staleSource', detail: { componentId } });
    }
  }
  if (stale.length > 0) return { ok: false, document, rejections: stale };
  let next = document;
  for (const componentId of plan.replacedComponentIds) next = removeComponent(next, componentId);
  const componentIds: string[] = [];
  for (const [index, segment] of plan.segments.entries()) {
    const source = createFilletWeldSource(plan.legOnSecond, plan.legOnFirst, {
      weldId: plan.weldId, segment: index, station: segment.start, length: segment.length,
      contactLength: plan.contactLength, parts: [plan.firstComponentId, plan.secondComponentId],
      ...(plan.interiorAngle === null ? {} : { interiorAngleDegrees: plan.interiorAngle.degrees }),
      ...(plan.cylindricalRadius === undefined ? {} : { cylindricalRadius: plan.cylindricalRadius }),
      ...(plan.cylindricalSide === undefined ? {} : { cylindricalSide: plan.cylindricalSide }),
    });
    const part = buildFilletWeldPart(source);
    const placement = weldSegmentPlacement(plan.frame, segment.start);
    if (part === null || placement === null) {
      return { ok: false, document, rejections: [{ code: 'invalidWorldFrame', detail: { weldId: plan.weldId, segment: index } }] };
    }
    // Replaced beads are removed first, so the current-max allocator alone would hand their IDs to the new beads. Reserve
    // every original pre-edit ID and every bead already added in this edit: a replacement never inherits an old identity.
    const reserved: AssemblyDocument = { ...next, components: [...document.components,
      ...next.components.filter((row) => componentIds.includes(row.id))] };
    const component = { ...createComponentFor(next, source, { partName: part.name, placement }),
      id: nextComponentId(reserved), materialId: plan.materialId };
    next = addComponent(next, component);
    componentIds.push(component.id);
  }
  next = joinRigidGroup(next, [plan.firstComponentId, plan.secondComponentId, ...componentIds]);
  return { ok: true, document: next, componentIds };
}

/**
 * 溶接のビードの全区間を1つの新しい文書で消す。溶接した部品の組は残す(ほかの締結も同じ組にいることがあり、
 * 組を解くのは別の明示の操作)。消すものが無ければ同じ文書を返す。
 */
export function removeFilletWeld(document: AssemblyDocument, segmentIds: readonly string[]): AssemblyDocument {
  return segmentIds.reduce((next, componentId) => removeComponent(next, componentId), document);
}
