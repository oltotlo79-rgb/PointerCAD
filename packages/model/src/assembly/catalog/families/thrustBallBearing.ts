/**
 * 族: 単式スラスト玉軸受 平面座形(511・512 系、内径 10〜100)。M-26(設計 §2.3)。
 *
 * 寸法は資料 K4-1(深溝玉軸受と同じ転がり軸受の寸法表の分冊、下の `THRUST_BALL_BEARING_EVIDENCE`、
 * PDF の SHA-256 と頁を記録)の主要寸法 d・D・T・r(最小)と寸法 d1(最大)・D1(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の thrustBallBearing で、検査が照らす。
 * 行は平面座形の呼び番号ごと(40 行)。調心座形・調心座金付きと 513・514 系は入れない。
 * 形は軸軌道盤(d・d1)・玉の帯・ハウジング軌道盤(D1・D)の 3 つの輪の簡略形状(`profiles/thrustBearing.ts`)。
 * 荷重・回転の性能・質量の参考値は扱わない。
 */
import { buildThrustBearingPart, thrustBearingVolume, type ThrustBearingDimensions } from '../profiles/thrustBearing.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const THRUST_BALL_BEARING_EVIDENCE = {
  title: '資料 K4-1 単式スラスト玉軸受の寸法表(製造元の公開カタログ)',
  edition: null,
  url: '',
  locator: 'PDF 166〜168 頁(冊子 B330〜B335)単式スラスト玉軸受の表: 主要寸法 d・D・T・r(最小)、寸法 d1(最大)・D1(最小)',
  sha256: '7d0d6dd4a346fadb61c0678659f9801a3d136fa12dc40e2081b41c006293d1af',
  fetchedDate: '2026-11-15',
} as const;

/** [呼び番号, d, D, T, r(最小), d1(最大), D1(最小)](mm)。系列ごとに内径の順。 */
const ROWS: readonly (readonly [string, number, number, number, number, number, number])[] = [
  ['51100', 10, 24, 9, 0.3, 24, 11], ['51101', 12, 26, 9, 0.3, 26, 13], ['51102', 15, 28, 9, 0.3, 28, 16],
  ['51103', 17, 30, 9, 0.3, 30, 18], ['51104', 20, 35, 10, 0.3, 35, 21], ['51105', 25, 42, 11, 0.6, 42, 26],
  ['51106', 30, 47, 11, 0.6, 47, 32], ['51107', 35, 52, 12, 0.6, 52, 37], ['51108', 40, 60, 13, 0.6, 60, 42],
  ['51109', 45, 65, 14, 0.6, 65, 47], ['51110', 50, 70, 14, 0.6, 70, 52], ['51111', 55, 78, 16, 0.6, 78, 57],
  ['51112', 60, 85, 17, 1, 85, 62], ['51113', 65, 90, 18, 1, 90, 67], ['51114', 70, 95, 18, 1, 95, 72],
  ['51115', 75, 100, 19, 1, 100, 77], ['51116', 80, 105, 19, 1, 105, 82], ['51117', 85, 110, 19, 1, 110, 87],
  ['51118', 90, 120, 22, 1, 120, 92], ['51120', 100, 135, 25, 1, 135, 102],
  ['51200', 10, 26, 11, 0.6, 26, 12], ['51201', 12, 28, 11, 0.6, 28, 14], ['51202', 15, 32, 12, 0.6, 32, 17],
  ['51203', 17, 35, 12, 0.6, 35, 19], ['51204', 20, 40, 14, 0.6, 40, 22], ['51205', 25, 47, 15, 0.6, 47, 27],
  ['51206', 30, 52, 16, 0.6, 52, 32], ['51207', 35, 62, 18, 1, 62, 37], ['51208', 40, 68, 19, 1, 68, 42],
  ['51209', 45, 73, 20, 1, 73, 47], ['51210', 50, 78, 22, 1, 78, 52], ['51211', 55, 90, 25, 1, 90, 57],
  ['51212', 60, 95, 26, 1, 95, 62], ['51213', 65, 100, 27, 1, 100, 67], ['51214', 70, 105, 27, 1, 105, 72],
  ['51215', 75, 110, 27, 1, 110, 77], ['51216', 80, 115, 28, 1, 115, 82], ['51217', 85, 125, 31, 1, 125, 88],
  ['51218', 90, 135, 35, 1.1, 135, 93], ['51220', 100, 150, 38, 1.1, 150, 103],
];

const THRUST_BALL_BEARING_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, D, T, r, d1, D1]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: '製造元の公開の寸法表(単式スラスト玉軸受)',
  densityMaterialId: 'steel',
  dims: { boreDiameter: d, outsideDiameter: D, height: T, minimumChamfer: r, shaftWasherOutsideDiameter: d1,
    housingWasherBoreDiameter: D1 },
  evidence: THRUST_BALL_BEARING_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function dimensionsOf(row: CatalogItemRow): ThrustBearingDimensions {
  return { boreDiameter: row.dims.boreDiameter ?? NaN, outsideDiameter: row.dims.outsideDiameter ?? NaN,
    height: row.dims.height ?? NaN, shaftWasherOutsideDiameter: row.dims.shaftWasherOutsideDiameter ?? NaN,
    housingWasherBoreDiameter: row.dims.housingWasherBoreDiameter ?? NaN };
}

function bearingName(row: CatalogItemRow): string {
  return `スラスト玉軸受 ${row.size}`;
}

export const THRUST_BALL_BEARING_FAMILY: CatalogFamily = {
  id: 'thrust-ball-bearing-flat-seat',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.thrustBallBearing',
  catalogRevision: 'thrust-ball-bearing-2026-11-r1',
  generatorRevision: 'thrust-bearing-1',
  options: [],
  stock: 'count',
  diagram: 'bearing',
  rows: THRUST_BALL_BEARING_ROWS,
  build: (row) => buildThrustBearingPart(dimensionsOf(row), bearingName(row)),
  nominalVolume: (row) => thrustBearingVolume(dimensionsOf(row)),
  partName: (row) => bearingName(row),
};
