import { writeDocumentBundle } from '../../packages/io/src/index.js';
import { createAssemblyDocument, createAssemblyDocumentBundle, EMPTY_PART_LIBRARY } from '../../packages/model/src/index.js';
import { testComponent, testPlacement } from '../../packages/model/src/analysis/beamInputs.testSupport.js';

/** Real catalog FB 50x6, 2 m long; this file contains CAD input only, never analysis results. */
export const RESOURCE_MEMBER_COUNT = 1000;
export const RESOURCE_MEMBER_LENGTH_MM = 2000;
export const RESOURCE_TOTAL_LENGTH_MM = RESOURCE_MEMBER_COUNT * RESOURCE_MEMBER_LENGTH_MM;

export async function analysisResourcesAssemblyFile(): Promise<Uint8Array> {
  const document = createAssemblyDocument('Resource benchmark: 1000 catalog bars');
  const components = Array.from({ length: RESOURCE_MEMBER_COUNT }, (_, i) => ({
    ...testComponent(`resource-beam-${String(i)}`, String(RESOURCE_MEMBER_LENGTH_MM)),
    placement: testPlacement([0, 0, i * RESOURCE_MEMBER_LENGTH_MM]),
  }));
  return writeDocumentBundle(createAssemblyDocumentBundle({ ...document, components }, EMPTY_PART_LIBRARY));
}
