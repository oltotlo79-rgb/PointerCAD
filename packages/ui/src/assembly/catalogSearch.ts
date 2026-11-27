/**
 * 規格部品の選ぶ窓の検索(K-07a)。今の 8 分類の行(鋼材を含む)と登録口の族の行を 1 つの並びにし、空白で区切った言葉を
 * 全部含む行を返す。選んだ行は「選び直す先」(分類・種類・材質・呼び)として窓へ渡し、窓の状態の持ち方は変えない。
 * 族の行は読み込んだ族の分だけ並ぶ(窓は検索の文字が入った時に全部の族を読む。`PickerSearch.tsx`)。選ぶ窓に出さない行(`listedRows`)は並べない。
 */
import {
  ALL_STEEL_PRODUCTS, PRODUCT_CATALOG_REGISTRY, type CatalogRegistry, type FastenerDimensionSeries, type SteelSectionCatalog, type ThreadSeries,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import {
  catalogRowLabel, familyKindKey, familyMaterials, familyPickerCategory, listedRows, type FamilyPickerCategory,
} from './catalogFamilyChoices.js';
import {
  STANDARD_PART_CATEGORIES, standardPartChoices, standardPartUsesDimensionSeries, standardPartUsesThreadSeries,
  STEEL_CONDITION_LABELS, steelShapeLabelKey, STRUCTURAL_MATERIAL_CHOICES,
  structuralPartChoices, type StandardPartCategory, type StructuralMaterialChoice,
} from './standardPartPicker.js';

/** 今の 8 分類の名前の鍵(分類の欄と検索の行で同じ名前を出す)。 */
export const STANDARD_PART_CATEGORY_LABELS: Readonly<Record<StandardPartCategory, MessageKey>> = {
  hexBolt: 'assembly.standardPart.hexBolt', hexNut: 'assembly.standardPart.hexNut', plainWasher: 'assembly.standardPart.plainWasher',
  springWasher: 'assembly.standardPart.springWasher', socketHeadCapScrew: 'assembly.standardPart.socketHeadCapScrew',
  panHeadScrew: 'assembly.standardPart.panHeadScrew', deepGrooveBallBearing: 'assembly.standardPart.deepGrooveBallBearing',
  structuralSection: 'assembly.standardPart.structuralSection',
};

const SERIES_LABELS: Readonly<Record<FastenerDimensionSeries, MessageKey>> = {
  annexJA: 'assembly.standardPart.dimensionSeries.annexJA', main: 'assembly.standardPart.dimensionSeries.main',
};

/** 選ぶ窓の分類: 今の 8 分類と、登録口の族の分類(保存には使わない値)。 */
export type PickerCategory = StandardPartCategory | FamilyPickerCategory;

/** 族の窓を開く時の初めの種類・材質・呼びと指定の値(材質の欄を出さない族は空。検索の行は指定の値を持たない)。 */
export interface CatalogFamilyStart {
  readonly familyId: string;
  readonly material: string;
  readonly itemKey: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * 検索の行・最近使った物を選んだ時に、窓をどこへ選び直すか。長さの欄の値(`lengthSource`)は最近使った物だけが持つ
 * (検索の行は null。分類が替わる時だけ初めの値に戻す)。
 */
export type PickerJumpTarget =
  | { readonly kind: 'standard'; readonly category: StandardPartCategory; readonly choiceKey: string;
    readonly dimensionSeries: FastenerDimensionSeries | null; readonly lengthSource: string | null;
    readonly threadSeries?: ThreadSeries }
  | { readonly kind: 'steel'; readonly material: StructuralMaterialChoice; readonly shape: SteelSectionCatalog | null;
    readonly choiceKey: string; readonly lengthSource: string | null }
  | { readonly kind: 'family'; readonly group: FamilyPickerCategory; readonly start: CatalogFamilyStart };

/** 最近使った物 1 件(検索の行と同じ名前と添え書き)。 */
export interface RecentPart {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly target: PickerJumpTarget;
}

interface PickerSearchEntry {
  /** 並びの中で一意。 */
  readonly key: string;
  /** 種類と呼び。 */
  readonly label: string;
  /** 規格・材質・寸法の系列など(無い時は空)。 */
  readonly detail: string;
  /** 照合に使う文字(揃えた後)。 */
  readonly text: string;
  /** 揃えた後の呼び(言葉と同じ呼びの行を先に出す)。 */
  readonly size: string;
  readonly target: PickerJumpTarget;
}

/** 全角と半角・大文字と小文字・「×」と「x」・続く空白を揃える(行の文字と入れた言葉の両方に使う)。 */
function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[×✕*]/gu, 'x').replace(/\s+/gu, ' ').trim();
}

