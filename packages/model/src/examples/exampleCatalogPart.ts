import { createComponentFor } from '../assembly/assemblyEdit.js';
import { PRODUCT_CATALOG_REGISTRY } from '../assembly/catalog/registry.js';
import { createCatalogItemSource } from '../assembly/catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../assembly/catalog/types.js';
import type { AssemblyComponent, AssemblyDocument, Placement } from '../assembly/types.js';

interface CatalogPart {
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
}

/** Select by dimensions. The current row supplies the persistent key and revisions. */
export async function exampleCatalogPart(familyId: string, matches: (row: CatalogItemRow) => boolean): Promise<CatalogPart> {
  await PRODUCT_CATALOG_REGISTRY.ensure([familyId]);
  const family = PRODUCT_CATALOG_REGISTRY.loaded(familyId);
  const row = family?.rows.find(matches);
  if (family === undefined || row === undefined) throw new Error(`Missing example part in ${familyId}`);
  return { family, row };
}

export function exampleCatalogComponent(document: AssemblyDocument, part: CatalogPart, placement: Placement,
  options: Readonly<Record<string, string>> = {}): AssemblyComponent {
  const { family, row } = part;
  const source = createCatalogItemSource(family, row, options);
  const component = createComponentFor(document, source, { partName: family.partName(row, source.options), placement });
  return row.densityMaterialId === undefined ? component : { ...component, materialId: row.densityMaterialId };
}
