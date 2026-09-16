import {
  EMPTY_SHORTCUT_ASSIGNMENTS, validateShortcutAssignments,
  type ShortcutAssignments,
} from '../commands/shortcutAssignments.js';
import type { DisplaySettings } from './settings.js';

/** Old or malformed key preferences never discard unrelated display preferences. */
export function readStoredShortcutAssignments(settings: object): ShortcutAssignments {
  if (!('shortcutAssignments' in settings)) return EMPTY_SHORTCUT_ASSIGNMENTS;
  const result = validateShortcutAssignments(settings.shortcutAssignments);
  return result.ok ? result.assignments : EMPTY_SHORTCUT_ASSIGNMENTS;
}

export function currentShortcutAssignments(settings: DisplaySettings): ShortcutAssignments {
  return settings.shortcutAssignments ?? EMPTY_SHORTCUT_ASSIGNMENTS;
}

/** Compare only the edited preference, preserving unrelated changes made while the form is open. */
export function prepareShortcutSettings(
  current: DisplaySettings,
  expected: ShortcutAssignments,
  proposed: unknown,
): DisplaySettings | null {
  if (currentShortcutAssignments(current) !== expected) return null;
  const result = validateShortcutAssignments(proposed);
  return result.ok ? { ...current, shortcutAssignments: result.assignments } : null;
}
