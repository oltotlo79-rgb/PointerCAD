/**
 * 族: 六角ナットの拡張 JIS B 1181:2014(本体)。M-05(設計 §2.3)。3 つの族(種類)を持つ:
 * - スタイル 1 の今の表(`HEX_NUT_TABLE` の本体 M3〜M20)に無い呼び(M2・M2.5・M3.5 と M22〜M64)
 * - スタイル 2(M5〜M36)
 * - 六角低ナット(両面取り、M2〜M64)
 * 今の六角ナットの分類(スタイル 1 の本体 M3〜M20 と附属書JA)は残し、ここで重ねて持たない。
 *
 * 全高 m(最大)と対辺 S(基準寸法)は、規格の抜粋の頁(下の `HEX_NUT_EXTENDED_EVIDENCE`、資料の番号 と頁を記録)の表を、
 * 頁の画像から読んだ 1 回目の転記。2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の hexNut で、検査が照らす。
 * M1.6 はねじの表(`thread/metricThread.ts`、M2〜M64)に無いので入れない。ねじは並目だけ(細目は今の分類で選べる M3〜M20)。
 * 形は今の六角ナットと同じ作り(`buildHexNutBody`: 対辺 S の六角柱・高さ m 最大・下穴径の通しのねじ穴)。
 */
import { findMetricThread, threadMinorDiameter } from '../../../thread/metricThread.js';
import { buildHexNutBody } from '../../standard/partPrimitives.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const HEX_NUT_EXTENDED_EVIDENCE = {
  title: '資料 K4-5 六角ナットの規格の抜粋(JIS B 1181-2014 本体)',
  edition: '2014',

  locator: 'PDF 1 頁(冊子 134 頁)の表: スタイル1・スタイル2 の全高 m(最大・最小)、六角低ナット 両面取りの m(基準・最小)、対辺 S(基準)',
  reference: 'K4-5',
} as const;

type NutStyle = 'style1' | 'style2' | 'thin';

/** [ねじの呼び, 対辺 S(基準), スタイル1 m 最大・最小, スタイル2 m 最大・最小(無い時 null), 六角低ナット m 基準・最小](mm)。 */
const TABLE: readonly (readonly [string, number, number, number, number | null, number | null, number, number])[] = [
  ['M2', 4, 1.6, 1.35, null, null, 1.2, 0.95],
  ['M2.5', 5, 2, 1.75, null, null, 1.6, 1.35],
  ['M3', 5.5, 2.4, 2.15, null, null, 1.8, 1.55],
  ['M3.5', 6, 2.8, 2.55, null, null, 2, 1.75],
  ['M4', 7, 3.2, 2.9, null, null, 2.2, 1.95],
  ['M5', 8, 4.7, 4.4, 5.1, 4.8, 2.7, 2.45],
  ['M6', 10, 5.2, 4.9, 5.7, 5.4, 3.2, 2.9],
  ['M8', 13, 6.8, 6.44, 7.5, 7.14, 4, 3.7],
  ['M10', 16, 8.4, 8.04, 9.3, 8.94, 5, 4.7],
  ['M12', 18, 10.8, 10.37, 12, 11.57, 6, 5.7],
  ['M14', 21, 12.8, 12.1, 14.1, 13.4, 7, 6.42],
  ['M16', 24, 14.8, 14.1, 16.4, 15.7, 8, 7.42],
  ['M18', 27, 15.8, 15.1, 17.6, 16.9, 9, 8.42],
  ['M20', 30, 18, 16.9, 20.3, 19, 10, 9.1],
  ['M22', 34, 19.4, 18.1, 21.8, 20.5, 11, 9.9],
  ['M24', 36, 21.5, 20.2, 23.9, 22.6, 12, 10.9],
  ['M27', 41, 23.8, 22.5, 26.7, 25.4, 13.5, 12.4],
  ['M30', 46, 25.6, 24.3, 28.6, 27.3, 15, 13.9],
  ['M33', 50, 28.7, 27.4, 32.5, 30.9, 16.5, 15.4],
  ['M36', 55, 31, 29.4, 34.7, 33.1, 18, 16.9],
  ['M39', 60, 33.4, 31.8, null, null, 19.5, 18.2],
  ['M42', 65, 34, 32.4, null, null, 21, 19.7],
  ['M45', 70, 36, 34.4, null, null, 22.5, 21.2],
  ['M48', 75, 38, 36.4, null, null, 24, 22.7],
  ['M52', 80, 42, 40.4, null, null, 26, 24.7],
  ['M56', 85, 45, 43.4, null, null, 28, 26.7],
  ['M60', 90, 48, 46.4, null, null, 30, 28.7],
  ['M64', 95, 51, 49.1, null, null, 32, 30.4],
];

