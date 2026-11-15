import { describe, expect, it } from 'vitest';
import { codeChordBrowserWarning, codeChordLabel, isReservedCodeChord, readCodeChord, type CodeChord } from './commandInputSettings.js';

const chord = (code: string, label: string, extra: Partial<Omit<CodeChord, 'code' | 'label'>> = {}): CodeChord | null =>
  readCodeChord({ code, label, primary: false, shift: false, alt: false, ...extra });
const valid = (code: string, label: string, extra: Partial<Omit<CodeChord, 'code' | 'label'>> = {}): CodeChord => {
  const read = chord(code, label, extra);
  if (read === null) throw new Error(`expected a valid chord: ${code}`);
  return read;
};

describe('位置で合わせるキー(矢印・テンキー・記号・Shift＋数字など)', () => {
  it('保存の形を読み、表示は位置の名前(記号は取り込んだ時の文字)にする', () => {
    expect(codeChordLabel(valid('ArrowUp', 'ArrowUp'))).toBe('↑');
    expect(codeChordLabel(valid('Numpad8', 'ArrowUp'))).toBe('テンキー8');
    expect(codeChordLabel(valid('NumpadAdd', '+', { primary: true }))).toBe('Ctrl/Cmd+テンキー+');
    expect(codeChordLabel(valid('Digit1', '!', { shift: true }))).toBe('Shift+1');
    expect(codeChordLabel(valid('Minus', 'ほ', { alt: true, shift: true }))).toBe('Alt+Shift+ほ');
    expect(codeChordLabel(valid('PageDown', 'PageDown'))).toBe('PageDown');
    expect(codeChordLabel(valid('Space', ' ', { shift: true }))).toBe('Shift+Space');
  });

  it('知らない位置・Tab・Shift の無い数字・余分な項目・壊れた文字の 1 件を読まない', () => {
    for (const raw of [
      { code: 'Tab', label: 'Tab', primary: false, shift: false, alt: false },
      { code: 'Enter', label: 'Enter', primary: false, shift: false, alt: false },
      { code: 'KeyA', label: 'a', primary: false, shift: false, alt: false },
      { code: 'Digit1', label: '1', primary: false, shift: false, alt: false },
      { code: 'Minus', label: '', primary: false, shift: false, alt: false },
      { code: 'Minus', label: '123456789', primary: false, shift: false, alt: false },
      { code: 'Minus', label: '-', primary: 'yes', shift: false, alt: false },
      { code: 'Minus', label: '-', primary: false, shift: false, alt: false, extra: 1 },
      null, [], 'Minus',
    ]) expect(readCodeChord(raw)).toBeNull();
  });

  it('ブラウザー・OS が使う組を断り、修飾の無い位置と Shift＋Space は受ける', () => {
    for (const reserved of [valid('Space', ' ', { alt: true }), valid('Space', ' ', { primary: true }),
      valid('Space', ' ', { primary: true, shift: true }), valid('PageUp', 'PageUp', { primary: true }),
      valid('PageDown', 'PageDown', { primary: true }), valid('Delete', 'Delete', { primary: true, shift: true }),
      valid('ArrowUp', 'ArrowUp', { primary: true, alt: true })]) expect(isReservedCodeChord(reserved)).toBe(true);
    for (const allowed of [valid('Space', ' ', { shift: true }), valid('ArrowUp', 'ArrowUp'), valid('Delete', 'Delete'),
      valid('PageUp', 'PageUp', { shift: true }), valid('Numpad5', '5', { alt: true })]) expect(isReservedCodeChord(allowed)).toBe(false);
  });

  it('ブラウザーの拡大縮小と同じ組は断らずに知らせる', () => {
    expect(codeChordBrowserWarning(valid('Minus', '-', { primary: true }))).toBe(true);
    expect(codeChordBrowserWarning(valid('NumpadAdd', '+', { primary: true }))).toBe(true);
    expect(codeChordBrowserWarning(valid('Minus', '-'))).toBe(false);
  });
});
