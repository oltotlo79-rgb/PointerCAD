/**
 * 族: 資料 1(アルミ構造材の総合カタログ)で寸法が確認できる溝つきアルミフレームの断面を、溝幅ごとに 3 つの族にした物
 * (`t-slot-frame-s6`・`t-slot-frame-s8`・`t-slot-frame-s10`。統括の決定 2026-11-16)。製造元の名前・型番は書かない(呼びは「溝幅 8 30×30（軽量形）」の形)。
 *
 * 行は、資料の 2 回の独立の読みが一致した断面だけ(行の表 `frameCatalogRows.ts` は道具が生成し、検査が 2 回目の読みの fixture と 1 行ずつ照らす)。
 * 断面は図に記入がある寸法(外形・溝の口・肩の厚さ・溝の中の幅と深さ・面ごとの溝の数と列の間隔・中心の穴・外の角の丸み・記入のある四隅の穴)だけで作る
 * 簡略の形(`profiles/tSlot.ts`。溝の部屋の側面 45°、四隅の中空・中心の穴の周りの形・仕切りは作らない)。**質量は形から計算せず、
 * 行の単位質量 × 長さ**(`nominalMassG`。資料の断面性能の表、表に行が無い断面は図の頁の箱の値)。断面積・Ix・Iy・Zx・Zy は表の値を持つ(表示と記録用)。
 */
import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredMassLength, miteredSectionVolume } from '../miterOption.js';
import {
  slottedOutlineBounds, slottedOutlineProfile, slottedOutlineSlots, type OutlineHole, type OutlineSlot, type SlottedOutline,
} from '../profiles/slottedOutline.js';
import { tSlotProfile, tSlotSectionBounds, tSlotSlots, type TSlotDimensions } from '../profiles/tSlot.js';
import type { CatalogFamily, CatalogItemRow, CatalogSimplifiedKind } from '../types.js';
import { T_SLOT_CATALOG_RECORDS } from './frameCatalogRows.js';
import { T_SLOT_OUTLINE_RECORDS } from './frameOutlineRows.js';

/** 行の表の 1 行(道具が生成する。数は資料の印字のまま。Ix・Iy は cm⁴、Zx・Zy は cm³)。 */
export interface TSlotCatalogRecord {
  readonly key: string;
  readonly size: string;
  readonly slot: 6 | 8 | 10;
  /** 断面の図の PDF の頁。 */
  readonly figurePage: number;
  /** 断面性能の表の PDF の頁(表に行が無い断面は null)。 */
  readonly tablePage: number | null;
  /** 単位質量などの出どころ: 断面性能の表か、図の頁の箱。 */
  readonly massSource: 'table' | 'box';
  readonly width: number;
  readonly height: number;
  readonly slotPitch: number;
  /** 上下の面の溝の数(升の列の数)。 */
  readonly slotsAcross: number;
  /** 溝のある面の頭文字(t 上・b 下・l 左・r 右)。 */
  readonly faces: string;
  readonly slotOpening: number;
  readonly shoulder: number;
  readonly slotInnerWidth: number;
  readonly slotDepth: number;
  readonly centerHole: number;
  readonly cornerRadius: number;
  readonly cornerHoleDiameter: number;
  readonly cornerHoleInset: number;
  /** 表の断面積(表に行が無い断面は null)。 */
  readonly areaMm2: number | null;
  readonly unitMassKgPerM: number;
  /** 断面の値。資料の表と頁の箱で向きが食い違う断面は null(持たない)。 */
  readonly ixCm4: number | null;
  readonly iyCm4: number | null;
  readonly zxCm3: number | null;
  readonly zyCm3: number | null;
  /** 資料の寸法で作らず簡略にした所(例: 位置が参考寸法だけの四隅の穴)。持つ行だけ(選ぶ画面と切断の一覧に印として出す)。 */
  readonly simplified?: readonly string[];
  /** 簡略の印の種類(溝の位置を幅の中央に置いた行は slotPositionSymmetric。フレームの溝への締結の予告が簡略の知らせを出す)。 */
  readonly simplifiedKinds?: readonly CatalogSimplifiedKind[];
  /** L 形の断面だけ: 腕の幅(端のキャップの候補を、腕の幅の同じ L 形のキャップに絞るのに使う)。 */
  readonly armWidth?: number;
  /**
   * 長方形の格子で表せない断面だけ: 外周の指定(行の表 frameOutlineRows.ts。頂点は反時計回り、原点は外形の中心。溝の形は行の口・肩・部屋の値。
   * profiles/slottedOutline.ts)。持つ行は、断面をこの外周で作る。
   */
  readonly outline?: {
    readonly vertices: readonly (readonly [number, number])[];
    readonly radii: readonly number[];
    readonly slots: readonly OutlineSlot[];
    readonly holes: readonly OutlineHole[];
  };
}

