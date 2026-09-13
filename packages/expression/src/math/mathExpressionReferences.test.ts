import { describe, expect, it } from 'vitest';
import { collectMathCoefficients, renameMathCoefficient } from './mathExpressionReferences.js';
import { parseMathText } from './mathTextSyntax.js';
import { decodeMathJson } from './decodeMathJson.js';
import { createMathLatexCodec } from './mathLatexCodec.js';
import { displayMathJson, convertMathNotation } from './mathNotationConversion.js';
import { CANDIDATE_MATH_OPERATIONS, CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { MATH_INPUT_FORMAT, type StoredMathExpression } from './mathInputContract.js';

const codec = createMathLatexCodec();
function names(label = 'i') {
  return { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [
    { role: 'coefficient' as const, id: 'factor-i', label },
    { role: 'coefficient' as const, id: 'factor-n', label: 'n' },
  ] };
}
function parse(source: string, label = 'i') {
  return decodeMathJson(codec.parse(source), { names: names(label), operations: CANDIDATE_MATH_OPERATIONS,
    scalarCoefficientIds: new Set(['factor-i', 'factor-n']), allowRenderedProducts: true });
}
function definition(): StoredMathExpression {
  const expression = parseMathText('sum(coef("i")*i,i,1,coef("n")) + coef("i")', {
    names: names(), operations: CANDIDATE_MATH_OPERATIONS,
  });
  const converted = convertMathNotation(expression, node => codec.serialize(displayMathJson(node, CANDIDATE_MATH_BY_ID)), source => parse(source));
  return { format: MATH_INPUT_FORMAT, source: converted.source, expression: converted.expression, inputNotation: 'latex', angleUnit: 'radian' };
}

describe('係数参照と総和の添字・定数を混同しない改名', () => {
  it('範囲と本文の参照を収集し、同じIDを重複せず添字を含めない', () => {
    expect(collectMathCoefficients(definition().expression)).toEqual([
      { role: 'coefficient', id: 'factor-n', label: 'n' },
      { role: 'coefficient', id: 'factor-i', label: 'i' },
    ]);
  });
  it.each(['π', 'sin', 'X', '厚さ２'])('%sへ改名しても係数IDを維持し、総和添字を変更しない', label => {
    const original = definition(), before = JSON.stringify(original);
    const next = renameMathCoefficient(original, 'factor-i', label, {
      format: expression => codec.serialize(displayMathJson(expression, CANDIDATE_MATH_BY_ID)),
      parse: source => parse(source, label),
    });
    expect(collectMathCoefficients(next.expression)).toContainEqual({ role: 'coefficient', id: 'factor-i', label });
    expect(next.source).not.toBe(original.source);
    expect(JSON.stringify(next.expression)).toContain('"role":"bound"');
    expect(JSON.stringify(next.expression)).toContain('"label":"i"');
    expect(parse(next.source, label)).toEqual(next.expression);
    expect(JSON.stringify(original)).toBe(before);
  });
  it('関係ない係数の改名で元の入力やオブジェクトを作り直さない', () => {
    const original = definition();
    const fail = (): never => { throw new Error('Must not format an unchanged expression'); };
    expect(renameMathCoefficient(original, 'other', '新名', { format: fail, parse: fail })).toBe(original);
  });
  it('表示側が旧名を返したら、IDだけが一致していても原式の更新を断る', () => {
    const original = definition(), before = JSON.stringify(original);
    expect(() => renameMathCoefficient(original, 'factor-i', '新名', {
      format: () => original.source, parse: source => parse(source),
    })).toThrow('変更した係数名');
    expect(JSON.stringify(original)).toBe(before);
  });
});
