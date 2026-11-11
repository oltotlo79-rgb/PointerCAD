/** Independent transcription of sources.md §4, checked on 2026-10-24.
 * No application modules are used. JISF documents are amendment drafts, not final JIS texts.
 * Producer lengths are producer offerings, not JIS length requirements or stock guarantees.
 */
export interface OracleCitation {
  readonly url: string;
  readonly locator: string;
}
export interface OracleSource<T> {
  readonly kind: 'source';
  readonly value: T;
  readonly citation: OracleCitation;
}
export interface OracleComputed<T> {
  readonly kind: 'computed';
  readonly value: T;
  readonly formula: string;
  readonly citation: OracleCitation;
}
export interface OracleUnverified {
  readonly kind: 'unverified';
  readonly value: null;
  readonly reason: string;
}
export type OracleValue<T> = OracleSource<T> | OracleComputed<T> | OracleUnverified;
export type OracleCatalog = 'flatBar' | 'roundBar' | 'equalAngle' | 'channel' | 'hBeam' | 'steelPipe';
export interface SteelCatalogOracleRow {
  readonly key: string;
  readonly grade: 'SS400' | 'S45C' | 'SGP';
  readonly catalog: OracleCatalog;
  readonly size: string;
  readonly dimensions: Readonly<Record<string, OracleSource<number>>>;
  /** Printed area when available; otherwise explicitly calculated. Units always mm². */
  readonly areaMm2: OracleSource<number> | OracleComputed<number>;
  readonly exactAreaMm2: OracleComputed<number>;
  readonly massKgPerM: OracleSource<number> | OracleComputed<number>;
  readonly rootRadiusMm: OracleValue<number>;
  readonly tipRadiusMm: OracleValue<number>;
  readonly standardLengthsMm: OracleValue<readonly number[]>;
  readonly legacyPolygonAreaMm2?: OracleComputed<number>;
}

const jis = 'https://www.jisf.or.jp/business/standard/jis/documents/';
const flatSource = { url: 'https://www.nipponsteel.com/product/construction/handbook/pdf/3-52.pdf',
  locator: '2025年9月改訂 PDF p2 標準断面寸法・切断長さ（厚さt×幅b）' };
const roundSource = { url: 'https://www.nipponsteel.com/product/construction/handbook/pdf/5-33.pdf',
  locator: '2025年9月改訂 PDF p1 SS400 断面積mm²・単位質量・標準長さ' };
const brightRoundSource = { url: 'https://taiheikouzai.co.jp/assets/pdf/marukou.pdf',
  locator: 'PDF p1 S45C黄色印 径20/25/30（面積・質量・標準長さの記載なし）' };
const brightFlatSource = { url: 'https://taiheikouzai.co.jp/assets/pdf/hirakou.pdf',
  locator: 'PDF p1 S45C黄色印 W50とT6/T9/T12の交点（面積・質量・標準長さの記載なし）' };
const pipeSource = { url: 'https://www.jfe-steel.co.jp/products/koukan/catalog/e1j-001.pdf',
  locator: 'PDF p12（冊子p10）SGP黒管 寸法・単位質量・標準長さ5500 mm' };
const pipeFormulaSource = { url: `${jis}docs_kouzai_0500_JISG3452_20251217.pdf`,
  locator: '2025-12-17原案 表4、単位質量 W=0.02466t(D−t)、有効数字3桁' };
const sectionFormulaSource = { url: `${jis}docs_kouzai_0400JISG3192_20240724.pdf`,
  locator: '2024-07-24原案 表6 面積計算。0.215/0.349/0.858は丸めた係数。円弧の係数は解析式で評価' };
const angleSource = { url: sectionFormulaSource.url,
  locator: '2024-07-24原案 表8 等辺山形鋼 寸法・r1/r2・面積・質量。大阪製鐵catalog_2403 PDF p4でも照合' };
const channelSource = { url: sectionFormulaSource.url,
  locator: '2024-07-24原案 表12 溝形鋼 寸法・r1/r2・面積・質量。大阪製鐵catalog_2403 PDF p4でも照合' };
const hSource = { url: sectionFormulaSource.url,
  locator: '2024-07-24原案 表15 H形鋼 寸法・r・面積・質量。日本製鉄3-28の広幅150/200/300でも照合' };

const source = <T>(value: T, citation: OracleCitation): OracleSource<T> => ({ kind: 'source', value, citation });
const computed = <T>(value: T, formula: string, citation: OracleCitation): OracleComputed<T> =>
  ({ kind: 'computed', value, formula, citation });
const unverified = (reason: string): OracleUnverified => ({ kind: 'unverified', value: null, reason });
const unknownRadius = (): OracleUnverified => unverified('出典に角半径の記載なし。r=0を出典値とはしない');
const unknownLength = (): OracleUnverified => unverified('参照した寸法表に標準長さの記載なし');

/** The nominal mass convention, not a measured density for a particular S45C heat.
 * Existing flat table: 12×50 mm, A=6.000 cm², W=4.71 kg/m;
 * 4.71/(600 mm²×1 m)=7850 kg/m³=7.85 g/cm³. No density is invented from grade alone.
 */
