import {describe, expect, it} from 'vitest';
import {hasMathControlCharacters, validateMathSource} from './mathInputContract.js';
import {decodeMathWorkRequest} from './mathWorkRequest.js';

describe('数式本文と名前の制御文字の境界', () => {
  it.each([...Array.from({length: 32}, (_, code) => code), 127])('文字コード%dの本文と名前の条件を分ける', code => {
    const character = String.fromCharCode(code);
    expect(hasMathControlCharacters(`前${character}後`)).toBe(true);
    if ([9, 10, 13].includes(code)) expect(() => validateMathSource(`1+${character}2`)).not.toThrow();
    else expect(() => validateMathSource(`1+${character}2`)).toThrow();
    expect(() => decodeMathWorkRequest({
      identity: {documentId: 'part', documentVersion: 0, editorId: 'X', inputRevision: 0},
      source: '1', notation: 'text', angleUnit: 'degree',
      coefficients: [{id: 'coefficient', label: `板${character}厚`, decimal: '3'}],
    })).toThrow();
  });
  it('日本語・ギリシャ文字・全角数字の名前を制御文字と誤認しない', () => {
    expect(hasMathControlCharacters('板厚α１２π')).toBe(false);
  });
});
