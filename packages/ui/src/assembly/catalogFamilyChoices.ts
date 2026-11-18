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
export type FamilyPickerCategory = typeof MECHANICAL_PICKER_CATEGORY | typeof ALUMINUM_FRAME_PICKER_CATEGORY;

/** 分類の欄の値が族の分類(機械要素・アルミフレーム)か。 */
export function isFamilyPickerCategory(value: string): value is FamilyPickerCategory {
  return value === MECHANICAL_PICKER_CATEGORY || value === ALUMINUM_FRAME_PICKER_CATEGORY;
}

/** 分類の欄の値が族の分類なら、その値。今の 8 分類なら null。 */
export function familyPickerCategory(value: string): FamilyPickerCategory | null {
  return isFamilyPickerCategory(value) ? value : null;
}

/** 族の分類ごとの種類の欄の名前と案内の鍵(アルミフレームの分類で「機械要素の種類」と出さない)。 */
export const FAMILY_KIND_FIELD_KEYS: Readonly<Record<FamilyPickerCategory, { readonly label: MessageKey; readonly guide: MessageKey }>> = {
  [MECHANICAL_PICKER_CATEGORY]: { label: 'catalog.mechanical.kind', guide: 'catalog.mechanical.kindGuide' },
  [ALUMINUM_FRAME_PICKER_CATEGORY]: { label: 'catalog.frame.kind', guide: 'catalog.frame.kindGuide' },
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

/** 族の行の材質(行の順、重なりなし)。材質を持たない族は空。 */
export function familyMaterials(family: LoadedFamily): readonly string[] {
  return [...new Set(family.rows.flatMap((row) => row.materialLabel === undefined ? [] : [row.materialLabel]))];
}

/** 寸法を指定して作る族(表を持たない族)の線図の種類と、その説明の 1 行の鍵(形が作れる条件と、規格の寸法ではない事)。 */
const SPECIFIED_FAMILY_HINTS: Readonly<Partial<Record<LoadedFamily['diagram'], MessageKey>>> = {
  compressionSpring: 'catalog.mechanical.spring.hint', sealRing: 'catalog.mechanical.sealRing.hint',
  tSlotFrame: 'catalog.frame.tSlot.hint', angleBracket: 'catalog.frame.bracket.hint', joinPlate: 'catalog.frame.plate.hint',
  slotNut: 'catalog.frame.nut.hint',
};

/** 資料の寸法に合わせたフレームの部品の族(行を選ぶ族。形は簡略)の説明の 1 行。行の文字に簡略の印を添える。 */
const FRAME_PART_HINTS: Readonly<Partial<Record<LoadedFamily['diagram'], MessageKey>>> = {
  tSlotNutBar: 'catalog.frame.nutBar.hint', tSlotNut: 'catalog.frame.catalogNut.hint', roundNut: 'catalog.frame.roundNut.hint',
  frameCap: 'catalog.frame.cap.hint', flatPlate: 'catalog.frame.flatPlate.hint', shapedPlate: 'catalog.frame.shapedPlate.hint',
  angleBracketCatalog: 'catalog.frame.angleBracketCatalog.hint', footBase: 'catalog.frame.footBase.hint', adjuster: 'catalog.frame.adjuster.hint',
  jointBar: 'catalog.frame.jointBar.hint', tSlotStud: 'catalog.frame.tSlotStud.hint', knurledNut: 'catalog.frame.knurledNut.hint',
  pipeFrame: 'catalog.frame.pipeFrame.hint', pipeFrameSlotted: 'catalog.frame.pipeFrameSlotted.hint', pipeFrameTwin: 'catalog.frame.pipeFrameTwin.hint',
  smallFrame: 'catalog.frame.smallFrame.hint', smallFrameCap: 'catalog.frame.smallFrameCap.hint', bracketStock: 'catalog.frame.bracketStock.hint',
  pipeFrameCap: 'catalog.frame.pipeFrameCap.hint', pipeFrameFoot: 'catalog.frame.pipeFrameFoot.hint',
  panelBoardFixed: 'catalog.board.fixed.hint', panelBoardOrder: 'catalog.board.order.hint',
  panelPartBox: 'catalog.board.partBox.hint', panelCoverFrame: 'catalog.board.coverFrame.hint', connectorBox: 'catalog.frame.connectorBox.hint',
  capFootBox: 'catalog.frame.capFootBox.hint', movableBox: 'catalog.frame.movableBox.hint', accessoryBox: 'catalog.frame.accessoryBox.hint',
  caster: 'catalog.frame.caster.hint',
};

/**
 * 族の指定の欄の説明の 1 行の鍵。長さを式で入れる族は「長さは自由に入力(規格の呼び長さとは名乗らない)」
 * (小ねじは頭の高さとの関係、ピンは面取りとの関係を添える)、寸法を指定して作るばねは形が作れる条件。どれでもない族は null。
 */
export function familyHintKey(family: LoadedFamily): MessageKey | null {
  const specified = SPECIFIED_FAMILY_HINTS[family.diagram] ?? FRAME_PART_HINTS[family.diagram];
  if (specified !== undefined) return specified;
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

/** 呼びの一覧に出す 1 行の文字(族の線図の種類ごとの形。製造元の型番は出さない)。 */
export function catalogRowLabel(family: LoadedFamily, row: FamilyRow): string {
  const dims = row.dims;
  if (family.diagram === 'camFollower') {
    const pitch = dims.threadPitch ?? NaN;
    return fill(t('catalog.mechanical.row.camFollower'), { outside: dims.outsideDiameter,
      thread: `M${dims.studDiameter}×${Number.isInteger(pitch) ? pitch.toFixed(1) : String(pitch)}`, length: dims.overallLength });
  }
  if (family.diagram === 'bush') {
    return fill(t('catalog.mechanical.row.bush'), { inner: dims.innerDiameter, outer: dims.outerDiameter, length: dims.length });
  }
  if (family.diagram === 'pin') return pinRowLabel(row);
  if (SPECIFIED_FAMILY_HINTS[family.diagram] !== undefined) return t('catalog.mechanical.row.spring');
  if (FRAME_PART_HINTS[family.diagram] !== undefined && row.simplified !== undefined && row.simplified.length > 0) {
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