export const ORACLE_DENSITY_KG_PER_M3 = computed(7850,
  '4.71 kg/m / (600 mm² × 1e-6 m²/mm²) = 7850 kg/m³', flatSource);
const nominalMass = (area: number): OracleComputed<number> => computed(area * 0.00785,
  'A[mm²] × 1e-6 × 7850[kg/m³] × 1[m]; density from 6.000 cm² / 4.71 kg/m flat-table row', flatSource);

function flat(grade: 'SS400' | 'S45C', width: number, thickness: number,
  printed?: readonly [number, number]): SteelCatalogOracleRow {
  const citation = grade === 'SS400' ? flatSource : brightFlatSource;
  const size = `FB ${width}×${thickness}`;
  const area = computed(width * thickness, 'A = width × thickness', citation);
  return { key: `${grade}:flatBar:${size}`, grade, catalog: 'flatBar', size,
    dimensions: { width: source(width, citation), thickness: source(thickness, citation) },
    areaMm2: printed === undefined ? area : source(printed[0], citation), exactAreaMm2: area,
    massKgPerM: printed === undefined ? nominalMass(area.value) : source(printed[1], citation),
    rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(),
    standardLengthsMm: grade === 'SS400' ? source([4500, 5000, 5500, 6000, 6500], citation) : unknownLength() };
}
function round(grade: 'SS400' | 'S45C', diameter: number,
  printed?: readonly [number, number]): SteelCatalogOracleRow {
  const citation = grade === 'SS400' ? roundSource : brightRoundSource;
  const size = `φ${diameter}`;
  const area = computed(Math.PI * diameter ** 2 / 4, 'A = π d² / 4 (unrounded)', citation);
  return { key: `${grade}:roundBar:${size}`, grade, catalog: 'roundBar', size,
    dimensions: { diameter: source(diameter, citation) },
    areaMm2: printed === undefined ? area : source(printed[0], citation), exactAreaMm2: area,
    massKgPerM: printed === undefined ? nominalMass(area.value) : source(printed[1], citation),
    rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(),
    standardLengthsMm: grade === 'SS400' ? source([5500, 6000], citation) : unknownLength() };
}
const quarterCorner = 1 - Math.PI / 4;
function section(catalog: 'equalAngle' | 'channel' | 'hBeam', size: string,
  height: number, width: number, web: number, flange: number, root: number, tip: number | null,
  printedArea: number, printedMass: number): SteelCatalogOracleRow {
  const citation = catalog === 'equalAngle' ? angleSource : catalog === 'channel' ? channelSource : hSource;
  const polygon = catalog === 'equalAngle' ? web * (height + width - web)
    : web * height + 2 * flange * (width - web);
  // For the channel, each 85° root adds r1²(tan(85°/2)−85°/2);
  // each 85° tip removes the same expression with r2. There are two of each.
  // This is the exact counterpart of the rounded coefficient 0.349 in JIS table 6.
  const turn = 85 * Math.PI / 180;
  const correction = catalog === 'equalAngle' ? quarterCorner * (root ** 2 - 2 * (tip ?? 0) ** 2)
    : catalog === 'channel' ? 2 * (root ** 2 - (tip ?? 0) ** 2) * (Math.tan(turn / 2) - turn / 2)
    : 4 * quarterCorner * root ** 2;
  const formula = catalog === 'equalAngle' ? 't(2A−t) + (1−π/4)(r1²−2r2²)'
    : catalog === 'channel' ? 'H tw + 2 tf(B−tw) + 2(r1²−r2²)(tan(85°/2)−85π/360)'
    : 'tw(H−2tf) + 2B tf + 4(1−π/4)r²';
  return { key: `SS400:${catalog}:${size}`, grade: 'SS400', catalog, size,
    dimensions: catalog === 'equalAngle'
      ? { a: source(height, citation), b: source(width, citation), thickness: source(web, citation) }
      : { height: source(height, citation), width: source(width, citation),
        webThickness: source(web, citation), flangeThickness: source(flange, citation) },
    areaMm2: source(printedArea, citation), massKgPerM: source(printedMass, citation),
    exactAreaMm2: computed(polygon + correction, formula, sectionFormulaSource),
    rootRadiusMm: source(root, citation),
    tipRadiusMm: tip === null ? unverified('H形鋼の表に先端半径なし。生成版は先端円弧を付けない') : source(tip, citation),
    standardLengthsMm: unknownLength(),
    legacyPolygonAreaMm2: computed(polygon, 't(A+B−t) or H tw + 2tf(B−tw); no corner arcs', citation) };
}
function pipe(size: string, outsideDiameter: number, wallThickness: number, mass: number): SteelCatalogOracleRow {
  const ro = outsideDiameter / 2;
  const ri = ro - wallThickness;
  const area = computed(Math.PI * (ro ** 2 - ri ** 2), 'A = π((D/2)²−(D/2−t)²)', pipeSource);
  return { key: `SGP:steelPipe:${size}`, grade: 'SGP', catalog: 'steelPipe', size,
    dimensions: { outsideDiameter: source(outsideDiameter, pipeSource), wallThickness: source(wallThickness, pipeSource) },
    areaMm2: area, exactAreaMm2: area, massKgPerM: source(mass, pipeSource),
    rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(), standardLengthsMm: source([5500], pipeSource) };
}

