import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import { FRAME_MITERS } from '../frame/frameMembers.js';
import type { StandardCatalogId } from '../types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { G3192_CT_ROWS } from './steelRows/g3192CtRows.js';
import { G3192_I_BEAM_ROWS, G3192_UNEQUAL_ANGLE_ROWS } from './steelRows/g3192ExtraRows.js';
import {
  G3350_HAT_ROWS, G3350_LIGHT_ANGLE_ROWS, G3350_LIGHT_CHANNEL_ROWS, G3350_LIGHT_Z_ROWS, G3350_LIP_CHANNEL_ROWS,
  G3350_LIP_Z_ROWS,
} from './steelRows/g3350Rows.js';
import { G3444_STRUCTURAL_PIPE_ROWS } from './steelRows/g3444Rows.js';
import { G3459_TABLE7_ROWS, G3459_TABLE8_ROWS } from './steelRows/g3459Rows.js';
import { G3466_RECT_TUBE_ROWS } from './steelRows/g3466Rows.js';
import { STEEL_PROFILE_EVIDENCE } from './steelSectionProfiles.js';
import { STEEL_STANDARDS, type SteelProductStandardReferences, type SteelStandard } from './steelStandards.js';

/** Separate from r1: a saved r1 section never acquires an inferred steel grade. */
export const STEEL_CATALOG_REVISION = 'jp-steel-2026-10-10-r1';
/**
 * 2026-11-14 に足した行（角形鋼管・一般構造用炭素鋼鋼管・不等辺山形鋼・I 形鋼）だけが持つ表の版。
 * r1 の行の鍵・保存の文字列・版は変えず、r2 の行は r2 の保存だけに一致する（行の catalogRevision）。
 */
export const STEEL_CATALOG_REVISION_R2 = 'jp-steel-2026-11-14-r2';
export const LEGACY_STEEL_GENERATOR_REVISION = '2-steel-1';
export const STEEL_GENERATOR_REVISION = '3-steel-profile-1';
/** r1 の鋼種。この一覧と r1 の表(STEEL_PRODUCTS)は凍結し、r2 の鋼種は STEEL_R2_MATERIAL_GRADES に置く。 */
export const STEEL_MATERIAL_GRADES = ['SS400', 'S45C', 'SGP'] as const;
/**
 * r2 で足した鋼種（JIS G 3466 の STKR400・JIS G 3444 の STK400、2026-11-15 に JIS G 3350 の SSC400・
 * JIS G 3459 の SUS304TP。記号は各原案の表1）。
 */
export const STEEL_R2_MATERIAL_GRADES = ['STKR400', 'STK400', 'SSC400', 'SUS304TP'] as const;
export type SteelMaterialGrade = typeof STEEL_MATERIAL_GRADES[number] | typeof STEEL_R2_MATERIAL_GRADES[number];
export type SteelSectionCatalog = Extract<StandardCatalogId,
  'flatBar' | 'roundBar' | 'steelPipe' | 'equalAngle' | 'channel' | 'hBeam' | 'rectTube' | 'unequalAngle' | 'iBeam'
  | 'lightChannel' | 'lightZ' | 'lightAngle' | 'lipChannel' | 'lipZ' | 'hatSection' | 'ctSection'>;
export type SteelCondition = 'hotRolled-heatTreatmentUnspecified'
  | 'brightBar-heatTreatmentUnspecified' | 'blackPipe-plainEnds' | 'whitePipe-zincCoated'
  /** JIS G 3466 5: 製造のまま（製造方法・熱処理・めっきは指定しない）、管端は指定が無ければプレンエンド。 */
  | 'rectTube-asManufactured'
  /** JIS G 3444 5: 製管方法と仕上げ方法は指定しない、管端は指定が無ければプレンエンド。 */
  | 'structuralPipe-plainEnds'
  /** JIS G 3350 5: 熱間圧延・冷間圧延・めっきの鋼板又は鋼帯から冷間成形（素材の鋼板の種類・めっきは指定しない）。 */
  | 'lightGauge-coldFormed'
  /** JIS G 3459 5: 製管方法・仕上方法は指定しない、表2 の固溶化熱処理と酸洗（又は準じる処理）、管端は指定が無ければプレンエンド。 */
  | 'stainlessPipe-solutionTreated-plainEnds';

export interface SteelEvidence {
  readonly title: string;
  /** Null means the publication itself does not state an edition. */
  readonly edition: string | null;
  readonly locator: string;
  readonly reference: string;
}

