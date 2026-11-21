import type { PartDocument } from '../part/types.js';

/** The picker looks up the name, the summary and the help page by this id. Documents carry no display text. */
export type PartExampleId = 'plateWithHole' | 'flange' | 'spring' | 'parameterBox' | 'saddleSurface' | 'shelledBox';

/** Each call builds a fresh document with the standard empty-part identity. The caller assigns a new id. */
export interface PartExample {
  readonly id: PartExampleId;
  readonly create: () => PartDocument;
}