export const STEEL_CATALOG_ORACLE: readonly SteelCatalogOracleRow[] = [
  flat('SS400', 50, 6, [300, 2.36]), flat('SS400', 50, 9, [450, 3.53]),
  flat('SS400', 50, 12, [600, 4.71]), flat('SS400', 100, 6, [600, 4.71]), flat('SS400', 100, 9, [900, 7.06]),
  round('SS400', 13, [132.7, 1.04]), round('SS400', 16, [201.1, 1.58]),
  round('SS400', 19, [283.5, 2.23]), round('SS400', 22, [380.1, 2.98]), round('SS400', 25, [490.9, 3.85]),
  section('equalAngle', 'L 40×40×5', 40, 40, 5, 5, 4.5, 3, 375.5, 2.95),
  section('equalAngle', 'L 50×50×6', 50, 50, 6, 6, 6.5, 4.5, 564.4, 4.43),
  section('equalAngle', 'L 65×65×6', 65, 65, 6, 6, 8.5, 4, 752.7, 5.91),
  section('channel', '[ 75×40×5×7', 75, 40, 5, 7, 8, 4, 881.8, 6.92),
  section('channel', '[ 100×50×5×7.5', 100, 50, 5, 7.5, 8, 4, 1192, 9.36),
  section('channel', '[ 125×65×6×8', 125, 65, 6, 8, 8, 4, 1711, 13.4),
  section('hBeam', 'H 150×150×7×10', 150, 150, 7, 10, 8, null, 3965, 31.1),
  section('hBeam', 'H 200×200×8×12', 200, 200, 8, 12, 13, null, 6353, 49.9),
  section('hBeam', 'H 300×300×10×15', 300, 300, 10, 15, 13, null, 11850, 93.0),
  round('S45C', 20), round('S45C', 25), round('S45C', 30),
  flat('S45C', 50, 6), flat('S45C', 50, 9), flat('S45C', 50, 12),
  pipe('15A', 21.7, 2.8, 1.31), pipe('20A', 27.2, 2.8, 1.68), pipe('25A', 34, 3.2, 2.43),
  pipe('32A', 42.7, 3.5, 3.38), pipe('40A', 48.6, 3.5, 3.89), pipe('50A', 60.5, 3.8, 5.31),
];

export function oraclePipeMass(row: SteelCatalogOracleRow): OracleComputed<number> {
  if (row.catalog !== 'steelPipe') throw new Error('Pipe mass formula requires SGP dimensions');
  const d = row.dimensions.outsideDiameter.value;
  const t = row.dimensions.wallThickness.value;
  return computed(0.02466 * t * (d - t), 'W = 0.02466 t(D−t), kg/m before 3-significant-digit rounding', pipeFormulaSource);
}

export const ORACLE_BOUNDARY_KEYS = [
  'SS400:flatBar:FB 50×6', 'SS400:roundBar:φ13', 'SS400:equalAngle:L 40×40×5',
  'SS400:channel:[ 75×40×5×7', 'SS400:hBeam:H 150×150×7×10', 'SGP:steelPipe:15A',
] as const;
export const ORACLE_LEGACY_KEYS = [
  'SS400:equalAngle:L 40×40×5', 'SS400:channel:[ 75×40×5×7', 'SS400:hBeam:H 150×150×7×10',
] as const;

const hotRoundSource = { url: `${jis}docs_kouzai_0700_JISG4051_20251217.pdf`,
  locator: '2025-12-17原案 PDF p8 7.1.1・表3 丸鋼の括弧なし推奨径（供給長さ・質量なし）; sources.md §2・§4' };
const hotFlatStandardSource = { url: `${jis}docs_kouzai_0500JISG3194_20240724.pdf`,
  locator: '2024-07-24原案 PDF p6 箇条5・表1 厚さ / 表2 幅; sources.md §2・§4' };

/** Independent constants, not imported from or generated by STEEL_PRODUCTS. */
export const S45C_HOT_ROUND_DIAMETERS = [
  11, 13, 16, 19, 22, 25, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50,
  55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 130, 140, 150, 160, 180, 200,
] as const;

/** [thickness mm, width mm, printed area cm², printed kg/m, PDF page].
 * Only the 116 intersections actually printed in the producer table are included.
 * Strings preserve the printed significant figures independently of calculated quantities.
 */
