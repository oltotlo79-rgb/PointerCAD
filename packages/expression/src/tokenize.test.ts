import { describe, expect, it } from 'vitest';

import { ExpressionFailure } from './errors.js';
import { normalizeExpressionSource, tokenize, type Token } from './tokenize.js';

/**
 * 全角空白(U+3000)。文字そのものを書くと見分けが付かず、混入や消失に気付けないので
 * エスケープで書く(docs/報告記録.md 2026-09-02 15:09 の教訓)。
 */
const FULL_WIDTH_SPACE = '\u3000';

/** 検査を読みやすくするため「型:文字列@位置」の列へ直す。 */
function summarize(tokens: readonly Token[]): string[] {
  return tokens.map((token) => `${token.type}:${token.text}@${String(token.position)}`);
}

function codeOf(source: string): string {
  try {
    tokenize(source);
  } catch (error) {
    if (error instanceof ExpressionFailure) {
      return error.detail.code;
    }
    throw error;
  }
  return 'エラーになりませんでした';
}

describe('字句解析(FR-201)', () => {
  it('四則の式を分ける', () => {
    expect(summarize(tokenize('1+2'))).toEqual(['number:1@0', 'operator:+@1', 'number:2@2']);
  });

  it('小数を1つの数として読む', () => {
    expect(summarize(tokenize('12.5'))).toEqual(['number:12.5@0']);
  });

  it('先頭が小数点でも読める', () => {
    expect(summarize(tokenize('.5'))).toEqual(['number:.5@0']);
  });

  it('関数呼び出しを分ける', () => {
    expect(summarize(tokenize('sqrt(2)'))).toEqual([
      'identifier:sqrt@0',
      'leftParenthesis:(@4',
      'number:2@5',
      'rightParenthesis:)@6',
    ]);
  });

  it('引数の区切りを分ける', () => {
    expect(summarize(tokenize('root(8,3)'))).toEqual([
      'identifier:root@0',
      'leftParenthesis:(@4',
      'number:8@5',
      'comma:,@6',
      'number:3@7',
      'rightParenthesis:)@8',
    ]);
  });

  it('√ は演算子として読む', () => {
    expect(summarize(tokenize('√9'))).toEqual(['operator:√@0', 'number:9@1']);
  });

  it('π は名前として読む', () => {
    expect(summarize(tokenize('π'))).toEqual(['identifier:π@0']);
  });

  it('半角空白は読み飛ばし、位置は元のまま', () => {
    expect(summarize(tokenize('1 + 2'))).toEqual(['number:1@0', 'operator:+@2', 'number:2@4']);
  });

  it('全角の数字と記号を半角として読む(FR-201、NFR-UX-5)', () => {
    expect(summarize(tokenize('１＋２'))).toEqual(['number:1@0', 'operator:+@1', 'number:2@2']);
    expect(summarize(tokenize('３×４'))).toEqual(['number:3@0', 'operator:*@1', 'number:4@2']);
    expect(normalizeExpressionSource('（１．５）')).toBe('(1.5)');
  });

  it('全角空白も空白として扱う', () => {
    expect(summarize(tokenize(`1${FULL_WIDTH_SPACE}2`))).toEqual(['number:1@0', 'number:2@2']);
  });

  it('空の式は empty', () => {
    expect(codeOf('')).toBe('empty');
    expect(codeOf('   ')).toBe('empty');
  });

  it('使えない文字は位置つきで unexpectedCharacter', () => {
    expect(codeOf('1@2')).toBe('unexpectedCharacter');
  });

  it('長すぎる式は tooLong', () => {
    expect(codeOf('1'.repeat(1001))).toBe('tooLong');
  });
});
