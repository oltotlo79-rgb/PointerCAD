/**
 * 平面から安全柵(E-12 第 1 段)を置く。柱(断面の向きごとの組)と横の材は一括配置の道(`frameMembersDocument`)で、パネルは板の族の
 * 部品(幅・高さを欄に入れる)で、全部を 1 つの文書にしてから 1 回で入れる(元に戻す 1 回で全部戻る)。選ぶ窓は開いたままにする。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { addComponent, createComponentFor, type AssemblyDocument, type FrameLine, type Vec3 } from '@pointercad/model';

import { useAppStore } from '../store/useAppStore.js';
import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
import { frameMembersDocument, type FrameMembersRequest } from './frameMembersPlacement.js';
import { FENCE_PANEL_FAMILY, type SafetyFenceRequest } from './safetyFenceInput.js';

type SafetyFencePlacement =
  | { readonly ok: true; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'unavailable' | 'invalidOption' };

const NO_CORNERS = { quarterTurns: 0, startExtension: 0, endExtension: 0, corners: 'none', swapThrough: [] } as const;

/** 柵の部品を全部足した文書。1 つでも作れなければ何も置かずに理由。 */
function safetyFenceDocument(assembly: AssemblyDocument, request: SafetyFenceRequest):
{ readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] } | { readonly ok: false } {
  let document = assembly;
  const componentIds: string[] = [];
  const place = (members: FrameMembersRequest): boolean => {
    const placed = frameMembersDocument(document, members);
    if (!placed.ok) return false;
    document = placed.document;
    componentIds.push(...placed.componentIds);
    return true;
  };
  // 柱は断面の局所 +Y を向ける向きごとに 1 回(一括配置の上の向きは 1 回に 1 つ)。
  const groups = new Map<string, { readonly up: Vec3; readonly lines: FrameLine[] }>();
  for (const post of request.plan.posts) {
    const key = post.up.join(',');
    let group = groups.get(key);
    if (group === undefined) {
      group = { up: post.up, lines: [] };
      groups.set(key, group);
    }
    group.lines.push(post.line);
  }
  for (const group of groups.values()) if (!place({ member: request.post, lines: group.lines, up: group.up, ...NO_CORNERS })) return { ok: false };
  if (request.plan.rails.length > 0 && !place({ member: request.rail, lines: request.plan.rails, up: [0, 0, 1], ...NO_CORNERS })) return { ok: false };
  // パネルは区画ごとの指定を当てた後の物(第 3 段。板の行と置き方は区画ごと)。
  for (const panel of request.panels) {
    const committed = commitCatalogItemChoice(FENCE_PANEL_FAMILY, panel.itemKey, { width: String(panel.width), height: String(panel.height) });
    if (!committed.ok) return { ok: false };
    const [x, y, z] = panel.placement.position;
    const component = createComponentFor(document, committed.value.source, { partName: committed.value.name, placement: {
      position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: panel.placement.rotation } });
    document = addComponent(document, committed.value.materialId === undefined ? component : { ...component, materialId: committed.value.materialId });
    componentIds.push(component.id);
  }
  // 足(第 2 段): 柱の下の床の点に、回さずに置く(足の板・アジャスターの形は外形の中心が原点で、下の面が z = 0)。
  for (const point of request.foot === null ? [] : request.plan.feet) {
    const foot = request.foot;
    if (foot === null) break;
    const committed = commitCatalogItemChoice(foot.familyId, foot.itemKey, {});
    if (!committed.ok) return { ok: false };
    const component = createComponentFor(document, committed.value.source, { partName: committed.value.name, placement: {
      position: [expressionValueFromNumber(point[0]), expressionValueFromNumber(point[1]), expressionValueFromNumber(point[2])],
      rotation: [0, 0, 0, 1] } });
    document = addComponent(document, committed.value.materialId === undefined ? component : { ...component, materialId: committed.value.materialId });
    componentIds.push(component.id);
  }
  return { ok: true, document, componentIds };
}

/** 柵を 1 回で置き、置いた部品を選び、選ぶ窓を残す(文書を入れると窓が閉じるため)。 */
export function placeSafetyFence(request: SafetyFenceRequest): SafetyFencePlacement {
  const state = useAppStore.getState();
  if (state.assembly === null || state.isComputing) return { ok: false, reason: 'unavailable' };
  const built = safetyFenceDocument(state.assembly, request);
  if (!built.ok) return { ok: false, reason: 'invalidOption' };
  const pickerOpen = state.standardPartPickerOpen;
  state.applyAssembly(built.document);
  useAppStore.getState().setSelection(built.componentIds);
  if (pickerOpen) useAppStore.setState({ standardPartPickerOpen: true });
  return { ok: true, componentIds: built.componentIds };
}