export const S45C_HOT_FLAT_PRINTED = [
  [4.5, 25, '1.125', '0.883', 2],
  [4.5, 32, '1.440', '1.13', 2],
  [4.5, 38, '1.710', '1.34', 2],
  [4.5, 44, '1.980', '1.55', 2],
  [4.5, 50, '2.250', '1.77', 2],
  [4.5, 65, '2.925', '2.30', 2],
  [4.5, 75, '3.375', '2.65', 2],
  [4.5, 90, '4.050', '3.18', 2],
  [4.5, 100, '4.500', '3.53', 2],
  [4.5, 125, '5.625', '4.42', 2],
  [4.5, 150, '6.750', '5.30', 2],
  [4.5, 200, '9.000', '7.06', 2],
  [6, 25, '1.500', '1.18', 2],
  [6, 32, '1.920', '1.51', 2],
  [6, 38, '2.280', '1.79', 2],
  [6, 44, '2.640', '2.07', 2],
  [6, 50, '3.000', '2.36', 2],
  [6, 65, '3.900', '3.06', 2],
  [6, 75, '4.500', '3.53', 2],
  [6, 90, '5.400', '4.24', 2],
  [6, 100, '6.000', '4.71', 2],
  [6, 125, '7.500', '5.89', 2],
  [6, 150, '9.000', '7.06', 2],
  [6, 200, '12.00', '9.42', 2],
  [9, 25, '2.250', '1.77', 2],
  [9, 32, '2.880', '2.26', 2],
  [9, 38, '3.420', '2.68', 2],
  [9, 44, '3.960', '3.11', 2],
  [9, 50, '4.500', '3.53', 2],
  [9, 65, '5.850', '4.59', 2],
  [9, 75, '6.750', '5.30', 2],
  [9, 90, '8.100', '6.36', 2],
  [9, 100, '9.000', '7.06', 2],
  [9, 125, '11.25', '8.83', 2],
  [9, 150, '13.50', '10.6', 2],
  [9, 200, '18.00', '14.1', 2],
  [12, 25, '3.000', '2.36', 2],
  [12, 32, '3.840', '3.01', 2],
  [12, 38, '4.560', '3.58', 2],
  [12, 44, '5.280', '4.14', 2],
  [12, 50, '6.000', '4.71', 2],
  [12, 65, '7.800', '6.12', 2],
  [12, 75, '9.000', '7.06', 2],
  [12, 90, '10.80', '8.48', 2],
  [12, 100, '12.00', '9.42', 2],
  [12, 125, '15.00', '11.8', 2],
  [12, 150, '18.00', '14.1', 2],
  [12, 200, '24.00', '18.8', 2],
  [16, 25, '4.000', '3.14', 2],
  [16, 32, '5.120', '4.02', 2],
  [16, 38, '6.080', '4.77', 2],
  [16, 44, '7.040', '5.53', 2],
  [16, 50, '8.000', '6.28', 2],
  [16, 65, '10.40', '8.16', 2],
  [16, 75, '12.00', '9.42', 2],
  [16, 90, '14.40', '11.3', 2],
  [16, 100, '16.00', '12.6', 2],
  [16, 125, '20.00', '15.7', 2],
  [16, 150, '24.00', '18.8', 2],
  [16, 200, '32.00', '25.1', 3],
  [19, 25, '4.750', '3.73', 3],
  [19, 32, '6.080', '4.77', 3],
  [19, 38, '7.220', '5.67', 3],
  [19, 44, '8.360', '6.56', 3],
  [19, 50, '9.500', '7.46', 3],
  [19, 65, '12.35', '9.69', 3],
  [19, 75, '14.25', '11.2', 3],
  [19, 90, '17.10', '13.4', 3],
  [19, 100, '19.00', '14.9', 3],
  [19, 125, '23.75', '18.6', 3],
  [19, 150, '28.50', '22.4', 3],
  [19, 200, '38.00', '29.8', 3],
  [22, 32, '7.040', '5.53', 3],
  [22, 38, '8.360', '6.56', 3],
  [22, 44, '9.680', '7.60', 3],
  [22, 50, '11.00', '8.64', 3],
  [22, 65, '14.30', '11.2', 3],
  [22, 75, '16.50', '13.0', 3],
  [22, 90, '19.80', '15.5', 3],
  [22, 100, '22.00', '17.3', 3],
  [22, 125, '27.50', '21.6', 3],
  [22, 150, '33.00', '25.9', 3],
  [22, 200, '44.00', '34.5', 3],
  [25, 32, '8.000', '6.28', 3],
  [25, 38, '9.500', '7.46', 3],
  [25, 50, '12.50', '9.81', 3],
  [25, 65, '16.25', '12.8', 3],
  [25, 75, '18.75', '14.7', 3],
  [25, 90, '22.50', '17.7', 3],
  [25, 100, '25.00', '19.6', 3],
  [25, 125, '31.25', '24.5', 3],
  [25, 150, '37.50', '29.4', 3],
  [25, 200, '50.00', '39.2', 3],
  [28, 50, '14.00', '11.0', 3],
  [28, 65, '18.20', '14.3', 3],
  [28, 75, '21.00', '16.5', 3],
  [28, 90, '25.20', '19.8', 3],
  [28, 125, '35.00', '27.5', 3],
  [28, 150, '42.00', '33.0', 3],
  [28, 200, '56.00', '44.0', 3],
  [32, 38, '12.16', '9.55', 3],
  [32, 50, '16.00', '12.6', 3],
  [32, 65, '20.80', '16.3', 3],
  [32, 75, '24.00', '18.8', 3],
  [32, 90, '28.80', '22.6', 3],
  [32, 100, '32.00', '25.1', 3],
  [32, 150, '48.00', '37.7', 3],
  [32, 200, '64.00', '50.2', 3],
  [36, 50, '18.00', '14.1', 3],
  [36, 65, '23.40', '18.4', 3],
  [36, 75, '27.00', '21.2', 3],
  [36, 90, '32.40', '25.4', 3],
  [36, 100, '36.00', '28.3', 3],
  [36, 125, '45.00', '35.3', 3],
  [36, 150, '54.00', '42.4', 3],
  [36, 200, '72.00', '56.5', 3],
] as const;