const SLOTS = [6, 8, 10] as const;
const FACE_KEYS = [['t', 'slotTop'], ['b', 'slotBottom'], ['l', 'slotLeft'], ['r', 'slotRight']] as const;

/** 出どころの欄(資料の番号と頁だけ。資料の SHA-256 と題名の対応は担当の記録に置き、製品に入れない)。 */
function evidenceOf(record: TSlotCatalogRecord): CatalogItemRow['evidence'] {
  const properties = record.tablePage === null
    ? `PDF ${record.figurePage} 頁 図の箱(Ix・Iy・Zx・Zy・単位質量。断面性能の表に行が無い)`
    : record.massSource === 'box'
      ? `PDF ${record.tablePage} 頁 断面性能の表(断面積・Ix・Iy・Zx・Zy)／PDF ${record.figurePage} 頁 図の箱(単位質量)`
      : `PDF ${record.tablePage} 頁 断面性能の表(断面積・Ix・Iy・Zx・Zy・単位質量)`;
  return { title: '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', edition: null,
    locator: `PDF ${record.figurePage} 頁 断面の図(外形・溝・穴・角の丸み)／${properties}`, reference: '' };
}

/** 行の dims に入れる値(null の値は入れない)。 */
function presentValues(values: Readonly<Record<string, number | null>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]): (readonly [string, number])[] => (value === null ? [] : [[key, value]])));
}

function rowOf(record: TSlotCatalogRecord): CatalogItemRow {
  const faces = Object.fromEntries(FACE_KEYS.map(([letter, key]): readonly [string, number] => [key, record.faces.includes(letter) ? 1 : 0]));
  const withheld = record.ixCm4 === null;
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: 'アルミ',
    densityMaterialId: 'aluminum',
    dims: { width: record.width, height: record.height, slotPitch: record.slotPitch, slotsAcross: record.slotsAcross, ...faces,
      slotOpening: record.slotOpening, shoulder: record.shoulder, slotInnerWidth: record.slotInnerWidth, slotDepth: record.slotDepth,
      centerHole: record.centerHole, cornerRadius: record.cornerRadius, cornerHoleDiameter: record.cornerHoleDiameter,
      cornerHoleInset: record.cornerHoleInset, unitMassKgPerM: record.unitMassKgPerM,
      // outlineSection: 外周の指定を持つ(外周が長方形でない)行の印。端のキャップの候補に、同じ外形の四角のキャップを出さないのに使う。
      ...presentValues({ areaMm2: record.areaMm2, ixCm4: record.ixCm4, iyCm4: record.iyCm4, zxCm3: record.zxCm3, zyCm3: record.zyCm3,
        armWidth: record.armWidth ?? null, outlineSection: record.outline === undefined ? null : 1 }) },
    evidence: evidenceOf(record),
    verification: 'manufacturer-catalog',
    verified: true,
    ...(record.simplified === undefined ? {} : { simplified: record.simplified }),
    ...(record.simplifiedKinds === undefined ? {} : { simplifiedKinds: record.simplifiedKinds }),
    note: withheld ? '内側の形は簡略。質量は単位質量の値。断面の値は資料の表と頁の箱で向きが食い違うので持たない'
      : record.massSource === 'box' && record.tablePage !== null
        ? '内側の形は簡略。質量は単位質量の値(頁の箱の値。断面性能の表の単位質量は断面積と合わないので使わない)' : '内側の形は簡略。質量は単位質量の値',
  };
}

function dimensionsOf(row: CatalogItemRow): TSlotDimensions {
  const dims = row.dims;
  const open = (key: string): boolean => dims[key] === 1;
  return { width: dims.width ?? NaN, height: dims.height ?? NaN, slotPitch: dims.slotPitch ?? NaN, slotsAcross: dims.slotsAcross ?? NaN,
    openFaces: { top: open('slotTop'), bottom: open('slotBottom'), left: open('slotLeft'), right: open('slotRight') },
    slotOpening: dims.slotOpening ?? NaN, shoulder: dims.shoulder ?? NaN, slotInnerWidth: dims.slotInnerWidth ?? NaN,
    slotDepth: dims.slotDepth ?? NaN, centerHole: dims.centerHole ?? NaN, cornerRadius: dims.cornerRadius ?? NaN,
    cornerHoleDiameter: dims.cornerHoleDiameter ?? NaN, cornerHoleInset: dims.cornerHoleInset ?? NaN };
}

function frameName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `アルミフレーム ${row.size}×${lengthText(values)}`;
}

