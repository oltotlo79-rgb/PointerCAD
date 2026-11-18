/**
 * 族: 単列アンギュラ玉軸受(70・72・73 系、内径 10〜100)。M-23(設計 §2.3)。
 *
 * 寸法は資料 K4-1(深溝玉軸受と同じ転がり軸受の寸法表の分冊、下の `ANGULAR_CONTACT_BALL_BEARING_EVIDENCE`、
 * 資料の番号 と頁を記録)の主要寸法 d・D・B・r(最小)・r1(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の angularContactBallBearing で、検査が照らす。
 * 行は呼び番号ごと。接触角の記号 無表示・B・C と呼び接触角 30°・40°・15° の割り当ては、資料の表(PDF 29〜37 頁の
 * 各頁)の注 2) による(規格の決まりではなく資料の注記を根拠にする。行の `note` に頁と一緒に書く)。主要寸法は記号に
 * よらず同じ。資料に記号つきの行が無い 7300・7301・7302 は記号なしの行だけ(183 行)。
 * 形は深溝玉軸受と同じ簡略形状(内輪・玉の帯・外輪の 3 つの輪、`profiles/radialBearing.ts`)。
 * 接触角・面取り・保持器は形に入れない。荷重・回転の性能・質量の参考値は扱わない。
 */
import { buildRadialBearingPart, radialBearingVolume, type RadialBearingDimensions } from '../profiles/radialBearing.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const ANGULAR_CONTACT_BALL_BEARING_EVIDENCE = {
  title: '資料 K4-1 単列アンギュラ玉軸受の寸法表(製造元の公開カタログ)',
  edition: null,

  locator: 'PDF 29〜37 頁(冊子 B56〜B73)単列アンギュラ玉軸受の表: 主要寸法 d・D・B・r(最小)・r1(最小)、注 2)(接触角の記号と呼び接触角)',
  reference: 'K4-1',
} as const;

/** [記号なしの呼び番号, d, D, B, r(最小), r1(最小)](mm)。系列ごとに内径の順。 */
const BASES: readonly (readonly [string, number, number, number, number, number])[] = [
  ['7000', 10, 26, 8, 0.3, 0.15], ['7001', 12, 28, 8, 0.3, 0.15], ['7002', 15, 32, 9, 0.3, 0.15],
  ['7003', 17, 35, 10, 0.3, 0.15], ['7004', 20, 42, 12, 0.6, 0.3], ['7005', 25, 47, 12, 0.6, 0.3],
  ['7006', 30, 55, 13, 1, 0.6], ['7007', 35, 62, 14, 1, 0.6], ['7008', 40, 68, 15, 1, 0.6],
  ['7009', 45, 75, 16, 1, 0.6], ['7010', 50, 80, 16, 1, 0.6], ['7011', 55, 90, 18, 1.1, 0.6],
  ['7012', 60, 95, 18, 1.1, 0.6], ['7013', 65, 100, 18, 1.1, 0.6], ['7014', 70, 110, 20, 1.1, 0.6],
  ['7015', 75, 115, 20, 1.1, 0.6], ['7016', 80, 125, 22, 1.1, 0.6], ['7017', 85, 130, 22, 1.1, 0.6],
  ['7018', 90, 140, 24, 1.5, 1], ['7019', 95, 145, 24, 1.5, 1], ['7020', 100, 150, 24, 1.5, 1],
  ['7200', 10, 30, 9, 0.6, 0.3], ['7201', 12, 32, 10, 0.6, 0.3], ['7202', 15, 35, 11, 0.6, 0.3],
  ['7203', 17, 40, 12, 0.6, 0.3], ['7204', 20, 47, 14, 1, 0.6], ['7205', 25, 52, 15, 1, 0.6],
  ['7206', 30, 62, 16, 1, 0.6], ['7207', 35, 72, 17, 1.1, 0.6], ['7208', 40, 80, 18, 1.1, 0.6],
  ['7209', 45, 85, 19, 1.1, 0.6], ['7210', 50, 90, 20, 1.1, 0.6], ['7211', 55, 100, 21, 1.5, 1],
  ['7212', 60, 110, 22, 1.5, 1], ['7213', 65, 120, 23, 1.5, 1], ['7214', 70, 125, 24, 1.5, 1],
  ['7215', 75, 130, 25, 1.5, 1], ['7216', 80, 140, 26, 2, 1], ['7217', 85, 150, 28, 2, 1],
  ['7218', 90, 160, 30, 2, 1], ['7219', 95, 170, 32, 2.1, 1.1], ['7220', 100, 180, 34, 2.1, 1.1],
  ['7300', 10, 35, 11, 0.6, 0.3], ['7301', 12, 37, 12, 1, 0.6], ['7302', 15, 42, 13, 1, 0.6],
  ['7303', 17, 47, 14, 1, 0.6], ['7304', 20, 52, 15, 1.1, 0.6], ['7305', 25, 62, 17, 1.1, 0.6],
  ['7306', 30, 72, 19, 1.1, 0.6], ['7307', 35, 80, 21, 1.5, 1], ['7308', 40, 90, 23, 1.5, 1],
  ['7309', 45, 100, 25, 1.5, 1], ['7310', 50, 110, 27, 2, 1], ['7311', 55, 120, 29, 2, 1],
  ['7312', 60, 130, 31, 2.1, 1.1], ['7313', 65, 140, 33, 2.1, 1.1], ['7314', 70, 150, 35, 2.1, 1.1],
  ['7315', 75, 160, 37, 2.1, 1.1], ['7316', 80, 170, 39, 2.1, 1.1], ['7317', 85, 180, 41, 3, 1.1],
  ['7318', 90, 190, 43, 3, 1.1], ['7319', 95, 200, 45, 3, 1.1], ['7320', 100, 215, 47, 3, 1.1],
];