function hotRoundOracle(diameter: number): SteelCatalogOracleRow {
  const size = `φ${diameter}`;
  const area = computed(Math.PI * diameter ** 2 / 4, 'A = π d² / 4 (unrounded)', hotRoundSource);
  return { key: `S45C:roundBar:${size}:hotRolled`, grade: 'S45C', catalog: 'roundBar', size,
    dimensions: { diameter: source(diameter, hotRoundSource) }, areaMm2: area, exactAreaMm2: area,
    massKgPerM: nominalMass(area.value), rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(),
    standardLengthsMm: unknownLength() };
}
function hotFlatOracle(thickness: number, width: number, page: number): SteelCatalogOracleRow {
  const size = `FB ${width}×${thickness}`;
  const citation = { url: flatSource.url,
    locator: `2025年9月改訂 PDF p${page} 標準断面寸法 厚${thickness}×幅${width} mm / p1 S10C〜S58C; sources.md §3・§4` };
  const area = computed(thickness * width, 'A = thickness × width', hotFlatStandardSource);
  return { key: `S45C:flatBar:${size}:hotRolled`, grade: 'S45C', catalog: 'flatBar', size,
    dimensions: { thickness: source(thickness, citation), width: source(width, citation) },
    areaMm2: area, exactAreaMm2: area, massKgPerM: nominalMass(area.value),
    rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(), standardLengthsMm: unknownLength() };
}

/** Separate from the untouched original 31 rows. No printed quantity is replaced by a calculation. */
export const STEEL_HOT_CATALOG_ORACLE: readonly SteelCatalogOracleRow[] = [
  ...S45C_HOT_ROUND_DIAMETERS.map(hotRoundOracle),
  ...S45C_HOT_FLAT_PRINTED.map(([thickness, width, , , page]) => hotFlatOracle(thickness, width, page)),
];


/** W5 independent JISF G 3194 table 1/2 grid and G 3191 table 1 recommendation set.
 * Existing 31-row and W4b 152-row transcriptions above remain frozen.
 */
const ssFlatDimensionSource = { url: `${jis}docs_kouzai_0500JISG3194_20240724.pdf`,
  locator: '2024-07-24原案 PDF p6 表1 標準厚さ / 表2 標準幅' };
const ssRoundDimensionSource = { url: `${jis}docs_kouzai010_jis12G3191_20210728.pdf`,
  locator: '2021-07-28原案 PDF p6 表1 括弧なし推奨径（5.1: 9 mm未満はバーインコイル）' };
const ssRoundPrintedSource = { url: ssRoundDimensionSource.url,
  locator: '2021-07-28原案 PDF p9 表7 断面積mm²・単位質量kg/m、p8 表6 丸め規則A' };
export const SS400_STANDARD_THICKNESSES = [4.5, 6, 9, 12, 16, 19, 22, 25, 28, 32, 36] as const;
export const SS400_STANDARD_WIDTHS = [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200] as const;
/** Full source table including the five frozen diameters, retaining printed significant digits. */
export const SS400_STANDARD_ROUND_PRINTED = [
  [5.5, '23.76', '0.186'],
  [6, '28.27', '0.222'],
  [7, '38.48', '0.302'],
  [8, '50.27', '0.395'],
  [9, '63.62', '0.499'],
  [10, '78.54', '0.617'],
  [11, '95.03', '0.746'],
  [12, '113.1', '0.888'],
  [13, '132.7', '1.04'],
  [16, '201.1', '1.58'],
  [19, '283.5', '2.23'],
  [20, '314.2', '2.47'],
  [22, '380.1', '2.98'],
  [24, '452.4', '3.55'],
  [25, '490.9', '3.85'],
  [28, '615.8', '4.83'],
  [30, '706.9', '5.55'],
  [32, '804.2', '6.31'],
  [36, '1018', '7.99'],
  [38, '1134', '8.90'],
  [42, '1385', '10.9'],
  [46, '1662', '13.0'],
  [48, '1810', '14.2'],
  [50, '1964', '15.4'],
  [55, '2376', '18.7'],
  [56, '2463', '19.3'],
  [60, '2827', '22.2'],
  [64, '3217', '25.3'],
  [65, '3318', '26.0'],
  [70, '3848', '30.2'],
  [75, '4418', '34.7'],
  [80, '5027', '39.5'],
  [85, '5675', '44.5'],
  [90, '6362', '49.9'],
  [95, '7088', '55.6'],
  [100, '7854', '61.7'],
  [110, '9503', '74.6'],
  [120, '11310', '88.8'],
  [130, '13270', '104'],
  [140, '15390', '121'],
  [150, '17670', '139'],
  [160, '20110', '158'],
  [180, '25450', '200'],
  [200, '31420', '247'],
] as const;
/** G 3191 PDF p9 table 7 prints 0.186 for d=5.5; table 6's rounded-area formula gives 0.187.
 * Retain both literal strings. This is a source-table discrepancy, never a rounding tolerance.
 */
