/**
 * 規格部品の選ぶ窓の寸法の図と表(K-07c)の元: 選んだ行の寸法の表の行と、線図を作る部品文書の作り方。
 * 表に出すのは、名前と単位を決めた鍵(下の白の一覧)だけ。族の行の `dims` には印の数(車輪の止めの有無など)・穴や溝の番号つきの座標・
 * 系列の番号も入るので、一覧に無い鍵は出さない(意味を確かめていない数を寸法として見せない)。並びは行の順。
 * 今の 8 分類(締結部品 6・軸受・鋼材)の行は `dims` を持たないので、分類ごとに行の型の欄から同じ鍵の名前の表を作る。
 * 行は JIS の記号を持たないので、表は日本語の名前・値・単位の 3 列にする(設計 wip/k07c-design.md §1)。
 */
import {
  ALL_DEEP_GROOVE_BALL_BEARINGS, buildStandardPartFromSource, CHANNEL_TABLE, createCatalogItemSource, EQUAL_ANGLE_TABLE,
  type CatalogRegistry, type FastenerDimensionSeries, HEX_BOLT_TABLE, HEX_NUT_TABLE, H_BEAM_TABLE, PAN_HEAD_SCREW_TABLE,
  type PartDocument, PLAIN_WASHER_TABLE, SOCKET_HEAD_CAP_SCREW_TABLE, SPRING_WASHER_TABLE, type SteelProduct, type ThreadSeries,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { defaultLengthSource } from './catalogSearch.js';
import { commitStandardPartChoice, type StandardPartCategory, type StandardPartChoice } from './standardPartPicker.js';

type LoadedFamily = NonNullable<ReturnType<CatalogRegistry['loaded']>>;
type FamilyRow = LoadedFamily['rows'][number];
type DimensionUnit = 'mm' | 'g' | 'kg/m' | 'kg/m²' | 'mm²' | 'cm²' | 'cm³' | 'cm⁴' | '°' | '';

interface DimensionRow {
  /** 行の鍵(族の dims の鍵、今の 8 分類は同じ名前に揃えた鍵)。 */
  readonly key: string;
  readonly label: MessageKey;
  readonly value: number;
  readonly unit: DimensionUnit;
}

/**
 * 表の下の印(族の行だけ。今の 8 分類と鋼材の窓は要確認の 1 行を窓が出しているので重ねない)。要確認は理由の文、簡略は簡略にした所の一覧、
 * 道具の画面の値は、資料に記入が無く参考にした組立用の道具の画面の値で入れた寸法の名前の鍵の一覧。
 */
type DimensionMark =
  | { readonly kind: 'unverified' | 'simplified'; readonly parts: readonly string[] }
  | { readonly kind: 'toolScreen'; readonly parts: readonly MessageKey[] };

export interface DimensionFigurePart {
  /** 同じ鍵なら同じ部品文書になる鍵(線図を覚える鍵)。 */
  readonly key: string;
  /** 線図を作る部品文書(置く時と同じ道で作る)。作れない時は null。 */
  readonly build: () => PartDocument | null;
  readonly rows: readonly DimensionRow[];
  readonly marks: readonly DimensionMark[];
}

const L = (label: MessageKey, unit: DimensionUnit = 'mm') => ({ label, unit });

/** 表に出す鍵と、その名前・単位。ここに無い鍵は出さない。 */
const DIMENSION_LABELS: ReadonlyMap<string, { readonly label: MessageKey; readonly unit: DimensionUnit }> = new Map([
  ['nominalDiameter', L('catalog.dimension.nominalDiameter')], ['diameter', L('catalog.dimension.diameter')],
  ['innerDiameter', L('catalog.dimension.innerDiameter')], ['boreDiameter', L('catalog.dimension.innerDiameter')],
  ['outerDiameter', L('catalog.dimension.outerDiameter')], ['outsideDiameter', L('catalog.dimension.outerDiameter')],
  ['width', L('catalog.dimension.width')], ['height', L('catalog.dimension.height')], ['depth', L('catalog.dimension.depth')],
  ['length', L('catalog.dimension.length')], ['overallLength', L('catalog.dimension.overallLength')],
  ['totalHeight', L('catalog.dimension.totalHeight')], ['thickness', L('catalog.dimension.thickness')],
  ['wallThickness', L('catalog.dimension.wallThickness')], ['webThickness', L('catalog.dimension.webThickness')],
  ['flangeThickness', L('catalog.dimension.flangeThickness')], ['flangeDiameter', L('catalog.dimension.flangeDiameter')],
  ['pitch', L('catalog.dimension.pitch')], ['threadPitch', L('catalog.dimension.pitch')],
  ['acrossFlats', L('catalog.dimension.acrossFlats')], ['headDiameter', L('catalog.dimension.headDiameter')],
  ['headHeight', L('catalog.dimension.headHeight')], ['headWidth', L('catalog.dimension.headWidth')],
  ['socketWidth', L('catalog.dimension.socketWidth')], ['socketDepth', L('catalog.dimension.socketDepth')],
  ['recessNumber', L('catalog.dimension.recessNumber', '')], ['threadLength', L('catalog.dimension.threadLength')],
  ['threadLengthMin', L('catalog.dimension.threadLengthMin')], ['heightMax', L('catalog.dimension.heightMax')],
  ['heightMin', L('catalog.dimension.heightMin')], ['lengthMin', L('catalog.dimension.lengthMin')],
  ['lengthMax', L('catalog.dimension.lengthMax')], ['minimumChamfer', L('catalog.dimension.minimumChamfer')],
  ['minimumChamferR1', L('catalog.dimension.minimumChamferR1')], ['chamfer', L('catalog.dimension.chamfer')],
  ['crossSection', L('catalog.dimension.crossSection')], ['innerRingWidth', L('catalog.dimension.innerRingWidth')],
  ['outerRingWidth', L('catalog.dimension.outerRingWidth')], ['rollerInscribedDiameter', L('catalog.dimension.rollerInscribedDiameter')],
  ['studDiameter', L('catalog.dimension.studDiameter')], ['studLength', L('catalog.dimension.studLength')],
  ['legA', L('catalog.dimension.legA')], ['legB', L('catalog.dimension.legB')],
  ['innerRadius', L('catalog.dimension.innerRadius')], ['tipRadius', L('catalog.dimension.tipRadius')],
  ['cornerRadius', L('catalog.dimension.cornerRadius')], ['centerHole', L('catalog.dimension.centerHole')],
  ['slotPitch', L('catalog.dimension.slotPitch')], ['slotOpening', L('catalog.dimension.slotOpening')],
  ['slotInnerWidth', L('catalog.dimension.slotInnerWidth')], ['slotDepth', L('catalog.dimension.slotDepth')],
  ['slotWidth', L('catalog.dimension.slotWidth')], ['holeDiameter', L('catalog.dimension.holeDiameter')],
  ['holePitch', L('catalog.dimension.holePitch')], ['holeCount', L('catalog.dimension.holeCount', '')],
  ['plateThickness', L('catalog.dimension.plateThickness')], ['plateWidth', L('catalog.dimension.plateWidth')],
  ['plateDepth', L('catalog.dimension.plateDepth')], ['wheelDiameter', L('catalog.dimension.wheelDiameter')],
  ['wheelWidth', L('catalog.dimension.wheelWidth')], ['stemDiameter', L('catalog.dimension.stemDiameter')],
  ['stemLength', L('catalog.dimension.stemLength')], ['padDiameter', L('catalog.dimension.padDiameter')],
  ['padThickness', L('catalog.dimension.padThickness')], ['contactAngle', L('catalog.dimension.contactAngle', '°')],
  ['massG', L('catalog.dimension.mass', 'g')], ['unitMassKgPerM', L('catalog.dimension.unitMass', 'kg/m')],
  ['massKgPerM2', L('catalog.dimension.areaMass', 'kg/m²')], ['areaMm2', L('catalog.dimension.area', 'mm²')],
  ['areaCm2', L('catalog.dimension.area', 'cm²')], ['ixCm4', L('catalog.dimension.ix', 'cm⁴')],
  ['iyCm4', L('catalog.dimension.iy', 'cm⁴')], ['zxCm3', L('catalog.dimension.zx', 'cm³')], ['zyCm3', L('catalog.dimension.zy', 'cm³')],
]);

/** 寸法の鍵と値から表の行(白の一覧の鍵で、有限の数の物だけ。並びは渡した順)。 */
function dimensionRows(dims: Readonly<Record<string, number>>): readonly DimensionRow[] {
  return Object.entries(dims).flatMap(([key, value]): DimensionRow[] => {
    const label = DIMENSION_LABELS.get(key);
    return label === undefined || !Number.isFinite(value) ? [] : [{ key, label: label.label, value, unit: label.unit }];
  });
}

type Pair = readonly [key: string, value: number | null];

/** 鍵と値の組から寸法の表の元(値の無い欄は落とす)。 */
function dimsOf(pairs: readonly Pair[]): Readonly<Record<string, number>> {
  return Object.fromEntries(pairs.flatMap(([key, value]): (readonly [string, number])[] => value === null ? [] : [[key, value]]));
}

/** 今の 8 分類の行の型の欄を、族と同じ鍵の名前に揃える(例 六角ボルトの s は二面幅)。行は model の公開の表から行の鍵で引く。 */
function legacyDims(choice: StandardPartChoice): Readonly<Record<string, number>> {
  const find = <Row extends { readonly key: string }>(table: readonly Row[]): Row | undefined =>
    table.find((row) => `${choice.catalog}:${row.key}` === choice.key);
  switch (choice.catalog) {
    case 'hexBolt': { const r = find(HEX_BOLT_TABLE); return r === undefined ? {} : dimsOf([['nominalDiameter', r.d], ['pitch', r.pitch],
      ['acrossFlats', r.s], ['headHeight', r.k], ['threadLength', r.b1]]); }
    case 'hexNut': { const r = find(HEX_NUT_TABLE); return r === undefined ? {} : dimsOf([['nominalDiameter', r.d], ['pitch', r.pitch],
      ['acrossFlats', r.s], ['heightMax', r.mMax], ['heightMin', r.mMin]]); }
    case 'plainWasher': { const r = find(PLAIN_WASHER_TABLE); return r === undefined ? {} : dimsOf([['nominalDiameter', r.d],
      ['innerDiameter', r.d1], ['outerDiameter', r.d2], ['thickness', r.thickness]]); }
    case 'springWasher': { const r = find(SPRING_WASHER_TABLE); return r === undefined ? {} : dimsOf([['nominalDiameter', r.d],
      ['innerDiameter', r.insideDiameter], ['outerDiameter', r.outsideDiameter], ['width', r.width], ['thickness', r.thickness]]); }
    case 'socketHeadCapScrew': { const r = find(SOCKET_HEAD_CAP_SCREW_TABLE); return r === undefined ? {} : dimsOf([['nominalDiameter', r.d],
      ['pitch', r.pitch], ['headDiameter', r.headDiameter], ['headHeight', r.headHeight], ['socketWidth', r.socketWidth],
      ['socketDepth', r.socketDepth]]); }
    case 'panHeadScrew': { const r = find(PAN_HEAD_SCREW_TABLE); return r === undefined ? {} : dimsOf([['nominalDiameter', r.d],
      ['pitch', r.pitch], ['headDiameter', r.headDiameter], ['headHeight', r.headHeight], ['recessNumber', r.recessNumber]]); }
    case 'deepGrooveBallBearing': { const r = find(ALL_DEEP_GROOVE_BALL_BEARINGS); return r === undefined ? {} : dimsOf([
      ['boreDiameter', r.boreDiameter], ['outsideDiameter', r.outsideDiameter], ['width', r.width], ['minimumChamfer', r.minimumChamfer]]); }
    case 'equalAngle': { const r = find(EQUAL_ANGLE_TABLE); return r === undefined ? {} : dimsOf([['legA', r.a], ['legB', r.b],
      ['thickness', r.thickness], ['innerRadius', r.innerRadius], ['tipRadius', r.tipRadius], ['areaCm2', r.areaCm2],
      ['unitMassKgPerM', r.massKgPerM]]); }
    case 'channel': { const r = find(CHANNEL_TABLE); return r === undefined ? {} : dimsOf([['height', r.height], ['width', r.width],
      ['webThickness', r.webThickness], ['flangeThickness', r.flangeThickness], ['innerRadius', r.innerRadius],
      ['tipRadius', r.tipRadius], ['areaCm2', r.areaCm2], ['unitMassKgPerM', r.massKgPerM]]); }
    case 'hBeam': { const r = find(H_BEAM_TABLE); return r === undefined ? {} : dimsOf([['height', r.height], ['width', r.width],
      ['webThickness', r.webThickness], ['flangeThickness', r.flangeThickness], ['innerRadius', r.innerRadius],
      ['areaCm2', r.areaCm2], ['unitMassKgPerM', r.massKgPerM]]); }
    default: return {};
  }
}

/** 材質別の鋼材の寸法(平鋼・丸鋼・鋼管だけが持つ。形鋼は持たないので表は出ず、線図の外形の幅と高さだけ)。 */
function steelDims(dimensions: NonNullable<SteelProduct['dimensions']>): Readonly<Record<string, number>> {
  return dimsOf([['width', dimensions.width ?? null], ['thickness', dimensions.thickness ?? null],
    ['diameter', dimensions.diameter ?? null], ['outsideDiameter', dimensions.outsideDiameter ?? null],
    ['wallThickness', dimensions.wallThickness ?? null]]);
}

/** 今の 8 分類と鋼材の窓の寸法の図と表。線図は置く時と同じ保存の形から作る(長さは分類の既定。断面は長さで変わらない)。 */
export function standardFigurePart(category: StandardPartCategory, choice: StandardPartChoice,
  dimensionSeries: FastenerDimensionSeries, threadSeries: ThreadSeries): DimensionFigurePart {
  const steel = choice.steelProduct;
  return {
    key: `standard:${category}:${choice.key}:${dimensionSeries}:${threadSeries}`,
    build: () => {
      const committed = commitStandardPartChoice(category, choice.key, defaultLengthSource(category), dimensionSeries, threadSeries);
      return committed.ok ? buildStandardPartFromSource(committed.value.source) : null;
    },
    rows: dimensionRows(steel === undefined ? legacyDims(choice) : steelDims(steel.dimensions ?? {})),
    marks: [],
  };
}

/**
 * 族の窓の寸法の図と表。線図は置く時と同じ保存の形から作り、今の指定の値が通らない時(打ちかけの長さなど)は既定の値で作る。
 * 表の下に、行の要確認の理由と、簡略にした所を出す。
 */
export function familyFigurePart(family: LoadedFamily, row: FamilyRow, values: Readonly<Record<string, string>>): DimensionFigurePart {
  const marks: DimensionMark[] = [];
  if (!row.verified) marks.push({ kind: 'unverified', parts: [row.note] });
  if (row.simplified !== undefined && row.simplified.length > 0) marks.push({ kind: 'simplified', parts: row.simplified });
  const source = row.valueSource;
  if (source !== undefined) {
    marks.push({ kind: 'toolScreen', parts: source.fields.flatMap((key) => DIMENSION_LABELS.get(key)?.label ?? []) });
  }
  return {
    key: `family:${family.id}:${family.catalogRevision}:${family.generatorRevision}:${row.key}:${JSON.stringify(values)}`,
    build: () => buildStandardPartFromSource(createCatalogItemSource(family, row, values))
      ?? buildStandardPartFromSource(createCatalogItemSource(family, row)),
    rows: dimensionRows(row.dims),
    marks,
  };
}
