/**
 * パネルと扉(E-10 第 1 段)の流れ: ビューか木で選んだ部材 4 本の枠から、model の `framePanelOpening` で開口と板の寸法を決め、
 * 注文の寸法の板(幅・高さを欄に入れる)を 1 回で置く(元に戻す 1 回で戻る)。部材の箱は表示中の配置から作る。選ぶ窓は開いたまま。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createComponentFor, framePanelOpening, placedFrameMembers, PRODUCT_CATALOG_REGISTRY, type FramePanelOpeningResult,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

type Opening = Extract<FramePanelOpeningResult, { readonly ok: true }>;

/** 予告(開口と板の寸法)か、作れない理由。 */
type FramePanelPlan = { readonly ok: true; readonly opening: Opening } | { readonly ok: false; readonly reason: string };

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  notFour: 'catalog.framePanel.reason.notFour', notRectangle: 'catalog.framePanel.reason.notRectangle',
  notCoplanar: 'catalog.framePanel.reason.notCoplanar', noRoom: 'catalog.framePanel.reason.noRoom',
  invalidNumber: 'catalog.framePanel.reason.invalidNumber', tooLarge: 'catalog.framePanel.reason.tooLarge',
  unavailable: 'catalog.framePanel.reason.unavailable', noPanel: 'catalog.framePanel.reason.noPanel',
};

/** 理由の文字。 */
export function framePanelReasonText(reason: string): string {
  return t(REASON_KEYS[reason] ?? 'catalog.framePanel.reason.unavailable');
}

/** 今選んでいる部材 4 本の枠に、板の行 itemKey を隙間 gap(mm)ではめる計画。 */
export function framePanelPlan(itemKey: string | null, gap: number): FramePanelPlan {
  const state = useAppStore.getState();
  const assembly = state.assembly, view = state.assemblyView;
  if (assembly === null || view === null || view.sourceDocument !== assembly) return { ok: false, reason: 'unavailable' };
  const family = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY);
  const row = itemKey === null ? undefined : family?.rows.find((candidate) => candidate.key === itemKey);
  const thickness = row?.dims.thickness;
  if (family === undefined || row === undefined || thickness === undefined) return { ok: false, reason: 'noPanel' };
  const selected = new Set(state.selection);
  const members = placedFrameMembers(assembly, view.resolved.placements).filter((member) => selected.has(member.componentId));
  if (members.length !== state.selection.length) return { ok: false, reason: 'notFour' };
  const opening = framePanelOpening(members, { thickness, gap });
  if (!opening.ok) return opening;
  if (family.build(row, { width: String(opening.width), height: String(opening.height) }) === null) return { ok: false, reason: 'tooLarge' };
  return { ok: true, opening };
}

/** 計画の板を 1 回で置き、置いた板を選び、選ぶ窓を残す。置いた部品の id か理由。 */
export function placeFramePanel(itemKey: string | null, gap: number): { readonly ok: true; readonly componentId: string }
| { readonly ok: false; readonly reason: string } {
  const plan = framePanelPlan(itemKey, gap);
  const state = useAppStore.getState();
  if (!plan.ok || state.assembly === null || itemKey === null) return plan.ok ? { ok: false, reason: 'unavailable' } : plan;
  const committed = commitCatalogItemChoice(FENCE_PANEL_FAMILY, itemKey,
    { width: String(plan.opening.width), height: String(plan.opening.height) });
  if (!committed.ok) return { ok: false, reason: 'tooLarge' };
  const [x, y, z] = plan.opening.placement.position;
  const component = createComponentFor(state.assembly, committed.value.source, { partName: committed.value.name, placement: {
    position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: plan.opening.placement.rotation } });
  const pickerOpen = state.standardPartPickerOpen;
  state.applyAssembly(addComponent(state.assembly,
    committed.value.materialId === undefined ? component : { ...component, materialId: committed.value.materialId }));
  useAppStore.getState().setSelection([component.id]);
  if (pickerOpen) useAppStore.setState({ standardPartPickerOpen: true });
  return { ok: true, componentId: component.id };
}
