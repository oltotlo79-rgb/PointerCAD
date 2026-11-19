/**
 * 一括配置・一筆書きで並べた部材に付属の組を付ける(A2)。端は accessoryChoice.ts の `exposedEnds` で部材ごとに決め、付ける端の無い部材は飛ばす。
 * 1 本でも付けられない時は、何も置かずに理由と線の番号を返す(並べた部材だけ残して付属が欠けた形にしない)。元に戻す 1 回で全部戻る
 * (呼ぶ側の frameMembersDocument が、部材と付属を 1 つの文書で返す)。
 */
import {
  applyAccessorySet, type AccessoryEndReference, type AccessoryRefusal, type AccessorySetId, type AssemblyDocument, type FrameLine,
  type FrameMembersResult,
} from '@pointercad/model';

import { exposedEnds } from './accessoryChoice.js';

/** 並べる時の付属の指定(組・線の端の意味・行)。端は部材ごとに決める。 */
export interface FrameAccessoryRequest {
  readonly setId: AccessorySetId;
  readonly endReference: AccessoryEndReference;
  readonly itemKey: string;
}

type FramePlan = Extract<FrameMembersResult, { readonly ok: true }>;

export function withFrameAccessories(document: AssemblyDocument, lines: readonly FrameLine[], plan: FramePlan,
  componentIds: readonly string[], request: FrameAccessoryRequest):
  | { readonly ok: true; readonly document: AssemblyDocument; readonly accessoryIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'accessoryRefused'; readonly detail: AccessoryRefusal; readonly lineIndex: number } {
  const ends = exposedEnds(lines, plan);
  let next = document;
  const accessoryIds: string[] = [];
  for (const [index, member] of plan.members.entries()) {
    const memberEnds = ends[index] ?? null;
    const componentId = componentIds[index];
    if (memberEnds === null || componentId === undefined) continue;
    const applied = applyAccessorySet(next, componentId, request.setId,
      { ends: memberEnds, endReference: request.endReference, itemKey: request.itemKey });
    if (!applied.ok) return { ok: false, reason: 'accessoryRefused', detail: applied.reason, lineIndex: member.lineIndex };
    next = applied.value.document;
    accessoryIds.push(...applied.value.componentIds);
  }
  return { ok: true, document: next, accessoryIds };
}
