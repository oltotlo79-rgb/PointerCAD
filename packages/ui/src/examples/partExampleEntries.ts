import type { PartExampleId } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/** What the picker shows for one example. The geometry itself comes from the model's example builders. */
interface PartExampleEntry {
  readonly nameKey: MessageKey;
  readonly summaryKey: MessageKey;
  /** The features the example uses, in the order they appear in the history. */
  readonly featuresKey: MessageKey;
  /** The help page about the feature the example shows best. */
  readonly helpTopic: string;
}

/** Every model example has an entry; the record type rejects a missing or extra id. */
export const PART_EXAMPLE_ENTRIES: Readonly<Record<PartExampleId, PartExampleEntry>> = {
  plateWithHole: {
    nameKey: 'examples.plateWithHole.name', summaryKey: 'examples.plateWithHole.summary',
    featuresKey: 'examples.plateWithHole.features', helpTopic: 'hole',
  },
  flange: {
    nameKey: 'examples.flange.name', summaryKey: 'examples.flange.summary',
    featuresKey: 'examples.flange.features', helpTopic: 'pattern',
  },
  spring: {
    nameKey: 'examples.spring.name', summaryKey: 'examples.spring.summary',
    featuresKey: 'examples.spring.features', helpTopic: 'spring',
  },
  parameterBox: {
    nameKey: 'examples.parameterBox.name', summaryKey: 'examples.parameterBox.summary',
    featuresKey: 'examples.parameterBox.features', helpTopic: 'parameters',
  },
  saddleSurface: {
    nameKey: 'examples.saddleSurface.name', summaryKey: 'examples.saddleSurface.summary',
    featuresKey: 'examples.saddleSurface.features', helpTopic: 'function-surface',
  },
  shelledBox: {
    nameKey: 'examples.shelledBox.name', summaryKey: 'examples.shelledBox.summary',
    featuresKey: 'examples.shelledBox.features', helpTopic: 'shape-edit',
  },
};
