import type { AssemblyExample, DrawingExample } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/** Text and help shared by all three kinds of example in the picker. */
export interface ExampleEntry {
  readonly nameKey: MessageKey;
  readonly summaryKey: MessageKey;
  readonly featuresKey: MessageKey;
  readonly helpTopic: string;
}

export const ASSEMBLY_EXAMPLE_ENTRIES: Readonly<Record<AssemblyExample['id'], ExampleEntry>> = {
  boltedPlates: {
    nameKey: 'examples.boltedPlates.name', summaryKey: 'examples.boltedPlates.summary',
    featuresKey: 'examples.boltedPlates.features', helpTopic: 'assembly',
  },
  aluminumFrame: {
    nameKey: 'examples.aluminumFrame.name', summaryKey: 'examples.aluminumFrame.summary',
    featuresKey: 'examples.aluminumFrame.features', helpTopic: 'standard-parts',
  },
};

export const DRAWING_EXAMPLE_ENTRIES: Readonly<Record<DrawingExample['id'], ExampleEntry>> = {
  flangeDrawing: {
    nameKey: 'examples.flangeDrawing.name', summaryKey: 'examples.flangeDrawing.summary',
    featuresKey: 'examples.flangeDrawing.features', helpTopic: 'drawing-views',
  },
};
