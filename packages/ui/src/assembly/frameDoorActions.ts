/**
 * パネルと扉(E-10 第 2 段)の流れ: ビューか木で選んだ部材 4 本の枠の開口に、扉(扉の枠 4 本〔パネル用のフレーム、角は留め〕・扉の板・ヒンジ 2 つ)を
 * model の `planFrameDoor` で決めて、1 回で置く(元に戻す 1 回で戻る)。部材の箱は表示中の配置から作る。選ぶ窓は開いたまま。
 * 第 3 段: 板の押さえ(各辺に等間隔)と平たいつなぎ(扉の枠の 4 隅の裏)も、行を選んだ時だけ一緒に置き、扉の部品(扉の枠・板・押さえ・つなぎ)を
 * 互いに固定した組にまとめる(一緒に動く。ヒンジは組に入れない)。開閉のジョイントと取っ手は作らない(model の frameDoor.ts の注)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createComponentFor, joinRigidGroup, placedFrameMembers, planFrameDoor, PRODUCT_CATALOG_REGISTRY, type AssemblyDocument,
  type FrameDoorResult, type RigidPlacement,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
import { frameMembersDocument } from './frameMembersPlacement.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

/** 扉の枠(パネル用のフレーム)とヒンジ(パネル扉の部品のうち、鍵が hinge- で始まる行)の族。 */
export const DOOR_FAMILIES = { frame: 'panel-cover-frame', hinge: 'panel-part-box' } as const;
export const DOOR_HINGE_PREFIX = 'hinge-';
/** 同じ族のうち、板の押さえ・平たいつなぎの行の鍵の頭。 */
export const DOOR_HOLDER_PREFIX = 'board-holder-';
export const DOOR_CONNECTOR_PREFIX = 'flat-connector-';

/** 窓で選ぶ物: 板・扉の枠・ヒンジの行、ヒンジを付ける側、上下の端からヒンジの中心まで、開口と扉の間の隙間(mm)。 */
export interface FrameDoorChoices {
  readonly boardKey: string | null;
  readonly frameKey: string | null;
  readonly hingeKey: string | null;
  readonly side: 'start' | 'end';
  readonly offset: number;
  readonly clearance: number;
  /** 板の押さえ・平たいつなぎの行(null は置かない)と、押さえを並べる間隔(mm)。 */
  readonly holderKey: string | null;
  readonly holderPitch: number;
  readonly connectorKey: string | null;
}

type DoorPlan = Extract<FrameDoorResult, { readonly ok: true }>;

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  notFour: 'catalog.framePanel.reason.notFour', notRectangle: 'catalog.framePanel.reason.notRectangle',
  notCoplanar: 'catalog.framePanel.reason.notCoplanar', noRoom: 'catalog.frameDoor.reason.noRoom',
  invalidNumber: 'catalog.frameDoor.reason.invalidNumber', hingeNoRoom: 'catalog.frameDoor.reason.hingeNoRoom',
  holderNoRoom: 'catalog.frameDoor.reason.holderNoRoom',
  tooLarge: 'catalog.framePanel.reason.tooLarge', noRows: 'catalog.frameDoor.reason.noRows',
  unavailable: 'catalog.framePanel.reason.unavailable', invalidOption: 'catalog.frameDoor.reason.invalidOption',
};

/** 理由の文字。 */
export function frameDoorReasonText(reason: string): string {
  return t(REASON_KEYS[reason] ?? 'catalog.framePanel.reason.unavailable');
}

const rowOf = (familyId: string, key: string | null) => key === null ? undefined
  : PRODUCT_CATALOG_REGISTRY.loaded(familyId)?.rows.find((candidate) => candidate.key === key);

