/**
 * 置いた後の部材の一括の書き換え(J-01 包み 8)。選んだ部品が同じ族の族の部品(または同じ鋼材の製品)の時に、
 * 族の行と長さ(鋼材は長さだけ)を替えた次の保存の形を部品ごとに作る。留めの欄などほかの欄は今のまま残す。
 *
 * 合致・ジョイントの選び直しは、次の形を解いてから `replaceComponent.ts` の `planReplacement` が部品ごとに行う
 * (ここは保存の形と、替える部品を指している合致・ジョイントの数まで。形を解かない純関数)。
 */
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { catalogItemRejection, createCatalogItemSource } from '../catalog/source.js';
import { FAMILY_KEY, ITEM_KEY, nextComponentNameFor, placedPartName } from '../componentNames.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import { steelProductFromSource } from '../standard/steelCatalog.js';
import type { AssemblyDocument } from '../types.js';

/** 替える中身: 族の行の鍵と長さ(式の文字)。どちらも省くと替える物が無い。 */
export interface MemberBulkChange {
  readonly itemKey?: string;
  readonly length?: string;
}

/** 部品 1 つの次の保存の形と名前(名前が置いた時の「部品名:番号」の形なら新しい部品名に合わせる。付け直した名前は今のまま)。 */
interface MemberBulkEntry {
  readonly componentId: string;
  readonly nextSource: StandardPartSource;
  readonly nextName: string;
}

export type MemberBulkPlan =
  | { readonly ok: true; readonly kind: 'catalogItem' | 'steel'; readonly entries: readonly MemberBulkEntry[];
    /** 替える部品を指している合致・ジョイントの数(形を解いた後に選び直す物の上限)。 */
    readonly referencingCount: number }
  | { readonly ok: false; readonly reason: MemberBulkRejection };

/** 部品を選んでいない・部材でない部品がある・族か製品が混ざる・行が無い・欄の値で作れない・替える物が無い・鋼材の行を替えようとした。 */
type MemberBulkRejection = 'noSelection' | 'notMember' | 'mixed' | 'unknownItem' | 'invalidOption' | 'noChange' | 'steelRow';

/** 部品の保存の形(族の部品か鋼材の製品の部品だけ)。 */
function memberSourceOf(assembly: AssemblyDocument, componentId: string): StandardPartSource | null {
  const component = assembly.components.find((candidate) => candidate.id === componentId);
  return component?.source.kind === 'standardPart' ? component.source : null;
}

/** 族の部品の次の保存の形(行と長さを替え、ほかの欄は今のまま)。作れない時は理由。 */
function nextCatalogSource(source: StandardPartSource, change: MemberBulkChange, registry: CatalogRegistry):
StandardPartSource | MemberBulkRejection {
  const family = registry.loaded(source.options[FAMILY_KEY] ?? '');
  const row = family?.rows.find((candidate) => candidate.key === (change.itemKey ?? source.options[ITEM_KEY]));
  if (family === undefined || row === undefined) return 'unknownItem';
  const values = Object.fromEntries(Object.entries(source.options).filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY));
  const next = createCatalogItemSource(family, row, { ...values, ...(change.length === undefined ? {} : { length: change.length }) });
  return catalogItemRejection(next, registry) === null && family.build(row, Object.fromEntries(Object.entries(next.options)
    .filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY))) !== null ? next : 'invalidOption';
}

/** 鋼材の部品の次の保存の形(長さだけを替える)。 */
function nextSteelSource(source: StandardPartSource, change: MemberBulkChange): StandardPartSource | MemberBulkRejection {
  if (change.itemKey !== undefined) return 'steelRow';
  const next: StandardPartSource = { ...source, options: { ...source.options, ...(change.length === undefined ? {} : { length: change.length }) } };
  return buildStandardPartFromSource(next) === null ? 'invalidOption' : next;
}

/** 選んだ部品の種類の鍵(族は族の id、鋼材は製品の鍵)。部材でなければ null。 */
function memberKindKey(source: StandardPartSource): { readonly kind: 'catalogItem' | 'steel'; readonly key: string } | null {
  if (source.catalog === 'catalogItem') return { kind: 'catalogItem', key: source.options[FAMILY_KEY] ?? '' };
  const steel = steelProductFromSource(source);
  return steel === undefined ? null : { kind: 'steel', key: steel.key };
}

/** 選んだ部品の行・長さを一括で替える計画。作れない時は何も替えずに理由を返す。 */
export function planMemberBulkEdit(assembly: AssemblyDocument, componentIds: readonly string[], change: MemberBulkChange,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): MemberBulkPlan {
  if (componentIds.length === 0) return { ok: false, reason: 'noSelection' };
  if (change.itemKey === undefined && change.length === undefined) return { ok: false, reason: 'noChange' };
  const sources = componentIds.map((id) => memberSourceOf(assembly, id));
  const kinds = sources.map((source) => (source === null ? null : memberKindKey(source)));
  const first = kinds[0];
  if (first === null || first === undefined || kinds.some((kind) => kind === null)) return { ok: false, reason: 'notMember' };
  if (kinds.some((kind) => kind?.kind !== first.kind || kind.key !== first.key)) return { ok: false, reason: 'mixed' };
  const ids = new Set(componentIds);
  // 今ある全部の名前と、この計画で付けた名前は使用中(連番が重ならない)。
  const used = new Set(assembly.components.map((component) => component.name));
  const entries: MemberBulkEntry[] = [];
  const nameSources = { registry, buildStandardPartFromSource };
  for (const [index, source] of sources.entries()) {
    const componentId = componentIds[index];
    const name = assembly.components.find((component) => component.id === componentId)?.name;
    if (source === null || componentId === undefined || name === undefined) return { ok: false, reason: 'notMember' };
    const next = first.kind === 'catalogItem' ? nextCatalogSource(source, change, registry) : nextSteelSource(source, change);
    if (typeof next === 'string') return { ok: false, reason: next };
    const nextName = nextComponentNameFor(name, {
      before: placedPartName(source, nameSources), after: placedPartName(next, nameSources),
    }, used);
    used.add(nextName);
    entries.push({ componentId, nextSource: next, nextName });
  }
  const referencingCount = [...assembly.mates, ...assembly.joints]
    .filter((item) => ids.has(item.a.componentId) || ids.has(item.b.componentId)).length;
  return { ok: true, kind: first.kind, entries, referencingCount };
}
