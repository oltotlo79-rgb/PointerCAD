import { addComponent, createComponentFor } from '../assembly/assemblyEdit.js';
import { createAssemblyDocument, DEFAULT_ASSEMBLY_NAME } from '../assembly/createAssemblyDocument.js';
import { createAssemblyDocumentBundle } from '../assembly/documentBundle.js';
import { placementOnAxis } from '../assembly/fastening/fastenerPlacements.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../assembly/partLibrary.js';
import { joinRigidGroup } from '../assembly/rigidGroups.js';
import type { AssemblyExample } from './assemblyExample.js';
import { exampleCatalogComponent, exampleCatalogPart } from './exampleCatalogPart.js';
import { plateWithHoleExample } from './plateWithHole.js';

const atHeight = (z: number) => placementOnAxis([0, 0, 0], [0, 0, 1], z, [0, 0, 1]);

async function createBoltedPlates() {
  const plate = plateWithHoleExample.create();
  const stock = plate.solids.find(feature => feature.kind === 'extrude');
  if (stock === undefined) throw new Error('Missing plate extrusion');
  const nominalDiameter = 8;
  const [embedded, bolt, washer, nut] = await Promise.all([
    embedPart(EMPTY_PART_LIBRARY, plate, `${plateWithHoleExample.id}.pcad`, ''),
    exampleCatalogPart('hex-bolt-main', row => row.dims.nominalDiameter === nominalDiameter),
    exampleCatalogPart('plain-washer-normal', row => row.size === String(nominalDiameter)),
    exampleCatalogPart('hex-nut-style2', row => row.dims.nominalDiameter === nominalDiameter),
  ]);
  const plateThickness = stock.distance.value;
  const grip = 2 * plateThickness;
  const washerThickness = washer.row.dims.thickness;
  let assembly = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
  for (const z of [0, plateThickness]) {
    const component = createComponentFor(assembly, { kind: 'part', partRef: embedded.partRef },
      { partName: plate.name, placement: atHeight(z) });
    assembly = addComponent(assembly, component);
  }
  // The head occupies negative Z. Both washer faces touch the outside faces of the stack.
  assembly = addComponent(assembly, exampleCatalogComponent(assembly, bolt, atHeight(-washerThickness), { length: '30' }));
  for (const z of [-washerThickness, grip]) {
    assembly = addComponent(assembly, exampleCatalogComponent(assembly, washer, atHeight(z)));
  }
  assembly = addComponent(assembly, exampleCatalogComponent(assembly, nut, atHeight(grip + washerThickness)));
  const fastened = joinRigidGroup(assembly, assembly.components.map(component => component.id));
  return createAssemblyDocumentBundle(fastened, embedded.library);
}

export const boltedPlatesExample: AssemblyExample = { id: 'boltedPlates', create: createBoltedPlates };
