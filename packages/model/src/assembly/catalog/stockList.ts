/**
 * 長さを持つ族(`stock: 'linear'`)の部品を、切断の一覧の 1 本にする(K-06 段 2 の土台。設計 §5.7 (f))。
 * 鋼材の切断の一覧(`standard/steelStockList.ts`)が、族の部品の時にここを呼び、鋼材の行とは別の並び(`catalogRows`)に束ねる。
 * 鋼材の行の作り方・順・鍵は変えない。'count' の族(ナット・座金・軸受・ねじ・ピンなど 1 個ずつ数える物)・読み込んでいない族・
 * 確かめに通らない保存は数えない(切断の一覧に出す物が無いだけで、理由の行も足さない)。
 * 質量は 形の台本どおりの体積 × 行の材質(densityMaterialId)の密度。密度の材質を持たない行は、行の単位質量だけから出す(無ければ null)。
 */
import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import { massFromVolume } from '../../measure/massProperties.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { lengthOf } from './lengthOption.js';
import type { CatalogRegistry } from './registry.js';
import { catalogItemNominalMass, catalogItemNominalVolume, catalogItemRejection } from './source.js';
import type { CatalogItemRow } from './types.js';

/** 切断の一覧の 1 本(族の部品 1 つ)。 */
export interface CatalogStockItem {
  /** 束ねる鍵(族・版・行・長さ)。同じ鍵の部品は同じ 1 行に数える。 */
  readonly key: string;
  readonly familyId: string;
  /** 種類の名前の i18n の鍵。 */
  readonly kindKey: string;
  readonly itemKey: string;
  /** 呼び(保存の size)。 */
  readonly size: string;
  /** 規格の欄(例 `JIS B 1354`。規格の行でない族は「寸法指定(規格の行ではない)」)。 */
  readonly standardLabel: string;
  /** 寸法の出どころ(切断の一覧の CSV の出どころの列に写す)。 */
  readonly evidence: CatalogItemRow['evidence'];
  /** 部品表の材質の表示(行が持つ時だけ)。 */
  readonly materialLabel: string | null;
  /** 行の密度の材質 id(密度の表に無い材料の行は null。その時の 1 本の質量は行の単位質量だけから出す)。 */
  readonly densityMaterialId: string | null;
  readonly catalogRevision: string;
  readonly generatorRevision: string;
  readonly lengthMm: number;
  /** 行が持つ単位質量(kg/m。製造元の寸法に合わせたフレームの系列だけ。無い行は null)。 */
  readonly unitMassKgPerM: number | null;
  /** 1 本の質量(g)。単位質量を持つ行は単位質量 × 長さ、無い行は体積 × 密度。出せない時は null。 */
  readonly massEachG: number | null;
  /**
   * 留めで 45° に切った端の数(0〜2。J-01 包み 5)。留めの部材の `lengthMm` は長い側の長さ(切る前の棒の長さ)で、
   * 質量は部品表と同じ値(単位質量 × 留めを引いた後の体積 ÷ 断面積)。
   */
  readonly miterEnds: number;
}

/** 留めの欄の値の端の数(切らない端・欄の無い保存は数えない)。 */
function miterEndsOf(options: Readonly<Record<string, string>>): number {
  return [options.startMiter, options.endMiter].filter((value) => value !== undefined && value !== 'none').length;
}

/** 族の部品の保存の形から、切断の一覧の 1 本を作る。'linear' でない族・読み込んでいない族・確かめに通らない保存は null。 */
export function catalogStockItem(source: StandardPartSource, registry: CatalogRegistry): CatalogStockItem | null {
  if (source.catalog !== 'catalogItem') return null;
  const familyId = source.options.family ?? '';
  const family = registry.loaded(familyId);
  if (family === undefined || family.stock !== 'linear' || catalogItemRejection(source, registry) !== null) return null;
  const row = family.rows.find((candidate) => candidate.key === source.options.item && candidate.size === source.size);
  const length = lengthOf(source.options);
  if (row === undefined || length === null || !(length.value > 0)) return null;
  const volume = catalogItemNominalVolume(source.size, source.options, registry);
  // 密度の材質を持たない行は、密度を引かない(体積 × 密度で質量を作らない)。
  const density = row.densityMaterialId === undefined ? undefined : findDensityMaterial(row.densityMaterialId)?.density;
  const nominalMass = catalogItemNominalMass(source, registry);
  const miterEnds = miterEndsOf(source.options);
  // 留めの部材は、留めの向きごとに別の行に束ねる(留めの無い部材の鍵は前と同じ)。
  const miterKey = miterEnds === 0 ? '' : `:miter=${source.options.startMiter ?? 'none'}/${source.options.endMiter ?? 'none'}`;
  return {
    key: `${familyId}@${family.catalogRevision}/${family.generatorRevision}:${row.key}:${length.value}${miterKey}`,
    familyId, kindKey: family.kindKey, itemKey: row.key, size: row.size, standardLabel: row.standardLabel, evidence: row.evidence,
    materialLabel: row.materialLabel ?? null,
    densityMaterialId: row.densityMaterialId ?? null, catalogRevision: family.catalogRevision, generatorRevision: family.generatorRevision,
    lengthMm: length.value,
    unitMassKgPerM: row.dims.unitMassKgPerM ?? null,
    // 族が単位質量を持つ時はその値(× 長さ)、無い時は形の体積 × 行の材質の密度。
    massEachG: nominalMass ?? (volume === null || density === undefined ? null : massFromVolume(volume, density)),
    miterEnds,
  };
}
