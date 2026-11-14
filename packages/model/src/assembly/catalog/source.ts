/**
 * 族の部品の保存の形(`catalog: 'catalogItem'`)を作る・確かめる・組む。
 *
 * 保存の形: `{ kind: 'standardPart', catalog: 'catalogItem', size: <呼び>,
 *   options: { family: <族の id>, item: <行の鍵>, <族の options の鍵>: <値>… },
 *   catalogRevision: <族の表の版>, generatorRevision: <族の形の台本の版> }`。
 * options の鍵は `family`・`item` と族の指定の鍵の**完全一致**だけを許し、余計な鍵・欠けた鍵・呼びの食い違いは
 * 型付きの拒否にする(鋼材の `findSteelProduct` と同じ厳しさ)。既存の 3 系統の保存はここを通らない。
 */
import { evaluateExpression } from '@pointercad/expression';

import type { PartDocument } from '../../part/types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from './registry.js';
import { catalogItemRejectionOf, type CatalogItemRejection } from './rejection.js';
import type { CatalogFamily, CatalogItemRow, CatalogOptionSpec } from './types.js';

const FAMILY_KEY = 'family';
const ITEM_KEY = 'item';

interface ResolvedCatalogItem {
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  /** 族の指定の鍵だけの値(`family`・`item` を含まない)。 */
  readonly values: Readonly<Record<string, string>>;
}

type CatalogItemResolution = { readonly item: ResolvedCatalogItem; readonly rejection: null }
  | { readonly item: null; readonly rejection: CatalogItemRejection };

function rejected(...args: Parameters<typeof catalogItemRejectionOf>): CatalogItemResolution {
  return { item: null, rejection: catalogItemRejectionOf(...args) };
}

function optionValueValid(spec: CatalogOptionSpec, value: string): boolean {
  if (spec.kind === 'choice') return (spec.choices ?? []).includes(value);
  const result = evaluateExpression(value);
  if (!result.ok || !Number.isFinite(result.value.value)) return false;
  const number = result.value.value;
  if (spec.kind === 'lengthExpression' && number <= 0) return false;
  return (spec.min === undefined || number >= spec.min) && (spec.max === undefined || number <= spec.max);
}

/** 保存された族の部品を、族・版・行・欄・値の順に確かめる。最初に見つかった理由で断る。 */
function resolveCatalogItem(source: StandardPartSource, registry: CatalogRegistry): CatalogItemResolution {
  const familyId = source.options[FAMILY_KEY];
  if (familyId === undefined || registry.entry(familyId) === undefined) return rejected('unknown-family');
  const family = registry.loaded(familyId);
  if (family === undefined) return rejected('family-not-loaded');
  if (source.catalogRevision !== family.catalogRevision) return rejected('unsupported-catalog-revision');
  if (source.generatorRevision !== family.generatorRevision) return rejected('unsupported-generator-revision');
  const row = family.rows.find((candidate) => candidate.key === source.options[ITEM_KEY]);
  if (row === undefined) return rejected('unknown-item');
  const allowed = new Set([FAMILY_KEY, ITEM_KEY, ...family.options.map((spec) => spec.key)]);
  const fields = [
    ...Object.keys(source.options).filter((key) => !allowed.has(key)),
    ...family.options.filter((spec) => !Object.hasOwn(source.options, spec.key)).map((spec) => spec.key),
    ...(source.size === row.size ? [] : ['size']),
  ];
  if (fields.length > 0) return rejected('saved-fields-mismatch', fields);
  const values = Object.fromEntries(family.options.map((spec) => [spec.key, source.options[spec.key] ?? spec.defaultValue]));
  const invalid = family.options.filter((spec) => !optionValueValid(spec, values[spec.key] ?? '')).map((spec) => spec.key);
  if (invalid.length > 0) return rejected('invalid-option-value', invalid);
  return { item: { family, row, values }, rejection: null };
}

/** 新しく置く族の部品の保存の形。選ぶ画面は読み込んだ族と行から、必ずここで作る(版の書き忘れを起こさない)。 */
export function createCatalogItemSource(family: CatalogFamily, row: CatalogItemRow,
  values: Readonly<Record<string, string>> = {}): StandardPartSource {
  return {
    kind: 'standardPart', catalog: 'catalogItem', size: row.size,
    options: { [FAMILY_KEY]: family.id, [ITEM_KEY]: row.key,
      ...Object.fromEntries(family.options.map((spec) => [spec.key, values[spec.key] ?? spec.defaultValue])) },
    catalogRevision: family.catalogRevision, generatorRevision: family.generatorRevision,
  };
}

/**
 * 呼びと options だけから作る(`createStandardPartSource` の `catalogItem` の道)。族が読み込み済みで行があれば
 * `createCatalogItemSource` と同じ。そうでなければ版の無い形を返し、組む時に「知らない種類」「読み込み中」
 * 「呼び寸法が無い」の型付きの拒否になる(黙って別の部品にしない)。
 */
export function catalogItemSourceFromOptions(size: string, options: Readonly<Record<string, string>>,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): StandardPartSource {
  const familyId = options[FAMILY_KEY];
  const family = familyId === undefined ? undefined : registry.loaded(familyId);
  const row = family?.rows.find((candidate) => candidate.key === options[ITEM_KEY] && candidate.size === size);
  if (family !== undefined && row !== undefined) return createCatalogItemSource(family, row, options);
  return { kind: 'standardPart', catalog: 'catalogItem', size, options: { ...options }, catalogRevision: '', generatorRevision: '' };
}

/** 保存された族の部品を組めない理由。組めるなら null。 */
export function catalogItemRejection(source: StandardPartSource,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): CatalogItemRejection | null {
  return resolveCatalogItem(source, registry).rejection;
}

/** 保存された族の部品を、族の表から普通の部品文書に組む。確かめに通らなければ null。 */
export function buildCatalogItemPart(source: StandardPartSource,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): PartDocument | null {
  const { item } = resolveCatalogItem(source, registry);
  return item === null ? null : item.family.build(item.row, item.values);
}

/** 族の台本どおりの体積(実カーネルの体積の検査の独立した期待値)。確かめに通らなければ null。 */
export function catalogItemNominalVolume(size: string, options: Readonly<Record<string, string>>,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): number | null {
  const familyId = options[FAMILY_KEY];
  const family = familyId === undefined ? undefined : registry.loaded(familyId);
  if (family === undefined) return null;
  const { item } = resolveCatalogItem({ kind: 'standardPart', catalog: 'catalogItem', size, options,
    catalogRevision: family.catalogRevision, generatorRevision: family.generatorRevision }, registry);
  return item === null ? null : item.family.nominalVolume(item.row, item.values);
}
