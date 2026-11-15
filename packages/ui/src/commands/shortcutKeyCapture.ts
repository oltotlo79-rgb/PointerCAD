import { isAssignableKeyCode } from './commandInputSettings.js';
import { isReservedCommandChord, type CommandChord } from './shortcutAssignments.js';

interface AssignmentKeyEvent {
  readonly key: string;
  /** 物理の位置。無い環境では英数字と F キーだけを受ける。 */
  readonly code?: string;
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
  | { readonly status: 'captured'; readonly chord: CommandChord };

const MAX_LABEL_LENGTH = 8;

/** 見えた文字(英数字・F キー)の組。Shift＋数字は配列で文字が変わるので位置の組で受ける(ここでは null)。 */
function keyChord(event: AssignmentKeyEvent, primary: boolean): CommandChord | null {
  const key = event.key.toLowerCase();
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/u.test(key)) return null;
  // NumLock の入ったテンキーの数字は、位置の組(テンキー)として受ける。
  if (/^[0-9]$/u.test(key) && event.code?.startsWith('Numpad') === true) return null;
  return Object.freeze({ key, primary, shift: event.shiftKey, alt: event.altKey });
}

/** 位置の組(矢印・Home/End・テンキー・記号・Shift＋数字・修飾つきの Space など)。 */
function codeChord(event: AssignmentKeyEvent, primary: boolean): CommandChord | null {
  const code = event.code;
  if (!isAssignableKeyCode(code)) return null;
  if (code.startsWith('Digit') && !event.shiftKey) return null;
  const label = event.key.length > 0 && event.key.length <= MAX_LABEL_LENGTH ? event.key : code;
  return Object.freeze({ code, label, primary, shift: event.shiftKey, alt: event.altKey });
}

/** Read the visible key once; never turn IME/AltGr/modifier-only events into commands. */
export function captureShortcutKey(event: AssignmentKeyEvent): CapturedShortcut {
  if (event.key === 'Tab' || event.key === 'F1') return { status: 'pass-through' };
  if (event.key === 'Escape') return { status: 'cancelled' };
  if (event.isComposing || event.keyCode === 229 || event.key === 'Process'
    || event.getModifierState('AltGraph')) return { status: 'rejected', reason: 'composition' };
  if (event.repeat || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return { status: 'ignored' };
  if (event.ctrlKey && event.metaKey) return { status: 'rejected', reason: 'unsupported' };
  const primary = event.ctrlKey || event.metaKey;
  const chord = keyChord(event, primary) ?? codeChord(event, primary);
  if (chord === null) return { status: 'rejected', reason: 'unsupported' };
  return isReservedCommandChord(chord) ? { status: 'rejected', reason: 'reserved' } : { status: 'captured', chord };
}
