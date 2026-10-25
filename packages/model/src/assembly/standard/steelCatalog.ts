import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import type { StandardCatalogId } from '../types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { STEEL_PROFILE_EVIDENCE } from './steelSectionProfiles.js';
import { STEEL_STANDARDS, type SteelProductStandardReferences, type SteelStandard } from './steelStandards.js';

/** Separate from r1: a saved r1 section never acquires an inferred steel grade. */
export const STEEL_CATALOG_REVISION = 'jp-steel-2026-10-10-r1';
export const LEGACY_STEEL_GENERATOR_REVISION = '2-steel-1';
export const STEEL_GENERATOR_REVISION = '3-steel-profile-1';
export const STEEL_MATERIAL_GRADES = ['SS400', 'S45C', 'SGP'] as const;
export type SteelMaterialGrade = typeof STEEL_MATERIAL_GRADES[number];
export type SteelSectionCatalog = Extract<StandardCatalogId,
  'flatBar' | 'roundBar' | 'steelPipe' | 'equalAngle' | 'channel' | 'hBeam'>;
export type SteelCondition = 'hotRolled-heatTreatmentUnspecified'
  | 'brightBar-heatTreatmentUnspecified' | 'blackPipe-plainEnds' | 'whitePipe-zincCoated';

export interface SteelEvidence {
  readonly title: string;
  /** Null means the publication itself does not state an edition. */
  readonly edition: string | null;
  readonly url: string;
  readonly locator: string;
  readonly sha256: string;
  readonly fetchedDate: string;
}

