/**
 * 規格部品・族の行・部品のファイルを、3D の画面で押した所に置く釦(G1。統括の決定 2026-11-19 15:4x。設計 wip/pa-pick/g1-design.md)。
 * - 押すと、3D の画面で押した物を欄へ入れる共通の頼み(componentPickActions の「置く点」)を開く。もう一度押すとやめる(aria-pressed)。
 * - 押した点(見えている部品の頂点か、高さ 0 の水平な面の上。固定の方眼なら格子点)に部品の原点が来るように置く。
 *   部品の種類(アルミフレーム・鋼材・機械要素・部品のファイル)では分けない。部品のファイルは押した点の座標を X・Y・Z の欄へ入れる(file)。
 * - 今の「置く」(原点)と流れはそのまま。置く物の指定は、押した時に作り直す(付属の組の欄など、窓の今の値を使う)。
 */
import type { SteelSectionCatalog } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { activeComponentPick, type ComponentPickSlice } from '../store/componentPickActions.js';
import { useAppStore } from '../store/useAppStore.js';
import { pickedAccessory, standardAccessoryOptionsFor } from './accessoryChoice.js';
import { standardPlacedTarget, type PickerJumpTarget } from './catalogSearch.js';
import { commitStandardPartChoice, type StandardPartCategory, type StructuralMaterialChoice } from './standardPartPicker.js';

type Placement = NonNullable<NonNullable<ComponentPickSlice['assemblyComponentPick']>['placement']>;
/** 置く物の指定を作った結果(規格部品は長さなどの指定が読めない時に断る)。 */
type PlacementResult = { readonly ok: true; readonly value: Placement } | { readonly ok: false; readonly reason: 'unknownChoice' | 'invalidLength' };

/** 規格部品(今の 8 分類と鋼材)の置く物。選ぶ窓の「置く」と同じ確かめ(commitStandardPartChoice)を先にする。 */
export function standardPartPlacement(category: StandardPartCategory, choiceKey: string, lengthSource: string,
  dimensionSeries: 'annexJA' | 'main', threadSeries: 'coarse' | 'fine',
  steel: { readonly material: StructuralMaterialChoice; readonly shape: SteelSectionCatalog | null }): PlacementResult {
  const committed = commitStandardPartChoice(category, choiceKey, lengthSource, dimensionSeries, threadSeries);
  if (!committed.ok) return { ok: false, reason: committed.reason };
  return { ok: true, value: { kind: 'standardPart', category, choiceKey, lengthSource, dimensionSeries, threadSeries,
    accessory: pickedAccessory(standardAccessoryOptionsFor(category, choiceKey, lengthSource, dimensionSeries, threadSeries)),
    recent: standardPlacedTarget(category, choiceKey, dimensionSeries, steel, lengthSource) } };
}

/** 族の行(アルミフレーム・形材・族の機械要素)の置く物。 */
export function catalogItemPlacement(familyId: string, itemKey: string, values: Readonly<Record<string, string>> | undefined,
  accessory: Extract<Placement, { readonly kind: 'catalogItem' }>['accessory'], recent: PickerJumpTarget): PlacementResult {
  return { ok: true, value: { kind: 'catalogItem', familyId, itemKey, values, accessory, recent } };
}

/** 部品のファイルの置く物(押した点の座標を X・Y・Z の欄へ入れる)。 */
export function partFilePlacement(): PlacementResult {
  return { ok: true, value: { kind: 'partFile' } };
}

interface PlacePointButtonProps {
  /** 置く物の指定を作る口(押した時に呼ぶ)。null の時は釦を出さない(曲げ・編集できる部品など、押した所に置けない置き方)。 */
  readonly placement: (() => PlacementResult) | null;
  /** 部品のファイルの配置の窓(欄へ入れる。釦の名前と説明が替わる)。 */
  readonly file?: boolean;
  /** 置く物の指定が読めない時(選ぶ窓の「置く」と同じ理由を窓に出す)。 */
  readonly onError?: (reason: 'unknownChoice' | 'invalidLength') => void;
}

export function PlacePointButton({ placement, file = false, onError }: PlacePointButtonProps): React.JSX.Element | null {
  const pick = useAppStore((state) => activeComponentPick(state));
  if (placement === null) return null;
  const picking = pick?.purpose === 'placementPoint';
  const toggle = (): void => {
    const built = picking ? null : placement();
    if (built !== null && !built.ok) { onError?.(built.reason); return; }
    useAppStore.getState().toggleComponentPick('placementPoint', [], built?.value);
  };
  return <>
    <button type="button" className="pcad-button" aria-pressed={picking}
      title={t(file ? 'assembly.placePoint.fileGuide' : 'assembly.placePoint.guide')} onClick={toggle}>
      {t(file ? 'assembly.placePoint.fileLabel' : 'assembly.placePoint.label')}</button>
    {picking ? <p className="pcad-popover__hint" aria-live="polite">
      {t(pick?.notice === 'notPlaced' ? 'assembly.placePoint.refused' : 'assembly.placePoint.hint')}</p> : null}
  </>;
}
