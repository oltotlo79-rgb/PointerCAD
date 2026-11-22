/**
 * 選ぶ画面の「機械要素」(登録口の族)の選び方の中身(設計 §5.6 のうち、族を選んで置ける最小の所:
 * 種類 → 材質(行の材質が 2 つ以上ある族だけ) → 呼び → 長さなどの指定 → 置く)。
 * 族の表は登録口が読み込んだ物だけを使い、保存の形は model の `createCatalogItemSource` で作る(版の書き忘れを起こさない)。
 * 指定の値の確かめは model の組み立て(`buildStandardPartFromSource`)に任せ、同じ決まりを ui で書き直さない。
 * 検索・最近使った物・寸法の図は後の包み(K-07)。
 */
import {
  buildStandardPartFromSource, createCatalogItemSource, PRODUCT_CATALOG_REGISTRY, type CatalogRegistry, type StandardPartSource,
} from '@pointercad/model';

import { MESSAGE_KEYS, t, type MessageKey } from '../i18n/t.js';

type LoadedFamily = NonNullable<ReturnType<CatalogRegistry['loaded']>>;
type FamilyRow = LoadedFamily['rows'][number];

/** 選ぶ画面の分類の値(今の 8 分類とは別の値。保存には使わない)。族の分類(group)と同じ文字。 */
export const MECHANICAL_PICKER_CATEGORY = 'mechanical';
export const ALUMINUM_FRAME_PICKER_CATEGORY = 'aluminumFrame';
export const PIPING_PICKER_CATEGORY = 'piping';
export type FamilyPickerCategory = typeof MECHANICAL_PICKER_CATEGORY | typeof ALUMINUM_FRAME_PICKER_CATEGORY | typeof PIPING_PICKER_CATEGORY;

/** 分類の欄の値が族の分類(機械要素・アルミフレーム・配管)か。 */
export function isFamilyPickerCategory(value: string): value is FamilyPickerCategory {
  return value === MECHANICAL_PICKER_CATEGORY || value === ALUMINUM_FRAME_PICKER_CATEGORY || value === PIPING_PICKER_CATEGORY;
}

/** 分類の欄の値が族の分類なら、その値。今の 8 分類なら null。 */
export function familyPickerCategory(value: string): FamilyPickerCategory | null {
  return isFamilyPickerCategory(value) ? value : null;
}

/** 族の分類ごとの種類の欄の名前と案内の鍵(アルミフレームの分類で「機械要素の種類」と出さない)。 */
export const FAMILY_KIND_FIELD_KEYS: Readonly<Record<FamilyPickerCategory, { readonly label: MessageKey; readonly guide: MessageKey }>> = {
  [MECHANICAL_PICKER_CATEGORY]: { label: 'catalog.mechanical.kind', guide: 'catalog.mechanical.kindGuide' },
  [ALUMINUM_FRAME_PICKER_CATEGORY]: { label: 'catalog.frame.kind', guide: 'catalog.frame.kindGuide' },
  [PIPING_PICKER_CATEGORY]: { label: 'catalog.piping.kind', guide: 'catalog.piping.kindGuide' },
};

/** 族の分類の族の入口(登録の順)。 */
export function catalogFamilyEntries(group: FamilyPickerCategory,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): CatalogRegistry['entries'] {
  return registry.entries.filter((entry) => entry.group === group);
}

/** 登録口・族が持つ i18n の鍵。i18n に無い時(作る側の誤り)は、内部の鍵を出さず `fallback` にする。 */
export function messageKeyOr(key: string, fallback: MessageKey): MessageKey {
  return MESSAGE_KEYS.find((candidate) => candidate === key) ?? fallback;
}

/** 種類の名前の鍵。 */
export function familyKindKey(kindKey: string): MessageKey {
  return messageKeyOr(kindKey, 'catalog.mechanical.kind');
}

/**
 * 選ぶ窓(検索の行・材質の欄・呼びの欄)に出す行(族の行の順)。`listed: false` の行(前に保存したファイルを読むためだけに残す行)は出さない。
 * 鍵で行を引く所(置く・保存した部品を組む・部品表)は族の行を全部読む。
 */
