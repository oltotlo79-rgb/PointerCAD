import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createComponentFor, framePanelOpening, joinRigidGroup, panelBoardHole, placedFrameMembers, planFramePanelFittings,
  PRODUCT_CATALOG_REGISTRY, type AssemblyDocument, type FramePanelOpeningResult, type RigidPlacement,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
import { DOOR_CONNECTOR_PREFIX, DOOR_FAMILIES, DOOR_HOLDER_PREFIX } from './frameDoorActions.js';
import { FENCE_PANEL_FAMILY } from './safetyFenceInput.js';

export const FRAME_PANEL_FAMILIES: readonly string[] = [FENCE_PANEL_FAMILY, 'welded-wire-mesh'];

export interface FramePanelOptions {
  readonly familyId: string;
  readonly flip: boolean;
  readonly hole: Readonly<Record<string, string>>;
  readonly holderKey: string;
  readonly connectorKey: string;
}

const DEFAULT_OPTIONS: FramePanelOptions = { familyId: FENCE_PANEL_FAMILY, flip: false, hole: {}, holderKey: '', connectorKey: '' };

type Opening = Extract<FramePanelOpeningResult, { readonly ok: true }>;
type ValidHole = Exclude<ReturnType<typeof panelBoardHole>, false>;
type PanelReason = Exclude<FramePanelOpeningResult, Opening>['reason']
  | 'tooLarge' | 'unavailable' | 'noPanel' | 'invalidHole' | 'invalidFitting' | 'holderNoRoom' | 'connectorNoRoom';

interface PanelComponentPlan {
  readonly familyId: string;
  readonly itemKey: string;
  readonly values: Readonly<Record<string, string>>;
  readonly placement: RigidPlacement;
}

type FramePanelPlan = { readonly ok: true; readonly opening: Opening; readonly hole: ValidHole;
  readonly board: PanelComponentPlan; readonly fittings: readonly PanelComponentPlan[] }
  | { readonly ok: false; readonly reason: PanelReason };

const REASON_KEYS: Readonly<Record<PanelReason, MessageKey>> = {
  notFour: 'catalog.framePanel.reason.notFour', notRectangle: 'catalog.framePanel.reason.notRectangle',
  notCoplanar: 'catalog.framePanel.reason.notCoplanar', noRoom: 'catalog.framePanel.reason.noRoom',
  invalidNumber: 'catalog.framePanel.reason.invalidNumber', tooLarge: 'catalog.framePanel.reason.tooLarge',
  unavailable: 'catalog.framePanel.reason.unavailable', noPanel: 'catalog.framePanel.reason.noPanel',
  invalidHole: 'catalog.framePanel.reason.invalidHole', invalidFitting: 'catalog.framePanel.reason.invalidFitting',
  holderNoRoom: 'catalog.framePanel.reason.holderNoRoom', connectorNoRoom: 'catalog.framePanel.reason.connectorNoRoom',
};

export function framePanelReasonText(reason: PanelReason): string {
  return t(REASON_KEYS[reason] ?? REASON_KEYS.unavailable);
}

function fittingRow(key: string, prefix: string) {
  return key === '' ? null : PRODUCT_CATALOG_REGISTRY.loaded(DOOR_FAMILIES.hinge)?.rows.find((row) =>
    row.key === key && row.key.startsWith(prefix) && row.listed !== false);
}

function plannedFittings(members: ReturnType<typeof placedFrameMembers>, options: FramePanelOptions, gap: number, thickness: number) {
  const holder = fittingRow(options.holderKey, DOOR_HOLDER_PREFIX);
  const connector = fittingRow(options.connectorKey, DOOR_CONNECTOR_PREFIX);
  if (holder === undefined || connector === undefined) return { ok: false, reason: 'invalidFitting' } as const;
  const plan = planFramePanelFittings(members, { gap, thickness, flip: options.flip, connector: connector !== null,
    holder: holder === null ? null : { width: holder.dims.width ?? NaN, depth: holder.dims.depth ?? NaN, height: holder.dims.height ?? NaN } });
  if (!plan.ok) return plan;
  const part = (itemKey: string, placement: RigidPlacement): PanelComponentPlan => ({ familyId: DOOR_FAMILIES.hinge, itemKey, values: {}, placement });
  return { ok: true, parts: [...plan.holders.map((placement) => part(options.holderKey, placement)),
    ...plan.connectors.map((placement) => part(options.connectorKey, placement))] } as const;
}

