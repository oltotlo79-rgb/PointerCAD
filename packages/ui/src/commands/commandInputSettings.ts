/**
 * キーの割当で使える「物理の位置で合わせるキー」(FR-1104 の拡張、設計 1-3)。
 *
 * 英数字と F キーは今どおり見えた文字で合わせる(shortcutAssignments.ts の AssignedChord)。
 * 矢印・Home/End/PageUp/PageDown・Insert・Delete・Backspace・Space・テンキー・記号・Shift＋数字は、配列や NumLock で
 * 見える文字が変わるので、KeyboardEvent.code(物理の位置)で合わせる。取り込んだ時に見えた文字は表示だけに使う。
 * Tab(焦点の移動)・Esc・Enter・メニューキーは割り当てない(一覧に無い)。
 */

const ASSIGNABLE_KEY_CODES = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'Backspace', 'Space',
  'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote',
  'Comma', 'Period', 'Slash', 'IntlRo', 'IntlYen',
] as const;
type AssignableKeyCode = (typeof ASSIGNABLE_KEY_CODES)[number];

export interface CodeChord {
  readonly code: AssignableKeyCode;
  /** 取り込んだ時に見えた文字。表示だけに使い、一致には使わない。 */
  readonly label: string;
  /** Ctrl か Cmd。 */
  readonly primary: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

const MAX_LABEL_LENGTH = 8;

/** 名前で表す位置。記号の位置は取り込んだ時の文字で表す(配列で変わるため)。 */
const NAMED_CODES: Readonly<Partial<Record<AssignableKeyCode, string>>> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End', PageUp: 'PageUp',
  PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace', Space: 'Space',
  NumpadAdd: 'テンキー+', NumpadSubtract: 'テンキー-', NumpadMultiply: 'テンキー*', NumpadDivide: 'テンキー/',
  NumpadDecimal: 'テンキー.',
};

export function isAssignableKeyCode(value: unknown): value is AssignableKeyCode {
  return typeof value === 'string' && (ASSIGNABLE_KEY_CODES as readonly string[]).includes(value);
}

/** 位置の名前(修飾を除く)。テンキーの数字・Shift＋数字・記号もここで決める。 */
function codeKeyName(chord: CodeChord): string {
  const named = NAMED_CODES[chord.code];
  if (named !== undefined) return named;
  if (chord.code.startsWith('Numpad')) return `テンキー${chord.code.slice('Numpad'.length)}`;
  if (chord.code.startsWith('Digit')) return chord.code.slice('Digit'.length);
  return chord.label;
}

/** 表示(Ctrl/Cmd+Alt+Shift+名前)。英数字の組の表示(assignedChordLabel)と同じ並び。 */
export function codeChordLabel(chord: CodeChord): string {
  return [chord.primary ? 'Ctrl/Cmd' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', codeKeyName(chord)]
    .filter(Boolean).join('+');
}

/** 保存の値を読む。形が違えば null(その 1 件だけ捨てる)。 */
export function readCodeChord(raw: unknown): CodeChord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || !('code' in raw) || !isAssignableKeyCode(raw.code)
    || !('label' in raw) || typeof raw.label !== 'string' || raw.label.length === 0 || raw.label.length > MAX_LABEL_LENGTH
    || !('primary' in raw) || typeof raw.primary !== 'boolean'
    || !('shift' in raw) || typeof raw.shift !== 'boolean'
    || !('alt' in raw) || typeof raw.alt !== 'boolean') return null;
  if (Object.keys(raw).some(key => !['code', 'label', 'primary', 'shift', 'alt'].includes(key))) return null;
  // 数字の位置は Shift と一緒の時だけ(Shift の無い数字は見えた文字の組で持つ)。
  if (raw.code.startsWith('Digit') && !raw.shift) return null;
  return Object.freeze({ code: raw.code, label: raw.label, primary: raw.primary, shift: raw.shift, alt: raw.alt });
}

/** ブラウザー・OS が使うため断る位置の組(設計 §5 の一覧のうち、位置で合わせる組の分)。 */
export function isReservedCodeChord(chord: CodeChord): boolean {
  if (chord.primary && chord.alt) return true;
  if (chord.code === 'Space' && (chord.alt || chord.primary)) return true;
  if (chord.primary && (chord.code === 'PageUp' || chord.code === 'PageDown')) return true;
  if (chord.primary && chord.shift && chord.code === 'Delete') return true;
  return false;
}

/** Web 版のブラウザーのタブで届かないことがある位置の組(断らずに知らせるだけ)。 */
export function codeChordBrowserWarning(chord: CodeChord): boolean {
  return chord.primary && ['Minus', 'Equal', 'Semicolon', 'NumpadAdd', 'NumpadSubtract'].includes(chord.code);
}