export function listedRows(family: LoadedFamily): readonly FamilyRow[] {
  return family.rows.filter((row) => row.listed !== false);
}

/** 選ぶ窓に出す行の材質(行の順、重なりなし)。材質を持たない族は空。 */
export function familyMaterials(family: LoadedFamily): readonly string[] {
  return [...new Set(listedRows(family).flatMap((row) => row.materialLabel === undefined ? [] : [row.materialLabel]))];
}

type FamilyHint = NonNullable<NonNullable<ReturnType<CatalogRegistry['entry']>>['hint']>;

/** 族の説明の 1 行と行の文字の形。登録口の行が持つ(族ごとの表を ui に持たない。族を足す時に ui を直さなくてよい)。 */
function registeredHint(family: LoadedFamily, registry: CatalogRegistry): FamilyHint | undefined {
  return registry.entry(family.id)?.hint;
}

/**
 * 族の指定の欄の説明の 1 行の鍵。長さを式で入れる族は「長さは自由に入力(規格の呼び長さとは名乗らない)」
 * (小ねじは頭の高さとの関係、ピンは面取りとの関係を添える)、寸法を指定して作るばねは形が作れる条件。どれでもない族は null。
 */
export function familyHintKey(family: LoadedFamily, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): MessageKey | null {
  const registered = registeredHint(family, registry)?.key;
  const hintKey = MESSAGE_KEYS.find((candidate) => candidate === registered);
  if (hintKey !== undefined) return hintKey;
  if (family.diagram === 'tSlotSeries') return 'catalog.frame.series.hint';
  if (family.diagram === 'bolt') {
    if (family.rows.some((row) => row.dims.shortLengthMax !== undefined)) return 'catalog.mechanical.setScrew.hint';
    return family.rows.some((row) => row.dims.acrossFlats !== undefined) ? 'catalog.mechanical.hexBolt.hint' : 'catalog.mechanical.screw.hint';
  }
  if (!family.options.some((spec) => spec.key === 'length')) return null;
  return family.rows.some((row) => row.dims.chamfer !== undefined) ? 'catalog.mechanical.freeLength' : 'catalog.mechanical.freeLengthPlain';
}

/** 指定の欄の既定の値(行ごとの既定を持つ族はその行の値。保存の形を作る model の決まりと同じ)。 */
export function optionDefault(spec: LoadedFamily['options'][number], row: FamilyRow | undefined): string {
  return (row === undefined ? undefined : spec.rowDefault?.(row)) ?? spec.defaultValue;
}

function fill(template: string, values: Readonly<Record<string, string | number | undefined>>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value ?? '')), template);
}

/**
 * 軸受の行の文字。呼び番号を持つ転がり軸受は呼び番号を前に出す(ラジアル軸受は幅 B〔アンギュラ玉軸受は呼び接触角も、
 * 内輪なしの針状ころ軸受は内径の代わりにころの内接円径 Fw〕、スラスト軸受は全高 T を持つ行)。
 * 呼び番号を持たない行(ローラフォロア)は内径・外径・内輪の幅だけ。
 */
function bearingRowLabel(row: FamilyRow): string {
  const dims = row.dims;
  if (dims.width !== undefined && dims.contactAngle !== undefined) {
    return fill(t('catalog.mechanical.row.designatedBearing'), { size: row.size, inner: dims.boreDiameter,
      outer: dims.outsideDiameter, width: dims.width, angle: dims.contactAngle });
  }
  if (dims.rollerInscribedDiameter !== undefined) {
    return fill(t('catalog.mechanical.row.needleBearing'), { size: row.size, fw: dims.rollerInscribedDiameter,
      outer: dims.outsideDiameter, width: dims.width });
  }
  if (dims.width !== undefined) {
    return fill(t('catalog.mechanical.row.radialBearing'), { size: row.size, inner: dims.boreDiameter,
      outer: dims.outsideDiameter, width: dims.width });
  }
  if (dims.height !== undefined) {
    return fill(t('catalog.mechanical.row.thrustBearing'), { size: row.size, inner: dims.boreDiameter,
      outer: dims.outsideDiameter, height: dims.height });
  }
  return fill(t('catalog.mechanical.row.bearing'), { inner: dims.boreDiameter, outer: dims.outsideDiameter, width: dims.innerRingWidth });
}

