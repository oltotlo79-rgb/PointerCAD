/**
 * 族: 資料 SF-1(アルミ構造材の総合カタログ)で寸法が確認できる溝つきアルミフレームの断面を、溝幅ごとに 3 つの族にした物
 * (`t-slot-frame-s6`・`t-slot-frame-s8`・`t-slot-frame-s10`。統括の決定 2026-11-16)。製造元の名前・型番は書かない(呼びは「溝幅 8 30×30（軽量形）」の形)。
 *
 * 行は、資料の 2 回の独立の読みが一致した断面だけ(行の表 `frameCatalogRows.ts` は道具が生成し、検査が 2 回目の読みの fixture と 1 行ずつ照らす)。
 * 断面は図に記入がある寸法(外形・溝の口・肩の厚さ・溝の中の幅と深さ・面ごとの溝の数と列の間隔・中心の穴・外の角の丸み・記入のある四隅の穴)だけで作る
 * 簡略の形(`profiles/tSlot.ts`。溝の部屋の側面 45°、四隅の中空・中心の穴の周りの形・仕切りは作らない)。**質量は形から計算せず、
 * 行の単位質量 × 長さ**(`nominalMassG`。資料の断面性能の表、表に行が無い断面は図の頁の箱の値)。断面積・Ix・Iy・Zx・Zy は表の値を持つ(表示と記録用)。
 */
import { buildProfileSection } from '../../standard/profileExtrusion.js';
import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { tSlotProfile, tSlotSectionBounds, type TSlotDimensions } from '../profiles/tSlot.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { T_SLOT_CATALOG_RECORDS } from './frameCatalogRows.js';

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
}

const SLOTS = [6, 8, 10] as const;
const FACE_KEYS = [['t', 'slotTop'], ['b', 'slotBottom'], ['l', 'slotLeft'], ['r', 'slotRight']] as const;

/** 出どころの欄(資料の番号と頁だけ。資料の SHA-256 と題名の対応は担当の記録に置き、製品に入れない)。 */
function evidenceOf(record: TSlotCatalogRecord): CatalogItemRow['evidence'] {
  const properties = record.tablePage === null
    ? `PDF ${record.figurePage} 頁 図の箱(Ix・Iy・Zx・Zy・単位質量。断面性能の表に行が無い)`
    : `PDF ${record.tablePage} 頁 断面性能の表(断面積・Ix・Iy・Zx・Zy・単位質量)`;
  return { title: '資料 SF-1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', edition: null, url: '',
    locator: `PDF ${record.figurePage} 頁 断面の図(外形・溝・穴・角の丸み)／${properties}`, sha256: '', fetchedDate: '' };
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
      ...presentValues({ areaMm2: record.areaMm2, ixCm4: record.ixCm4, iyCm4: record.iyCm4, zxCm3: record.zxCm3, zyCm3: record.zyCm3 }) },
    evidence: evidenceOf(record),
    verification: 'manufacturer-catalog',
    verified: true,
    note: withheld ? '内側の形は簡略。質量は単位質量の値。断面の値は資料の表と頁の箱で向きが食い違うので持たない' : '内側の形は簡略。質量は単位質量の値',
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

function familyOf(slot: (typeof SLOTS)[number], rows: readonly CatalogItemRow[]): CatalogFamily {
  return {
    id: `t-slot-frame-s${slot}`,
    group: 'aluminumFrame',
    kindKey: `catalog.frame.kind.tSlotS${slot}`,
    catalogRevision: `t-slot-frame-s${slot}-2026-11-r1`,
    generatorRevision: 't-slot-2',
    options: [lengthOptionSpec('1000')],
    stock: 'linear',
    diagram: 'tSlotSeries',
    rows,
    build: (row, values) => {
      const profile = tSlotProfile(dimensionsOf(row));
      const length = lengthOf(values);
      if (profile === null || length === null || !(length.value > 0)) return null;
      return withName(buildProfileSection(profile, length), frameName(row, values));
    },
    nominalVolume: (row, values) => {
      const profile = tSlotProfile(dimensionsOf(row));
      const length = lengthOf(values)?.value ?? NaN;
      return profile === null || !(length > 0) ? null : profile.areaMm2 * length;
    },
    // 単位質量(kg/m)× 長さ(mm)= 質量(g)。
    nominalMassG: (row, values) => {
      const length = lengthOf(values)?.value ?? NaN;
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      return length > 0 && unitMass > 0 ? unitMass * length : null;
    },
    sectionBounds: (row) => tSlotSectionBounds(dimensionsOf(row)),
    partName: (row, values) => frameName(row, values),
  };
}

/** 行の表から溝幅ごとの 3 族を作る。 */
function tSlotCatalogFamilies(records: readonly TSlotCatalogRecord[]): Readonly<Record<'s6' | 's8' | 's10', CatalogFamily>> {
  const [s6, s8, s10] = SLOTS.map((slot) => familyOf(slot, records.filter((record) => record.slot === slot).map(rowOf)));
  if (s6 === undefined || s8 === undefined || s10 === undefined) throw new Error('溝幅の族が 3 つそろわない');
  return { s6, s8, s10 };
}

export const T_SLOT_CATALOG_FAMILIES = tSlotCatalogFamilies(T_SLOT_CATALOG_RECORDS);
