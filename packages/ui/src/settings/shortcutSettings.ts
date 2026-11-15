import {
  chordsOf, EMPTY_SHORTCUT_ASSIGNMENTS, salvageShortcutAssignments, validateShortcutAssignments,
  type CommandChord, type ShortcutAssignments,
} from '../commands/shortcutAssignments.js';
import type { DisplaySettings } from './settings.js';

/** 端末の設定に書くキーの割当の新しい形(版 2。1 命令に 0〜2 個の組)。 */
interface StoredInputAssignments {
  readonly version: 2;
  readonly keys: Readonly<Record<string, readonly CommandChord[] | null>>;
}

/**
 * 保存されていたキーの割当を読む。新しい形(inputAssignments)を先に読み、無ければ v1(shortcutAssignments)から移す。
 * 読めない 1 件だけを捨て、捨てた数を返す(他の割当と表示の設定は消さない。設計 R6)。
 */
export function readStoredShortcutAssignments(settings: object): { readonly assignments: ShortcutAssignments; readonly dropped: number } {
  const legacy = 'shortcutAssignments' in settings ? settings.shortcutAssignments : undefined;
  if (!('inputAssignments' in settings)) return salvageShortcutAssignments(legacy);
  const stored = settings.inputAssignments;
  if (typeof stored === 'object' && stored !== null && 'version' in stored && stored.version === 2 && 'keys' in stored) {
    return salvageShortcutAssignments(stored.keys);
  }
  // 読めない新しい形(未来の版も)は v1 から移し直し、そのことを 1 件として知らせる。
  const migrated = salvageShortcutAssignments(legacy);
  return { assignments: migrated.assignments, dropped: migrated.dropped + 1 };
}

/**
 * 保存する欄。新しい形は inputAssignments へ書き、v1 の欄(shortcutAssignments)は保存されていた値をそのまま残す。
 * 古い版へ戻した時に、古い版が読める v1 の割当が消えないようにするため(設計 §4.1 案 A)。
 */
export function storedShortcutFields(assignments: ShortcutAssignments | undefined, previousLegacy: unknown): {
  readonly shortcutAssignments: unknown;
  readonly inputAssignments: StoredInputAssignments | undefined;
} {
  if (assignments === undefined) return { shortcutAssignments: previousLegacy, inputAssignments: undefined };
  const keys: Record<string, readonly CommandChord[] | null> = {};
  for (const [id, entry] of Object.entries(assignments)) {
    if (entry !== undefined) keys[id] = entry === null ? null : chordsOf(entry);
  }
  return { shortcutAssignments: previousLegacy, inputAssignments: { version: 2, keys } };
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
  const result = validateShortcutAssignments(proposed, expected);
  // 適用した時点で、起動の時に読めなかった数のお知らせは役目を終える。
  return result.ok ? { ...current, shortcutAssignments: result.assignments, shortcutAssignmentsRecovered: undefined } : null;
}