/** ピンの行の文字(割りピンは頭の外径を持つ行、テーパピンは端の a を持つ行、平行ピンは面取りを持つ行)。 */
function pinRowLabel(row: FamilyRow): string {
  const dims = row.dims;
  if (dims.headDiameter !== undefined) {
    return fill(t('catalog.mechanical.row.splitPin'), { size: row.size, diameter: dims.diameter, head: dims.headDiameter });
  }
  if (dims.endLength !== undefined) {
    return fill(t('catalog.mechanical.row.taperPin'), { diameter: dims.diameter, end: dims.endLength });
  }
  return fill(t('catalog.mechanical.row.pin'), { diameter: dims.diameter, chamfer: dims.chamfer });
}

/**
 * 配管(K-28)の行の文字: エルボ・チーズは中心から端面まで、ソケットは長さと、腕の外径。キャップは高さと外径、プラグは頭の二面幅と高さ、
 * 六角ニップル・ブッシングは長さと二面幅、フランジは外径・厚さ・ボルト穴・ボルトの呼び。配管の族でなければ null。
 */
function pipingRowLabel(diagram: LoadedFamily['diagram'], row: FamilyRow): string | null {
  const dims = row.dims;
  switch (diagram) {
    case 'pipeElbow':
    case 'pipeTee':
      return fill(t('catalog.piping.row.fitting'), { size: row.size, length: dims.length, outer: dims.outerDiameter });
    case 'pipeSocket':
      return fill(t('catalog.piping.row.socket'), { size: row.size, length: dims.length, outer: dims.outerDiameter });
    case 'pipeCap':
      return fill(t('catalog.piping.row.cap'), { size: row.size, height: dims.height, outer: dims.outerDiameter });
    case 'pipePlug':
      return fill(t('catalog.piping.row.plug'), { size: row.size, across: dims.acrossFlats, height: dims.headHeight });
    case 'pipeNipple':
    case 'pipeBushing':
      return fill(t('catalog.piping.row.hex'), { size: row.size, length: dims.overallLength, across: dims.acrossFlats });
    case 'pipeFlange':
      return fill(t('catalog.piping.row.flange'), { size: row.size, outer: dims.outerDiameter, thickness: dims.thickness,
        count: dims.holeCount, hole: dims.holeDiameter, bolt: dims.boltDiameter });
    default:
      return null;
  }
}

