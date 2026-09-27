import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { decodeMathJson } from './decodeMathJson.js';
import { decodeStoredMath } from './decodeStoredMath.js';
import { formatMathText } from './formatMathText.js';
import { MATH_INPUT_FORMAT, MATH_INPUT_LIMITS, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { convertMathNotation, displayMathJson, sameMathMeaning } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { parseMathText } from './mathTextSyntax.js';
import { parseMathLatex } from './parseMathLatex.js';
import { serializeMathLatex } from './serializeMathLatex.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

const options = { operations: CANDIDATE_MATH_OPERATIONS,
  names: { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [] } };
const text = (source: string): MathNode => parseMathText(source, options);
const latex = (source: string): MathNode => decodeMathJson(parseMathLatex(source), {
  ...options, allowRenderedProducts: true,
});
const toLatex = (node: MathNode): string => serializeMathLatex(displayMathJson(node, CANDIDATE_MATH_BY_ID));
const toText = (node: MathNode): string => formatMathText(node, CANDIDATE_MATH_BY_ID);

// The named calls independently specify the exact operation and operand order of each glyph.
const NOTATIONS = [
  ['±2', 'PlusMinus(2)', String.raw`\pm 2`, String.raw`\pm`, '±'],
  ['∓2', 'MinusPlus(2)', String.raw`\mp 2`, String.raw`\mp`, '∓'],
  ['1±2', 'PlusMinus(1,2)', String.raw`1\pm 2`, String.raw`\pm`, '±'],
  ['1∓2', 'MinusPlus(1,2)', String.raw`1\mp 2`, String.raw`\mp`, '∓'],
  ['2∉{1,3}', 'NotElement(2,{1,3})', String.raw`2\notin\{1,3\}`, String.raw`\notin`, '∉'],
  ['{1}⊂{1,2}', 'Subset({1},{1,2})', String.raw`\{1\}\subset\{1,2\}`, String.raw`\subset`, '⊂'],
  ['{1}⊆{1}', 'SubsetEqual({1},{1})', String.raw`\{1\}\subseteq\{1\}`, String.raw`\subseteq`, '⊆'],
  ['{1,2}⊃{1}', 'Superset({1,2},{1})', String.raw`\{1,2\}\supset\{1\}`, String.raw`\supset`, '⊃'],
  ['{1}⊇{1}', 'SupersetEqual({1},{1})', String.raw`\{1\}\supseteq\{1\}`, String.raw`\supseteq`, '⊇'],
  ['∁({1},{1,2})', 'Complement({1},{1,2})', String.raw`\complement(\{1\},\{1,2\})`, String.raw`\complement`, '∁'],
  ['1≈1.01', 'ApproxEqual(1,1.01)', String.raw`1\approx 1.01`, String.raw`\approx`, '≈'],
  ['approxequal(1,1.01,0.001)', 'ApproxEqual(1,1.01,0.001)',
    String.raw`\operatorname{approxequal}(1,1.01,0.001)`, String.raw`\operatorname{approxequal}`, 'ApproxEqual'],
  ['⟨[1,2],[3,4]⟩', 'Dot([1,2],[3,4])', String.raw`\left\langle[1,2],[3,4]\right\rangle`, String.raw`\langle`, '⟨'],
  ['⟨[1,2,3],[4,5,6]⟩', 'Dot([1,2,3],[4,5,6])', String.raw`\langle[1,2,3],[4,5,6]\rangle`, String.raw`\langle`, '⟨'],
  ['{1,2}×{3,4}', 'CartesianProduct({1,2},{3,4})', String.raw`\{1,2\}\times\{3,4\}`, String.raw`\times`, 'CartesianProduct'],
  ['2×3', 'Multiply(2,3)', String.raw`2\times 3`, String.raw`\times`, 'Multiply'],
] as const;

describe('MC-19a の記号は登録された演算・引数・保存形式を保つ', () => {
  it.each(NOTATIONS)('%s の通常入力と構造入力は明示した演算名と一致する', (source, named, structured) => {
    const expected = text(named);
    expect(text(source)).toEqual(expected);
    expect(latex(structured)).toEqual(expected);
  });

  it.each(NOTATIONS)('%s を通常→構造→通常と戻し、記号と全引数を保つ', (source, named, _structured, latexSymbol, textSymbol) => {
    const original = text(source);
    const structured = convertMathNotation(original, toLatex, latex);
    const plain = convertMathNotation(structured.expression, toText, text);
    expect(structured.source).toContain(latexSymbol);
    expect(plain.source).toContain(textSymbol);
    expect(structured.expression).toEqual(text(named));
    expect(plain.expression).toEqual(original);
    expect(convertMathNotation(plain.expression, toLatex, latex).source).toBe(structured.source);
  });

  it.each(NOTATIONS)('%s の元の入力と演算を text/latex の保存再読込みでも保つ', (source, _named, structured) => {
    for (const inputNotation of ['text', 'latex'] as const) {
      const visible = inputNotation === 'text' ? source : structured;
      const stored: StoredMathExpression = { format: MATH_INPUT_FORMAT, source: visible, inputNotation,
        angleUnit: 'degree', expression: inputNotation === 'text' ? text(visible) : latex(visible) };
      const saved: unknown = JSON.parse(JSON.stringify(stored));
      expect(decodeStoredMath(saved, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
        parseSource: (value, notation) => notation === 'text' ? text(value) : latex(value) })).toEqual(stored);
    }
  });
});