export const SS400_ROUND_PRINTED_DISCREPANCIES = [[5.5, '0.186', '0.187']] as const;
/** Added flat rows with producer printing; values are cm², kg/m, PDF page. */
export const SS400_EXPANSION_FLAT_PRINTED = [
  [9, 25, '2.250', '1.77', 2],
  [9, 32, '2.880', '2.26', 2],
  [9, 38, '3.420', '2.68', 2],
  [9, 44, '3.960', '3.11', 2],
  [9, 65, '5.850', '4.59', 2],
  [9, 75, '6.750', '5.30', 2],
  [9, 90, '8.100', '6.36', 2],
  [9, 125, '11.25', '8.83', 2],
  [9, 150, '13.50', '10.6', 2],
  [9, 200, '18.00', '14.1', 2],
  [4.5, 25, '1.125', '0.883', 2],
  [4.5, 32, '1.440', '1.13', 2],
  [4.5, 38, '1.710', '1.34', 2],
  [4.5, 44, '1.980', '1.55', 2],
  [12, 25, '3.000', '2.36', 2],
  [4.5, 50, '2.250', '1.77', 2],
  [12, 32, '3.840', '3.01', 2],
  [4.5, 65, '2.925', '2.30', 2],
  [12, 38, '4.560', '3.58', 2],
  [4.5, 75, '3.375', '2.65', 2],
  [12, 44, '5.280', '4.14', 2],
  [4.5, 90, '4.050', '3.18', 2],
  [4.5, 100, '4.500', '3.53', 2],
  [12, 65, '7.800', '6.12', 2],
  [4.5, 125, '5.625', '4.42', 2],
  [12, 75, '9.000', '7.06', 2],
  [4.5, 150, '6.750', '5.30', 2],
  [12, 90, '10.80', '8.48', 2],
  [12, 100, '12.00', '9.42', 2],
  [4.5, 200, '9.000', '7.06', 2],
  [12, 125, '15.00', '11.8', 2],
  [12, 150, '18.00', '14.1', 2],
  [12, 200, '24.00', '18.8', 2],
  [6, 25, '1.500', '1.18', 2],
  [6, 32, '1.920', '1.51', 2],
  [6, 38, '2.280', '1.79', 2],
  [6, 44, '2.640', '2.07', 2],
  [6, 65, '3.900', '3.06', 2],
  [16, 25, '4.000', '3.14', 2],
  [6, 75, '4.500', '3.53', 2],
  [16, 32, '5.120', '4.02', 2],
  [6, 90, '5.400', '4.24', 2],
  [16, 38, '6.080', '4.77', 2],
  [16, 44, '7.040', '5.53', 2],
  [6, 125, '7.500', '5.89', 2],
  [16, 50, '8.000', '6.28', 2],
  [6, 150, '9.000', '7.06', 2],
  [16, 65, '10.40', '8.16', 2],
  [16, 75, '12.00', '9.42', 2],
  [6, 200, '12.00', '9.42', 2],
  [16, 90, '14.40', '11.3', 2],
  [16, 100, '16.00', '12.6', 2],
  [16, 125, '20.00', '15.7', 2],
  [16, 150, '24.00', '18.8', 2],
  [16, 200, '32.00', '25.1', 3],
  [28, 50, '14.00', '11.0', 3],
  [28, 65, '18.20', '14.3', 3],
  [28, 75, '21.00', '16.5', 3],
  [28, 90, '25.20', '19.8', 3],
  [28, 125, '35.00', '27.5', 3],
  [19, 25, '4.750', '3.73', 3],
  [28, 150, '42.00', '33.0', 3],
  [19, 32, '6.080', '4.77', 3],
  [28, 200, '56.00', '44.0', 3],
  [19, 38, '7.220', '5.67', 3],
  [19, 44, '8.360', '6.56', 3],
  [32, 38, '12.16', '9.55', 3],
  [19, 50, '9.500', '7.46', 3],
  [32, 50, '16.00', '12.6', 3],
  [19, 65, '12.35', '9.69', 3],
  [32, 65, '20.80', '16.3', 3],
  [19, 75, '14.25', '11.2', 3],
  [32, 75, '24.00', '18.8', 3],
  [19, 90, '17.10', '13.4', 3],
  [32, 90, '28.80', '22.6', 3],
  [19, 100, '19.00', '14.9', 3],
  [32, 100, '32.00', '25.1', 3],
  [19, 125, '23.75', '18.6', 3],
  [32, 150, '48.00', '37.7', 3],
  [19, 150, '28.50', '22.4', 3],
  [32, 200, '64.00', '50.2', 3],
  [19, 200, '38.00', '29.8', 3],
  [36, 50, '18.00', '14.1', 3],
  [36, 65, '23.40', '18.4', 3],
  [36, 75, '27.00', '21.2', 3],
  [36, 90, '32.40', '25.4', 3],
  [22, 32, '7.040', '5.53', 3],
  [36, 100, '36.00', '28.3', 3],
  [22, 38, '8.360', '6.56', 3],
  [36, 125, '45.00', '35.3', 3],
  [22, 44, '9.680', '7.60', 3],
  [36, 150, '54.00', '42.4', 3],
  [22, 50, '11.00', '8.64', 3],
  [22, 65, '14.30', '11.2', 3],
  [36, 200, '72.00', '56.5', 3],
  [22, 75, '16.50', '13.0', 3],
  [22, 90, '19.80', '15.5', 3],
  [22, 100, '22.00', '17.3', 3],
  [22, 125, '27.50', '21.6', 3],
  [22, 150, '33.00', '25.9', 3],
  [22, 200, '44.00', '34.5', 3],
  [25, 32, '8.000', '6.28', 3],
  [25, 38, '9.500', '7.46', 3],
  [25, 50, '12.50', '9.81', 3],
  [25, 65, '16.25', '12.8', 3],
  [25, 75, '18.75', '14.7', 3],
  [25, 90, '22.50', '17.7', 3],
  [25, 100, '25.00', '19.6', 3],
  [25, 125, '31.25', '24.5', 3],
  [25, 150, '37.50', '29.4', 3],
  [25, 200, '50.00', '39.2', 3],
] as const;
/** Two additional source rows absent from the producer table: G 3194 PDF p10 table 6, mm²/kg/m. */
export const SS400_EXPANSION_FLAT_JIS_PRINTED = [
  [28, 100, '2800', '22.0'], [32, 125, '4000', '31.4'],
] as const;

