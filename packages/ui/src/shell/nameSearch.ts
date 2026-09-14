import { featureNoteTargetKey, type FeatureNoteTarget } from '@pointercad/model';
import { normalizeHelpSearch } from '@pointercad/help-content';
import type { SketchTreeGroup, TreeRow, TreeSection } from '../solid/solidSummary.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { AssemblyTreeRow, AssemblyTreeSection } from './assemblyTreeRows.js';

export interface NameSearchEntry {
  readonly key: string;
  readonly name: string;
  readonly context: string;
  readonly selectionId: string | null;
  readonly sketchId?: string;
  readonly badges: readonly MessageKey[];
  readonly historyTarget?: FeatureNoteTarget;
  readonly assemblyReveal?: { readonly section: AssemblyTreeSection['key']; readonly parents: readonly string[] };
}

export function partNameSearchEntries(sections: readonly TreeSection[], sketches: readonly SketchTreeGroup[]): readonly NameSearchEntry[] {
  const entries: NameSearchEntry[] = [];
  const add = (row: TreeRow, context: string, target: FeatureNoteTarget, sketchId?: string): void => {
    const badges: MessageKey[] = [];
    if (row.hidden) badges.push('nameSearch.hidden');
    if (row.suppressed) badges.push('nameSearch.suppressed');
    if (row.consumed) badges.push('nameSearch.consumed');
    entries.push({ key: featureNoteTargetKey(target), name: row.name, context, historyTarget: target,
      selectionId: row.id, ...(sketchId === undefined ? {} : { sketchId }), badges });
  };
  for (const section of sections) {
    if (section.key !== 'sketch') for (const row of section.rows) add(row, t(section.titleKey), { kind: section.key, id: row.id });
  }
  for (const group of sketches) {
    entries.push({ key: JSON.stringify(['sketch', group.sketchId]), name: group.name, context: t('nameSearch.sketch'),
      sketchId: group.sketchId, selectionId: null, badges: [], historyTarget: { kind: 'sketch', id: group.sketchId } });
    for (const row of group.rows) add(row, `${group.name} / ${t(row.kindLabelKey)}`, { kind: 'sketch-feature', sketchId: group.sketchId, id: row.id }, group.sketchId);
  }
  return entries;
}

export function assemblyNameSearchEntries(sections: readonly AssemblyTreeSection[]): readonly NameSearchEntry[] {
  const entries: NameSearchEntry[] = [];
  const add = (row: AssemblyTreeRow, context: string, section: AssemblyTreeSection['key'], parents: readonly string[]): void => {
    const badges: MessageKey[] = [];
    if (row.badges.includes('hidden')) badges.push('nameSearch.hidden');
    if (row.badges.includes('suppressed')) badges.push('nameSearch.suppressed');
    entries.push({ key: row.key, name: row.name, context, selectionId: row.id, badges, assemblyReveal: { section, parents } });
    for (const child of row.children ?? []) add(child, `${context} / ${row.name}`, section, [...parents, row.id]);
  };
  for (const section of sections) for (const row of section.rows) add(row, t(section.titleKey), section.key, []);
  return entries;
}

export function searchNamedEntries(entries: readonly NameSearchEntry[], query: string): readonly { readonly entry: NameSearchEntry; readonly ordinal: number }[] {
  const words = [...new Set(normalizeHelpSearch(query).split(' ').filter(Boolean))];
  if (words.length === 0) return [];
  return entries.flatMap((entry, index) => {
    const name = normalizeHelpSearch(entry.name), context = normalizeHelpSearch(entry.context);
    return words.every(word => name.includes(word) || context.includes(word)) ? [{ entry, ordinal: index + 1 }] : [];
  });
}