/** Producer catalogs substantiate nominal sizes and grades, not inventory or certification. */
export const STEEL_EVIDENCE = {
  ssHBeamDraft: {
    title: 'JIS G 3192 改正原案 H形鋼', edition: null,
    locator: 'JIS G 3192 原案 2024-07-24 表15 PDF p21–22; 転記 g3192-tables.json。最終規格票・供給長さは未確認',
    reference: 'JIS G 3192 原案 2024-07-24',
  },
  ssAngleDraft: {
    title: 'JIS G 3192 改正原案 等辺山形鋼', edition: null,
    locator: 'JIS G 3192 原案 2024-07-24 表8 PDF p14; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json。最終規格票・供給長さは未確認',
    reference: 'JIS G 3192 原案 2024-07-24',
  },
  ssChannelDraft: {
    title: 'JIS G 3192 改正原案 溝形鋼', edition: null,
    locator: 'JIS G 3192 原案 2024-07-24 表12 PDF p18; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json。最終規格票・供給長さは未確認',
    reference: 'JIS G 3192 原案 2024-07-24',
  },
  ssFlatDraft: {
    title: 'JIS G 3194 改正原案', edition: null,
    locator: '2024-07-24原案 PDF p6 JIS G 3194 箇条5・表1 標準厚さ / 表2 標準幅（11厚さ×12幅）。製造元の供給寸法・長さは未確認',
    reference: 'JIS G 3194 原案 2024-07-24',
  },
  ssRoundDraft: {
    title: 'JIS G 3191 改正原案', edition: null,
    locator: '2021-07-28原案 PDF p6 表1 括弧なし推奨径 / 5.1 径9 mm未満はバーインコイル。製造元の供給寸法・長さは未確認',
    reference: 'JIS G 3191 原案 2021-07-28',
  },
  ss400GradeDraft: {
    title: 'JIS G 3101 改正原案', edition: null,
    locator: '2023-07-26原案 PDF p6 表1 SS400 棒鋼・平鋼（平鋼は厚さ100 mm以下）',
    reference: 'JIS G 3101 原案 2023-07-26',
  },
  hotRound: {
    title: 'JIS G 4051 改正原案', edition: null,
    locator: '2025-12-17原案 PDF p8 7.1.1・表3 熱間圧延丸鋼の括弧なし推奨径 / p6 5 c) 熱処理未指定',
    reference: 'JIS G 4051 原案 2025-12-17',
  },
  hotFlat: {
    title: '平鋼', edition: '2025年9月改訂版',
    locator: 'PDF p1 JIS G 4051 S10C〜S58C / p2〜3 標準断面寸法の厚さ×幅（G 3194原案の標準格子との共通部分）',
    reference: '平鋼',
  },
  rolledSections: {
    title: '圧延形鋼', edition: null,
    locator: 'PDF p3 製品・規格 / p4 等辺山形鋼・溝形鋼寸法表',
    reference: '圧延形鋼',
  },
  wideFlange: {
    title: 'H形鋼', edition: '2025.12',
    locator: 'PDF p4 製品規格 / p6 H形鋼標準寸法表',
    reference: 'H形鋼',
  },
  flat: {
    title: '平鋼', edition: '2025年9月改訂版',
    locator: 'PDF p1 規格 / p2 標準断面寸法 / p4 製造寸法',
    reference: '平鋼',
  },
  round: {
    title: '一般構造用丸鋼',
    edition: '2025年9月改訂版',
    locator: 'PDF p1 SS400標準断面寸法・標準長さ',
    reference: '一般構造用丸鋼',
  },
  brightRound: {
    title: 'みがき丸鋼', edition: null,
    locator: 'PDF p1 S45C（黄色印）の径20・25・30行',
    reference: 'みがき丸鋼',
  },
  brightFlat: {
    title: 'みがき平鋼', edition: null,
    locator: 'PDF p1 S45C（黄色印）、幅50×厚6・9・12 mmの交点',
    reference: 'みがき平鋼',
  },
  carbonGrade: {
    title: 'JIS G 4051 構造用棒鋼', edition: null,
    locator: 'PDF p5 機械構造用炭素鋼鋼材（JIS G4051）S45C行（鋼種分類のみ）',
    reference: 'JIS G 4051 構造用棒鋼',
  },
  pipe: {
    title: '配管用鋼管', edition: null,
    locator: 'PDF p12（冊子p10）SGP種類・寸法・標準長さ / p13管端形状',
    reference: '配管用鋼管',
  },
  // r2 の規格の原案。
  stkrDraft: {
    title: 'JIS G 3466 改正原案 一般構造用角形鋼管', edition: null,
    locator: 'JIS G 3466 原案 2024-12-20 表5（正方形）PDF p9〜10・表6（長方形）PDF p11〜12、'
      + '角部の外側及び内側の半径 2t・t（表5・表6 の注a）、8.1 標準長さ 6・8・10・12 m、表1 STKR400 PDF p6。最終規格票・供給は未確認',
    reference: 'JIS G 3466 原案 2024-12-20',
  },
  stkDraft: {
    title: 'JIS G 3444 改正原案 一般構造用炭素鋼鋼管', edition: null,
    locator: 'JIS G 3444 原案 2024-12-20 表6 管の寸法 PDF p10〜12、表1 STK400 PDF p6、5 c) 管端はプレンエンド。'
      + '標準長さの規定は無い。最終規格票・供給は未確認',
    reference: 'JIS G 3444 原案 2024-12-20',
  },
  ssUnequalAngleDraft: {
    title: 'JIS G 3192 改正原案 不等辺山形鋼', edition: null,
    locator: 'JIS G 3192 原案 2024-07-24 表9 PDF p15、表2 標準長さ PDF p7、表6 質量の計算方法 PDF p12。最終規格票・供給は未確認',
    reference: 'JIS G 3192 原案 2024-07-24',
  },
  ssIBeamDraft: {
    title: 'JIS G 3192 改正原案 I形鋼', edition: null,
    locator: 'JIS G 3192 原案 2024-07-24 表11 PDF p17（図: 内面の角度 98°、t2 は (B−t1)/4 の位置）、表2 標準長さ PDF p7、'
      + '表6 質量の計算方法 PDF p12。最終規格票・供給は未確認',
    reference: 'JIS G 3192 原案 2024-07-24',
  },
  // r2 に 2026-11-15 に足した行の資料（G 3350・G 3459 は 2020-12-02 の三者委員会の改正案）。
  sscDraft: {
    title: 'JIS G 3350 改正原案 一般構造用軽量形鋼', edition: null,
    locator: 'JIS G 3350 原案 2020-12-02 表1 SSC400 PDF p4、表5〜表10 PDF p6〜10（図と標準断面寸法）、'
      + '8.1 角部の曲率半径は厚さの中心線で通常 1.5t PDF p5、表11 標準長さ PDF p10、表12 質量の計算方法 PDF p11。最終規格票・供給は未確認',
    reference: 'JIS G 3350 原案 2020-12-02',
  },
  ssCtDraft: {
    title: 'JIS G 3192 改正原案 CT形鋼', edition: null,
    locator: 'JIS G 3192 原案 2024-07-24 表17 PDF p30〜31（図: フランジの外面が上、t2 は B/4 の位置、根元の丸み r）、'
      + '表2 標準長さ PDF p7、表6 質量の計算方法 PDF p12。最終規格票・供給は未確認',
    reference: 'JIS G 3192 原案 2024-07-24',
  },
  susPipeDraft: {
    title: 'JIS G 3459 改正原案 配管用ステンレス鋼鋼管', edition: null,
    locator: 'JIS G 3459 原案 2020-12-02 表1 SUS304TP PDF p4、5 製造方法 PDF p4〜5、表7 PDF p12〜13、表8 溶接鋼管 PDF p14〜15、'
      + '表9 単位質量の算出式 PDF p16、箇条15 の呼び方の例 PDF p21。標準長さの規定は無い。最終規格票・供給は未確認',
    reference: 'JIS G 3459 原案 2020-12-02',
  },
} as const satisfies Readonly<Record<string, SteelEvidence>>;

