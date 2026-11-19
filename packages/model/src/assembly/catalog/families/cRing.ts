/**
 * 族: C 形止め輪 JIS B 2804:2010 の軸用(呼び 10〜120 の 39 行)と穴用(呼び 10〜125 の 50 行)。A6(付属の組: 軸受の止め輪)の付属の部品。
 *
 * 寸法は JIS B 2804:2010 の抜粋の表の、止め輪の d3(基準寸法)・t(基準寸法)・b(約)・a(約)と、適用する軸(穴)の d5・d1・d2(基準寸法)・
 * m(基準寸法)。呼びの 1 欄・2 欄の別(2 欄は必要に応じて使う呼び)も行の寸法 series に持つ。d0(耳の穴の径の最小)と n(溝から端までの最小)は入れない。
 * 2 つ目の独立の出どころは製造元の表(JIS の呼びの範囲だけを照らす)と 2001 年の版の抜粋で、cRingOracle.fixture.json を検査が照らす
 * (行ごとに、どちらかが 8 欄〔d3・t・b・a・d5・d1・d2・m〕の全部で一致した行だけを入れた)。資料の番号・URL・発行元は担当の資料の記録だけに置く。
 * 形は簡略形状: 偏心の輪・耳・穴・切口を入れず、幅 b の同心の輪を Z 軸の向きに厚さ t で作る(軸用は内径 d3・外径 d3 + 2b、穴用は外径 d3・内径 d3 − 2b)。
 */
import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendRing, withName } from '../../standard/partPrimitives.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

type RingKind = 'shaft' | 'bore';

/** 出どころの欄は JIS の番号と版の年だけを持つ(資料の番号・URL・発行元は製品に書かない。担当の資料の記録に置く。統括の決定 2026-11-19 15:1x)。 */
const C_RING_EVIDENCE = {
  title: 'C 形止め輪の規格の抜粋(JIS B 2804:2010)',
  edition: '2010',
  locator: 'JIS B 2804:2010 の C 形止め輪の軸用・穴用の表: 止め輪の d3・t・b(約)・a(約)、適用する軸(穴)の d5・d1・d2・m、呼びの 1 欄・2 欄',
  reference: 'JIS B 2804:2010',
} as const;

const SIMPLIFIED = ['偏心の輪・耳・穴・切口は作らず、幅 b の同心の輪にしている'] as const;

/** [呼び, 欄(1 か 2), d3, t, b, a, d5, d2, m](mm)。d1 は呼びと同じ。 */
type RingTuple = readonly [string, 1 | 2, number, number, number, number, number, number, number];

const SHAFT_ROWS: readonly RingTuple[] = [
  ['10', 1, 9.3, 1, 1.6, 3, 17, 9.6, 1.15], ['11', 2, 10.2, 1, 1.8, 3.1, 18, 10.5, 1.15],
  ['12', 1, 11.1, 1, 1.8, 3.2, 19, 11.5, 1.15], ['14', 1, 12.9, 1, 2, 3.4, 22, 13.4, 1.15],
  ['15', 1, 13.8, 1, 2.1, 3.5, 23, 14.3, 1.15], ['16', 1, 14.7, 1, 2.2, 3.6, 24, 15.2, 1.15],
  ['17', 1, 15.7, 1, 2.2, 3.7, 25, 16.2, 1.15], ['18', 1, 16.5, 1.2, 2.6, 3.8, 26, 17, 1.35],
  ['19', 2, 17.5, 1.2, 2.7, 3.8, 27, 18, 1.35], ['20', 1, 18.5, 1.2, 2.7, 3.9, 28, 19, 1.35],
  ['22', 1, 20.5, 1.2, 2.7, 4.1, 31, 21, 1.35], ['24', 2, 22.2, 1.2, 3.1, 4.2, 33, 22.9, 1.35],
  ['25', 1, 23.2, 1.2, 3.1, 4.3, 34, 23.9, 1.35], ['26', 2, 24.2, 1.2, 3.1, 4.4, 35, 24.9, 1.35],
  ['28', 1, 25.9, 1.5, 3.1, 4.6, 38, 26.6, 1.65], ['30', 1, 27.9, 1.5, 3.5, 4.8, 40, 28.6, 1.65],
  ['32', 1, 29.6, 1.5, 3.5, 5, 43, 30.3, 1.65], ['35', 1, 32.2, 1.5, 4, 5.4, 46, 33, 1.65],
  ['36', 2, 33.2, 1.75, 4, 5.4, 47, 34, 1.9], ['38', 2, 35.2, 1.75, 4.5, 5.6, 50, 36, 1.9],
  ['40', 1, 37, 1.75, 4.5, 5.8, 53, 38, 1.9], ['42', 2, 38.5, 1.75, 4.5, 6.2, 55, 39.5, 1.9],
  ['45', 1, 41.5, 1.75, 4.8, 6.3, 58, 42.5, 1.9], ['48', 2, 44.5, 1.75, 4.8, 6.5, 62, 45.5, 1.9],
  ['50', 1, 45.8, 2, 5, 6.7, 64, 47, 2.2], ['55', 1, 50.8, 2, 5, 7, 70, 52, 2.2], ['56', 2, 51.8, 2, 5, 7, 71, 53, 2.2],
  ['60', 1, 55.8, 2, 5.5, 7.2, 75, 57, 2.2], ['65', 1, 60.8, 2.5, 6.4, 7.4, 81, 62, 2.7],
  ['70', 1, 65.5, 2.5, 6.4, 7.8, 86, 67, 2.7], ['75', 1, 70.5, 2.5, 7, 7.9, 92, 72, 2.7],
  ['80', 1, 74.5, 2.5, 7.4, 8.2, 97, 76.5, 2.7], ['85', 1, 79.5, 3, 8, 8.4, 103, 81.5, 3.2],
  ['90', 1, 84.5, 3, 8, 8.7, 108, 86.5, 3.2], ['95', 1, 89.5, 3, 8.6, 9.1, 114, 91.5, 3.2],
  ['100', 1, 94.5, 3, 9, 9.5, 119, 96.5, 3.2], ['105', 2, 98, 4, 9.5, 9.8, 125, 101, 4.2],
  ['110', 1, 103, 4, 9.5, 10, 131, 106, 4.2], ['120', 1, 113, 4, 10.3, 10.9, 143, 116, 4.2],
];

