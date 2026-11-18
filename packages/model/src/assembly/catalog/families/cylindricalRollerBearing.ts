/**
 * 族: 単列円筒ころ軸受(内径 20〜100)。M-27(設計 §2.3)。形式(NU・NJ・NUP・N・NF)ごとに 1 つの族にする(呼びの一覧を短くする)。
 *
 * 寸法は資料 K4-1(深溝玉軸受と同じ転がり軸受の寸法表の分冊、下の `CYLINDRICAL_ROLLER_BEARING_EVIDENCE`、
 * 資料の番号 と頁を記録)の主要寸法 d・D・B・r(最小)・r1(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の cylindricalRollerBearing で、検査が照らす。
 * 行の鍵と呼びは JIS の形式記号と基本番号(例 NU204)。資料の呼び番号に付く製造元の補助の記号(末尾の R)は出さない
 * (統括の決定 2026-11-16 02:5x)。主要寸法は基本番号ごとに同じで、記号の付いた行も、同じ基本番号の記号の無い行と
 * 同じ寸法である事を検査が資料の行で確かめる。行は資料にある形式と基本番号の組だけ(409 行)。
 * 形は深溝玉軸受と同じ簡略形状(内輪・ころの帯・外輪の 3 つの輪、`profiles/radialBearing.ts`)。
 * つば・ころ・保持器・L 形つば輪は形に入れない。荷重・回転の性能・質量の参考値は扱わない。
 */
import { buildRadialBearingPart, radialBearingVolume, type RadialBearingDimensions } from '../profiles/radialBearing.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const CYLINDRICAL_ROLLER_BEARING_EVIDENCE = {
  title: '資料 K4-1 単列円筒ころ軸受の寸法表(製造元の公開カタログ)',
  edition: null,

  locator: 'PDF 68〜75 頁(冊子 B134〜B149)単列円筒ころ軸受の表: 主要寸法 d・D・B・r(最小)・r1(最小)、形式ごとの呼び番号',
  reference: 'K4-1',
} as const;

type CylindricalRollerBearingType = 'NU' | 'NJ' | 'NUP' | 'N' | 'NF';

type Basic = readonly [string, number, number, number, number, number];

