import { accessoryCandidates, applyAccessorySet } from '../assembly/accessories/accessorySets.js';
import { addComponent } from '../assembly/assemblyEdit.js';
import { PRODUCT_CATALOG_REGISTRY } from '../assembly/catalog/registry.js';
import { createAssemblyDocument, DEFAULT_ASSEMBLY_NAME } from '../assembly/createAssemblyDocument.js';
import { createAssemblyDocumentBundle } from '../assembly/documentBundle.js';
import { placementOnAxis } from '../assembly/fastening/fastenerPlacements.js';
import type { AssemblyDocument } from '../assembly/types.js';
import type { AssemblyExample } from './assemblyExample.js';
import { exampleCatalogComponent, exampleCatalogPart } from './exampleCatalogPart.js';

function capExposedEnds(assembly: AssemblyDocument, railId: string): AssemblyDocument {
  const candidates = accessoryCandidates(assembly, railId, 'frame-end-caps');
  if (!candidates.ok) throw new Error(candidates.reason);
  const cap = candidates.value.find(candidate => candidate.thicknessMm === 3);
  if (cap === undefined) throw new Error('Missing matching frame cap');
  const capped = applyAccessorySet(assembly, railId, 'frame-end-caps',
    { itemKey: cap.itemKey, ends: 'both', endReference: 'member' });
  if (!capped.ok) throw new Error(capped.reason);
  return capped.value.document;
}

async function createAluminumFrame() {
  const [section] = await Promise.all([
    exampleCatalogPart('t-slot-frame-s6', ({ dims }) => dims.width === 20 && dims.height === 20
      && dims.slotTop === 1 && dims.slotBottom === 1 && dims.slotLeft === 1 && dims.slotRight === 1),
    PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-cap']),
  ]);
  const railLength = 200, postLength = 100, side = section.row.dims.width;
  let assembly = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
  for (const z of [0, postLength + side]) {
    const placement = placementOnAxis([-railLength / 2, 0, z], [1, 0, 0], 0, [1, 0, 0]);
    const rail = exampleCatalogComponent(assembly, section, placement, { length: String(railLength) });
    assembly = capExposedEnds(addComponent(assembly, rail), rail.id);
  }
  const postOffset = (railLength - side) / 2;
  for (const x of [-postOffset, postOffset]) {
    const placement = placementOnAxis([x, 0, side / 2], [0, 0, 1], 0, [0, 0, 1]);
    const post = exampleCatalogComponent(assembly, section, placement, { length: String(postLength) });
    assembly = addComponent(assembly, post);
  }
  return createAssemblyDocumentBundle(assembly);
}

export const aluminumFrameExample: AssemblyExample = { id: 'aluminumFrame', create: createAluminumFrame };
