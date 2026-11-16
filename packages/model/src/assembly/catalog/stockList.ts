/**
 * 長さを持つ族(`stock: 'linear'`)の部品を、切断の一覧の 1 本にする(K-06 段 2 の土台。設計 §5.7 (f))。
 * 鋼材の切断の一覧(`standard/steelStockList.ts`)が、族の部品の時にここを呼び、鋼材の行とは別の並び(`catalogRows`)に束ねる。
 * 鋼材の行の作り方・順・鍵は変えない。'count' の族(ナット・座金・軸受・ねじ・ピンなど 1 個ずつ数える物)・読み込んでいない族・
 * 確かめに通らない保存は数えない(切断の一覧に出す物が無いだけで、理由の行も足さない)。
 * 質量は 形の台本どおりの体積 × 行の材質(densityMaterialId)の密度。
 */
import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import { massFromVolume } from '../../measure/massProperties.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { lengthOf } from './lengthOption.js';
import type { CatalogRegistry } from './registry.js';
import { catalogItemNominalVolume, catalogItemRejection } from './source.js';

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
  /** 部品表の材質の表示(行が持つ時だけ)。 */
  readonly materialLabel: string | null;
  readonly densityMaterialId: string;
  readonly catalogRevision: string;
  readonly generatorRevision: string;
  readonly lengthMm: number;
  /** 1 本の質量(g)。体積か密度が出せない時は null。 */
  readonly massEachG: number | null;
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
  const density = findDensityMaterial(row.densityMaterialId)?.density;
  return {
    key: `${familyId}@${family.catalogRevision}/${family.generatorRevision}:${row.key}:${length.value}`,
    familyId, kindKey: family.kindKey, itemKey: row.key, size: row.size, materialLabel: row.materialLabel ?? null,
    densityMaterialId: row.densityMaterialId, catalogRevision: family.catalogRevision, generatorRevision: family.generatorRevision,
    lengthMm: length.value,
    massEachG: volume === null || density === undefined ? null : massFromVolume(volume, density),
  };
}