/** 今の六角ナットの分類(スタイル 1 の本体)が持つ呼び。スタイル 1 の族はこれを除く。 */
const CURRENT_STYLE1 = new Set(['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M18', 'M20']);

const STYLE_CODES: Readonly<Record<NutStyle, string>> = { style1: 'S1', style2: 'S2', thin: 'T' };

function nutRow(style: NutStyle, size: string, acrossFlats: number, heightMax: number, heightMin: number): CatalogItemRow {
  const nominalDiameter = Number(size.slice(1));
  return {
    key: `${STYLE_CODES[style]}-${size}`,
    size,
    standardLabel: 'JIS B 1181:2014',
    densityMaterialId: 'steel',
    dims: { nominalDiameter, acrossFlats, heightMax, heightMin, pitch: findMetricThread(size)?.coarsePitch ?? NaN },
    evidence: HEX_NUT_EXTENDED_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: '',
  };
}

const HEX_NUT_STYLE1_ROWS: readonly CatalogItemRow[] = TABLE.filter(([size]) => !CURRENT_STYLE1.has(size))
  .map(([size, s, mMax, mMin]) => nutRow('style1', size, s, mMax, mMin));
const HEX_NUT_STYLE2_ROWS: readonly CatalogItemRow[] = TABLE.flatMap(([size, s, , , mMax, mMin]) =>
  mMax === null || mMin === null ? [] : [nutRow('style2', size, s, mMax, mMin)]);
const HEX_NUT_THIN_ROWS: readonly CatalogItemRow[] = TABLE.map(([size, s, , , , , mBasic, mMin]) =>
  nutRow('thin', size, s, mBasic, mMin));

const NAMES: Readonly<Record<NutStyle, (size: string) => string>> = {
  style1: (size) => `六角ナット ${size}（スタイル1）`,
  style2: (size) => `六角ナット ${size}（スタイル2）`,
  thin: (size) => `六角低ナット ${size}`,
};

function hexNutFamily(style: NutStyle, id: string, kindKey: string, rows: readonly CatalogItemRow[]): CatalogFamily {
  const pitchOf = (row: CatalogItemRow): number => row.dims.pitch ?? NaN;
  return {
    id, group: 'mechanical', kindKey, catalogRevision: 'hex-nut-2026-11-r1', generatorRevision: 'hex-nut-1',
    options: [], stock: 'count', diagram: 'nut', rows,
    build: (row) => (Number.isFinite(pitchOf(row)) ? buildHexNutBody({ designation: row.size,
      nominalDiameter: row.dims.nominalDiameter ?? NaN, acrossFlats: row.dims.acrossFlats ?? NaN, height: row.dims.heightMax ?? NaN },
    { series: 'coarse', pitch: pitchOf(row) }, NAMES[style](row.size)) : null),
    nominalVolume: (row) => {
      const s = row.dims.acrossFlats ?? NaN, m = row.dims.heightMax ?? NaN;
      const hole = threadMinorDiameter(row.dims.nominalDiameter ?? NaN, pitchOf(row));
      const volume = (Math.sqrt(3) / 2 * s ** 2 - Math.PI * (hole / 2) ** 2) * m;
      return Number.isFinite(volume) && volume > 0 ? volume : null;
    },
    partName: (row) => NAMES[style](row.size),
  };
}

export const HEX_NUT_STYLE1_FAMILY = hexNutFamily('style1', 'hex-nut-style1-extended', 'catalog.mechanical.kind.hexNutStyle1',
  HEX_NUT_STYLE1_ROWS);
export const HEX_NUT_STYLE2_FAMILY = hexNutFamily('style2', 'hex-nut-style2', 'catalog.mechanical.kind.hexNutStyle2',
  HEX_NUT_STYLE2_ROWS);
export const HEX_NUT_THIN_FAMILY = hexNutFamily('thin', 'hex-nut-thin', 'catalog.mechanical.kind.hexNutThin', HEX_NUT_THIN_ROWS);
