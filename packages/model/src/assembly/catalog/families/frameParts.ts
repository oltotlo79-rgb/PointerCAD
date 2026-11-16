/**
 * 族: T スロットフレーム用の汎用の部品(寸法を指定して作る)。E-04(統括の決定 2026-11-16 11:52)。
 * 直角のブラケット・つなぎ板・T 溝用のナットの 3 つ。どれも規格の寸法の行は持たず(どの製造元の寸法の行でもない)、利用者が寸法を式で入れる。
 * 初めの値は、どの製造元の値でもない丸めた例。範囲は形が成り立つ条件だけ(根拠の無い上限は置かない)。形は `profiles/frameParts.ts`。
 * T 溝用のナットのねじの呼びは、今あるメートルねじの表(thread/metricThread.ts)の呼びから選び、並目のピッチと谷の径を使う。
 * 質量は台帳の材料の密度による(ブラケット・つなぎ板はアルミ、ナットは鋼)。
 */
import { evaluateExpression } from '@pointercad/expression';

import { METRIC_THREAD_DESIGNATIONS } from '../../../thread/metricThread.js';
import { withName } from '../../standard/partPrimitives.js';
import {
  angleBracketVolume, buildAngleBracketPart, buildJoinPlatePart, buildSlotNutPart, joinPlateVolume, slotNutVolume,
  type AngleBracketDimensions, type JoinPlateDimensions, type SlotNutDimensions,
} from '../profiles/frameParts.js';
import type { CatalogFamily, CatalogItemRow, CatalogOptionSpec } from '../types.js';

/** 資料の値を使わない族の出どころの欄(題に、規格の行ではない事を書く。資料の番号・SHA・頁は無い)。 */
const FRAME_PART_EVIDENCE = {
  title: '寸法は利用者の指定(資料・規格・製造元の値を使わない汎用の形)',
  edition: null,
  url: '',
  locator: '初めの値は丸めた例(どの製造元の値でもない)',
  sha256: '',
  fetchedDate: '',
} as const;

function specifiedRow(materialLabel: string, densityMaterialId: string): readonly CatalogItemRow[] {
  return [{ key: 'specified', size: '寸法指定', standardLabel: '寸法指定(規格の行ではない)', materialLabel, densityMaterialId, dims: {},
    evidence: FRAME_PART_EVIDENCE, verification: 'unverified', verified: false, note: '' }];
}

/** 長さの式の欄(鍵・初めの値)。名前の鍵は `catalog.frame.option.<鍵>`。 */
function lengthOptions(entries: readonly (readonly [string, string])[]): CatalogOptionSpec[] {
  return entries.map(([key, defaultValue]): CatalogOptionSpec => ({ key, kind: 'lengthExpression', labelKey: `catalog.frame.option.${key}`,
    defaultValue }));
}

function numberOf(values: Readonly<Record<string, string>>, key: string): number {
  const result = evaluateExpression(values[key] ?? '');
  return result.ok ? result.value.value : NaN;
}

function bracketOf(values: Readonly<Record<string, string>>): AngleBracketDimensions {
  return { legA: numberOf(values, 'legA'), legB: numberOf(values, 'legB'), width: numberOf(values, 'bracketWidth'),
    thickness: numberOf(values, 'thickness'), rib: numberOf(values, 'rib'), holeDiameter: numberOf(values, 'holeDiameter'),
    holePosition: numberOf(values, 'holePosition') };
}

function plateOf(values: Readonly<Record<string, string>>): JoinPlateDimensions {
  return { length: numberOf(values, 'plateLength'), width: numberOf(values, 'plateWidth'), thickness: numberOf(values, 'thickness'),
    holeDiameter: numberOf(values, 'holeDiameter'), holeCount: numberOf(values, 'holeCount'), holePitch: numberOf(values, 'holePitch') };
}

function nutOf(values: Readonly<Record<string, string>>): SlotNutDimensions {
  return { thread: values.thread ?? '', flangeWidth: numberOf(values, 'flangeWidth'), length: numberOf(values, 'nutLength'),
    flangeThickness: numberOf(values, 'flangeThickness'), neckWidth: numberOf(values, 'neckWidth'),
    neckHeight: numberOf(values, 'neckHeight') };
}