/** 寸法系列ごとの [基本番号, d, D, B, r(最小), r1(最小)](mm)と、資料にある形式。 */
const SERIES: readonly { readonly types: readonly CylindricalRollerBearingType[]; readonly rows: readonly Basic[] }[] = [
  { types: ['NU', 'NUP'], rows: [
    ['1005', 25, 47, 12, 0.6, 0.3], ['1006', 30, 55, 13, 1, 0.6], ['1007', 35, 62, 14, 1, 0.6], ['1008', 40, 68, 15, 1, 0.6],
    ['1009', 45, 75, 16, 1, 0.6], ['1010', 50, 80, 16, 1, 0.6], ['1011', 55, 90, 18, 1.1, 1], ['1012', 60, 95, 18, 1.1, 1],
    ['1013', 65, 100, 18, 1.1, 1], ['1014', 70, 110, 20, 1.1, 1], ['1015', 75, 115, 20, 1.1, 1], ['1016', 80, 125, 22, 1.1, 1],
    ['1017', 85, 130, 22, 1.1, 1], ['1018', 90, 140, 24, 1.5, 1.1], ['1019', 95, 145, 24, 1.5, 1.1], ['1020', 100, 150, 24, 1.5, 1.1],
  ] },
  { types: ['NU', 'NJ', 'NUP', 'N', 'NF'], rows: [
    ['204', 20, 47, 14, 1, 0.6], ['205', 25, 52, 15, 1, 0.6], ['206', 30, 62, 16, 1, 0.6], ['207', 35, 72, 17, 1.1, 0.6],
    ['208', 40, 80, 18, 1.1, 1.1], ['209', 45, 85, 19, 1.1, 1.1], ['210', 50, 90, 20, 1.1, 1.1], ['211', 55, 100, 21, 1.5, 1.1],
    ['212', 60, 110, 22, 1.5, 1.5], ['213', 65, 120, 23, 1.5, 1.5], ['214', 70, 125, 24, 1.5, 1.5], ['215', 75, 130, 25, 1.5, 1.5],
    ['216', 80, 140, 26, 2, 2], ['217', 85, 150, 28, 2, 2], ['218', 90, 160, 30, 2, 2], ['219', 95, 170, 32, 2.1, 2.1],
    ['220', 100, 180, 34, 2.1, 2.1],
  ] },
  { types: ['NU', 'NJ', 'NUP'], rows: [
    ['2204', 20, 47, 18, 1, 0.6], ['2205', 25, 52, 18, 1, 0.6], ['2206', 30, 62, 20, 1, 0.6], ['2207', 35, 72, 23, 1.1, 0.6],
    ['2208', 40, 80, 23, 1.1, 1.1], ['2209', 45, 85, 23, 1.1, 1.1], ['2210', 50, 90, 23, 1.1, 1.1], ['2211', 55, 100, 25, 1.5, 1.1],
    ['2212', 60, 110, 28, 1.5, 1.5], ['2213', 65, 120, 31, 1.5, 1.5], ['2214', 70, 125, 31, 1.5, 1.5], ['2215', 75, 130, 31, 1.5, 1.5],
    ['2216', 80, 140, 33, 2, 2], ['2217', 85, 150, 36, 2, 2], ['2218', 90, 160, 40, 2, 2], ['2219', 95, 170, 43, 2.1, 2.1],
    ['2220', 100, 180, 46, 2.1, 2.1],
  ] },
  { types: ['NU'], rows: [
    ['3206', 30, 62, 23.8, 1, 1], ['3207', 35, 72, 27, 1.1, 1.1], ['3208', 40, 80, 30.2, 1.1, 1.1], ['3209', 45, 85, 30.2, 1.1, 1.1],
    ['3210', 50, 90, 30.2, 1.1, 1.1], ['3211', 55, 100, 33.3, 1.5, 1.5], ['3212', 60, 110, 36.5, 1.5, 1.5],
    ['3213', 65, 120, 38.1, 1.5, 1.5], ['3214', 70, 125, 39.7, 1.5, 1.5], ['3215', 75, 130, 41.3, 1.5, 1.5],
    ['3216', 80, 140, 44.4, 2, 2], ['3217', 85, 150, 49.2, 2, 2], ['3218', 90, 160, 52.4, 2, 2], ['3219', 95, 170, 55.6, 2.1, 2.1],
    ['3220', 100, 180, 60.3, 2.1, 2.1],
  ] },
  { types: ['NU', 'NJ', 'NUP', 'N', 'NF'], rows: [
    ['304', 20, 52, 15, 1.1, 0.6], ['305', 25, 62, 17, 1.1, 1.1], ['306', 30, 72, 19, 1.1, 1.1], ['307', 35, 80, 21, 1.5, 1.1],
    ['308', 40, 90, 23, 1.5, 1.5], ['309', 45, 100, 25, 1.5, 1.5], ['310', 50, 110, 27, 2, 2], ['311', 55, 120, 29, 2, 2],
    ['312', 60, 130, 31, 2.1, 2.1], ['313', 65, 140, 33, 2.1, 2.1], ['314', 70, 150, 35, 2.1, 2.1], ['315', 75, 160, 37, 2.1, 2.1],
    ['316', 80, 170, 39, 2.1, 2.1], ['317', 85, 180, 41, 3, 3], ['318', 90, 190, 43, 3, 3], ['319', 95, 200, 45, 3, 3],
    ['320', 100, 215, 47, 3, 3],
  ] },
  { types: ['NU', 'NJ', 'NUP'], rows: [
    ['2304', 20, 52, 21, 1.1, 0.6], ['2305', 25, 62, 24, 1.1, 1.1], ['2306', 30, 72, 27, 1.1, 1.1], ['2307', 35, 80, 31, 1.5, 1.1],
    ['2308', 40, 90, 33, 1.5, 1.5], ['2309', 45, 100, 36, 1.5, 1.5], ['2310', 50, 110, 40, 2, 2], ['2311', 55, 120, 43, 2, 2],
    ['2312', 60, 130, 46, 2.1, 2.1], ['2313', 65, 140, 48, 2.1, 2.1], ['2314', 70, 150, 51, 2.1, 2.1], ['2315', 75, 160, 55, 2.1, 2.1],
    ['2316', 80, 170, 58, 2.1, 2.1], ['2317', 85, 180, 60, 3, 3], ['2318', 90, 190, 64, 3, 3], ['2319', 95, 200, 67, 3, 3],
    ['2320', 100, 215, 73, 3, 3],
  ] },
  { types: ['NU'], rows: [
    ['3306', 30, 72, 30.2, 1.1, 1.1], ['3307', 35, 80, 34.9, 1.5, 1.5], ['3308', 40, 90, 36.5, 1.5, 1.5],
    ['3309', 45, 100, 39.7, 1.5, 1.5], ['3310', 50, 110, 44.4, 2, 2], ['3311', 55, 120, 49.2, 2, 2], ['3312', 60, 130, 54, 2.1, 2.1],
    ['3313', 65, 140, 58.7, 2.1, 2.1], ['3314', 70, 150, 63.5, 2.1, 2.1], ['3315', 75, 160, 68.3, 2.1, 2.1],
    ['3316', 80, 170, 68.3, 2.1, 2.1], ['3317', 85, 180, 73, 3, 3], ['3318', 90, 190, 73, 3, 3], ['3319', 95, 200, 77.8, 3, 3],
    ['3320', 100, 215, 82.6, 3, 3],
  ] },
  { types: ['NU', 'NJ', 'NUP', 'N', 'NF'], rows: [
    ['406', 30, 90, 23, 1.5, 1.5], ['407', 35, 100, 25, 1.5, 1.5], ['408', 40, 110, 27, 2, 2], ['409', 45, 120, 29, 2, 2],
    ['410', 50, 130, 31, 2.1, 2.1], ['411', 55, 140, 33, 2.1, 2.1], ['412', 60, 150, 35, 2.1, 2.1], ['413', 65, 160, 37, 2.1, 2.1],
    ['414', 70, 180, 42, 3, 3], ['415', 75, 190, 45, 3, 3], ['416', 80, 200, 48, 3, 3], ['417', 85, 210, 52, 4, 4],
    ['418', 90, 225, 54, 4, 4], ['419', 95, 240, 55, 4, 4], ['420', 100, 250, 58, 4, 4],
  ] },
];