/** Read the current four-member opening without editing the assembly or building candidate bodies. */
export function framePanelPlan(itemKey: string | null, gap: number, options: FramePanelOptions = DEFAULT_OPTIONS): FramePanelPlan {
  const state = useAppStore.getState();
  const { assembly, assemblyView: view } = state;
  if (assembly === null || view === null || view.sourceDocument !== assembly) return { ok: false, reason: 'unavailable' };
  const family = FRAME_PANEL_FAMILIES.includes(options.familyId) ? PRODUCT_CATALOG_REGISTRY.loaded(options.familyId) : undefined;
  const row = family?.rows.find((candidate) => candidate.key === itemKey && candidate.listed !== false);
  const thickness = row?.dims.thickness;
  if (family === undefined || row === undefined || thickness === undefined) return { ok: false, reason: 'noPanel' };
  const selected = new Set(state.selection);
  const members = placedFrameMembers(assembly, view.resolved.placements).filter((member) => selected.has(member.componentId));
  if (members.length !== state.selection.length) return { ok: false, reason: 'notFour' };
  const opening = framePanelOpening(members, { thickness, gap, flip: options.flip });
  if (!opening.ok) return opening;
  const hole = panelBoardHole(row, [opening.width, opening.height], options.hole);
  if (hole === false) return { ok: false, reason: 'invalidHole' };
  const values = { ...options.hole, width: String(opening.width), height: String(opening.height) };
  if (family.nominalVolume(row, values) === null) return { ok: false, reason: 'tooLarge' };
  const fittings = plannedFittings(members, options, gap, thickness);
  if (!fittings.ok) return fittings;
  return { ok: true, opening, hole, fittings: fittings.parts, board: { familyId: family.id, itemKey: row.key, values, placement: opening.placement } };
}

function addPanelComponent(document: AssemblyDocument, part: PanelComponentPlan) {
  const committed = commitCatalogItemChoice(part.familyId, part.itemKey, part.values);
  if (!committed.ok) return null;
  const [x, y, z] = part.placement.position;
  const component = createComponentFor(document, committed.value.source, { partName: committed.value.name, placement: {
    position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: part.placement.rotation,
  } });
  const material = committed.value.materialId;
  return { id: component.id, document: addComponent(document, material === undefined ? component : { ...component, materialId: material }) };
}

type PanelPlacement = { readonly ok: true; readonly componentId: string } | { readonly ok: false; readonly reason: PanelReason };

/** Stage the whole installation in one immutable assembly and commit it in one history step. */
function commitFramePanel(plan: FramePanelPlan): PanelPlacement {
  if (!plan.ok) return plan;
  const state = useAppStore.getState();
  if (state.assembly === null || state.assemblyUndoStack === null) return { ok: false, reason: 'unavailable' };
  const board = addPanelComponent(state.assembly, plan.board);
  if (board === null) return { ok: false, reason: 'tooLarge' };
  let document = board.document;
  const addedIds = [board.id];
  for (const part of plan.fittings) {
    const added = addPanelComponent(document, part);
    if (added === null) return { ok: false, reason: 'invalidFitting' };
    document = added.document;
    addedIds.push(added.id);
  }
  if (addedIds.length > 1) document = joinRigidGroup(document, addedIds);
  state.applyAssembly(document);
  useAppStore.getState().setSelection(addedIds);
  if (state.standardPartPickerOpen) useAppStore.setState({ standardPartPickerOpen: true });
  return { ok: true, componentId: board.id };
}

export function placeFramePanel(itemKey: string | null, gap: number): PanelPlacement {
  return commitFramePanel(framePanelPlan(itemKey, gap));
}

export function placeFramePanelInstallation(itemKey: string, gap: number, options: FramePanelOptions): PanelPlacement {
  return commitFramePanel(framePanelPlan(itemKey, gap, options));
}