/**
 * Producer pages that name the product/dimension standard where the dimensional source does not.
 * They show which standard the producer applies; they are not a current normative JIS edition.
 */
export const STEEL_PRODUCT_STANDARD_EVIDENCE = {
  hotFlatDraft: {
    title: 'JIS G 3194 改正原案', edition: null,
    locator: '2024-07-24原案 PDF p6 JIS G 3194 箇条5・表1 標準厚さ / 表2 標準幅（G 4051原案7.3が引用）',
    reference: 'JIS G 3194 原案 2024-07-24',
  },
  rolledSections: {
    title: '形鋼・平鋼・丸鋼 寸法表', edition: null,
    locator: 'PDF p26（冊子p24）形状・寸法の許容差表：等辺山形鋼 AB・溝形鋼 CB に JIS G 3192',
    reference: '形鋼・平鋼・丸鋼 寸法表',
  },
  wideFlangeH: {
    title: 'H形鋼', edition: '2025.12',
    locator: 'PDF p9 H形鋼の形状・寸法の許容差表：JIS G 3192',
    reference: 'H形鋼',
  },
  brightBar: {
    title: 'JIS G 3123 公差表', edition: null,
    locator: '公差表（JIS G 3123）、適用形状 丸・平',
    reference: 'JIS G 3123 公差表',
  },
} as const satisfies Readonly<Record<string, SteelEvidence>>;

export interface SteelProduct {
  readonly key: string;
  readonly catalog: SteelSectionCatalog;
  readonly size: string;
  readonly materialGrade: SteelMaterialGrade;
  /** Grade standard and dimensional/product standard are deliberately separate. */
  readonly materialStandard: string;
  readonly productStandard: string;
  readonly condition: SteelCondition;
  /** Source and nominal pipe limitations; never persisted in saved options. */
  readonly note?: string;
  readonly evidence: keyof typeof STEEL_EVIDENCE;
  readonly materialEvidence?: keyof typeof STEEL_EVIDENCE;
  /** Absent when the dimensional source itself states productStandard. Not persisted in saved options. */
  readonly productStandardEvidence?: SteelEvidence;
  /** Ledger provenance only; never serialized by steelProductOptions. */
  readonly standardReferences: SteelProductStandardReferences;
  /** Derived ledger editions and evidence status only; never persisted in saved options. */
  readonly standardEdition: { readonly material: SteelStandard; readonly dimensions: SteelStandard };
  readonly geometry: 'nominal' | 'simplifiedSection' | 'profileSection';
  readonly profileEvidence?: SteelEvidence;
  /** Catalog standard lengths; empty means unknown, never an availability promise. */
  readonly standardLengthsMm: readonly number[];
  readonly dimensions?: { readonly width?: number; readonly thickness?: number;
    readonly diameter?: number; readonly outsideDiameter?: number; readonly wallThickness?: number };
  /** The saved table revision. Absent means STEEL_CATALOG_REVISION (every r1 row); only r2 rows carry a value. */
  readonly catalogRevision?: string;
}

function standardEdition(references: SteelProductStandardReferences): SteelProduct['standardEdition'] {
  return { material: STEEL_STANDARDS[references.material], dimensions: STEEL_STANDARDS[references.dimensions] };
}

