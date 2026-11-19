/**
 * 族: ねじ込み式可鍛鋳鉄製管継手(JIS B 2301)の 90° エルボ・同径チーズ・同径ソケット(K-28 束 1。設計 wip/k28-design-v2.md)。呼び 1/8〜6 の 14 行。
 *
 * 寸法(資料の番号・URL・発行元は担当の資料の記録だけに置く。製品には JIS の番号だけ):
 * - エルボ・チーズの中心から端面まで A、ソケットの長さ L: 互いに独立な 2 つの公開の資料(JIS B 2301 の品の表)で一致した値。
 * - 腕の外径(めねじ側の外径 A1。参考寸法)と、めねじ部の長さ l′(参考寸法): 2 つの公開の資料の継手の端部の寸法の表で一致した値。
 * - 穴の径: 管用テーパねじ(JIS B 0203)の基準径の位置の谷の径 d1(`thread/pipeThread.ts`)。
 * - 合う管の呼び(A)とねじの呼び(B)の対: 2 つの資料の呼びの欄で一致した対(6A＝1/8 … 150A＝6)。
 * 照らす側の値は pipeFittingOracle.fixture.json。形は `profiles/pipeFitting.ts` の簡略形状(帯・リブ・面取り・ねじの山とテーパは作らない)。
 * 可鍛鋳鉄の密度は密度の表に無いので、密度の材質を持たない(質量は出さない。統括の決定 2026-11-17 19:5x の (1) と同じ扱い)。
 */
import { findPipeTaperThread } from '../../../thread/pipeThread.js';
import { buildPipeFittingPart, pipeFittingVolume, type PipeFittingDimensions, type PipeFittingKind } from '../profiles/pipeFitting.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** [ねじの呼び(B), 管の呼び(A の数), エルボの A, チーズの A, ソケットの L, 腕の外径 A1, めねじ部の長さ l′](mm)。 */
type FittingRecord = readonly [string, number, number, number, number, number, number];

const RECORDS: readonly FittingRecord[] = [
  ['1/8', 6, 17, 17, 22, 15, 6], ['1/4', 8, 19, 19, 25, 19, 8], ['3/8', 10, 23, 23, 30, 23, 9],
  ['1/2', 15, 27, 27, 35, 27, 11], ['3/4', 20, 32, 32, 40, 33, 13], ['1', 25, 38, 38, 45, 41, 15],
  ['1 1/4', 32, 46, 46, 50, 50, 17], ['1 1/2', 40, 48, 48, 55, 56, 18], ['2', 50, 57, 57, 60, 69, 20],
  ['2 1/2', 65, 69, 69, 70, 86, 23], ['3', 80, 78, 78, 75, 99, 25], ['4', 100, 97, 97, 85, 127, 28],
  ['5', 125, 113, 113, 95, 154, 30], ['6', 150, 132, 132, 105, 182, 33],
];

/** 出どころの欄は JIS の番号だけを持つ(資料の番号・URL・発行元は製品に書かない)。表の版の年は資料に書いていないので持たない。 */
const FITTING_EVIDENCE = {
  title: 'ねじ込み式可鍛鋳鉄製管継手(JIS B 2301)の中心から端面までの距離・ソケットの長さと、継手の端部の寸法',
  edition: null,
  locator: 'JIS B 2301 の品の表: エルボ・チーズの中心から端面まで A、ソケットの長さ L、端部のめねじ側の外径 A1(参考)・めねじ部の長さ l′(参考)',
  reference: 'JIS B 2301',
} as const;

const SIMPLIFIED = ['帯・リブ・面取り・ねじの山とテーパは作らない。穴は管用テーパねじの基準径の位置の谷の径'] as const;
const KIND_TEXT: Readonly<Record<PipeFittingKind, string>> = { elbow: 'エルボ', tee: 'チーズ', socket: 'ソケット' };

/** 呼びの行。穴の径の引けない呼びは作らない(表の全部の呼びは引ける)。 */
function rowsOf(kind: PipeFittingKind): readonly CatalogItemRow[] {
  return RECORDS.flatMap(([thread, pipe, elbow, tee, socket, outer, femaleLength]): CatalogItemRow[] => {
    const bore = findPipeTaperThread(thread)?.minorDiameter;
    if (bore === undefined) return [];
    return [{ key: `${kind}-${String(pipe)}A`, size: `${String(pipe)}A (Rc${thread})`, standardLabel: 'JIS B 2301',
      dims: { length: kind === 'elbow' ? elbow : kind === 'tee' ? tee : socket, outerDiameter: outer, boreDiameter: bore,
        femaleThreadLength: femaleLength, pipeSize: pipe },
      evidence: FITTING_EVIDENCE, verification: 'manufacturer-catalog', verified: true, note: '', simplified: SIMPLIFIED }];
  });
}

function dimensionsOf(row: CatalogItemRow): PipeFittingDimensions {
  return { length: row.dims.length ?? NaN, outerDiameter: row.dims.outerDiameter ?? NaN, boreDiameter: row.dims.boreDiameter ?? NaN };
}

function fittingFamily(kind: PipeFittingKind): CatalogFamily {
  const name = (row: CatalogItemRow): string => `${KIND_TEXT[kind]} ${row.size}`;
  return {
    id: `pipe-fitting-${kind}`,
    group: 'piping',
    kindKey: `catalog.piping.kind.${kind}`,
    catalogRevision: `pipe-fitting-${kind}-2026-11-r1`,
    generatorRevision: 'pipe-fitting-1',
    options: [],
    stock: 'count',
    diagram: kind === 'elbow' ? 'pipeElbow' : kind === 'tee' ? 'pipeTee' : 'pipeSocket',
    rows: rowsOf(kind),
    build: (row) => buildPipeFittingPart(kind, dimensionsOf(row), name(row)),
    nominalVolume: (row) => pipeFittingVolume(kind, dimensionsOf(row)),
    partName: name,
  };
}

export const PIPE_FITTING_FAMILIES: Readonly<Record<PipeFittingKind, CatalogFamily>> = {
  elbow: fittingFamily('elbow'), tee: fittingFamily('tee'), socket: fittingFamily('socket'),
};
