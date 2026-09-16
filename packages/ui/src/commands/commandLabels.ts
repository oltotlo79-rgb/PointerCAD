import { t } from '../i18n/t.js';
import { commandDefinition, type CommandDocumentKind, type CommandId } from './commandDefinitions.js';
import { effectiveBindings, type ShortcutAssignments } from './shortcutAssignments.js';

/** Derive tooltips from the bindings actually used in this document, including unassigned commands. */
export function currentCommandLabel(id: CommandId, assignments: ShortcutAssignments, documentKind: CommandDocumentKind): string {
  const definition = commandDefinition(id);
  if (definition === null) return t('settings.shortcuts.unknown');
  const keys = [...new Set(effectiveBindings(definition, assignments)
    .filter(binding => binding.documentKinds.includes(documentKind)).map(binding => binding.display))];
  return t(definition.labelKey) + (keys.length === 0 ? '' : ` (${keys.join(' / ')})`);
}