/** 行の断面の輪・外形・溝(外周の指定を持つ行は溝つきの外周の台本、ほかは長方形の格子の台本)。 */
interface SectionOf {
  readonly profile: (row: CatalogItemRow) => ReturnType<typeof tSlotProfile>;
  readonly bounds: (row: CatalogItemRow) => ReturnType<typeof tSlotSectionBounds>;
  readonly slots: (row: CatalogItemRow) => ReturnType<typeof tSlotSlots>;
}

function sectionOf(outlines: ReadonlyMap<string, SlottedOutline>): SectionOf {
  return {
    profile: (row) => {
      const outline = outlines.get(row.key);
      return outline === undefined ? tSlotProfile(dimensionsOf(row)) : slottedOutlineProfile(outline);
    },
    bounds: (row) => {
      const outline = outlines.get(row.key);
      return outline === undefined ? tSlotSectionBounds(dimensionsOf(row)) : slottedOutlineBounds(outline);
    },
    slots: (row) => {
      const outline = outlines.get(row.key);
      return outline === undefined ? tSlotSlots(dimensionsOf(row)) : slottedOutlineSlots(outline);
    },
  };
}

/** 行の外周の指定を、溝つきの外周の台本の入力にする(溝の形は行の口・肩・部屋の値)。 */
function slottedOf(record: TSlotCatalogRecord, outline: NonNullable<TSlotCatalogRecord['outline']>): SlottedOutline {
  return { vertices: outline.vertices, radii: outline.radii, slotOpening: record.slotOpening, shoulder: record.shoulder,
    slotInnerWidth: record.slotInnerWidth, slotDepth: record.slotDepth, slots: outline.slots, holes: outline.holes };
}

function familyOf(slot: (typeof SLOTS)[number], rows: readonly CatalogItemRow[], section: SectionOf): CatalogFamily {
  return {
    id: `t-slot-frame-s${slot}`,
    group: 'aluminumFrame',
    kindKey: `catalog.frame.kind.tSlotS${slot}`,
    catalogRevision: `t-slot-frame-s${slot}-2026-11-r1`,
    generatorRevision: 't-slot-2',
    // 留めの欄は一括配置の留めの角だけが書く任意の欄(J-01 包み 5。miterOption.ts)。
    options: [lengthOptionSpec('1000'), ...MITER_OPTION_SPECS],
    stock: 'linear',
    diagram: 'tSlotSeries',
    rows,
    build: (row, values) => {
      const profile = section.profile(row);
      const length = lengthOf(values);
      if (profile === null || length === null || !(length.value > 0)) return null;
      const document = buildMiteredSection(profile, length, section.bounds(row), values);
      return document === null ? null : withName(document, frameName(row, values));
    },
    nominalVolume: (row, values) => {
      const profile = section.profile(row);
      const length = lengthOf(values)?.value ?? NaN;
      return profile === null || !(length > 0) ? null : miteredSectionVolume(profile, section.bounds(row), values, length);
    },
    // 単位質量(kg/m)× 長さ(mm)= 質量(g)。留めの部材の長さは、留めを引いた後の体積 ÷ 断面積(miterOption.ts)。
    nominalMassG: (row, values) => {
      const length = lengthOf(values)?.value ?? NaN;
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      const massLength = length > 0 ? miteredMassLength(section.profile(row), section.bounds(row), values, length) : null;
      return massLength !== null && unitMass > 0 ? unitMass * massLength : null;
    },
    sectionBounds: (row) => section.bounds(row),
    sectionSlots: (row) => section.slots(row),
    partName: (row, values) => frameName(row, values),
  };
}

/** 行の表から溝幅ごとの 3 族を作る(長方形の格子の行の後に、外周の指定を持つ行)。 */
function tSlotCatalogFamilies(records: readonly TSlotCatalogRecord[]): Readonly<Record<'s6' | 's8' | 's10', CatalogFamily>> {
  const section = sectionOf(new Map(records.flatMap((record): (readonly [string, SlottedOutline])[] =>
    (record.outline === undefined ? [] : [[record.key, slottedOf(record, record.outline)]]))));
  const [s6, s8, s10] = SLOTS.map((slot) => familyOf(slot, records.filter((record) => record.slot === slot).map(rowOf), section));
  if (s6 === undefined || s8 === undefined || s10 === undefined) throw new Error('溝幅の族が 3 つそろわない');
  return { s6, s8, s10 };
}

export const T_SLOT_CATALOG_FAMILIES = tSlotCatalogFamilies([...T_SLOT_CATALOG_RECORDS, ...T_SLOT_OUTLINE_RECORDS]);
