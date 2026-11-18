/**
 * 族: 製造元の寸法に合わせた溝つきアルミフレームの系列(仮の id `t-slot-frame-series`。統括の仮の決定 2026-11-16 11:59。
 * 利用者に確かめる前の仮の形で、後で変えられる)。E-03 の汎用の族(寸法指定)とは別。
 *
 * 行は、取付けに効く寸法(外形 W×H・溝の口・肩の厚さ・溝の中の幅と深さ・中心の穴の径・外の角の丸み・溝の列の間隔、30 の系列は四隅の穴)と
 * 単位質量(kg/m)を、販売店の公開の頁の数値から持つ(出どころの頁と読んだ日時は作業の記録に置き、製品には入れない)。製造元の名前・型番は書かない。
 * 断面の内側(溝の部屋の側面・斜めの肉・四隅の中空・中心の穴の周りの切り欠き・長方形の中央の仕切り)は数値が無いので、E-03 と同じ簡略形状
 * (`profiles/tSlot.ts`。部屋の側面 45°、中空・切り欠き・仕切り無しの中実)で作る。そのため形の体積は実物より大きく、**質量は形から計算せず、
 * 行の単位質量 × 長さで出す**(`nominalMassG`。部品表・切断の一覧)。重心は一様な断面なので形のままでよい。
 */
import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredMassLength, miteredSectionVolume } from '../miterOption.js';
import { tSlotProfile, tSlotSectionBounds, tSlotSlots, type TSlotDimensions } from '../profiles/tSlot.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は値の種類だけを書く(頁の URL・読んだ日時は製品に入れない。統括の決定 案 A)。 */
const T_SLOT_SERIES_EVIDENCE = {
  title: '販売店の公開の頁の数値(製造元の寸法に合わせた物)',
  edition: null,
  url: '',
  locator: '',
  sha256: '',
  fetchedDate: '',
} as const;

/** [鍵, 呼び, W, H, 溝の口, 中の幅, 肩, 中の深さ, 中心の穴, 角 R, 列の間隔, 四隅の穴の径, 四隅の穴の位置, 単位質量 kg/m]。 */
const ROWS: readonly (readonly [string, string, number, number, number, number, number, number, number, number, number, number, number,
  number])[] = [
  ['s6-20x20', '溝幅 6 20×20', 20, 20, 6, 12, 2, 4, 4.2, 1, 20, 0, 0, 0.49],
  ['s6-20x40', '溝幅 6 20×40', 20, 40, 6, 12, 2, 4, 4.2, 1, 20, 0, 0, 0.87],
  ['s8-30x30', '溝幅 8 30×30', 30, 30, 8, 16.5, 2, 7, 6.8, 2, 30, 4.2, 3.4, 0.90],
  ['s8-30x60', '溝幅 8 30×60', 30, 60, 8, 16.5, 2, 7, 6.8, 2, 30, 4.2, 3.4, 1.60],
  ['s10-40x40', '溝幅 10 40×40', 40, 40, 10, 20, 5.5, 7, 10.5, 3, 40, 0, 0, 1.74],
  ['s10-40x80', '溝幅 10 40×80', 40, 80, 10, 20, 5.5, 7, 10.5, 3, 40, 0, 0, 3.01],
];

const T_SLOT_SERIES_ROWS: readonly CatalogItemRow[] = ROWS.map(([key, size, width, height, slotOpening, slotInnerWidth, shoulder,
  slotDepth, centerHole, cornerRadius, slotPitch, cornerHoleDiameter, cornerHoleInset, unitMassKgPerM]): CatalogItemRow => ({
  key,
  size,
  standardLabel: '製造元の寸法に合わせた物',
  materialLabel: 'アルミ',
  densityMaterialId: 'aluminum',
  dims: { width, height, slotOpening, slotInnerWidth, shoulder, slotDepth, centerHole, cornerRadius, slotPitch, cornerHoleDiameter,
    cornerHoleInset, unitMassKgPerM },
  evidence: T_SLOT_SERIES_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '内側の形は簡略。質量は単位質量の値',
}));

function dimensionsOf(row: CatalogItemRow): TSlotDimensions {
  const dims = row.dims;
  return { width: dims.width ?? NaN, height: dims.height ?? NaN, slotPitch: dims.slotPitch ?? NaN, slotOpening: dims.slotOpening ?? NaN,
    shoulder: dims.shoulder ?? NaN, slotInnerWidth: dims.slotInnerWidth ?? NaN, slotDepth: dims.slotDepth ?? NaN,
    centerHole: dims.centerHole ?? NaN, cornerRadius: dims.cornerRadius ?? NaN, cornerHoleDiameter: dims.cornerHoleDiameter ?? NaN,
    cornerHoleInset: dims.cornerHoleInset ?? NaN };
}

function frameName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `アルミフレーム ${row.size}×${lengthText(values)}`;
}

export const T_SLOT_FRAME_SERIES_FAMILY: CatalogFamily = {
  id: 't-slot-frame-series',
  group: 'aluminumFrame',
  kindKey: 'catalog.frame.kind.tSlotSeries',
  catalogRevision: 't-slot-frame-series-2026-11-r1',
  generatorRevision: 't-slot-1',
  // 留めの欄は一括配置の留めの角だけが書く任意の欄(J-01 包み 5)。
  options: [lengthOptionSpec('1000'), ...MITER_OPTION_SPECS],
  stock: 'linear',
  diagram: 'tSlotSeries',
  rows: T_SLOT_SERIES_ROWS,
  build: (row, values) => {
    const profile = tSlotProfile(dimensionsOf(row));
    const length = lengthOf(values);
    if (profile === null || length === null || !(length.value > 0)) return null;
    const document = buildMiteredSection(profile, length, tSlotSectionBounds(dimensionsOf(row)), values);
    return document === null ? null : withName(document, frameName(row, values));
  },
  nominalVolume: (row, values) => {
    const profile = tSlotProfile(dimensionsOf(row));
    const length = lengthOf(values)?.value ?? NaN;
    return profile === null || !(length > 0) ? null : miteredSectionVolume(profile, tSlotSectionBounds(dimensionsOf(row)), values, length);
  },
  // 単位質量(kg/m)× 長さ(mm)= 質量(g)。留めの部材の長さは、留めを引いた後の体積 ÷ 断面積(miterOption.ts)。
  nominalMassG: (row, values) => {
    const length = lengthOf(values)?.value ?? NaN;
    const unitMass = row.dims.unitMassKgPerM ?? NaN;
    const massLength = length > 0 ? miteredMassLength(tSlotProfile(dimensionsOf(row)), tSlotSectionBounds(dimensionsOf(row)), values, length)
      : null;
    return massLength !== null && unitMass > 0 ? unitMass * massLength : null;
  },
  sectionBounds: (row) => tSlotSectionBounds(dimensionsOf(row)),
  sectionSlots: (row) => tSlotSlots(dimensionsOf(row)),
  partName: (row, values) => frameName(row, values),
};