function rowsOf(type: CylindricalRollerBearingType): readonly CatalogItemRow[] {
  return SERIES.filter((series) => series.types.includes(type)).flatMap((series) => series.rows.map(
    ([basic, d, D, B, r, r1]): CatalogItemRow => ({
      key: `${type}${basic}`,
      size: `${type}${basic}`,
      standardLabel: '製造元の公開の寸法表(単列円筒ころ軸受)',
      densityMaterialId: 'steel',
      dims: { boreDiameter: d, outsideDiameter: D, width: B, minimumChamfer: r, minimumChamferR1: r1 },
      evidence: CYLINDRICAL_ROLLER_BEARING_EVIDENCE,
      verification: 'manufacturer-catalog',
      verified: true,
      note: '',
    })));
}

function dimensionsOf(row: CatalogItemRow): RadialBearingDimensions {
  return { boreDiameter: row.dims.boreDiameter ?? NaN, outsideDiameter: row.dims.outsideDiameter ?? NaN,
    width: row.dims.width ?? NaN };
}

function bearingName(row: CatalogItemRow): string {
  return `円筒ころ軸受 ${row.size}`;
}

/** 形式ごとの族の id と種類の名前の鍵(登録の一覧 `registry/k5.ts` と同じ文字)。 */
const IDENTITIES: Readonly<Record<CylindricalRollerBearingType, { readonly id: string; readonly kindKey: string }>> = {
  NU: { id: 'cylindrical-roller-bearing-nu', kindKey: 'catalog.mechanical.kind.cylindricalRollerBearingNU' },
  NJ: { id: 'cylindrical-roller-bearing-nj', kindKey: 'catalog.mechanical.kind.cylindricalRollerBearingNJ' },
  NUP: { id: 'cylindrical-roller-bearing-nup', kindKey: 'catalog.mechanical.kind.cylindricalRollerBearingNUP' },
  N: { id: 'cylindrical-roller-bearing-n', kindKey: 'catalog.mechanical.kind.cylindricalRollerBearingN' },
  NF: { id: 'cylindrical-roller-bearing-nf', kindKey: 'catalog.mechanical.kind.cylindricalRollerBearingNF' },
};

function familyOf(type: CylindricalRollerBearingType): CatalogFamily {
  return {
    ...IDENTITIES[type],
    group: 'mechanical',
    catalogRevision: 'cylindrical-roller-bearing-2026-11-r1',
    generatorRevision: 'radial-bearing-1',
    options: [],
    stock: 'count',
    diagram: 'bearing',
    rows: rowsOf(type),
    build: (row) => buildRadialBearingPart(dimensionsOf(row), bearingName(row)),
    nominalVolume: (row) => radialBearingVolume(dimensionsOf(row)),
    partName: (row) => bearingName(row),
  };
}

/** 形式ごとの族(登録の一覧は形式ごとに 1 行)。 */
export const CYLINDRICAL_ROLLER_BEARING_FAMILIES: Readonly<Record<CylindricalRollerBearingType, CatalogFamily>> = {
  NU: familyOf('NU'), NJ: familyOf('NJ'), NUP: familyOf('NUP'), N: familyOf('N'), NF: familyOf('NF'),
};