function entry(key: string, label: string, detail: string, size: string, extra: readonly string[], target: PickerJumpTarget):
PickerSearchEntry {
  return { key, label, detail, text: normalizeSearchText([label, detail, ...extra].join(' ')), size: normalizeSearchText(size), target };
}

function standardEntries(): PickerSearchEntry[] {
  return STANDARD_PART_CATEGORIES.filter((category) => category !== 'structuralSection').flatMap((category) => {
    const series: readonly (FastenerDimensionSeries | null)[] = standardPartUsesDimensionSeries(category) ? ['annexJA', 'main'] : [null];
    return series.flatMap((dimensionSeries) => standardPartChoices(category, dimensionSeries ?? undefined).map((choice) => entry(
      `${choice.key}|${dimensionSeries ?? ''}`, `${t(STANDARD_PART_CATEGORY_LABELS[category])} ${choice.size}`,
      [dimensionSeries === null ? '' : t(SERIES_LABELS[dimensionSeries]), choice.verified ? '' : t('assembly.standardPart.unverifiedShort')]
        .filter((part) => part !== '').join(' · '),
      choice.size, [], { kind: 'standard', category, choiceKey: choice.key, dimensionSeries, lengthSource: null })));
  });
}

function steelEntries(): PickerSearchEntry[] {
  const section = t(STANDARD_PART_CATEGORY_LABELS.structuralSection);
  const graded = ALL_STEEL_PRODUCTS.flatMap((row) => {
    const material = STRUCTURAL_MATERIAL_CHOICES.find((choice) => choice === row.materialGrade);
    if (material === undefined) return [];
    return [entry(`steel:${row.key}`, `${t(steelShapeLabelKey(row.catalog, row.materialGrade))} ${row.size}`,
      `${row.materialGrade} · ${row.productStandard} · ${t(STEEL_CONDITION_LABELS[row.condition])}`, row.size, [section, row.materialStandard],
      { kind: 'steel', material, shape: row.catalog, choiceKey: `steel:${row.key}`, lengthSource: null })];
  });
  const legacy = structuralPartChoices('unspecified').map((choice) => entry(`legacy:${choice.key}`, `${section} ${choice.size}`,
    t('assembly.steel.unspecified'), choice.size, [],
    { kind: 'steel', material: 'unspecified', shape: null, choiceKey: choice.key, lengthSource: null }));
  return [...graded, ...legacy];
}

function familyEntries(registry: CatalogRegistry): PickerSearchEntry[] {
  return registry.entries.flatMap((familyEntry) => {
    const group = familyPickerCategory(familyEntry.group);
    const family = registry.loaded(familyEntry.id);
    if (group === null || family === undefined) return [];
    const kind = t(familyKindKey(family.kindKey));
    const withMaterial = familyMaterials(family).length >= 2;
    return listedRows(family).map((row) => {
      const material = withMaterial ? row.materialLabel ?? '' : '';
      return entry(`${family.id}|${row.key}`, `${kind} ${catalogRowLabel(family, row, registry)}`,
        [row.standardLabel, material].filter((part) => part !== '').join(' · '), row.size, [row.size, row.materialLabel ?? ''],
        { kind: 'family', group, start: { familyId: family.id, material, itemKey: row.key, values: {} } });
    });
  });
}

const cache = new WeakMap<CatalogRegistry, { readonly loaded: number; readonly entries: readonly PickerSearchEntry[] }>();

/** 検索の並び(今の 8 分類 → 鋼材 → 族の順)。読み込んだ族の数が変わった時だけ作り直す。 */
export function pickerSearchEntries(registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): readonly PickerSearchEntry[] {
  const loaded = registry.entries.filter((familyEntry) => registry.loaded(familyEntry.id) !== undefined).length;
  const cached = cache.get(registry);
  if (cached !== undefined && cached.loaded === loaded) return cached.entries;
  const entries = [...standardEntries(), ...steelEntries(), ...familyEntries(registry)];
  cache.set(registry, { loaded, entries });
  return entries;
}

/** 検索の結果(上から `limit` 件)と、出しきれなかった数。 */
interface PickerSearchResult {
  readonly entries: readonly PickerSearchEntry[];
  readonly more: number;
}