const BORE_ROWS: readonly RingTuple[] = [
  ['10', 1, 10.7, 1, 1.8, 3.1, 3, 10.4, 1.15], ['11', 1, 11.8, 1, 1.8, 3.2, 4, 11.4, 1.15],
  ['12', 1, 13, 1, 1.8, 3.3, 5, 12.5, 1.15], ['13', 2, 14.1, 1, 1.8, 3.5, 6, 13.6, 1.15],
  ['14', 1, 15.1, 1, 2, 3.6, 7, 14.6, 1.15], ['15', 2, 16.2, 1, 2, 3.6, 8, 15.7, 1.15],
  ['16', 1, 17.3, 1, 2, 3.7, 8, 16.8, 1.15], ['17', 2, 18.3, 1, 2, 3.8, 9, 17.8, 1.15], ['18', 1, 19.5, 1, 2.5, 4, 10, 19, 1.15],
  ['19', 1, 20.5, 1, 2.5, 4, 11, 20, 1.15], ['20', 1, 21.5, 1, 2.5, 4, 12, 21, 1.15], ['22', 1, 23.5, 1, 2.5, 4.1, 13, 23, 1.15],
  ['24', 2, 25.9, 1.2, 2.5, 4.3, 15, 25.2, 1.35], ['25', 1, 26.9, 1.2, 3, 4.4, 16, 26.2, 1.35],
  ['26', 2, 27.9, 1.2, 3, 4.6, 16, 27.2, 1.35], ['28', 1, 30.1, 1.2, 3, 4.6, 18, 29.4, 1.35],
  ['30', 1, 32.1, 1.2, 3, 4.7, 20, 31.4, 1.35], ['32', 1, 34.4, 1.2, 3.5, 5.2, 21, 33.7, 1.35],
  ['35', 1, 37.8, 1.5, 3.5, 5.2, 24, 37, 1.65], ['36', 2, 38.8, 1.5, 3.5, 5.2, 25, 38, 1.65],
  ['37', 1, 39.8, 1.5, 3.5, 5.2, 26, 39, 1.65], ['38', 2, 40.8, 1.5, 4, 5.3, 27, 40, 1.65],
  ['40', 1, 43.5, 1.75, 4, 5.7, 28, 42.5, 1.9], ['42', 1, 45.5, 1.75, 4, 5.8, 30, 44.5, 1.9],
  ['45', 1, 48.5, 1.75, 4.5, 5.9, 33, 47.5, 1.9], ['47', 1, 50.5, 1.75, 4.5, 6.1, 34, 49.5, 1.9],
  ['48', 2, 51.5, 1.75, 4.5, 6.2, 35, 50.5, 1.9], ['50', 1, 54.2, 2, 4.5, 6.5, 37, 53, 2.2],
  ['52', 1, 56.2, 2, 5.1, 6.5, 39, 55, 2.2], ['55', 1, 59.2, 2, 5.1, 6.5, 41, 58, 2.2],
  ['56', 2, 60.2, 2, 5.1, 6.6, 42, 59, 2.2], ['60', 1, 64.2, 2, 5.5, 6.8, 46, 63, 2.2],
  ['62', 1, 66.2, 2, 5.5, 6.9, 48, 65, 2.2], ['63', 2, 67.2, 2, 5.5, 6.9, 49, 66, 2.2],
  ['65', 2, 69.2, 2.5, 5.5, 7, 50, 68, 2.7], ['68', 1, 72.5, 2.5, 6, 7.4, 53, 71, 2.7],
  ['70', 2, 74.5, 2.5, 6, 7.4, 55, 73, 2.7], ['72', 1, 76.5, 2.5, 6.6, 7.4, 57, 75, 2.7],
  ['75', 1, 79.5, 2.5, 6.6, 7.8, 60, 78, 2.7], ['80', 1, 85.5, 2.5, 7, 8, 64, 83.5, 2.7],
  ['85', 1, 90.5, 3, 7, 8, 69, 88.5, 3.2], ['90', 1, 95.5, 3, 7.6, 8.3, 73, 93.5, 3.2],
  ['95', 1, 100.5, 3, 8, 8.5, 77, 98.5, 3.2], ['100', 1, 105.5, 3, 8.3, 8.8, 82, 103.5, 3.2],
  ['105', 2, 112, 4, 8.9, 9.1, 86, 109, 4.2], ['110', 1, 117, 4, 8.9, 10.2, 89, 114, 4.2],
  ['112', 2, 119, 4, 8.9, 10.2, 90, 116, 4.2], ['115', 2, 122, 4, 9.5, 10.2, 94, 119, 4.2],
  ['120', 1, 127, 4, 9.5, 10.7, 98, 124, 4.2], ['125', 1, 132, 4, 10, 10.7, 103, 129, 4.2],
];

