/**
 * 付属の組(設計 wip/auto-accessory-design.md。統括の決定 2026-11-19 02:08: Q1〜Q6 は推す案)。置いた本体に、組の決まりで付属の部品を足す
 * 次の文書を作るだけの純関数で、店はこれを 1 回で入れる(元に戻す 1 回で戻る)。
 *
 * - 組は製品のコードに書いた決まりで、付属の寸法は今ある族の行から引く。合う行が無い組は出さない(近い行を推測で選ばない)。
 * - 本体は部品の保存の形から引く(G2。accessoryHost.ts。族の部品・鋼材の部材・8 分類の部品)。組ごとの候補の引き方と付け方は、
 *   組の定義の表(accessorySetDefinitions.ts)の 1 行ずつ。端のキャップの計算は frameEndCaps.ts、ボルトの組は boltAccessorySet.ts、
 *   軸受の止め輪は bearingRingSet.ts。付け直しは accessorySync.ts。
 * - 付属は本体と同じ一緒に動く組(`joinRigidGroup`)に入れる。記録を足した文書は保存形式の版 23 以上にする(使ったファイルだけ。frameJoints と同じ)。
 */
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import type { AssemblyDocument } from '../types.js';
import { accessoryHostOf, catalogItemHost } from './accessoryHost.js';
import type { AccessoryEnds, AccessoryEndReference, AccessorySetId } from './accessoryRecord.js';
import { ACCESSORY_SET_DEFINITIONS } from './accessorySetDefinitions.js';
import type { BearingRingRefusal } from './bearingRingSet.js';

/** 付属を付けられない理由。画面は理由ごとの文を出す。 */
export type AccessoryRefusal = 'noHost' | 'notFrame' | 'slotWidthUnknown' | 'capLinkUnknown' | 'capsNotLoaded' | 'noMatchingCap'
  | 'unknownItem' | 'invalidLength' | 'lengthOutOfRange' | 'setNotAvailable' | BearingRingRefusal;

/** キャップの候補の行。quarterTurn は本体の長さの軸のまわりの 90° の回しの数(0 か 1)。 */
export interface AccessoryCandidate {
  readonly familyId: string;
  readonly itemKey: string;
  readonly size: string;
  readonly thicknessMm: number;
  readonly quarterTurn: 0 | 1;
}

export interface AccessoryChoices {
  readonly ends: AccessoryEnds;
  readonly endReference: AccessoryEndReference;
  /** 候補の行の鍵(候補が 1 つの時も明示する。画面は候補が 1 つなら自動で選ぶ)。 */
  readonly itemKey: string;
  /** ボルトの座金とナットの組(A4)の締め付ける厚さ(mm。無ければ既定)とばね座金の有無。ほかの組は持たない。 */
  readonly gripMm?: number;
  readonly springWasher?: boolean;
}

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AccessoryRefusal };

/** 登録した組の全部(鋼材・機械要素の組を足す時はここと記録の型と組の定義の表に足す)。 */
export const ACCESSORY_SET_IDS: readonly AccessorySetId[] = ['frame-end-caps', 'bearing-shaft-rings', 'bearing-bore-rings'];

/** 置く前の本体(族・行・欄の値)に付けられる組の候補。組ごとに、候補の行か、付けられない理由。 */
export function accessoryCandidatesForPart(family: CatalogFamily, row: CatalogItemRow, values: Readonly<Record<string, string>>,
  setId: AccessorySetId, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): Result<readonly AccessoryCandidate[]> {
  const source = createCatalogItemSource(family, row, values);
  return ACCESSORY_SET_DEFINITIONS[setId].candidates(catalogItemHost(source, family, row, values), source, registry);
}

/** 置いた本体に付けられる組の候補。 */
export function accessoryCandidates(document: AssemblyDocument, hostComponentId: string, setId: AccessorySetId,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): Result<readonly AccessoryCandidate[]> {
  const component = document.components.find((candidate) => candidate.id === hostComponentId);
  if (component === undefined) return { ok: false, reason: 'noHost' };
  return ACCESSORY_SET_DEFINITIONS[setId].candidates(accessoryHostOf(component.source, registry), component.source, registry);
}

/**
 * 本体に付属の組を付けた次の文書(組の定義の表の付け方)。付けられない時は何も変えずに理由を返す。
 */
export function applyAccessorySet(document: AssemblyDocument, hostComponentId: string, setId: AccessorySetId, choices: AccessoryChoices,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): Result<{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] }> {
  return ACCESSORY_SET_DEFINITIONS[setId].apply(document, hostComponentId, choices, registry);
}
