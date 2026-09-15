import { isReservedChord, type AssignedChord } from './shortcutAssignments.js';

export interface AssignmentKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly keyCode?: number;
  getModifierState(key: string): boolean;
}
export type CapturedShortcut =
  | { readonly status: 'pass-through' }
  | { readonly status: 'ignored' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'rejected'; readonly reason: 'composition' | 'unsupported' | 'reserved' }
  | { readonly status: 'captured'; readonly chord: AssignedChord };

/** Read the visible key once; never turn IME/AltGr/modifier-only events into commands. */
export function captureShortcutKey(event: AssignmentKeyEvent): CapturedShortcut {
  if (event.key === 'Tab' || event.key === 'F1') return { status: 'pass-through' };
  if (event.key === 'Escape') return { status: 'cancelled' };
  if (event.isComposing || event.keyCode === 229 || event.key === 'Process'
    || event.getModifierState('AltGraph')) return { status: 'rejected', reason: 'composition' };
  if (event.repeat || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return { status: 'ignored' };
  const key = event.key.toLowerCase();
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/u.test(key) || (event.ctrlKey && event.metaKey)) {
    return { status: 'rejected', reason: 'unsupported' };
  }
  const chord = Object.freeze({ key, primary: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey });
  return isReservedChord(chord) ? { status: 'rejected', reason: 'reserved' } : { status: 'captured', chord };
}