/**
 * 行の寸法。d3 は軸用なら止め輪の内径(innerDiameter)、穴用なら外径(outerDiameter)。appliedDiameter は適用する軸径・穴径 d1(呼びと同じ)、
 * fittedDiameter は d5(軸用ははめた時の外周の最大径、穴用ははめた時の内周の最小径)。
 */
function rowsOf(kind: RingKind, tuples: readonly RingTuple[]): readonly CatalogItemRow[] {
  return tuples.map(([size, series, d3, t, b, a, d5, d2, m]): CatalogItemRow => ({
    key: size,
    size,
    standardLabel: 'JIS B 2804:2010',
    densityMaterialId: 'steel',
    dims: { appliedDiameter: Number(size), [kind === 'shaft' ? 'innerDiameter' : 'outerDiameter']: d3, thickness: t, width: b, lugWidth: a,
      fittedDiameter: d5, grooveDiameter: d2, grooveWidth: m, series },
    evidence: C_RING_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: '',
    simplified: SIMPLIFIED,
  }));
}

/** 簡略の輪の内半径と外半径(mm)。寸法が欠ける・輪にならない行は null。 */
function ringRadii(kind: RingKind, row: CatalogItemRow): readonly [number, number] | null {
  const width = row.dims.width ?? NaN;
  const d3 = (kind === 'shaft' ? row.dims.innerDiameter : row.dims.outerDiameter) ?? NaN;
  const [inner, outer] = kind === 'shaft' ? [d3 / 2, d3 / 2 + width] : [d3 / 2 - width, d3 / 2];
  return Number.isFinite(inner) && Number.isFinite(outer) && inner > 0 && outer > inner ? [inner, outer] : null;
}

function familyOf(kind: RingKind, tuples: readonly RingTuple[]): CatalogFamily {
  const label = kind === 'shaft' ? '軸用' : '穴用';
  const name = (row: CatalogItemRow): string => `${label} C 形止め輪 ${row.size}`;
  const thickness = (row: CatalogItemRow): number => row.dims.thickness ?? NaN;
  return {
    id: kind === 'shaft' ? 'c-ring-shaft' : 'c-ring-bore',
    group: 'mechanical',
    kindKey: kind === 'shaft' ? 'catalog.mechanical.kind.cRingShaft' : 'catalog.mechanical.kind.cRingBore',
    catalogRevision: `c-ring-${kind}-2026-11-r1`,
    generatorRevision: 'c-ring-1',
    options: [],
    stock: 'count',
    diagram: 'washer',
    rows: rowsOf(kind, tuples),
    build: (row): PartDocument | null => {
      const radii = ringRadii(kind, row);
      const t = thickness(row);
      if (radii === null || !(t > 0)) return null;
      return withName(appendRing(createEmptyPartDocument(), radii[0], radii[1], t).document, name(row));
    },
    nominalVolume: (row) => {
      const radii = ringRadii(kind, row);
      const t = thickness(row);
      return radii === null || !(t > 0) ? null : Math.PI * (radii[1] ** 2 - radii[0] ** 2) * t;
    },
    partName: name,
  };
}

export const C_RING_SHAFT_FAMILY: CatalogFamily = familyOf('shaft', SHAFT_ROWS);
export const C_RING_BORE_FAMILY: CatalogFamily = familyOf('bore', BORE_ROWS);
