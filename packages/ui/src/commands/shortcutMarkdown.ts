import { t } from '../i18n/t.js';
import { currentShortcutList } from './commandDefinitions.js';
import { EMPTY_SHORTCUT_ASSIGNMENTS, effectiveBindings, type ShortcutAssignments } from './shortcutAssignments.js';

export const SHORTCUT_TABLE_MARKER = '<!-- pointercad:current-shortcuts -->';

export function currentShortcutMarkdown(assignments: ShortcutAssignments = EMPTY_SHORTCUT_ASSIGNMENTS): string {
  const rows = currentShortcutList(definition => effectiveBindings(definition, assignments)).map((entry) =>
    `| ${t(entry.labelKey)} | \`${entry.shortcut}\` | ${t(entry.contextKey)} |`,
  );
  return [`| ${t('command.table.action')} | ${t('command.table.key')} | ${t('command.table.context')} |`, '|---|---|---|', ...rows].join('\n');
}

export function resolveShortcutTable(source: string, assignments: ShortcutAssignments = EMPTY_SHORTCUT_ASSIGNMENTS): string {
  const first = source.indexOf(SHORTCUT_TABLE_MARKER);
  if (first < 0) return source;
  if (source.indexOf(SHORTCUT_TABLE_MARKER, first + SHORTCUT_TABLE_MARKER.length) >= 0) {
    throw new Error('Shortcut table marker must occur once');
  }
  return source.replace(SHORTCUT_TABLE_MARKER, currentShortcutMarkdown(assignments));
}
