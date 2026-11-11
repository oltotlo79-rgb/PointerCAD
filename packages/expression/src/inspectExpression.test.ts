import { describe, expect, it } from 'vitest';

import * as publicExpression from './index.js';
import { evaluateExpressionExact } from './evaluate.js';
import { parse } from './parse.js';

describe('inspectExpression: 実parserの位置と公開入口', () => {
  it('実parserと安全評価器の原票は反復名・欠けた括弧・未定義名を区別する', () => {
    expect(parse('板厚+板厚')).toMatchObject({
      kind: 'binary', position: 2,
      left: { kind: 'variable', name: '板厚', position: 0 },
      right: { kind: 'variable', name: '板厚', position: 3 },
    });
    expect(() => parse('(板厚')).toThrowError('閉じ括弧 ) が足りません。');
    expect(evaluateExpressionExact('板厚*2')).toMatchObject({
      ok: false, error: { code: 'unknownVariable', position: 0 },
    });
    expect(evaluateExpressionExact('板厚*2', { exactVariables: new Map([['板厚', '3']]) }))
      .toMatchObject({ ok: true, value: { source: '板厚*2', value: 6, exact: '6' } });
  });

  it('安全な読み取り入口を公開する', () => {
    expect('inspectExpression' in publicExpression).toBe(true);
    expect('parse' in publicExpression).toBe(false);
    expect('tokenize' in publicExpression).toBe(false);
  });

  it('既存exact評価と一致し、原式を保持する', () => {
    const width = publicExpression.inspectExpression('w*2', { exactVariables: new Map([['w', '3']]) });
    expect(width.source).toBe('w*2');
    expect(width.result).toMatchObject({ ok: true, value: { source: 'w*2', exact: '6', value: 6 } });
    expect(width.references).toEqual([{ name: 'w', start: 0, end: 1 }]);
    expect(width.units).toEqual([]);
    expect(width.error).toBeNull();

    const angle = publicExpression.inspectExpression('30*2');
    expect(angle.result).toMatchObject({ ok: true, value: { exact: '60', value: 60 } });
    expect(angle.units).toEqual([]); // degree欄の単位は呼び出し側の文脈。

    const inches = publicExpression.inspectExpression('1in*2');
    expect(inches.result).toMatchObject({ ok: true, value: { exact: '50.8', value: 50.8 } });
    expect(inches.units).toEqual([{ unit: 'in', start: 1, end: 3 }]);
  });

  it('同名反復、関数の入れ子、定数、日本語のUTF-16位置を区別する', () => {
    const source = '板厚+sqrt(w*板厚)+π+e';
    const inspected = publicExpression.inspectExpression(source, {
      exactVariables: new Map([['板厚', '3'], ['w', '4']]),
    });
    expect(inspected.references).toEqual([
      { name: '板厚', start: 0, end: 2 },
      { name: 'w', start: 8, end: 9 },
      { name: '板厚', start: 10, end: 12 },
    ]);
    for (const reference of inspected.references) {
      expect(source.slice(reference.start, reference.end)).toBe(reference.name);
    }
    expect(inspected.units).toEqual([]);
    expect(inspected.result.ok).toBe(true);
    expect(publicExpression.collectVariableNames(source)).toEqual(['板厚', 'w']);
    expect(publicExpression.renameVariable('板厚+板厚', '板厚', 'w')).toBe('w+w');

    const normalized = publicExpression.inspectExpression('板厚２+1', {
      exactVariables: new Map([['板厚2', '3']]),
    });
    expect(normalized.source).toBe('板厚２+1');
    expect(normalized.references).toEqual([{ name: '板厚2', start: 0, end: 3 }]);
    expect(normalized.source.slice(0, 3)).toBe('板厚２');
    expect(normalized.result).toMatchObject({ ok: true, value: { source: '板厚２+1', value: 4 } });

    // 既存tokenizerはNFKCを行わない。2 UTF-16単位の数学用文字を参照へ推測変換しない。
    const incompatible = publicExpression.inspectExpression('𝑤+1');
    expect(incompatible.references).toEqual([]);
    expect(incompatible.error).toMatchObject({ code: 'unexpectedCharacter', position: 0 });
  });

  it('明示単位は元の綴りに対応し、同名の変数mmを単位と誤認しない', () => {
    const source = '1IN+3/8"+mm*2';
    const inspected = publicExpression.inspectExpression(source, { exactVariables: new Map([['mm', '2']]) });
    expect(inspected.units).toEqual([
      { unit: 'in', start: 1, end: 3 },
      { unit: '"', start: 7, end: 8 },
    ]);
    expect(inspected.units.map(unit => source.slice(unit.start, unit.end))).toEqual(['IN', '"']);
    expect(inspected.references).toEqual([{ name: 'mm', start: 9, end: 11 }]);
    expect(inspected.result).toMatchObject({ ok: false, error: { code: 'unitMismatch' } });

    const nested = publicExpression.inspectExpression('(w*2)in', { exactVariables: new Map([['w', '3']]) });
    expect(nested.references).toEqual([{ name: 'w', start: 1, end: 2 }]);
    expect(nested.units).toEqual([{ unit: 'in', start: 5, end: 7 }]);
  });

  it('名前解決エラーでも確実な参照を残し、構文エラーは偽の参照を返さない', () => {
    const unknown = publicExpression.inspectExpression('板厚+w', { exactVariables: new Map([['板厚', '3']]) });
    expect(unknown.references).toEqual([
      { name: '板厚', start: 0, end: 2 },
      { name: 'w', start: 3, end: 4 },
    ]);
    expect(unknown.error).toMatchObject({ code: 'unknownVariable', position: 3 });
    expect(unknown.result).toMatchObject({ ok: false, error: unknown.error });
    expect(Object.isFrozen(unknown.error)).toBe(true);

    const unclosed = publicExpression.inspectExpression('(板厚');
    expect(unclosed.references).toEqual([]);
    expect(unclosed.error).toMatchObject({ code: 'unclosedParenthesis', position: 0 });

    const missing = publicExpression.inspectExpression('板厚+');
    expect(missing.references).toEqual([]);
    expect(missing.error).toMatchObject({ code: 'unexpectedEnd', position: -1 });
    const operator = publicExpression.inspectExpression('w 2');
    expect(operator.references).toEqual([]);
    expect(operator.error).toMatchObject({ code: 'unexpectedTrailing', position: 2 });
    const unknownFunction = publicExpression.inspectExpression('mystery(w)');
    expect(unknownFunction.references).toEqual([{ name: 'w', start: 8, end: 9 }]);
    expect(unknownFunction.error).toMatchObject({ code: 'unknownFunction', position: 0 });
    const wrongUnit = publicExpression.inspectExpression('1in+2');
    expect(wrongUnit.units).toEqual([{ unit: 'in', start: 1, end: 3 }]);
    expect(wrongUnit.error).toMatchObject({ code: 'unitMismatch', position: 3 });
  });

  it('長さ上限・多段括弧でも安全評価器の境界を保つ', () => {
    const long = publicExpression.inspectExpression('1'.repeat(publicExpression.EXPRESSION_MAX_LENGTH + 1));
    expect(long.references).toEqual([]);
    expect(long.error).toMatchObject({ code: 'tooLong', position: -1 });

    const source = `${'('.repeat(32)}w${')'.repeat(32)}`;
    const deep = publicExpression.inspectExpression(source, { variables: new Map([['w', 3]]) });
    expect(deep.references).toEqual([{ name: 'w', start: 32, end: 33 }]);
    expect(deep.result).toMatchObject({ ok: true, value: { source, value: 3 } });
  });

  it('公開DTOは入れ子まで読み取り専用のplain objectである', () => {
    const inspected = publicExpression.inspectExpression('w+1', { variables: new Map([['w', 2]]) });
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.references)).toBe(true);
    expect(Object.isFrozen(inspected.references[0])).toBe(true);
    expect(Object.isFrozen(inspected.result)).toBe(true);
    if (inspected.result.ok) {
      expect(Object.isFrozen(inspected.result.value)).toBe(true);
    }
  });
});