/** Producer catalogs substantiate nominal sizes and grades, not inventory or certification. */
export const STEEL_EVIDENCE = {
  ssHBeamDraft: {
    title: '日本鉄鋼連盟 JIS G 3192 改正原案 H形鋼', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3192_20240724.pdf',
    locator: 'JISF G 3192 原案 2024-07-24 表15 PDF p21–22; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json。最終規格票・供給長さは未確認',
    sha256: 'ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa',
    fetchedDate: '2026-10-25',
  },
  ssAngleDraft: {
    title: '日本鉄鋼連盟 JIS G 3192 改正原案 等辺山形鋼', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3192_20240724.pdf',
    locator: 'JISF G 3192 原案 2024-07-24 表8 PDF p14; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json。最終規格票・供給長さは未確認',
    sha256: 'ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa',
    fetchedDate: '2026-10-25',
  },
  ssChannelDraft: {
    title: '日本鉄鋼連盟 JIS G 3192 改正原案 溝形鋼', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3192_20240724.pdf',
    locator: 'JISF G 3192 原案 2024-07-24 表12 PDF p18; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json。最終規格票・供給長さは未確認',
    sha256: 'ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa',
    fetchedDate: '2026-10-25',
  },
  ssFlatDraft: {
    title: '日本鉄鋼連盟 JIS G 3194 改正原案', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0500JISG3194_20240724.pdf',
    locator: '2024-07-24原案 PDF p6 JIS G 3194 箇条5・表1 標準厚さ / 表2 標準幅（11厚さ×12幅）。製造元の供給寸法・長さは未確認',
    sha256: '07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea',
    fetchedDate: '2026-10-24',
  },
  ssRoundDraft: {
    title: '日本鉄鋼連盟 JIS G 3191 改正原案', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai010_jis12G3191_20210728.pdf',
    locator: '2021-07-28原案 PDF p6 表1 括弧なし推奨径 / 5.1 径9 mm未満はバーインコイル。製造元の供給寸法・長さは未確認',
    sha256: '8ea886730b59558553d49f395e7ada43c093210c51e00e3080c08f2163c0e313',
    fetchedDate: '2026-10-24',
  },
  ss400GradeDraft: {
    title: '日本鉄鋼連盟 JIS G 3101 改正原案', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0400JISG3101_20230726.pdf',
    locator: '2023-07-26原案 PDF p6 表1 SS400 棒鋼・平鋼（平鋼は厚さ100 mm以下）',
    sha256: '797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893',
    fetchedDate: '2026-10-24',
  },
  hotRound: {
    title: '日本鉄鋼連盟 JIS G 4051 改正原案', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0700_JISG4051_20251217.pdf',
    locator: '2025-12-17原案 PDF p8 7.1.1・表3 熱間圧延丸鋼の括弧なし推奨径 / p6 5 c) 熱処理未指定',
    sha256: '158ac7b25b0c1cda41ae5cdf68cfe37530b73f1288b9cacf62c2d45584664245',
    fetchedDate: '2026-10-24',
  },
  hotFlat: {
    title: '日本製鉄 建設用資材ハンドブック 王子製鉄 平鋼', edition: '2025年9月改訂版',
    url: 'https://www.nipponsteel.com/product/construction/handbook/pdf/3-52.pdf',
    locator: 'PDF p1 JIS G 4051 S10C〜S58C / p2〜3 標準断面寸法の厚さ×幅（G 3194原案の標準格子との共通部分）',
    sha256: '50b0a027712a8a0991f52b33896309c3c3f4f83ec3c3704d54eaecb76a87ac3b',
    fetchedDate: '2026-10-24',
  },
  osaka: {
    title: '大阪製鐵 製品カタログ', edition: null,
    url: 'https://www.osaka-seitetu.co.jp/wp/wp-content/themes/osaka-seitetu/pdf/catalog_2403.pdf',
    locator: 'PDF p3 製品・規格 / p4 等辺山形鋼・溝形鋼寸法表',
    sha256: '6921b44fe26e066498d5e4257067cdc5e1f5aca6f7e307481095a658f8ddf109',
    fetchedDate: '2026-10-10',
  },
  yamato: {
    title: '大和工業グループ 会社案内', edition: '2025.12',
    url: 'https://www.yamatokogyo.co.jp/steel/en/catalog/pdf/company-brochureA3.pdf',
    locator: 'PDF p4 製品規格 / p6 H形鋼標準寸法表',
    sha256: '69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22',
    fetchedDate: '2026-10-10',
  },
  flat: {
    title: '日本製鉄 建設用資材ハンドブック 王子製鉄 平鋼', edition: '2025年9月改訂版',
    url: 'https://www.nipponsteel.com/product/construction/handbook/pdf/3-52.pdf',
    locator: 'PDF p1 規格 / p2 標準断面寸法 / p4 製造寸法',
    sha256: '50b0a027712a8a0991f52b33896309c3c3f4f83ec3c3704d54eaecb76a87ac3b',
    fetchedDate: '2026-10-10',
  },
  round: {
    title: '日本製鉄 建設用資材ハンドブック 大阪製鐵 一般構造用丸鋼',
    edition: '2025年9月改訂版',
    url: 'https://www.nipponsteel.com/product/construction/handbook/pdf/5-33.pdf',
    locator: 'PDF p1 SS400標準断面寸法・標準長さ',
    sha256: '5e9fbba2c98ccadfaf0f88497af97664393234e4da8b5bb23606997909ef542c',
    fetchedDate: '2026-10-10',
  },
  brightRound: {
    title: '太平鋼材工業 みがき丸鋼サイズ表', edition: null,
    url: 'https://taiheikouzai.co.jp/assets/pdf/marukou.pdf',
    locator: 'PDF p1 S45C（黄色印）の径20・25・30行',
    sha256: 'a52cd2467606af4ba52bcc2aa14bc30cb70d7855071e3ee66f1c38193edc07ce',
    fetchedDate: '2026-10-10',
  },
  brightFlat: {
    title: '太平鋼材工業 みがき平鋼サイズ表', edition: null,
    url: 'https://taiheikouzai.co.jp/assets/pdf/hirakou.pdf',
    locator: 'PDF p1 S45C（黄色印）、幅50×厚6・9・12 mmの交点',
    sha256: 'f45feea1ccb83dbc1706ee7241f97accc92473b139b463c38f7155f22893dd87',
    fetchedDate: '2026-10-10',
  },
  carbonGrade: {
    title: '合同製鐵 構造用棒鋼', edition: null,
    url: 'https://www.godo-steel.co.jp/seihin/pdf/The_structural_bars_of_Godo_Steel_20221116.pdf',
    locator: 'PDF p5 機械構造用炭素鋼鋼材（JIS G4051）S45C行（鋼種分類のみ）',
    sha256: 'f19cd3ea52561f00bf43149748d4b924227f06e59ede71fe42bb0680612b2b70',
    fetchedDate: '2026-10-10',
  },
  pipe: {
    title: 'JFEスチール 配管用鋼管', edition: null,
    url: 'https://www.jfe-steel.co.jp/products/koukan/catalog/e1j-001.pdf',
    locator: 'PDF p12（冊子p10）SGP種類・寸法・標準長さ / p13管端形状',
    sha256: 'e0790c1900aa6eedeb7c51dc18916c7c506c02765550e8a5a2ca642b7096d0be',
    fetchedDate: '2026-10-10',
  },
} as const satisfies Readonly<Record<string, SteelEvidence>>;

