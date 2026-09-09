import { describe, expect, it } from 'vitest';
import { generalToleranceNote } from './generalTolerance.js';

describe('普通公差の注記', () => {
  const location = { titleBlockRight: 410, titleBlockTop: 40 };
  it('既定は中級m', () => {
    expect(generalToleranceNote(location)?.text).toBe('指示なき寸法の普通公差 JIS B 0405-中級(m)');
  });
  it.each([['f', '精級'], ['m', '中級'], ['c', '粗級'], ['v', '極粗級']])('%sを%sとして記入する', (grade, label) => {
    expect(generalToleranceNote({ ...location, grade })?.text).toBe(`指示なき寸法の普通公差 JIS B 0405-${label}(${grade})`);
  });
  it('表題欄の上で右揃え、文字の下端に余白を持つ', () => {
    expect(generalToleranceNote(location)).toMatchObject({ position: [410, 43.5], anchor: 'end', baseline: 'bottom', sizeMm: 3.5 });
  });
  it('無効なら注記を作らない', () => {
    expect(generalToleranceNote({ ...location, enabled: false })).toBeNull();
  });
  it('未対応の幾何普通公差は出さない', () => {
    expect(generalToleranceNote(location)?.geometricNote).toBeNull();
  });
  it('未知の等級・非有限位置を断る', () => {
    expect(generalToleranceNote({ ...location, grade: 'M' })).toBeNull();
    expect(generalToleranceNote({ ...location, titleBlockRight: Infinity })).toBeNull();
  });
});
