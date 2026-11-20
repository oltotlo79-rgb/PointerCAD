/**
 * 族: 鋼製管フランジ(JIS B 2220)の呼び圧力 5K・10K の板(K-28 束 2。設計 wip/k28-design-v2.md)。呼び径 15A〜150A の 11 行ずつ。
 *
 * 寸法(資料の番号・URL・発行元は担当の資料の記録だけに置く。製品には JIS の番号だけ):
 * - 外径 D・厚さ t・座の径 g と高さ f・ボルト穴の中心円 C・穴の数 n と径 h・ボルトのねじの呼び: 互いに独立な 2 つ以上の公開の資料の
 *   JIS B 2220 の接合の寸法の表で一致した値(5K は 3 つ、10K は 2 つの資料の全部の欄。10K の 20A〜150A の外径・中心円・穴・ボルトは
 *   もう 1 つの資料とも一致)。
 * - 中心の穴の径: 合う管(配管用炭素鋼鋼管 JIS G 3452 の黒管)の外径(鋼材の表 `standard/steelCatalog.ts` の値)。差込みの隙間の寸法は
 *   資料に無いので、隙間は作っていない(行の簡略の印に出す)。
 * 閉止フランジ(BL)は、厚さが板と同じかを資料で確かめられないので入れない。
 * 照らす側の値は pipeFlangeOracle.fixture.json。形は `profiles/pipeFlange.ts` の簡略形状(座・ハブ・面取りは作らない)。
 * 材料の種類(SS400 など)は資料の表に無いので、密度の材質を持たない(質量は出さない)。
 */
import { ALL_STEEL_PRODUCTS } from '../../standard/steelCatalog.js';
import { buildPipeFlangePart, pipeFlangeVolume, type PipeFlangeDimensions } from '../profiles/pipeFlange.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

type FlangeGrade = '5k' | '10k';

/** [呼び径 A, 外径 D, 厚さ t, 座の高さ f, 座の径 g, 中心円 C, 穴の数 n, 穴の径 h, ボルトのねじの呼びの径]。 */
type FlangeRecord = readonly [number, number, number, number, number, number, number, number, number];

const RECORDS: Readonly<Record<FlangeGrade, readonly FlangeRecord[]>> = {
  '5k': [
    [15, 80, 9, 1, 44, 60, 4, 12, 10], [20, 85, 10, 1, 49, 65, 4, 12, 10], [25, 95, 10, 1, 59, 75, 4, 12, 10], [32, 115, 12, 2, 70, 90, 4, 15, 12],
    [40, 120, 12, 2, 75, 95, 4, 15, 12], [50, 130, 14, 2, 85, 105, 4, 15, 12], [65, 155, 14, 2, 110, 130, 4, 15, 12],
    [80, 180, 14, 2, 121, 145, 4, 19, 16], [100, 200, 16, 2, 141, 165, 8, 19, 16], [125, 235, 16, 2, 176, 200, 8, 19, 16],
    [150, 265, 18, 2, 206, 230, 8, 19, 16],
  ],
  '10k': [
    [15, 95, 12, 1, 51, 70, 4, 15, 12], [20, 100, 14, 1, 56, 75, 4, 15, 12], [25, 125, 14, 1, 67, 90, 4, 19, 16], [32, 135, 16, 2, 76, 100, 4, 19, 16],
    [40, 140, 16, 2, 81, 105, 4, 19, 16], [50, 155, 16, 2, 96, 120, 4, 19, 16], [65, 175, 18, 2, 116, 140, 4, 19, 16],
    [80, 185, 18, 2, 126, 150, 8, 19, 16], [100, 210, 18, 2, 151, 175, 8, 19, 16], [125, 250, 20, 2, 182, 210, 8, 23, 20],
    [150, 280, 22, 2, 212, 240, 8, 23, 20],
  ],
};

const EVIDENCE = {
  title: '鋼製管フランジ(JIS B 2220)の呼び圧力 5K・10K の接合の寸法',
  edition: null,
  locator: 'JIS B 2220 の表: 外径 D・厚さ t・座の径 g と高さ f・ボルト穴の中心円の径 C・穴の数と径 h・ボルトのねじの呼び。中心の穴は JIS G 3452 の管の外径',
  reference: 'JIS B 2220',
} as const;

const SIMPLIFIED = ['中心の穴は合う管(JIS G 3452)の外径。差込みの隙間は作っていない(隙間の寸法は資料に無い)', '座・ハブ・面取りは作らない'] as const;
const GRADE_TEXT: Readonly<Record<FlangeGrade, string>> = { '5k': '5K', '10k': '10K' };

/** 合う管(JIS G 3452 の黒管)の外径。鋼材の表に無い呼びは undefined。 */
function pipeOutsideDiameter(pipeSize: number): number | undefined {
  return ALL_STEEL_PRODUCTS.find((product) => product.key === `SGP:steelPipe:${String(pipeSize)}A`)?.dimensions?.outsideDiameter;
}

function rowsOf(grade: FlangeGrade): readonly CatalogItemRow[] {
  return RECORDS[grade].flatMap(([pipe, outerDiameter, thickness, faceHeight, faceDiameter, boltCircle, count, hole, bolt]): CatalogItemRow[] => {
    const bore = pipeOutsideDiameter(pipe);
    if (bore === undefined) return [];
    return [{ key: `flange-${grade}-${String(pipe)}A`, size: `${String(pipe)}A`, standardLabel: 'JIS B 2220',
      dims: { outerDiameter, thickness, boreDiameter: bore, holeDiameter: hole, holeCount: count, boltCircleDiameter: boltCircle,
        raisedFaceDiameter: faceDiameter, raisedFaceHeight: faceHeight, boltDiameter: bolt, pipeSize: pipe },
      evidence: EVIDENCE, verification: 'manufacturer-catalog', verified: true, note: '', simplified: SIMPLIFIED }];
  });
}

function dimensionsOf(row: CatalogItemRow): PipeFlangeDimensions {
  const value = (key: string): number => row.dims[key] ?? NaN;
  return { outerDiameter: value('outerDiameter'), thickness: value('thickness'), boreDiameter: value('boreDiameter'),
    boltCircleDiameter: value('boltCircleDiameter'), holeDiameter: value('holeDiameter'), holeCount: value('holeCount') };
}

function flangeFamily(grade: FlangeGrade): CatalogFamily {
  const name = (row: CatalogItemRow): string => `フランジ ${GRADE_TEXT[grade]} ${row.size}`;
  return {
    id: `pipe-flange-${grade}`,
    group: 'piping',
    kindKey: `catalog.piping.kind.flange${GRADE_TEXT[grade]}`,
    catalogRevision: `pipe-flange-${grade}-2026-11-r1`,
    generatorRevision: 'pipe-flange-1',
    options: [],
    stock: 'count',
    diagram: 'pipeFlange',
    rows: rowsOf(grade),
    build: (row) => buildPipeFlangePart(dimensionsOf(row), name(row)),
    nominalVolume: (row) => pipeFlangeVolume(dimensionsOf(row)),
    partName: name,
  };
}

export const PIPE_FLANGE_FAMILIES: Readonly<Record<FlangeGrade, CatalogFamily>> = { '5k': flangeFamily('5k'), '10k': flangeFamily('10k') };