describe('優先順位・括弧・省略されていない条件を保持する', () => {
  it.each([
    ['±2^2', String.raw`\pm 2^2`, 'PlusMinus(Power(2,2))'],
    ['∓2+3', String.raw`\mp 2+3`, 'Add(MinusPlus(2),3)'],
    ['1±2*3', String.raw`1\pm 2*3`, 'PlusMinus(1,Multiply(2,3))'],
    ['1+2∓3', String.raw`1+2\mp 3`, 'MinusPlus(Add(1,2),3)'],
    ['1±(2∓3)', String.raw`1\pm(2\mp 3)`, 'PlusMinus(1,MinusPlus(2,3))'],
    ['(1±2)∓3', String.raw`(1\pm 2)\mp 3`, 'MinusPlus(PlusMinus(1,2),3)'],
    ['-(±2)', String.raw`-(\pm 2)`, 'Negate(PlusMinus(2))'],
    ['(±2)^3', String.raw`(\pm 2)^3`, 'Power(PlusMinus(2),3)'],
    ['1+2≈3*4', String.raw`1+2\approx 3*4`, 'ApproxEqual(Add(1,2),Multiply(3,4))'],
    ['∁({1},{1,2})⊆{1,2}', String.raw`\complement(\{1\},\{1,2\})\subseteq\{1,2\}`, 'SubsetEqual(Complement({1},{1,2}),{1,2})'],
    ['⟨[1+2,3],[4,5]⟩+6', String.raw`\langle[1+2,3],[4,5]\rangle+6`, 'Add(Dot([Add(1,2),3],[4,5]),6)'],
  ])('%s の演算順を両入力と表示往復で保つ', (source, structured, named) => {
    const expected = text(named);
    expect(text(source)).toEqual(expected);
    expect(latex(structured)).toEqual(expected);
    expect(convertMathNotation(expected, toLatex, latex).expression).toEqual(expected);
    expect(convertMathNotation(expected, toText, text).expression).toEqual(expected);
  });

  it('連続する集合の比較は隣り合う関係の論理積として往復する', () => {
    const original = text('{1}⊂{1,2}⊆{1,2,3}');
    expect(original).toEqual(text('And(Subset({1},{1,2}),SubsetEqual({1,2},{1,2,3}))'));
    expect(convertMathNotation(original, toLatex, latex).expression).toEqual(original);
  });
  it('許容差の有無・値、母集合、包含の向き、±の順序を同じ意味にしない', () => {
    for (const [left, right] of [
      ['1≈2', 'approxequal(1,2,0.01)'], ['approxequal(1,2,0.01)', 'approxequal(1,2,0.02)'],
      ['∁({1},{1,2})', '∁({1},{1,3})'], ['{1}⊂{1,2}', '{1}⊆{1,2}'],
      ['{1}⊂{1,2}', '{1}⊃{1,2}'], ['1±2', '1∓2'],
    ]) expect(sameMathMeaning(text(left), text(right))).toBe(false);
  });
  it.each(['±2', '∓2', '1±2', '1∓2', '1≈2', '⟨[1,2],[3,4]⟩', '2×3'])('%s のUnicodeを構造入力でも読む', source => {
    expect(latex(source)).toEqual(text(source));
  });
  it('集合関係と補集合のUnicodeもLaTeXの集合枠と組み合わせられる', () => {
    for (const symbol of ['∉', '⊂', '⊆', '⊃', '⊇']) {
      expect(latex(String.raw`\{1\}` + symbol + String.raw`\{1,2\}`)).toEqual(text(`{1}${symbol}{1,2}`));
    }
    expect(latex(String.raw`∁(\{1\},\{1,2\})`)).toEqual(text('∁({1},{1,2})'));
  });
  it('数の集合・入れ子の直積・三因子の明示直積を区別して往復する', () => {
    for (const source of ['ℝ×ℚ', '∁({1},{1,2})×{3}', '{1}×{2}×{3}', 'cartesianproduct({1},{2},{3})']) {
      const original = text(source);
      expect(convertMathNotation(original, toLatex, latex).expression).toEqual(original);
    }
    expect(sameMathMeaning(text('{1}×{2}×{3}'), text('cartesianproduct({1},{2},{3})'))).toBe(false);
  });
});

