/**
 * 族: 巻きブシュ(すべり軸受の巻いた管、内径 3〜28)。M-20(設計 §2.3)。
 *
 * 寸法は製造元の公開の寸法表(下の `WRAPPED_BUSH_EVIDENCE`、PDF の SHA-256 と頁を記録)の内径 φd・外径 φD・肉厚 T と、
 * 作れる長さ L(部品番号の表に載っている組だけ)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の wrappedBush で、検査が 1 行ずつ照らす。
 * 作れる長さが内径ごとに違うので、行は(内径, 長さ)の組ごとに持つ(表に無い長さは置けない)。
 * **画面・部品の名前・保存の行の鍵には製造元の名前と系列名を出さない**(行の鍵と呼びは寸法で表す)。
 * 形は管の簡略形状(`profiles/bush.ts`)。公差・圧入後の内径・許容荷重は扱わない。
 */
import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const WRAPPED_BUSH_EVIDENCE = {
  title: '資料 K4-3 巻きブシュの寸法表(製造元の公開カタログ、英語版、内径 3〜28)',
  edition: null,
  url: '',
  locator: 'PDF 1 頁(冊子 155〜156 頁)の表: 内径 φd・外径 φD・肉厚 T(155 頁)、長さ L ごとの品番の表(155〜156 頁)',
  sha256: '0a678b4ffc91f638d54202b00266ddd292719ebbde506ebb8829bcab4903637c',
  fetchedDate: '2026-11-14',
} as const;

/** [内径 d, 外径 D, 肉厚 T, 作れる長さ L の一覧](mm)。 */
const ROWS: readonly (readonly [number, number, number, readonly number[]])[] = [
  [3, 5, 1, [3, 4, 5, 6]],
  [4, 6, 1, [3, 4, 5, 6, 8]],
  [5, 7, 1, [3, 4, 5, 6, 8]],
  [6, 8, 1, [3, 4, 5, 6, 7, 8, 10, 12]],
  [7, 9, 1, [5, 6, 7, 8, 10, 12]],
  [8, 10, 1, [5, 6, 7, 8, 10, 12, 15]],
  [9, 11, 1, [6, 10]],
  [10, 12, 1, [6, 7, 8, 10, 12, 15, 20]],
  [12, 14, 1, [6, 8, 10, 12, 15, 20]],
  [13, 15, 1, [8, 10, 12, 15, 20]],
  [14, 16, 1, [8, 10, 12, 14, 15, 16, 20]],
  [15, 17, 1, [8, 10, 12, 15, 20, 25]],
  [16, 18, 1, [10, 12, 15, 20, 25]],
  [17, 19, 1, [10, 15]],
  [18, 20, 1, [10, 12, 15, 20, 25, 30]],
  [19, 22, 1.5, [10, 15, 20]],
  [20, 23, 1.5, [10, 12, 15, 20, 25, 30]],
  [22, 25, 1.5, [10, 12, 15, 20, 25, 30]],
  [24, 27, 1.5, [15, 20, 25, 30]],
  [25, 28, 1.5, [10, 12, 15, 20, 25, 30, 35]],
  [26, 30, 2, [15, 20, 25, 30]],
  [28, 32, 2, [12, 15, 20, 25, 30]],
];

const WRAPPED_BUSH_ROWS: readonly CatalogItemRow[] = ROWS.flatMap(([d, D, T, lengths]) => lengths.map((L): CatalogItemRow => ({
  key: `d${d}-L${L}`,
  size: `${d}×${D}×${L}`,
  standardLabel: '製造元の公開の寸法表',
  densityMaterialId: 'steel',
  dims: { innerDiameter: d, outerDiameter: D, wallThickness: T, length: L },
  evidence: WRAPPED_BUSH_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
})));

function dimensionsOf(row: CatalogItemRow): BushDimensions {
  return { innerDiameter: row.dims.innerDiameter ?? NaN, outerDiameter: row.dims.outerDiameter ?? NaN,
    length: row.dims.length ?? NaN };
}

function bushName(row: CatalogItemRow): string {
  return `巻きブシュ 内径${row.dims.innerDiameter}×外径${row.dims.outerDiameter}×長さ${row.dims.length}`;
}

export const WRAPPED_BUSH_FAMILY: CatalogFamily = {
  id: 'wrapped-bush',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.wrappedBush',
  catalogRevision: 'wrapped-bush-2026-11-r1',
  generatorRevision: 'bush-1',
  options: [],
  stock: 'count',
  diagram: 'bush',
  rows: WRAPPED_BUSH_ROWS,
  build: (row) => buildBushPart(dimensionsOf(row), bushName(row)),
  nominalVolume: (row) => bushVolume(dimensionsOf(row)),
  partName: (row) => bushName(row),
};