/** 呼びの一覧に出す 1 行の文字(族の線図の種類ごとの形。製造元の型番は出さない)。 */
export function catalogRowLabel(family: LoadedFamily, row: FamilyRow,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): string {
  const dims = row.dims;
  const rowForm = registeredHint(family, registry)?.rowLabel;
  const piping = pipingRowLabel(family.diagram, row);
  if (piping !== null) return piping;
  if (family.diagram === 'camFollower') {
    const pitch = dims.threadPitch ?? NaN;
    return fill(t('catalog.mechanical.row.camFollower'), { outside: dims.outsideDiameter,
      thread: `M${dims.studDiameter}×${Number.isInteger(pitch) ? pitch.toFixed(1) : String(pitch)}`, length: dims.overallLength });
  }
  if (family.diagram === 'bush') {
    return fill(t('catalog.mechanical.row.bush'), { inner: dims.innerDiameter, outer: dims.outerDiameter, length: dims.length });
  }
  if (family.diagram === 'pin') return pinRowLabel(row);
  if (rowForm === 'specified') return t('catalog.mechanical.row.spring');
  if (rowForm === 'simplified' && row.simplified !== undefined && row.simplified.length > 0) {
    return fill(t('catalog.frame.row.simplified'), { size: row.size, parts: row.simplified.join('・') });
  }
  if (family.diagram === 'tSlotSeries') {
    return fill(t('catalog.frame.row.series'), { size: row.size, opening: dims.slotOpening, inner: dims.slotInnerWidth,
      mass: dims.unitMassKgPerM });
  }
  if (family.diagram === 'oRing') {
    return fill(t('catalog.mechanical.row.oRing'), { size: row.size, inner: dims.innerDiameter, section: dims.crossSection });
  }
  if (family.diagram === 'bearing') return bearingRowLabel(row);
  if (family.diagram === 'bolt' && dims.shortLengthMax !== undefined) {
    return fill(t('catalog.mechanical.row.setScrew'), { size: row.size, socket: dims.socketWidth, min: dims.lengthMin,
      max: dims.lengthMax, pitch: dims.pitch });
  }
  if (family.diagram === 'bolt' && dims.acrossFlats !== undefined) {
    return fill(t('catalog.mechanical.row.hexBolt'), { size: row.size, across: dims.acrossFlats, height: dims.headHeight,
      pitch: dims.pitch });
  }
  if (family.diagram === 'bolt') {
    return fill(t('catalog.mechanical.row.screw'), { size: row.size, head: dims.headDiameter, height: dims.headHeight,
      pitch: dims.pitch });
  }
  if (family.diagram === 'key') return fill(t('catalog.mechanical.row.key'), { size: row.size, width: dims.width, height: dims.height });
  // C 形止め輪(A6。適用する軸径・穴径を持つ行): d3 は軸用なら内径、穴用なら外径。
  if (family.diagram === 'washer' && dims.appliedDiameter !== undefined) {
    return fill(t('catalog.mechanical.row.cRing'), { size: row.size, free: dims.innerDiameter ?? dims.outerDiameter, thickness: dims.thickness,
      groove: dims.grooveDiameter });
  }
  if (family.diagram === 'washer') {
    return fill(t('catalog.mechanical.row.washer'), { size: row.size, inner: dims.innerDiameter, outer: dims.outerDiameter,
      thickness: dims.thickness });
  }
  if (family.diagram === 'nut') {
    return fill(t('catalog.mechanical.row.nut'), { size: row.size, height: dims.heightMax, across: dims.acrossFlats });
  }
  return row.size;
}

export interface CatalogItemCommit {
  readonly source: StandardPartSource;
  readonly name: string;
  /** 置いた部品に付ける材質(行の密度の材質。部品表の材質と質量に使う。K-06)。密度の材質を持たない行は付けない(省く)。 */
  readonly materialId?: string;
}

export type CatalogItemCommitResult = { readonly ok: true; readonly value: CatalogItemCommit }
  | { readonly ok: false; readonly reason: 'unknownChoice' | 'invalidOption' };

/**
 * 読み込んだ族と行と指定の値から、置く部品の保存の形と名前を作る。族が未読込・行が無い時は unknownChoice、
 * 指定の値が範囲の外・数として読めない時は invalidOption(どちらも置かない)。
 */
export function commitCatalogItemChoice(familyId: string, itemKey: string,
  values: Readonly<Record<string, string>> = {}): CatalogItemCommitResult {
  // 確かめは製品の登録口で組む道(buildStandardPartFromSource)と同じ登録口を使う。
  const family = PRODUCT_CATALOG_REGISTRY.loaded(familyId);
  const row = family?.rows.find((candidate) => candidate.key === itemKey);
  if (family === undefined || row === undefined) return { ok: false, reason: 'unknownChoice' };
  const source = createCatalogItemSource(family, row, values);
  if (buildStandardPartFromSource(source) === null) return { ok: false, reason: 'invalidOption' };
  const saved = Object.fromEntries(family.options.map((spec) => [spec.key, source.options[spec.key] ?? spec.defaultValue]));
  return { ok: true, value: { source, name: family.partName(row, saved),
    ...(row.densityMaterialId === undefined ? {} : { materialId: row.densityMaterialId }) } };
}