function ss400FlatOracle(thickness: number, width: number): SteelCatalogOracleRow {
  const citation = { ...ssFlatDimensionSource,
    locator: `${ssFlatDimensionSource.locator} 厚${thickness}×幅${width} mm` };
  const exact = computed(thickness * width, 'A = thickness × width (unrounded)', citation);
  const producer = SS400_EXPANSION_FLAT_PRINTED.find(([t, w]) => t === thickness && w === width);
  const jisPrinted = SS400_EXPANSION_FLAT_JIS_PRINTED.find(([t, w]) => t === thickness && w === width);
  const printedCitation = producer === undefined
    ? { url: citation.url, locator: `2024-07-24原案 PDF p10 表6 厚${thickness}×幅${width} mm` }
    : { url: flatSource.url, locator: `2025年9月改訂 PDF p${producer[4]} 厚${thickness}×幅${width} mm` };
  const printedArea = producer === undefined ? jisPrinted?.[2] : String(Number(producer[2]) * 100);
  const printedMass = producer?.[3] ?? jisPrinted?.[3];
  return { key: `SS400:flatBar:FB ${width}×${thickness}`, grade: 'SS400', catalog: 'flatBar',
    size: `FB ${width}×${thickness}`,
    dimensions: { thickness: source(thickness, citation), width: source(width, citation) },
    areaMm2: printedArea === undefined ? exact : source(Number(printedArea), printedCitation),
    exactAreaMm2: exact, massKgPerM: printedMass === undefined ? nominalMass(exact.value) : source(Number(printedMass), printedCitation),
    rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(),
    standardLengthsMm: unverified('原案の標準長さを製造元の供給長さとはしない（供給長さは未確認）') };
}
function ss400RoundOracle(diameter: number, printedArea: string, printedMass: string): SteelCatalogOracleRow {
  const exact = computed(Math.PI * diameter ** 2 / 4, 'A = π d² / 4 (unrounded)', ssRoundDimensionSource);
  return { key: `SS400:roundBar:φ${diameter}`, grade: 'SS400', catalog: 'roundBar', size: `φ${diameter}`,
    dimensions: { diameter: source(diameter, { ...ssRoundDimensionSource,
      locator: `${ssRoundDimensionSource.locator} 径${diameter} mm` }) },
    areaMm2: source(Number(printedArea), ssRoundPrintedSource), exactAreaMm2: exact,
    massKgPerM: source(Number(printedMass), ssRoundPrintedSource),
    rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(),
    standardLengthsMm: unverified('原案の標準長さを製造元の供給長さとはしない（供給長さは未確認）') };
}
const frozenSsFlatPairs: readonly (readonly [number, number])[] = [[6, 50], [9, 50], [12, 50], [6, 100], [9, 100]];
const frozenSsRoundDiameters: readonly number[] = [13, 16, 19, 22, 25];
export const STEEL_SS400_EXPANSION_ORACLE: readonly SteelCatalogOracleRow[] = [
  ...SS400_STANDARD_THICKNESSES.flatMap((thickness) => SS400_STANDARD_WIDTHS
    .filter((width) => !frozenSsFlatPairs.some(([t, w]) => t === thickness && w === width))
    .map((width) => ss400FlatOracle(thickness, width))),
  ...SS400_STANDARD_ROUND_PRINTED.filter(([diameter]) => !frozenSsRoundDiameters.includes(diameter))
    .map(([diameter, area, mass]) => ss400RoundOracle(diameter, area, mass)),
];