/** 空白で区切った言葉を全部含む行。言葉のどれかと呼びが同じ行を先に、あとは並びの順。言葉が無い時は空。 */
export function searchPickerEntries(entries: readonly PickerSearchEntry[], query: string, limit = 30): PickerSearchResult {
  const words = normalizeSearchText(query).split(' ').filter((word) => word !== '');
  if (words.length === 0) return { entries: [], more: 0 };
  const matched = entries.filter((candidate) => words.every((word) => candidate.text.includes(word)));
  const exact = matched.filter((candidate) => words.includes(candidate.size));
  const ordered = [...exact, ...matched.filter((candidate) => !words.includes(candidate.size))];
  return { entries: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) };
}

/** 分類を替えた時の長さの欄の初めの値(鋼材は 1000、ほかは 30。今の窓と同じ)。 */
export function defaultLengthSource(category: PickerCategory): string {
  return category === 'structuralSection' ? '1000' : '30';
}

/** 窓の今の値のうち、選び直しで替わり得る物。 */
interface PickerJumpCurrent {
  readonly category: PickerCategory;
  readonly choiceKey: string;
  readonly lengthSource: string;
  readonly dimensionSeries: FastenerDimensionSeries;
}

/** 選び直した後の窓の値。鋼材は材質と断面、族は族の窓の初めの値も持つ。 */
interface PickerJumpState extends PickerJumpCurrent {
  readonly steel: { readonly material: StructuralMaterialChoice; readonly shape: SteelSectionCatalog | null } | null;
  readonly family: CatalogFamilyStart | null;
}

/**
 * 検索の行・最近使った物を選んだ時の窓の値。長さの欄は、最近使った物はその時の値、検索の行は分類が替わる時だけ初めの値に戻す
 * (今の窓で分類を替えた時と同じ)。
 */
export function pickerJumpState(target: PickerJumpTarget, current: PickerJumpCurrent): PickerJumpState {
  const category: PickerCategory = target.kind === 'family' ? target.group : target.kind === 'steel' ? 'structuralSection' : target.category;
  const kept = category === current.category ? current.lengthSource : defaultLengthSource(category);
  const lengthSource = target.kind === 'family' ? kept : target.lengthSource ?? kept;
  if (target.kind === 'family') return { ...current, category, lengthSource, steel: null, family: target.start };
  if (target.kind === 'steel') {
    return { ...current, category, lengthSource, choiceKey: target.choiceKey, steel: { material: target.material, shape: target.shape }, family: null };
  }
  return { ...current, category, lengthSource, choiceKey: target.choiceKey, dimensionSeries: target.dimensionSeries ?? current.dimensionSeries,
    steel: null, family: null };
}

/** 選び直す先の、検索の並びの中の鍵(検索の行と同じ行なら同じ鍵。長さや指定の値には依らない)。 */
function entryKeyOf(target: PickerJumpTarget): string {
  if (target.kind === 'family') return `${target.start.familyId}|${target.start.itemKey}`;
  if (target.kind === 'steel') return target.material === 'unspecified' ? `legacy:${target.choiceKey}` : target.choiceKey;
  return `${target.choiceKey}|${target.dimensionSeries ?? ''}`;
}

/** 置けた物の最近使った物の 1 件(名前と添え書きは検索の行と同じ)。検索の並びに無い物(読み込んでいない族の行など)は null。 */
export function recentPartOf(target: PickerJumpTarget): RecentPart | null {
  const key = entryKeyOf(target);
  const found = pickerSearchEntries().find((candidate) => candidate.key === key);
  return found === undefined ? null : { key, label: found.label, detail: found.detail, target };
}

/**
 * 今の 8 分類・鋼材の窓で置けた物の選び直す先(長さの欄の値も持つ)。寸法系は、寸法系を選べる分類だけが持つ。
 * 鋼材の断面は、鋼種を指定しない今までの行では持たない。
 */
export function standardPlacedTarget(category: StandardPartCategory, choiceKey: string, dimensionSeries: FastenerDimensionSeries,
  steel: { readonly material: StructuralMaterialChoice; readonly shape: SteelSectionCatalog | null },
  lengthSource: string, threadSeries?: ThreadSeries): PickerJumpTarget {
  if (category === 'structuralSection') {
    return { kind: 'steel', material: steel.material, shape: steel.material === 'unspecified' ? null : steel.shape, choiceKey, lengthSource };
  }
  return { kind: 'standard', category, choiceKey, dimensionSeries: standardPartUsesDimensionSeries(category) ? dimensionSeries : null,
    lengthSource, ...(threadSeries !== undefined && standardPartUsesThreadSeries(category) ? { threadSeries } : {}) };
}
