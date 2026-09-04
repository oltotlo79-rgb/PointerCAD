import { describe, expect, it } from 'vitest';

import { ExpressionFailure, type ExpressionError } from './errors.js';
import { evaluateExpression } from './evaluateExpression.js';
import { normalizeExpressionSource, tokenize, type Token } from './tokenize.js';

/**
 * 全角空白(U+3000)。文字そのものを書くと見分けが付かず、混入や消失に気付けないので
 * エスケープで書く(docs/報告記録.md 2026-09-02 15:09 の教訓)。
 */
const FULL_WIDTH_SPACE = '\u3000';

/**
 * 絵文字(U+1F600)。UTF-16 では 2 単位を占めるサロゲートペアで、片割れだけを取り出すと
 * 読めない文字になる。エスケープで書くのは全角空白と同じ理由。
 */
const GRINNING_FACE = '\u{1F600}';

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

/** 失敗したときのエラー内容を取り出す。エラーにならなければテストを落とす。 */
function failureOf(source: string): ExpressionError {
  try {
    tokenize(source);
  } catch (error) {
    if (error instanceof ExpressionFailure) {
      return error.detail;
    }
    throw error;
  }
  throw new Error(`エラーになりませんでした: ${source}`);
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
    expect(failureOf('1@2').position).toBe(1);
    expect(failureOf('1@2').message).toBe('使えない文字があります: 「@」(2 文字目)');
  });

  it('絵文字(サロゲートペア)は丸ごと1文字として文言へ出す', () => {
    const detail = failureOf(`1+${GRINNING_FACE}`);
    expect(detail.code).toBe('unexpectedCharacter');
    // 片割れ(U+D83D)ではなく絵文字がそのまま入る。位置は UTF-16 の添字(0 始まり)。
    expect(detail.message).toBe(`使えない文字があります: 「${GRINNING_FACE}」(3 文字目)`);
    expect(detail.position).toBe(2);
  });

  it('全角の置き換えはサロゲートペアを壊さず、長さも変えない', () => {
    // 位置が元の式とずれないことが前提なので、変換の前後で長さが変わらないことを固定する。
    const source = `１＋${GRINNING_FACE}`;
    const normalized = normalizeExpressionSource(source);
    expect(normalized).toBe(`1+${GRINNING_FACE}`);
    expect(normalized.length).toBe(source.length);
  });

  it('長すぎる式は tooLong', () => {
    expect(codeOf('1'.repeat(1001))).toBe('tooLong');
  });
});

describe('日本語の変数名(FR-207、記法バージョン2)', () => {
  it('ひらがな・カタカナ・漢字を含む名前を1つの識別子として読む', () => {
    expect(summarize(tokenize('板厚'))).toEqual(['identifier:板厚@0']);
    expect(summarize(tokenize('あなが'))).toEqual(['identifier:あなが@0']);
    expect(summarize(tokenize('アナガ'))).toEqual(['identifier:アナガ@0']);
    expect(summarize(tokenize('穴径ー'))).toEqual(['identifier:穴径ー@0']);
  });

  it('数字は識別子の先頭に来られない(2文字目以降では続く)', () => {
    expect(summarize(tokenize('2倍'))).toEqual(['number:2@0', 'identifier:倍@1']);
    expect(summarize(tokenize('穴径2'))).toEqual(['identifier:穴径2@0']);
  });

  it('半角カタカナは範囲に入れず、使えない文字として断る(§0.16の決定)', () => {
    expect(codeOf('ｱ1')).toBe('unexpectedCharacter');
  });

  it('全角空白を挟んでも識別子は変わらない(normalizeExpressionSource は空白だけ半角へ直す)', () => {
    expect(summarize(tokenize(`板厚${FULL_WIDTH_SPACE}*${FULL_WIDTH_SPACE}2`))).toEqual([
      'identifier:板厚@0',
      'operator:*@3',
      'number:2@5',
    ]);
  });

  it('日本語の名前を変数として評価できる(FR-201)', () => {
    const result = evaluateExpression('板厚 * 2', { variables: new Map([['板厚', 3]]) });
    expect(result).toEqual({
      ok: true,
      value: { source: '板厚 * 2', value: 6, display: '6' },
    });
  });

  it('変数表を渡さなければ従来どおり unknownVariable で断る', () => {
    const result = evaluateExpression('板厚 * 2');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('unknownVariable');
  });

  it('全角空白を挟んだ日本語の変数名も評価できる', () => {
    const result = evaluateExpression('板厚　* 2', { variables: new Map([['板厚', 3]]) });
    expect(result).toEqual({
      ok: true,
      value: { source: '板厚　* 2', value: 6, display: '6' },
    });
  });
});