/** W5 saved-string table: independent literal expectations, never read from the product module. */
export const SS400_EXPANSION_SAVED_OPTIONS = [
  ['SS400:flatBar:FB 25×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×4.5', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×6', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×9', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×12', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×16', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×19', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×22', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×25', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×28', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×32', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 25×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 32×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 38×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 44×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 50×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 65×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 75×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 90×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 100×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 125×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 150×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:flatBar:FB 200×36', 'SS400', 'JIS G 3101', 'JIS G 3194', 'hotRolled-heatTreatmentUnspecified', 'ssFlatDraft'],
  ['SS400:roundBar:φ5.5', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ6', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ7', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ8', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ9', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ10', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ11', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ12', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ20', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ24', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ28', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ30', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ32', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ36', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ38', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ42', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ46', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ48', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ50', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ55', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ56', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ60', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ64', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ65', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ70', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ75', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ80', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ85', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ90', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ95', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ100', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ110', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ120', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ130', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ140', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ150', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ160', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ180', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
  ['SS400:roundBar:φ200', 'SS400', 'JIS G 3101', 'JIS G 3191', 'hotRolled-heatTreatmentUnspecified', 'ssRoundDraft'],
] as const;
export const SS400_EXPANSION_EDITION_ORACLE = SS400_EXPANSION_SAVED_OPTIONS.map(
  ([key, , , productStandard]) => [key, productStandard, productStandard,
    productStandard === 'JIS G 3194' ? '2024' : '2022'] as const,
);

/** W8b: literal printed strings transcribed from g3452-tables.json, not application data.
 * JISF G 3452 2025-12-17 amendment draft, table 4, PDF p10 / printed p6.
 * Columns: source row ID, nominal size, outside diameter mm, wall thickness mm, reference kg/m.
 */
export const SGP_TABLE4_PRINTED = [
  ['T4-01', '6A', '10.5', '2.0', '0.419'],
  ['T4-02', '8A', '13.8', '2.3', '0.652'],
  ['T4-03', '10A', '17.3', '2.3', '0.851'],
  ['T4-04', '15A', '21.7', '2.8', '1.31'],
  ['T4-05', '20A', '27.2', '2.8', '1.68'],
  ['T4-06', '25A', '34.0', '3.2', '2.43'],
  ['T4-07', '32A', '42.7', '3.5', '3.38'],
  ['T4-08', '40A', '48.6', '3.5', '3.89'],
  ['T4-09', '50A', '60.5', '3.8', '5.31'],
  ['T4-10', '65A', '76.3', '4.2', '7.47'],
  ['T4-11', '80A', '89.1', '4.2', '8.79'],
  ['T4-12', '90A', '101.6', '4.2', '10.1'],
  ['T4-13', '100A', '114.3', '4.5', '12.2'],
  ['T4-14', '125A', '139.8', '4.5', '15.0'],
  ['T4-15', '150A', '165.2', '5.0', '19.8'],
  ['T4-16', '175A', '190.7', '5.3', '24.2'],
  ['T4-17', '200A', '216.3', '5.8', '30.1'],
  ['T4-18', '225A', '241.8', '6.2', '36.0'],
  ['T4-19', '250A', '267.4', '6.6', '42.4'],
  ['T4-20', '300A', '318.5', '6.9', '53.0'],
  ['T4-21', '350A', '355.6', '7.9', '67.7'],
  ['T4-22', '400A', '406.4', '7.9', '77.6'],
  ['T4-23', '450A', '457.2', '7.9', '87.5'],
  ['T4-24', '500A', '508.0', '7.9', '97.4'],
] as const;

export const SGP_TABLE4_PDF_SHA256 = '03b3975041cee440fd7be67ef7928089158cc8d7e7d1fc584399cfb282170318';
const sgpOriginalSizes: readonly string[] = ['15A', '20A', '25A', '32A', '40A', '50A'];
const sgpAddedConditions = (size: string): readonly ('blackPipe-plainEnds' | 'whitePipe-zincCoated')[] =>
  sgpOriginalSizes.includes(size) ? ['whitePipe-zincCoated'] : ['blackPipe-plainEnds', 'whitePipe-zincCoated'];

/** Only the 42 added products. The old 31-row oracle remains unchanged. */
export const SGP_ADDITION_ORACLE: readonly SteelCatalogOracleRow[] = SGP_TABLE4_PRINTED.flatMap(
  ([id, size, diameter, thickness, mass]) => sgpAddedConditions(size).map((condition): SteelCatalogOracleRow => {
    const citation = { url: pipeFormulaSource.url,
      locator: `2025-12-17原案 表4 PDF p10（印刷p6）${id}; g3452-tables.json。ソケットなしの参考質量。めっき・ねじは含まない` };
    const d = Number(diameter), t = Number(thickness);
    const area = computed(Math.PI / 4 * (d ** 2 - (d - 2 * t) ** 2), 'A = π/4(D²−(D−2t)²)', citation);
    return { key: `SGP:steelPipe:${size}${condition === 'whitePipe-zincCoated' ? ':whitePipe-zincCoated' : ''}`,
      grade: 'SGP', catalog: 'steelPipe', size,
      dimensions: { outsideDiameter: source(d, citation), wallThickness: source(t, citation) },
      areaMm2: area, exactAreaMm2: area, massKgPerM: source(Number(mass), citation),
      rootRadiusMm: unknownRadius(), tipRadiusMm: unknownRadius(), standardLengthsMm: source([5500], pipeSource) };
  }));

/** Independent six-string contract for the additions, separate from every frozen table. */
export const SGP_ADDITION_SAVED_OPTIONS = SGP_TABLE4_PRINTED.flatMap(([, size]) =>
  sgpAddedConditions(size).map((condition) => [
    `SGP:steelPipe:${size}${condition === 'whitePipe-zincCoated' ? ':whitePipe-zincCoated' : ''}`,
    'SGP', 'JIS G 3452', 'JIS G 3452', condition, 'pipe',
  ] as const));
