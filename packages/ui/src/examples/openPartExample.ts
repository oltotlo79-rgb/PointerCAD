import { PART_EXAMPLES, type PartExampleId } from '@pointercad/model';
import { createDefaultPartFileDeps, newPartFrom, type PartFileDeps } from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { PART_EXAMPLE_ENTRIES } from './partExampleEntries.js';

/** Show the example list. The file menu and the empty part's welcome both open it. */
export function openPartExamples(): void {
  useAppStore.getState().setUtilityPanelOpen('examples', true);
}

/**
 * Start a new part from one example, through the same confirmation, fresh id and cleared save target as New.
 * The document takes the example's name; saving asks where to save like any new part.
 */
export function openPartExample(id: PartExampleId, deps: PartFileDeps = createDefaultPartFileDeps()): Promise<void> {
  const example = PART_EXAMPLES.find(entry => entry.id === id);
  if (example === undefined) return Promise.resolve();
  return newPartFrom(deps, { ...example.create(), name: t(PART_EXAMPLE_ENTRIES[id].nameKey) });
}