/** 接触角の記号と呼び接触角(°)。資料の表の注 2) による(無表示 30°・B 40°・C 15°)。 */
const CONTACT_ANGLES = [['', 30], ['B', 40], ['C', 15]] as const;

/** 行の記録に残す、接触角の割り当ての根拠(資料の番号・頁・注の番号)。 */
function contactAngleNote(symbol: string, angle: number): string {
  return `接触角の記号 ${symbol === '' ? '無表示' : symbol} は呼び接触角 ${angle}°(資料 K4-1 PDF 29〜37 頁の表の注 2))`;
}

/** 資料の表に接触角の記号つきの行が無い呼び番号。 */
const WITHOUT_ANGLE_SYMBOLS: ReadonlySet<string> = new Set(['7300', '7301', '7302']);

const ANGULAR_CONTACT_BALL_BEARING_ROWS: readonly CatalogItemRow[] = BASES.flatMap(([base, d, D, B, r, r1]) =>
  CONTACT_ANGLES.filter(([symbol]) => symbol === '' || !WITHOUT_ANGLE_SYMBOLS.has(base)).map(([symbol, angle]): CatalogItemRow => ({
    key: `${base}${symbol}`,
    size: `${base}${symbol}`,
    standardLabel: '製造元の公開の寸法表(単列アンギュラ玉軸受)',
    densityMaterialId: 'steel',
    dims: { boreDiameter: d, outsideDiameter: D, width: B, minimumChamfer: r, minimumChamferR1: r1, contactAngle: angle },
    evidence: ANGULAR_CONTACT_BALL_BEARING_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: contactAngleNote(symbol, angle),
  })));

function dimensionsOf(row: CatalogItemRow): RadialBearingDimensions {
  return { boreDiameter: row.dims.boreDiameter ?? NaN, outsideDiameter: row.dims.outsideDiameter ?? NaN,
    width: row.dims.width ?? NaN };
}

function bearingName(row: CatalogItemRow): string {
  return `アンギュラ玉軸受 ${row.size}`;
}

export const ANGULAR_CONTACT_BALL_BEARING_FAMILY: CatalogFamily = {
  id: 'angular-contact-ball-bearing',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.angularContactBallBearing',
  catalogRevision: 'angular-contact-ball-bearing-2026-11-r1',
  generatorRevision: 'radial-bearing-1',
  options: [],
  stock: 'count',
  diagram: 'bearing',
  rows: ANGULAR_CONTACT_BALL_BEARING_ROWS,
  build: (row) => buildRadialBearingPart(dimensionsOf(row), bearingName(row)),
  nominalVolume: (row) => radialBearingVolume(dimensionsOf(row)),
  partName: (row) => bearingName(row),
};