/**
 * Producer pages that name the product/dimension standard where the dimensional source does not.
 * They show which standard the producer applies; they are not a current normative JIS edition.
 */
export const STEEL_PRODUCT_STANDARD_EVIDENCE = {
  hotFlatDraft: {
    title: '日本鉄鋼連盟 JIS G 3194 改正原案', edition: null,
    url: 'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai_0500JISG3194_20240724.pdf',
    locator: '2024-07-24原案 PDF p6 JIS G 3194 箇条5・表1 標準厚さ / 表2 標準幅（G 4051原案7.3が引用）',
    sha256: '07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea',
    fetchedDate: '2026-10-24',
  },
  jfeSections: {
    title: 'JFE条鋼 形鋼・平鋼・丸鋼 寸法表', edition: null,
    url: 'https://www.jfe-bs.co.jp/files/size_kata-hira-maru.pdf',
    locator: 'PDF p26（冊子p24）形状・寸法の許容差表：等辺山形鋼 AB・溝形鋼 CB に JIS G 3192',
    sha256: '031d35df73d5681c7ad7cb721eea4838e80624c9ca7092a69c8e83641c5d65de',
    fetchedDate: '2026-10-10',
  },
  yamatoH: {
    title: '大和工業グループ 会社案内', edition: '2025.12',
    url: 'https://www.yamatokogyo.co.jp/steel/en/catalog/pdf/company-brochureA3.pdf',
    locator: 'PDF p9 H形鋼の形状・寸法の許容差表：JIS G 3192',
    sha256: '69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22',
    fetchedDate: '2026-10-10',
  },
  brightBar: {
    title: '太平鋼材工業 製品情報 公差表', edition: null,
    url: 'https://taiheikouzai.co.jp/product.html?id=lineup',
    locator: '公差表（JIS G 3123）、適用形状 丸・平',
    sha256: '63430ac1b24c555dbe09796a706cdfd75b77e12c727fe064e5d4db63917480eb',
    fetchedDate: '2026-10-10',
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
}

function standardEdition(references: SteelProductStandardReferences): SteelProduct['standardEdition'] {
  return { material: STEEL_STANDARDS[references.material], dimensions: STEEL_STANDARDS[references.dimensions] };
}

const hot = 'hotRolled-heatTreatmentUnspecified';
function ssSection(catalog: SteelSectionCatalog, size: string,
  evidence: 'osaka' | 'yamato'): SteelProduct {
  return { key: `SS400:${catalog}:${size}`, catalog, size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    evidence, productStandardEvidence: catalog === 'hBeam' ? STEEL_PRODUCT_STANDARD_EVIDENCE.yamatoH
      : STEEL_PRODUCT_STANDARD_EVIDENCE.jfeSections,
    geometry: 'profileSection',
    profileEvidence: catalog === 'equalAngle' ? STEEL_PROFILE_EVIDENCE.jfeAngle
      : catalog === 'channel' ? STEEL_PROFILE_EVIDENCE.jfeChannel : STEEL_PROFILE_EVIDENCE.yamatoH,
    standardLengthsMm: [] };
}
function flat(thickness: number, width: number, materialGrade: 'SS400' | 'S45C' = 'SS400'): SteelProduct {
  const size = `FB ${width}×${thickness}`;
  return { key: `${materialGrade}:flatBar:${size}`, catalog: 'flatBar', size, materialGrade,
    materialStandard: materialGrade === 'SS400' ? 'JIS G 3101' : 'JIS G 4051',
    productStandard: materialGrade === 'SS400' ? '王子製鉄 公表断面寸法' : 'JIS G 3123',
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
    productStandard: materialGrade === 'SS400' ? '大阪製鐵 公表丸鋼寸法' : 'JIS G 3123',
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

/** sources.md §2・§4: draft standard dimensions, never stock or treatment/strength guarantees. */
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

/** W5: only SS400 dimensions present in the JISF drafts, separate from frozen producer rows. */
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

/** W6d: draft table 8/12 additions, separate from every frozen producer row. */
function ss400SectionStandard(catalog: 'equalAngle' | 'channel', size: string): SteelProduct {
  const evidence = catalog === 'equalAngle' ? 'ssAngleDraft' : 'ssChannelDraft';
  return { key: `SS400:${catalog}:${size}`, catalog, size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    evidence, materialEvidence: 'ss400GradeDraft',
    productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.jfeSections,
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE[evidence], standardLengthsMm: [] };
}

/** W7: table 15 additions only; keep every existing producer row and saved string. */
function ss400HBeamStandard(size: string): SteelProduct {
  return { key: `SS400:hBeam:${size}`, catalog: 'hBeam', size, materialGrade: 'SS400',
    materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: hot,
    evidence: 'ssHBeamDraft', materialEvidence: 'ss400GradeDraft',
    productStandardEvidence: STEEL_PRODUCT_STANDARD_EVIDENCE.yamatoH,
    standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' },
    get standardEdition() { return standardEdition(this.standardReferences); },
    geometry: 'profileSection', profileEvidence: STEEL_EVIDENCE.ssHBeamDraft, standardLengthsMm: [] };
}

/** A small, explicit grade/size matrix; no cartesian product of grades and sections. */
export const STEEL_PRODUCTS: readonly SteelProduct[] = [
  flat(6, 50), flat(9, 50), flat(12, 50), flat(6, 100), flat(9, 100),
  ...[13, 16, 19, 22, 25].map((diameter) => round(diameter, 'SS400')),
  ssSection('equalAngle', 'L 40×40×5', 'osaka'),
  ssSection('equalAngle', 'L 50×50×6', 'osaka'),
  ssSection('equalAngle', 'L 65×65×6', 'osaka'),
  ssSection('channel', '[ 75×40×5×7', 'osaka'),
  ssSection('channel', '[ 100×50×5×7.5', 'osaka'),
  ssSection('channel', '[ 125×65×6×8', 'osaka'),
  ssSection('hBeam', 'H 150×150×7×10', 'yamato'),
  ssSection('hBeam', 'H 200×200×8×12', 'yamato'),
  ssSection('hBeam', 'H 300×300×10×15', 'yamato'),
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
  // W5, G 3194 draft PDF p6 tables 1/2: all 132 standard pairs, minus the frozen five above.
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
  // W5, G 3191 draft PDF p6 table 1: 44 unparenthesized diameters, minus the frozen five.
  // Clause 5.1: diameters below 9 mm refer to bar-in-coil; no cut-stock supply is asserted.
  ...[5.5, 6, 7, 8, 9, 10, 11, 12, 20, 24, 28, 30, 32, 36, 38, 42, 46, 48, 50,
    55, 56, 60, 64, 65, 70, 75, 80, 85, 90, 95, 100, 110, 120, 130, 140, 150, 160, 180, 200]
    .map((diameter) => ss400Standard('roundBar', `φ${diameter}`, { diameter })),
  // W6d: JISF G 3192 draft tables 8/12, transcribed g3192-tables.json.
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
  // W7: JISF G 3192 draft table 15; scratchpad/claude/agents/cl-v103-ex03-g3192-source/g3192-tables.json.
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
  // W8b: JISF G 3452 draft table 4, PDF p10 / printed p6; black additions and all -ZN white pipes.
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
    const note = `JISF G 3452 2025-12-17原案 表4 PDF p10（印刷p6）${sourceRow}。`
      + '転記: scratchpad/claude/agents/cl-v103-ex03-g3452-source/g3452-tables.json。'
      + '表 4 の単位質量はソケットを含まない参考値。めっき・ねじの分は含まない。'
      + (Number.parseInt(size, 10) <= 300 ? '300A以下はねじ付又はプレンエンド。' : '350A以上はプレンエンド。')
      + '管端・ソケット・ねじ・めっき厚さは形状に反映しない。5500 mmは従来の製造元資料による。最終規格票・供給は未確認。';
    return [...(missingBlack ? [pipe(size, diameter, thickness, 'blackPipe-plainEnds', note)] : []),
      pipe(size, diameter, thickness, 'whitePipe-zincCoated', `白管（亜鉛めっき -ZN）。${note}`)];
  }),
];

export function steelProducts(material: SteelMaterialGrade,
  catalog?: SteelSectionCatalog): readonly SteelProduct[] {
  return STEEL_PRODUCTS.filter((row) => row.materialGrade === material
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
  const row = STEEL_PRODUCTS.find((candidate) => candidate.key === options.steelProduct
    && candidate.catalog === catalog && candidate.size === size);
  if (row === undefined) return undefined;
  const canonical = steelProductOptions(row);
  return Object.entries(canonical).every(([key, value]) => options[key] === value)
    && Object.keys(options).every((key) => key === 'length' || Object.hasOwn(canonical, key))
    ? row : undefined;
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
  if (source.catalogRevision !== STEEL_CATALOG_REVISION
    || (source.generatorRevision !== STEEL_GENERATOR_REVISION
      && source.generatorRevision !== LEGACY_STEEL_GENERATOR_REVISION)) return undefined;
  const row = findSteelProduct(source.catalog, source.size, source.options);
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