describe('省略・曖昧な積・大きすぎる記号入力を推測で補わない', () => {
  it.each(['⟨⟩', '⟨[1,2]⟩', '⟨[1],[2],[3]⟩', '⟨[1],[2]', '⟨[1],[2])',
    '∁({1})', '∁({1},{1,2},{3})', '∁{1}', '1≈', '±', '1∉', '{1}×2', '{1}·{2}'])('%s を拒否する', source => {
    expect(() => text(source)).toThrow();
  });
  it.each([String.raw`\langle\rangle`, String.raw`\langle[1,2]\rangle`, String.raw`\langle[1],[2],[3]\rangle`,
    String.raw`\langle[1],[2]`, String.raw`\complement(\{1\})`, String.raw`\complement\{1\}`,
    String.raw`1\approx`, String.raw`\pm`, String.raw`\{1\}\times 2`])('%s の不足した構造も拒否する', source => {
    expect(() => latex(source)).toThrow();
  });
  it('単項±の入れ子にも既存の深さ上限を適用する', () => {
    expect(() => text('±'.repeat(MATH_INPUT_LIMITS.depth + 1) + '1')).toThrow('深すぎ');
    expect(() => latex(String.raw`\pm `.repeat(MATH_INPUT_LIMITS.depth + 1) + '1')).toThrow('深すぎ');
  });
});

describe('<> の追加は != と数値の×を変えない', () => {
  it.each(['1<>2', '1!=2', '1≠2', '１＜＞２'])('%s を同じ不等号として往復する', source => {
    const expected = text('NotEqual(1,2)');
    expect(text(source)).toEqual(expected);
    expect(convertMathNotation(text(source), toLatex, latex).expression).toEqual(expected);
    expect(convertMathNotation(expected, toText, text).expression).toEqual(expected);
  });
  it('連鎖比較でも<>と!=の結合規則を同じにする', () => {
    expect(text('1<>2<3')).toEqual(text('1!=2<3'));
    expect(text('1<>2<3')).toEqual(text('And(NotEqual(1,2),Less(2,3))'));
  });
  it('引用符内の記号を演算子や全角の別表記として扱わない', () => {
    const label = '±∓∁⟨⟩<>＜＞', namedOptions = { ...options,
      names: { ...options.names, coefficients: [{ role: 'coefficient' as const, id: 'symbols', label }] } };
    const original = parseMathText(`coef(${JSON.stringify(label)})`, namedOptions);
    expect(original).toMatchObject({ reference: { role: 'coefficient', id: 'symbols', label } });
    expect(convertMathNotation(original, toText, source => parseMathText(source, namedOptions)).expression).toEqual(original);
    // Quoted plain-text names are preserved, but the existing structured-label boundary still rejects these glyphs.
    expect(() => toLatex(original)).toThrow('数式の記号名に使えない文字');
  });

  let backend: MathExecutionBackend;
  beforeAll(() => { backend = createMathBackend(); });
  it.each([
    ['2×3', 6], ['which(1<>2,7,true,9)', 7], ['which(2<>2,7,true,9)', 9],
    ['which(1!=2,7,true,9)', 7], ['which(2!=2,7,true,9)', 9],
  ])('%s の計算結果を公開の返信で確かめる', (source, expected) => {
    const request: MathWorkRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'notation', inputRevision: 1 },
      source, notation: 'text', angleUnit: 'degree', coefficients: [] };
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request), backend);
    const result = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.definition?.source).toBe(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
  });
});