const hot = 'hotRolled-heatTreatmentUnspecified';
function ssSection(catalog: SteelSectionCatalog, size: string,
  evidence: 'rolledSections' | 'wideFlange'): SteelProduct {
  return { key: `SS400:${catalog}:${size}`, catalog, size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    evidence, productStandardEvidence: catalog === 'hBeam' ? STEEL_PRODUCT_STANDARD_EVIDENCE.wideFlangeH
      : STEEL_PRODUCT_STANDARD_EVIDENCE.rolledSections,
    geometry: 'profileSection',
    profileEvidence: catalog === 'equalAngle' ? STEEL_PROFILE_EVIDENCE.angleProfile
      : catalog === 'channel' ? STEEL_PROFILE_EVIDENCE.channelProfile : STEEL_PROFILE_EVIDENCE.wideFlangeH,
    standardLengthsMm: [] };
}
function flat(thickness: number, width: number, materialGrade: 'SS400' | 'S45C' = 'SS400'): SteelProduct {
  const size = `FB ${width}×${thickness}`;
  return { key: `${materialGrade}:flatBar:${size}`, catalog: 'flatBar', size, materialGrade,
    materialStandard: materialGrade === 'SS400' ? 'JIS G 3101' : 'JIS G 4051',
    productStandard: materialGrade === 'SS400' ? '公表平鋼寸法' : 'JIS G 3123',
    standardReferences: materialGrade === 'SS400'
      ? { material: 'jis-g-3101-2024', dimensions: 'jis-g-3194-2024' }
      : { material: 'jis-g-4051-2026', dimensions: 'jis-g-3123-2004' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    condition: materialGrade === 'SS400' ? hot : 'brightBar-heatTreatmentUnspecified',
    evidence: materialGrade === 'SS400' ? 'flat' : 'brightFlat',
    ...(materialGrade === 'S45C' ? { materialEvidence: 'carbonGrade' as const,
      productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.brightBar } : {}),
    geometry: 'nominal', standardLengthsMm: materialGrade === 'SS400' ? [4500, 5000, 5500, 6000, 6500] : [],
    dimensions: { width, thickness } };
}
function round(diameter: number, materialGrade: 'SS400' | 'S45C'): SteelProduct {
  const size = `φ${diameter}`;
  return { key: `${materialGrade}:roundBar:${size}`, catalog: 'roundBar', size, materialGrade,
    materialStandard: materialGrade === 'SS400' ? 'JIS G 3101' : 'JIS G 4051',
    productStandard: materialGrade === 'SS400' ? '公表丸鋼寸法' : 'JIS G 3123',
    standardReferences: materialGrade === 'SS400'
      ? { material: 'jis-g-3101-2024', dimensions: 'jis-g-3191-2022' }
      : { material: 'jis-g-4051-2026', dimensions: 'jis-g-3123-2004' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    condition: materialGrade === 'SS400' ? hot : 'brightBar-heatTreatmentUnspecified',
    evidence: materialGrade === 'SS400' ? 'round' : 'brightRound',
    ...(materialGrade === 'S45C' ? { materialEvidence: 'carbonGrade' as const,
      productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.brightBar } : {}), geometry: 'nominal',
    standardLengthsMm: materialGrade === 'SS400' ? [5500, 6000] : [], dimensions: { diameter } };
}
function pipe(size: string, outsideDiameter: number, wallThickness: number,
  condition: 'blackPipe-plainEnds' | 'whitePipe-zincCoated' = 'blackPipe-plainEnds', note?: string): SteelProduct {
  return { key: `SGP:steelPipe:${size}${condition === 'whitePipe-zincCoated' ? ':whitePipe-zincCoated' : ''}`, catalog: 'steelPipe', size, materialGrade: 'SGP',
    materialStandard: 'JIS G 3452', productStandard: 'JIS G 3452',
    standardReferences: { material: 'jis-g-3452-2026', dimensions: 'jis-g-3452-2026' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    condition, ...(note === undefined ? {} : { note }), evidence: 'pipe', geometry: 'nominal',
    standardLengthsMm: [5500], dimensions: { outsideDiameter, wallThickness } };
}

/** Draft standard dimensions, never stock or treatment/strength guarantees. */
function hotS45c(catalog: 'roundBar' | 'flatBar', size: string, dimensions: SteelProduct['dimensions']): SteelProduct {
  return { key: `S45C:${catalog}:${size}:hotRolled`, catalog, size, materialGrade: 'S45C',
    materialStandard: 'JIS G 4051', productStandard: catalog === 'roundBar' ? 'JIS G 4051' : 'JIS G 3194',
    condition: hot, evidence: catalog === 'roundBar' ? 'hotRound' : 'hotFlat',
    standardReferences: { material: 'jis-g-4051-2026',
      dimensions: catalog === 'roundBar' ? 'jis-g-4051-2026' : 'jis-g-3194-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    ...(catalog === 'flatBar' ? { materialEvidence: 'hotRound' as const,
      productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.hotFlatDraft } : {}),
    geometry: 'nominal', standardLengthsMm: [], dimensions };
}

/** Only SS400 dimensions present in the JIS drafts, separate from frozen producer rows. */
function ss400Standard(catalog: 'flatBar' | 'roundBar', size: string,
  dimensions: SteelProduct['dimensions']): SteelProduct {
  return { key: `SS400:${catalog}:${size}`, catalog, size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: catalog === 'flatBar' ? 'JIS G 3194' : 'JIS G 3191',
    condition: hot, evidence: catalog === 'flatBar' ? 'ssFlatDraft' : 'ssRoundDraft',
    materialEvidence: 'ss400GradeDraft',
    ...(catalog === 'flatBar' ? { productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.hotFlatDraft } : {}),
    standardReferences: { material: 'jis-g-3101-2024',
      dimensions: catalog === 'flatBar' ? 'jis-g-3194-2024' : 'jis-g-3191-2022' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    geometry: 'nominal', standardLengthsMm: [], dimensions };
}

/** Draft table 8/12 additions, separate from every frozen producer row. */
function ss400SectionStandard(catalog: 'equalAngle' | 'channel', size: string): SteelProduct {
  const evidence = catalog === 'equalAngle' ? 'ssAngleDraft' : 'ssChannelDraft';
  return { key: `SS400:${catalog}:${size}`, catalog, size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    evidence, materialEvidence: 'ss400GradeDraft',
    productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.rolledSections,
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE[evidence], standardLengthsMm: [] };
}

/** Table 15 additions only; keep every existing producer row and saved string. */
function ss400HBeamStandard(size: string): SteelProduct {
  return { key: `SS400:hBeam:${size}`, catalog: 'hBeam', size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    evidence: 'ssHBeamDraft', materialEvidence: 'ss400GradeDraft',
    productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.wideFlangeH,
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE.ssHBeamDraft, standardLengthsMm: [] };
}

/** A small, explicit grade/size matrix; no cartesian product of grades and sections. */
export const STEEL_PRODUCTS: readonly SteelProduct[] = [
  flat(6, 50), flat(9, 50), flat(12, 50), flat(6, 100), flat(9, 100),
  ...[13, 16, 19, 22, 25].map((diameter) => round(diameter, 'SS400')),
  ssSection('equalAngle', 'L 40×40×5', 'rolledSections'),
  ssSection('equalAngle', 'L 50×50×6', 'rolledSections'),
  ssSection('equalAngle', 'L 65×65×6', 'rolledSections'),
  ssSection('channel', '[ 75×40×5×7', 'rolledSections'),
  ssSection('channel', '[ 100×50×5×7.5', 'rolledSections'),
  ssSection('channel', '[ 125×65×6×8', 'rolledSections'),
  ssSection('hBeam', 'H 150×150×7×10', 'wideFlange'),
  ssSection('hBeam', 'H 200×200×8×12', 'wideFlange'),
  ssSection('hBeam', 'H 300×300×10×15', 'wideFlange'),
  ...[20, 25, 30].map((diameter) => round(diameter, 'S45C')),
  flat(6, 50, 'S45C'), flat(9, 50, 'S45C'), flat(12, 50, 'S45C'),
  pipe('15A', 21.7, 2.8), pipe('20A', 27.2, 2.8), pipe('25A', 34, 3.2),
  pipe('32A', 42.7, 3.5), pipe('40A', 48.6, 3.5), pipe('50A', 60.5, 3.8),
  // G 4051 draft PDF p8 table 3: only unparenthesized recommended round diameters.
  ...[11, 13, 16, 19, 22, 25, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50,
    55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 130, 140, 150, 160, 180, 200]
    .map((diameter) => hotS45c('roundBar', `φ${diameter}`, { diameter })),
  // G 3194 draft PDF p6 tables 1/2 intersected with Nippon Steel 3-52 PDF p2/3.
  // Each thickness has only the widths actually printed in the producer table (116 pairs).
  ...([
    [4.5, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [6, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [9, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [12, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [16, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [19, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [22, [32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [25, [32, 38, 50, 65, 75, 90, 100, 125, 150, 200]],
    [28, [50, 65, 75, 90, 125, 150, 200]],
    [32, [38, 50, 65, 75, 90, 100, 150, 200]],
    [36, [50, 65, 75, 90, 100, 125, 150, 200]],
  ] as const).flatMap(([thickness, widths]) => widths.map((width) =>
    hotS45c('flatBar', `FB ${width}×${thickness}`, { width, thickness }))),
  // G 3194 draft PDF p6 tables 1/2: all 132 standard pairs, minus the frozen five above.
  ...([
    [4.5, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [6, [25, 32, 38, 44, 65, 75, 90, 125, 150, 200]],
    [9, [25, 32, 38, 44, 65, 75, 90, 125, 150, 200]],
    [12, [25, 32, 38, 44, 65, 75, 90, 100, 125, 150, 200]],
    [16, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [19, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [22, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [25, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [28, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [32, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
    [36, [25, 32, 38, 44, 50, 65, 75, 90, 100, 125, 150, 200]],
  ] as const).flatMap(([thickness, widths]) => widths.map((width) =>
    ss400Standard('flatBar', `FB ${width}×${thickness}`, { width, thickness }))),
  // G 3191 draft PDF p6 table 1: 44 unparenthesized diameters, minus the frozen five.
  // Clause 5.1: diameters below 9 mm refer to bar-in-coil; no cut-stock supply is asserted.
  ...[5.5, 6, 7, 8, 9, 10, 11, 12, 20, 24, 28, 30, 32, 36, 38, 42, 46, 48, 50,
    55, 56, 60, 64, 65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 130, 140, 150, 160, 180, 200]
    .map((diameter) => ss400Standard('roundBar', `φ${diameter}`, { diameter })),
  // JIS G 3192 draft tables 8/12, transcribed g3192-tables.json.
  ...[
    'L 120×120×8',
    'L 130×130×9',
    'L 130×130×12',
    'L 130×130×15',
    'L 150×150×12',
    'L 150×150×15',
    'L 150×150×19',
    'L 175×175×12',
    'L 175×175×15',
    'L 200×200×15',
    'L 200×200×20',
    'L 200×200×25',
    'L 250×250×25',
    'L 250×250×35',
  ].map((size) => ss400SectionStandard('equalAngle', size)),
  ...[
    '[ 250×90×9×13',
    '[ 250×90×11×14.5',
    '[ 300×90×9×13',
    '[ 300×90×10×15.5',
    '[ 300×90×12×16',
    '[ 380×100×10.5×16',
    '[ 380×100×13×16.5',
    '[ 380×100×13×20',
  ].map((size) => ss400SectionStandard('channel', size)),
  // JIS G 3192 draft 2024-07-24, table 15, PDF p21–22; final standard and supply lengths unverified.
  ...[
    'H 100×50×5×7',
    'H 125×60×6×8',
    'H 150×75×5×7',
    'H 148×100×6×9',
    'H 175×90×5×8',
    'H 198×99×4.5×7',
    'H 200×100×5.5×8',
    'H 194×150×6×9',
    'H 248×124×5×8',
    'H 250×125×6×9',
    'H 244×175×7×11',
    'H 298×149×5.5×8',
    'H 300×150×6.5×9',
    'H 294×200×8×12',
    'H 346×174×6×9',
    'H 350×175×7×11',
    'H 340×250×9×14',
    'H 350×350×12×19',
    'H 396×199×7×11',
    'H 400×200×8×13',
    'H 390×300×10×16',
    'H 400×400×13×21',
    'H 414×405×18×28',
    'H 428×407×20×35',
    'H 458×417×30×50',
    'H 498×432×45×70',
    'H 446×199×8×12',
    'H 450×200×9×14',
    'H 440×300×11×18',
    'H 496×199×9×14',
    'H 500×200×10×16',
    'H 482×300×11×15',
    'H 488×300×11×18',
    'H 596×199×10×15',
    'H 600×200×11×17',
    'H 582×300×12×17',
    'H 588×300×12×20',
    'H 594×302×14×23',
    'H 692×300×13×20',
    'H 700×300×13×24',
    'H 792×300×14×22',
    'H 800×300×14×26',
    'H 890×299×15×23',
    'H 900×300×16×28',
    'H 912×302×18×34',
    'H 918×303×19×37',
  ].map(ss400HBeamStandard),
  // JIS G 3452 draft table 4, PDF p10 / printed p6; black additions and all -ZN white pipes.
  ...([
    ['6A', 10.5, 2.0, 'T4-01', true],
    ['8A', 13.8, 2.3, 'T4-02', true],
    ['10A', 17.3, 2.3, 'T4-03', true],
    ['15A', 21.7, 2.8, 'T4-04', false],
    ['20A', 27.2, 2.8, 'T4-05', false],
    ['25A', 34.0, 3.2, 'T4-06', false],
    ['32A', 42.7, 3.5, 'T4-07', false],
    ['40A', 48.6, 3.5, 'T4-08', false],
    ['50A', 60.5, 3.8, 'T4-09', false],
    ['65A', 76.3, 4.2, 'T4-10', true],
    ['80A', 89.1, 4.2, 'T4-11', true],
    ['90A', 101.6, 4.2, 'T4-12', true],
    ['100A', 114.3, 4.5, 'T4-13', true],
    ['125A', 139.8, 4.5, 'T4-14', true],
    ['150A', 165.2, 5.0, 'T4-15', true],
    ['175A', 190.7, 5.3, 'T4-16', true],
    ['200A', 216.3, 5.8, 'T4-17', true],
    ['225A', 241.8, 6.2, 'T4-18', true],
    ['250A', 267.4, 6.6, 'T4-19', true],
    ['300A', 318.5, 6.9, 'T4-20', true],
    ['350A', 355.6, 7.9, 'T4-21', true],
    ['400A', 406.4, 7.9, 'T4-22', true],
    ['450A', 457.2, 7.9, 'T4-23', true],
    ['500A', 508.0, 7.9, 'T4-24', true],
  ] as const).flatMap(([size, diameter, thickness, sourceRow, missingBlack]) => {
    const note = `JIS G 3452 2025-12-17原案 表4 PDF p10（印刷p6）${sourceRow}。`
      + '転記: g3452-tables.json。'
      + '表 4 の単位質量はソケットを含まない参考値。めっき・ねじの分は含まない。'
      + (Number.parseInt(size, 10) <= 300 ? '300A以下はねじ付又はプレンエンド。' : '350A以上はプレンエンド。')
      + '管端・ソケット・ねじ・めっき厚さは形状に反映しない。5500 mmは従来の製造元資料による。最終規格票・供給は未確認。';
    return [...(missingBlack ? [pipe(size, diameter, thickness, 'blackPipe-plainEnds', note)] : []),
      pipe(size, diameter, thickness, 'whitePipe-zincCoated', `白管（亜鉛めっき -ZN）。${note}`)];
  }),
];

/** JIS G 3466 8.1（PDF p8）の標準長さ。供給の約束ではない。 */
const G3466_STANDARD_LENGTHS_MM = [6000, 8000, 10000, 12000];
/** JIS G 3192 表2（PDF p7）の標準長さ。アプリで作図できる長さの上限（12,000 mm）とは別。供給の約束ではない。 */
const G3192_STANDARD_LENGTHS_MM = [6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000];
const R2_NOTE_TAIL = '最終規格票・供給は未確認。';

/** r2 rows: JIS draft table values with their PDF page; never stock, supply or certification. */
function r2Product(fields: Omit<SteelProduct, 'standardEdition' | 'catalogRevision'>): SteelProduct {
  return { ...fields, catalogRevision: STEEL_CATALOG_REVISION_R2,
    get standardEdition() { return standardEdition(this.standardReferences); } };
}
function rectTubeProduct([a, b, t, mass, area, page, table]: typeof G3466_RECT_TUBE_ROWS[number]): SteelProduct {
  const size = `□ ${a}×${b}×${t}`;
  return r2Product({ key: `STKR400:rectTube:${size}`, catalog: 'rectTube', size, materialGrade: 'STKR400',
    materialStandard: 'JIS G 3466', productStandard: 'JIS G 3466', condition: 'rectTube-asManufactured',
    note: `JIS G 3466 2024-12-20原案 表${table} PDF p${page}。単位質量 ${mass} kg/m・断面積 ${area} cm²（原案の参考の値）。`
      + `角部の外側の半径 2t・内側の半径 t（表${table}の注a）。製造方法・熱処理・めっき・管端は形状に含まない。${R2_NOTE_TAIL}`,
    evidence: 'stkrDraft', standardReferences: { material: 'jis-g-3466-2025', dimensions: 'jis-g-3466-2025' },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE.stkrDraft, standardLengthsMm: G3466_STANDARD_LENGTHS_MM });
}
function structuralPipeProduct([diameter, thickness, mass, area, page]: typeof G3444_STRUCTURAL_PIPE_ROWS[number]): SteelProduct {
  const size = `φ${diameter}×${thickness}`;
  return r2Product({ key: `STK400:steelPipe:${size}`, catalog: 'steelPipe', size, materialGrade: 'STK400',
    materialStandard: 'JIS G 3444', productStandard: 'JIS G 3444', condition: 'structuralPipe-plainEnds',
    note: `JIS G 3444 2024-12-20原案 表6 PDF p${page}。単位質量 ${mass} kg/m・断面積 ${area} cm²（原案の参考の値）。`
      + `製管方法・仕上げ方法・めっき・管端は形状に含まない。${R2_NOTE_TAIL}`,
    evidence: 'stkDraft', standardReferences: { material: 'jis-g-3444-2025', dimensions: 'jis-g-3444-2025' },
    geometry: 'nominal', standardLengthsMm: [],
    dimensions: { outsideDiameter: Number(diameter), wallThickness: Number(thickness) } });
}
function ss400R2Section(catalog: 'unequalAngle' | 'iBeam', size: string, table: string, page: number,
  printed: string): SteelProduct {
  const evidence = catalog === 'unequalAngle' ? 'ssUnequalAngleDraft' : 'ssIBeamDraft';
  return r2Product({ key: `SS400:${catalog}:${size}`, catalog, size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    note: `JIS G 3192 2024-07-24原案 表${table} PDF p${page}。${printed}（表6 の計算方法による原案の値）。${R2_NOTE_TAIL}`,
    evidence, materialEvidence: 'ss400GradeDraft',
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE[evidence], standardLengthsMm: G3192_STANDARD_LENGTHS_MM });
}

/** JIS G 3350 表11（PDF p10）の標準長さ。供給の約束ではない。 */
const G3350_STANDARD_LENGTHS_MM = [6000, 7000, 8000, 9000, 10000, 11000, 12000];
type LightGaugeCatalog = Extract<SteelSectionCatalog,
  'lightChannel' | 'lightZ' | 'lightAngle' | 'lipChannel' | 'lipZ' | 'hatSection'>;
/** 軽量形鋼の断面の種類ごとの呼び寸法の頭（形の通称の記号。steelCatalogProfile.ts の振り分けと同じ）。 */
const LIGHT_GAUGE_SIZE_PREFIXES = {
  lightChannel: '[', lightZ: 'Z', lightAngle: 'L', lipChannel: 'C', lipZ: 'Z', hatSection: 'ハット',
} as const satisfies Readonly<Record<LightGaugeCatalog, string>>;
const LIGHT_GAUGE_TABLES = {
  lightChannel: '5', lightZ: '6', lightAngle: '7', lipChannel: '8', lipZ: '9', hatSection: '10',
} as const satisfies Readonly<Record<LightGaugeCatalog, string>>;
/** 印刷の値が表12 の計算方法と食い違う行（原案の印刷の値はそのまま持ち、食い違いを書き添える）。 */
const LIGHT_GAUGE_PRINT_REMARKS: Readonly<Record<string, string>> = {
  'lipChannel:4367': '印刷の単位質量 8.32 は丸めた断面積 10.59 からの値 8.31 と違い、丸める前の断面積からの値と一致する。',
};

/** SSC400 の軽量形鋼の行。寸法は表の記号の順（H×A×B・H×A×C・軽山形は A×B）に厚さを続ける。 */
interface LightGaugeRow {
  readonly code: string; readonly dims: readonly string[]; readonly t: string;
  readonly area: string; readonly mass: string; readonly page: number;
}
function lightGaugeProduct(catalog: LightGaugeCatalog, { code, dims, t, area, mass, page }: LightGaugeRow): SteelProduct {
  const size = `${LIGHT_GAUGE_SIZE_PREFIXES[catalog]} ${[...dims, t].join('×')}`;
  return r2Product({ key: `SSC400:${catalog}:${size}`, catalog, size, materialGrade: 'SSC400',
    materialStandard: 'JIS G 3350', productStandard: 'JIS G 3350', condition: 'lightGauge-coldFormed',
    note: `JIS G 3350 2020-12-02原案 表${LIGHT_GAUGE_TABLES[catalog]} PDF p${page}。呼び名 ${code}。`
      + `断面積 ${area} cm²・単位質量 ${mass} kg/m（表12 の計算方法による原案の値）。`
      + (LIGHT_GAUGE_PRINT_REMARKS[`${catalog}:${code}`] ?? '')
      + `角部の曲率半径は厚さの中心線で 1.5t（外側 2t・内側 t、8.1）。素材の鋼板の種類・めっきは形状に含まない。${R2_NOTE_TAIL}`,
    evidence: 'sscDraft', standardReferences: { material: 'jis-g-3350-2021', dimensions: 'jis-g-3350-2021' },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE.sscDraft, standardLengthsMm: G3350_STANDARD_LENGTHS_MM });
}
function ctProduct([h, b, t1, t2, , area, mass, , page]: typeof G3192_CT_ROWS[number]): SteelProduct {
  const size = `CT ${h}×${b}×${t1}×${t2}`;
  return r2Product({ key: `SS400:ctSection:${size}`, catalog: 'ctSection', size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    note: `JIS G 3192 2024-07-24原案 表17 PDF p${page}。断面積 ${area} cm²・単位質量 ${mass} kg/m（表6 の計算方法による原案の値）。`
      + R2_NOTE_TAIL,
    evidence: 'ssCtDraft', materialEvidence: 'ss400GradeDraft',
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE.ssCtDraft, standardLengthsMm: G3192_STANDARD_LENGTHS_MM });
}
/** SUS304TP の鋼管の行。表7 は呼び径×Sch、表8 の括弧の厚さ（表7 と違う寸法）は外径×厚さで呼ぶ（各表の注a、箇条15）。 */
function stainlessPipeProduct(size: string, note: string, diameter: string, thickness: string): SteelProduct {
  return r2Product({ key: `SUS304TP:steelPipe:${size}`, catalog: 'steelPipe', size, materialGrade: 'SUS304TP',
    materialStandard: 'JIS G 3459', productStandard: 'JIS G 3459', condition: 'stainlessPipe-solutionTreated-plainEnds',
    note: `${note}製管方法・仕上方法・熱処理・管端は形状に含まない。${R2_NOTE_TAIL}`,
    evidence: 'susPipeDraft', standardReferences: { material: 'jis-g-3459-2021', dimensions: 'jis-g-3459-2021' },
    geometry: 'nominal', standardLengthsMm: [],
    dimensions: { outsideDiameter: Number(diameter), wallThickness: Number(thickness) } });
}
const G3459_NOTE_HEAD = 'JIS G 3459 2020-12-02原案';
const g3459Mass = (mass: string): string => `単位質量 ${mass} kg/m（SUS304TP の列、表9 の式による原案の値）。`;
const STAINLESS_PIPE_PRODUCTS: readonly SteelProduct[] = [
  ...G3459_TABLE7_ROWS.map(([a, b, d, sch, t, mass, page]) => stainlessPipeProduct(`${a}A×Sch${sch}`,
    `${G3459_NOTE_HEAD} 表7 PDF p${page}。呼び径 ${a}A（${b}B）・Sch${sch}、外径 ${d} mm・厚さ ${t} mm・${g3459Mass(mass)}`, d, t)),
  // 表8 の括弧の無い厚さは表7 と同じ寸法、括弧の厚さのうち表7 の同じ外径の別の Sch と同じ寸法の 3 組も表7 の行で足りる。
  ...G3459_TABLE8_ROWS.filter(([, , d, , t, , , bracketed]) => bracketed
    && !G3459_TABLE7_ROWS.some((row) => row[2] === d && row[4] === t))
    .map(([a, b, d, sch, t, mass, page]) => stainlessPipeProduct(`φ${d}×${t}`,
      `${G3459_NOTE_HEAD} 表8 PDF p${page}。溶接鋼管の呼び径 ${a}A（${b}B）・Sch${sch} の厚さ（表7 と違う寸法）、`
      + `外径 ${d} mm・厚さ ${t} mm・${g3459Mass(mass)}`, d, t)),
];

/**
 * r2 の行（2026-11-14 の 273 行の後に、2026-11-15 の軽量形鋼 91 行・CT 形鋼 53 行・SUS304TP の鋼管 190 行の 334 行）。
 * r1 の STEEL_PRODUCTS の後に置き、探す関数は ALL_STEEL_PRODUCTS（両方）を見る。
 */
const STEEL_R2_PRODUCTS: readonly SteelProduct[] = [
  ...G3466_RECT_TUBE_ROWS.map(rectTubeProduct),
  ...G3444_STRUCTURAL_PIPE_ROWS.map(structuralPipeProduct),
  ...G3192_UNEQUAL_ANGLE_ROWS.map(([a, b, t, , , area, mass, page]) => ss400R2Section('unequalAngle',
    `L ${a}×${b}×${t}`, '9', page, `断面積 ${area} cm²・単位質量 ${mass} kg/m`)),
  ...G3192_I_BEAM_ROWS.map(([h, b, t1, t2, , , area, mass, page]) => ss400R2Section('iBeam',
    `I ${h}×${b}×${t1}×${t2}`, '11', page, `断面積 ${area} cm²・単位質量 ${mass} kg/m`)),
  ...G3350_LIGHT_CHANNEL_ROWS.map(([code, h, a, b, t, area, mass, page]) =>
    lightGaugeProduct('lightChannel', { code, dims: [h, a, b], t, area, mass, page })),
  ...G3350_LIGHT_Z_ROWS.map(([code, h, a, b, t, area, mass, page]) =>
    lightGaugeProduct('lightZ', { code, dims: [h, a, b], t, area, mass, page })),
  ...G3350_LIGHT_ANGLE_ROWS.map(([code, a, b, t, area, mass, page]) =>
    lightGaugeProduct('lightAngle', { code, dims: [a, b], t, area, mass, page })),
  ...G3350_LIP_CHANNEL_ROWS.map(([code, h, a, c, t, area, mass, page]) =>
    lightGaugeProduct('lipChannel', { code, dims: [h, a, c], t, area, mass, page })),
  ...G3350_LIP_Z_ROWS.map(([code, h, a, c, t, area, mass, page]) =>
    lightGaugeProduct('lipZ', { code, dims: [h, a, c], t, area, mass, page })),
  ...G3350_HAT_ROWS.map(([code, h, a, c, t, area, mass, page]) =>
    lightGaugeProduct('hatSection', { code, dims: [h, a, c], t, area, mass, page })),
  ...G3192_CT_ROWS.map(ctProduct),
  ...STAINLESS_PIPE_PRODUCTS,
];

/** 選ぶ画面・保存の確かめ・切断の一覧が見る全ての材質別の鋼材（r1 の 459 行と r2 の行）。 */
export const ALL_STEEL_PRODUCTS: readonly SteelProduct[] = [...STEEL_PRODUCTS, ...STEEL_R2_PRODUCTS];

/** 行の保存の版。r1 の行は STEEL_CATALOG_REVISION。 */
export function steelProductCatalogRevision(row: SteelProduct): string {
  return row.catalogRevision ?? STEEL_CATALOG_REVISION;
}
/** 材質別の鋼材の表の版か（r1 か r2）。 */
export function isSteelCatalogRevision(revision: string): boolean {
  return revision === STEEL_CATALOG_REVISION || revision === STEEL_CATALOG_REVISION_R2;
}

export function steelProducts(material: SteelMaterialGrade,
  catalog?: SteelSectionCatalog): readonly SteelProduct[] {
  return ALL_STEEL_PRODUCTS.filter((row) => row.materialGrade === material
    && (catalog === undefined || row.catalog === catalog));
}
export function steelSectionCatalogs(material: SteelMaterialGrade): readonly SteelSectionCatalog[] {
  return [...new Set(steelProducts(material).map((row) => row.catalog))];
}
export function steelProductOptions(row: SteelProduct): Readonly<Record<string, string>> {
  return { steelProduct: row.key, materialGrade: row.materialGrade,
    materialStandard: row.materialStandard, productStandard: row.productStandard,
    condition: row.condition, evidence: row.evidence };
}
export function hasSteelOptions(options: Readonly<Record<string, string>>): boolean {
  return ['steelProduct', 'materialGrade', 'materialStandard', 'productStandard', 'condition', 'evidence']
    .some((key) => options[key] !== undefined);
}
export function findSteelProduct(catalog: StandardCatalogId, size: string,
  options: Readonly<Record<string, string>>): SteelProduct | undefined {
  const row = ALL_STEEL_PRODUCTS.find((candidate) => candidate.key === options.steelProduct
    && candidate.catalog === catalog && candidate.size === size);
  if (row === undefined) return undefined;
  const canonical = steelProductOptions(row);
  return Object.entries(canonical).every(([key, value]) => options[key] === value)
    && Object.keys(options).every((key) => key === 'length' || steelMiterField(key, options[key]) || Object.hasOwn(canonical, key))
    ? row : undefined;
}

/**
 * 留めの欄(J-01 包み 6。一括配置の留めの角だけが書く任意の鍵 startMiter・endMiter。値は短くする側 x+・x-・y+・y-)。
 * 留めの無い部材は欄を持たず、保存の形と形は前と同じ。前の版はこの鍵を「保存の欄が合わない」で断る(黙って直角にしない)。
 */
export function steelMiterField(key: string, value: string | undefined): boolean {
  return (key === 'startMiter' || key === 'endMiter') && FRAME_MITERS.some((side) => side === value);
}
/** Application modeling bounds, not a claim about JIS limits or producer stock. */
export const STEEL_LENGTH_LIMITS_MM = { min: 1, max: 12000 } as const;
export function steelLength(source: string): ExpressionValue | null {
  const result = evaluateExpression(source);
  return result.ok && Number.isFinite(result.value.value)
    && result.value.value >= STEEL_LENGTH_LIMITS_MM.min
    && result.value.value <= STEEL_LENGTH_LIMITS_MM.max ? result.value : null;
}
export function steelProductFromSource(source: StandardPartSource): SteelProduct | undefined {
  if (!isSteelCatalogRevision(source.catalogRevision)
    || (source.generatorRevision !== STEEL_GENERATOR_REVISION
      && source.generatorRevision !== LEGACY_STEEL_GENERATOR_REVISION)) return undefined;
  const row = findSteelProduct(source.catalog, source.size, source.options);
  // An r1 row matches only an r1 save and an r2 row only an r2 save; r2 rows never had the legacy generator.
  if (row !== undefined && (steelProductCatalogRevision(row) !== source.catalogRevision
    || (row.catalogRevision !== undefined && source.generatorRevision !== STEEL_GENERATOR_REVISION))) return undefined;
  if (row === undefined || source.generatorRevision !== LEGACY_STEEL_GENERATOR_REVISION
    || row.geometry !== 'profileSection') return row;
  // The old generator retains its exact simplified geometry and provenance; the product standard (not geometry) is shared.
  return { key: row.key, catalog: row.catalog, size: row.size, materialGrade: row.materialGrade,
    materialStandard: row.materialStandard, productStandard: row.productStandard,
    condition: row.condition, evidence: row.evidence,
    standardReferences: row.standardReferences,
    get standardEdition() { return standardEdition(this.standardReferences); },
    ...(row.productStandardEvidence === undefined ? {} : { productStandardEvidence: row.productStandardEvidence }),
    geometry: 'simplifiedSection', standardLengthsMm: row.standardLengthsMm };
}
