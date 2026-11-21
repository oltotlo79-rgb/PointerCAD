import { catalogItemFallbackMaterialLabel } from '../assembly/catalog/source.js';
import type { StandardPartSource } from '../assembly/resolveAssembly.js';
import { steelProductFromSource } from '../assembly/standard/steelCatalog.js';
import { STRENGTH_MATERIALS } from '../measure/strengthMaterials.js';
import type { StrengthMaterialPreset } from '../measure/strengthMaterialTypes.js';

/** A grade identifies candidate rows only. Condition and product thickness remain separate choices. */
export function catalogStrengthMaterials(source: StandardPartSource): readonly StrengthMaterialPreset[] {
  const grade = source.catalog === 'catalogItem'
    ? catalogItemFallbackMaterialLabel(source)
    : steelProductFromSource(source)?.materialGrade;
  return STRENGTH_MATERIALS.filter(row => row.grade === grade);
}
