import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyAccessorySet, createComponentFor, DEFAULT_COMPONENT_PLACEMENT,
  type AccessoryChoices, type AccessorySetId, type AssemblyDocument, type ComponentSource, type Placement, type Vec3,
} from '@pointercad/model';
import { commitCatalogItemChoice } from '../assembly/catalogFamilyChoices.js';
import { frameMembersDocument, type FrameMembersPlacement, type FrameMembersRequest } from '../assembly/frameMembersPlacement.js';
import { commitStandardPartChoice, type StandardPartCategory } from '../assembly/standardPartPicker.js';
import type { AppState } from './appState.js';
import { endComponentPickFor } from './componentPickActions.js';

export interface StandardPartPlacementSlice {
  readonly openStandardPartPicker: () => boolean;
  readonly closeStandardPartPicker: () => void;
  readonly placeStandardPart: (
    category: StandardPartCategory,
    choiceKey: string,
    lengthSource: string,
    dimensionSeries?: 'annexJA' | 'main',
    threadSeries?: 'coarse' | 'fine',
    /** 付属の組と、置く点(部品の原点が来る所。G1 の 3D の画面で押した点。無ければ今までどおり原点)。引数は 6 つまで(max-params)。 */
    options?: { readonly accessory?: { readonly setId: AccessorySetId; readonly choices: AccessoryChoices }; readonly at?: Vec3 },
  ) => boolean;
  /** 選ぶ画面の機械要素(登録口の族)の行を、長さなどの指定の値で置く。族が未読込・行が無い・値が範囲の外の時は置かずに false。 */
  readonly placeCatalogItem: (familyId: string, itemKey: string, values?: Readonly<Record<string, string>>,
    accessory?: { readonly setId: AccessorySetId; readonly choices: AccessoryChoices }, at?: Vec3) => boolean;
  /** 長さを持つ族の行を、線の列に沿って 1 本ずつ並べる(J-01)。全部を 1 回で入れる(Undo 1 回)。作れない時は何も置かずに理由。 */
  readonly placeFrameMembers: (request: FrameMembersRequest) => FrameMembersPlacement;
}

/** 置いた部品に付属の組を足す口(A4。今の 8 分類の窓のボルトの組)。付けられない時は null(置かない)。 */
function accessoryExtender(accessory: { readonly setId: AccessorySetId; readonly choices: AccessoryChoices } | undefined):
  ((document: AssemblyDocument, componentId: string) => AssemblyDocument | null) | undefined {
  return accessory === undefined ? undefined : (document, componentId) => {
    const applied = applyAccessorySet(document, componentId, accessory.setId, accessory.choices);
    return applied.ok ? applied.value.document : null;
  };
}

/** 押した点に部品の原点が来る置き方(G1。向きは今の「置く」と同じく回さない)。 */
function placementAt(point: Vec3): Placement {
  return { ...DEFAULT_COMPONENT_PLACEMENT,
    position: [expressionValueFromNumber(point[0]), expressionValueFromNumber(point[1]), expressionValueFromNumber(point[2])] };
}

/**
 * 選ぶ画面で選んだ部品(規格部品・族の部品)を 1 つ置く。窓が閉じている・アセンブリが無い時は置かない。
 * 確定後も窓と選択を残す。次の Enter を同じ 1 操作としてもう 1 個置ける(NFR-UX-4)。
 * 族の部品は行の密度の材質を部品の材質に付ける(部品表の材質と質量。K-06)。材質を持たない選び方(今の規格部品)は前と同じ形。
 */
function placePickedPart(get: () => AppState, set: (partial: Pick<AppState, 'standardPartPickerOpen'>) => void,
  picked: { readonly source: ComponentSource; readonly name: string; readonly materialId?: string },
  extend: (document: AssemblyDocument, componentId: string) => AssemblyDocument | null = (document) => document, at?: Vec3): boolean {
  const state = get();
  if (!state.standardPartPickerOpen || state.assembly === null) return false;
  const component = createComponentFor(state.assembly, picked.source,
    at === undefined ? { partName: picked.name } : { partName: picked.name, placement: placementAt(at) });
  // 付属の組(A2)は、置いた部品と同じ 1 つの文書で足す(元に戻す 1 回で両方戻る)。付けられない時は置かない。
  const next = extend(addComponent(state.assembly,
    picked.materialId === undefined ? component : { ...component, materialId: picked.materialId }), component.id);
  if (next === null) return false;
  get().applyAssembly(next);
  set({ standardPartPickerOpen: true });
  return true;
}

/** 選ぶ画面の族の行を、長さなどの指定の値で置く(`placeCatalogItem`)。 */
function placeCatalogItemFor(get: () => AppState, set: (partial: Pick<AppState, 'standardPartPickerOpen'>) => void,
  familyId: string, itemKey: string, values: Readonly<Record<string, string>> | undefined,
  extra: { readonly accessory: { readonly setId: AccessorySetId; readonly choices: AccessoryChoices } | undefined; readonly at?: Vec3 }): boolean {
  const selected = commitCatalogItemChoice(familyId, itemKey, values);
  const accessory = extra.accessory;
  return selected.ok && placePickedPart(get, set, selected.value, accessory === undefined ? undefined : (document, componentId) => {
    const applied = applyAccessorySet(document, componentId, accessory.setId, accessory.choices);
    return applied.ok ? applied.value.document : null;
  }, extra.at);
}

/** 長さを持つ族の行を線の列に沿って並べる(`placeFrameMembers`、J-01)。全部を 1 回で入れるので Undo 1 回で戻る。 */
function placeFrameMembersFor(get: () => AppState, set: (partial: Pick<AppState, 'standardPartPickerOpen'>) => void,
  request: FrameMembersRequest): FrameMembersPlacement {
  const state = get();
  if (!state.standardPartPickerOpen || state.assembly === null) return { ok: false, reason: 'unavailable', lineIndex: null };
  const planned = frameMembersDocument(state.assembly, request);
  if (!planned.ok) return planned;
  get().applyAssembly(planned.document);
  // 1 本ずつ置く時と同じく、置いた後も窓を残す(文書を入れると窓が閉じるため)。
  set({ standardPartPickerOpen: true });
  return { ok: true, componentIds: planned.componentIds };
}

export function createStandardPartPlacementActions(set: (patch: Partial<AppState>) => void, get: () => AppState): StandardPartPlacementSlice {
  return {
    openStandardPartPicker: () => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null
        || state.assemblyMateDraft !== null || state.assemblyDrag !== null || state.isComputing) return false;
      set({ standardPartPickerOpen: true, assemblyExplodeDraft: null, assemblyExplodeError: null });
      return true;
    },
    closeStandardPartPicker: () => {
      const state = get();
      set({ standardPartPickerOpen: false, ...endComponentPickFor(state, ['placementPoint']) });
    },
    placeStandardPart: (category, choiceKey, lengthSource, dimensionSeries, threadSeries, options) => {
      const selected = commitStandardPartChoice(category, choiceKey, lengthSource, dimensionSeries, threadSeries);
      return selected.ok && placePickedPart(get, set, selected.value, accessoryExtender(options?.accessory), options?.at);
    },
    placeCatalogItem: (familyId, itemKey, values, accessory, at) => placeCatalogItemFor(get, set, familyId, itemKey, values, { accessory, at }),
    placeFrameMembers: (request) => placeFrameMembersFor(get, set, request),
  };
}
