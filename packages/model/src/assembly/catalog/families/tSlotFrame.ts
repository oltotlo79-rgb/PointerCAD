/**
 * 族: 汎用の T スロットフレーム(寸法を指定して作る)。E-03(統括の決定 2026-11-16 11:31)。
 *
 * 規格の寸法の行は持たない(どの製造元の寸法の行でもない)。利用者が 外形・溝の口・肩の厚さ・溝の部屋の幅と深さ・中心の穴・外の角の丸み・長さ を
 * 式で入れ、その断面を押し出す。断面は `profiles/tSlot.ts` の簡略形状(部屋の側面 45° は汎用の形の決まり)。
 * 初めの値は、どの製造元の値でもない丸めた例(40・8・4・18・7・8・2、長さ 1000)。範囲は形が成り立つ条件だけ(根拠の無い上限は置かない)。
 * 長さを持つ族(stock 'linear')なので、置いた部品は切断の一覧の族の行に出る。質量は台帳のアルミ(aluminum)の密度による。
 */
import { evaluateExpression } from '@pointercad/expression';

import { withName } from '../../standard/partPrimitives.js';
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildMiteredSection, MITER_OPTION_SPECS, miteredSectionVolume } from '../miterOption.js';
import { tSlotProfile, tSlotSectionBounds, type TSlotDimensions } from '../profiles/tSlot.js';
import type { CatalogFamily, CatalogItemRow, CatalogOptionSpec } from '../types.js';

/** 資料の値を使わない族の出どころの欄(題に、規格の行ではない事を書く。資料の番号・SHA・頁は無い)。 */
const T_SLOT_FRAME_EVIDENCE = {
  title: '寸法は利用者の指定(資料・規格・製造元の値を使わない汎用の形)',
  edition: null,
  url: '',
  locator: '初めの値は丸めた例(どの製造元の値でもない)。溝の部屋の側面 45° は汎用の形の決まり',
  sha256: '',
  fetchedDate: '',
} as const;

const T_SLOT_FRAME_ROWS: readonly CatalogItemRow[] = [{
  key: 'specified',
  size: '寸法指定',
  standardLabel: '寸法指定(規格の行ではない)',
  materialLabel: 'アルミ',
  densityMaterialId: 'aluminum',
  dims: {},
  evidence: T_SLOT_FRAME_EVIDENCE,
  verification: 'unverified',
  verified: false,
  note: '',
}];

/** 断面の欄(鍵・名前の鍵・初めの値)。長さの欄は共通の lengthOptionSpec。 */
const SECTION_OPTIONS: readonly (readonly [string, string])[] = [
  ['width', '40'], ['slotOpening', '8'], ['shoulder', '4'], ['slotInnerWidth', '18'], ['slotDepth', '7'], ['centerHole', '8'],
  ['cornerRadius', '2'],
];

const OPTIONS: readonly CatalogOptionSpec[] = [
  ...SECTION_OPTIONS.map(([key, defaultValue]): CatalogOptionSpec => ({ key, kind: 'lengthExpression',
    labelKey: `catalog.frame.option.${key}`, defaultValue })),
  lengthOptionSpec('1000'),
  // 一括配置の留めの角だけが書く任意の欄(J-01 包み 5)。
  ...MITER_OPTION_SPECS,
];

function numberOf(values: Readonly<Record<string, string>>, key: string): number {
  const result = evaluateExpression(values[key] ?? '');
  return result.ok ? result.value.value : NaN;
}

/** 汎用の族は正方形(長い辺 = 短い辺、溝は各面に 1 つ)で、四隅の穴は持たない。 */
function dimensionsOf(values: Readonly<Record<string, string>>): TSlotDimensions {
  const width = numberOf(values, 'width');
  return { width, height: width, slotPitch: width, slotOpening: numberOf(values, 'slotOpening'), shoulder: numberOf(values, 'shoulder'),
    slotInnerWidth: numberOf(values, 'slotInnerWidth'), slotDepth: numberOf(values, 'slotDepth'),
    centerHole: numberOf(values, 'centerHole'), cornerRadius: numberOf(values, 'cornerRadius'), cornerHoleDiameter: 0, cornerHoleInset: 0 };
}

function frameName(values: Readonly<Record<string, string>>): string {
  return `アルミフレーム(寸法指定) ${dimensionsOf(values).width}角×${lengthText(values)}`;
}

export const T_SLOT_FRAME_FAMILY: CatalogFamily = {
  id: 't-slot-frame-specified',
  group: 'aluminumFrame',
  kindKey: 'catalog.frame.kind.tSlotSpecified',
  catalogRevision: 't-slot-frame-specified-2026-11-r1',
  generatorRevision: 't-slot-1',
  options: OPTIONS,
  stock: 'linear',
  diagram: 'tSlotFrame',
  rows: T_SLOT_FRAME_ROWS,
  build: (_row, values) => {
    const profile = tSlotProfile(dimensionsOf(values));
    const length = lengthOf(values);
    if (profile === null || length === null || !(length.value > 0)) return null;
    const document = buildMiteredSection(profile, length, tSlotSectionBounds(dimensionsOf(values)), values);
    return document === null ? null : withName(document, frameName(values));
  },
  nominalVolume: (_row, values) => {
    const profile = tSlotProfile(dimensionsOf(values));
    const length = lengthOf(values)?.value ?? NaN;
    return profile === null || !(length > 0) ? null : miteredSectionVolume(profile, tSlotSectionBounds(dimensionsOf(values)), values, length);
  },
  sectionBounds: (_row, values) => tSlotSectionBounds(dimensionsOf(values)),
  partName: (_row, values) => frameName(values),
};