const bracketName = (values: Readonly<Record<string, string>>): string => {
  const dims = bracketOf(values);
  return `直角のブラケット(寸法指定) ${dims.legA}×${dims.legB}×幅${dims.width}`;
};
const plateName = (values: Readonly<Record<string, string>>): string => {
  const dims = plateOf(values);
  return `つなぎ板(寸法指定) ${dims.length}×${dims.width}×厚さ${dims.thickness}`;
};
const nutName = (values: Readonly<Record<string, string>>): string => {
  const dims = nutOf(values);
  return `T 溝用のナット(寸法指定) ${dims.thread} ${dims.flangeWidth}×${dims.length}`;
};

export const ANGLE_BRACKET_FAMILY: CatalogFamily = {
  id: 'angle-bracket-specified',
  group: 'aluminumFrame',
  kindKey: 'catalog.frame.kind.angleBracket',
  catalogRevision: 'angle-bracket-specified-2026-11-r1',
  generatorRevision: 'angle-bracket-1',
  options: [
    ...lengthOptions([['legA', '40'], ['legB', '40'], ['bracketWidth', '20'], ['thickness', '5']]),
    // リブは 0(無し)を許すので数の式(0 以上)。
    { key: 'rib', kind: 'numberExpression', labelKey: 'catalog.frame.option.rib', min: 0, defaultValue: '10' },
    ...lengthOptions([['holeDiameter', '6'], ['holePosition', '25']]),
  ],
  stock: 'count',
  diagram: 'angleBracket',
  rows: specifiedRow('アルミ', 'aluminum'),
  build: (_row, values) => {
    const part = buildAngleBracketPart(bracketOf(values));
    return part === null ? null : withName(part, bracketName(values));
  },
  nominalVolume: (_row, values) => angleBracketVolume(bracketOf(values)),
  partName: (_row, values) => bracketName(values),
};

export const JOIN_PLATE_FAMILY: CatalogFamily = {
  id: 'join-plate-specified',
  group: 'aluminumFrame',
  kindKey: 'catalog.frame.kind.joinPlate',
  catalogRevision: 'join-plate-specified-2026-11-r1',
  generatorRevision: 'join-plate-1',
  options: [
    ...lengthOptions([['plateLength', '80'], ['plateWidth', '20'], ['thickness', '5'], ['holeDiameter', '6']]),
    { key: 'holeCount', kind: 'numberExpression', labelKey: 'catalog.frame.option.holeCount', min: 1, defaultValue: '2' },
    ...lengthOptions([['holePitch', '40']]),
  ],
  stock: 'count',
  diagram: 'joinPlate',
  rows: specifiedRow('アルミ', 'aluminum'),
  build: (_row, values) => {
    const part = buildJoinPlatePart(plateOf(values));
    return part === null ? null : withName(part, plateName(values));
  },
  nominalVolume: (_row, values) => joinPlateVolume(plateOf(values)),
  partName: (_row, values) => plateName(values),
};

export const SLOT_NUT_FAMILY: CatalogFamily = {
  id: 'slot-nut-specified',
  group: 'aluminumFrame',
  kindKey: 'catalog.frame.kind.slotNut',
  catalogRevision: 'slot-nut-specified-2026-11-r1',
  generatorRevision: 'slot-nut-1',
  options: [
    { key: 'thread', kind: 'choice', labelKey: 'catalog.frame.option.thread', choices: METRIC_THREAD_DESIGNATIONS, defaultValue: 'M5' },
    ...lengthOptions([['flangeWidth', '16'], ['nutLength', '16'], ['flangeThickness', '4'], ['neckWidth', '7'], ['neckHeight', '2']]),
  ],
  stock: 'count',
  diagram: 'slotNut',
  rows: specifiedRow('鋼', 'steel'),
  build: (_row, values) => {
    const part = buildSlotNutPart(nutOf(values));
    return part === null ? null : withName(part, nutName(values));
  },
  nominalVolume: (_row, values) => slotNutVolume(nutOf(values)),
  partName: (_row, values) => nutName(values),
};