/** 今選んでいる部材 4 本の枠に付ける扉の計画(作れない時は理由)。 */
export function frameDoorPlan(choices: FrameDoorChoices): { readonly ok: true; readonly plan: DoorPlan } | { readonly ok: false; readonly reason: string } {
  const state = useAppStore.getState();
  const assembly = state.assembly, view = state.assemblyView;
  if (assembly === null || view === null || view.sourceDocument !== assembly) return { ok: false, reason: 'unavailable' };
  const board = rowOf(FENCE_PANEL_FAMILY, choices.boardKey), frame = rowOf(DOOR_FAMILIES.frame, choices.frameKey);
  const hinge = rowOf(DOOR_FAMILIES.hinge, choices.hingeKey);
  const [thickness, frameWidth] = [board?.dims.thickness, frame?.dims.width];
  const [hingeWidth, hingeDepth, hingeHeight] = [hinge?.dims.width, hinge?.dims.depth, hinge?.dims.height];
  if (thickness === undefined || frameWidth === undefined || hingeWidth === undefined || hingeDepth === undefined || hingeHeight === undefined) {
    return { ok: false, reason: 'noRows' };
  }
  const holderRow = rowOf(DOOR_FAMILIES.hinge, choices.holderKey), connectorRow = rowOf(DOOR_FAMILIES.hinge, choices.connectorKey);
  if ((choices.holderKey !== null && holderRow === undefined) || (choices.connectorKey !== null && connectorRow === undefined)) {
    return { ok: false, reason: 'noRows' };
  }
  const holder = holderRow === undefined ? null : { width: holderRow.dims.width ?? Number.NaN, depth: holderRow.dims.depth ?? Number.NaN,
    height: holderRow.dims.height ?? Number.NaN, pitch: choices.holderPitch };
  const connector = connectorRow === undefined ? null
    : { height: connectorRow.dims.height ?? Number.NaN, frameDepth: frame?.dims.height ?? Number.NaN };
  const selected = new Set(state.selection);
  const members = placedFrameMembers(assembly, view.resolved.placements).filter((member) => selected.has(member.componentId));
  if (members.length !== state.selection.length) return { ok: false, reason: 'notFour' };
  const plan = planFrameDoor(members, { clearance: choices.clearance, frameWidth, boardThickness: thickness,
    hinge: { width: hingeWidth, depth: hingeDepth, height: hingeHeight, side: choices.side, offset: choices.offset }, holder, connector });
  if (!plan.ok) return plan;
  const family = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY);
  const built = board === undefined || family === undefined ? null
    : family.build(board, { width: String(plan.board.width), height: String(plan.board.height) });
  return built === null ? { ok: false, reason: 'tooLarge' } : { ok: true, plan };
}

/** 族の行の部品を 1 つ、置き方 placement で足す。 */
function addCatalogPart(document: AssemblyDocument, familyId: string, itemKey: string, values: Readonly<Record<string, string>>,
  placement: RigidPlacement): { readonly document: AssemblyDocument; readonly id: string } | null {
  const committed = commitCatalogItemChoice(familyId, itemKey, values);
  if (!committed.ok) return null;
  const [x, y, z] = placement.position;
  const component = createComponentFor(document, committed.value.source, { partName: committed.value.name, placement: {
    position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: placement.rotation } });
  return { document: addComponent(document, committed.value.materialId === undefined ? component : { ...component, materialId: committed.value.materialId }),
    id: component.id };
}

/** 扉を 1 回で置き、置いた部品を選び、選ぶ窓を残す。置いた部品の id か理由。 */
export function placeFrameDoor(choices: FrameDoorChoices): { readonly ok: true; readonly componentIds: readonly string[] }
| { readonly ok: false; readonly reason: string } {
  const planned = frameDoorPlan(choices);
  const state = useAppStore.getState();
  if (!planned.ok) return planned;
  if (state.assembly === null || choices.frameKey === null || choices.boardKey === null || choices.hingeKey === null) {
    return { ok: false, reason: 'unavailable' };
  }
  const { plan } = planned;
  const frames = frameMembersDocument(state.assembly, { member: { kind: 'catalogItem', familyId: DOOR_FAMILIES.frame, itemKey: choices.frameKey,
    values: {} }, lines: plan.frameLines, up: plan.frameUp, quarterTurns: 0, startExtension: 0, endExtension: 0, corners: 'miter', swapThrough: [] });
  if (!frames.ok) return { ok: false, reason: 'invalidOption' };
  let document = frames.document;
  const componentIds = [...frames.componentIds];
  // 互いに固定した組にまとめる扉の部品(ヒンジは入れない)。
  const doorIds = [...frames.componentIds];
  const part = (itemKey: string, placement: RigidPlacement, grouped: boolean) => [DOOR_FAMILIES.hinge, itemKey, {}, placement, grouped] as const;
  const parts: readonly (readonly [string, string, Readonly<Record<string, string>>, RigidPlacement, boolean])[] = [
    [FENCE_PANEL_FAMILY, choices.boardKey, { width: String(plan.board.width), height: String(plan.board.height) }, plan.board.placement, true],
    ...plan.hinges.map((placement) => part(choices.hingeKey ?? '', placement, false)),
    ...plan.holders.map((placement) => part(choices.holderKey ?? '', placement, true)),
    ...plan.connectors.map((placement) => part(choices.connectorKey ?? '', placement, true)),
  ];
  for (const [familyId, itemKey, values, placement, grouped] of parts) {
    const added = addCatalogPart(document, familyId, itemKey, values, placement);
    if (added === null) return { ok: false, reason: 'invalidOption' };
    document = added.document;
    componentIds.push(added.id);
    if (grouped) doorIds.push(added.id);
  }
  document = joinRigidGroup(document, doorIds);
  const pickerOpen = state.standardPartPickerOpen;
  state.applyAssembly(document);
  useAppStore.getState().setSelection(componentIds);
  if (pickerOpen) useAppStore.setState({ standardPartPickerOpen: true });
  return { ok: true, componentIds };
}
