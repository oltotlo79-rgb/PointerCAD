import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createMathBackend } from './createMathBackend.js';
import { decodeMathJson } from './decodeMathJson.js';
import { decodeStoredMath } from './decodeStoredMath.js';
import { rationalOfExpression } from './exactRational.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { formatMathText } from './formatMathText.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { MATH_INPUT_FORMAT, MathInputProblem, type MathAxis, type MathEvaluation, type MathNode, type MathParameter,
  type StoredMathExpression } from './mathInputContract.js';
import { convertMathNotation, displayMathJson, sameMathMeaning } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { parseMathText } from './mathTextSyntax.js';
import { executeMathWorkRequest, type MathExecutionBackend, type MathExecutionReply } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { parseMathLatex } from './parseMathLatex.js';
import { createScalarSampler } from './scalarMathTape.js';
import { serializeMathLatex } from './serializeMathLatex.js';

/** Scopes of the real editors: a Z=f(X,Y)/implicit surface and a coordinate/coefficient field. */
interface Scope { readonly axes: readonly MathAxis[]; readonly parameters: readonly MathParameter[] }
const SPACE: Scope = { axes: ['X', 'Y', 'Z'], parameters: [] };
const VALUE: Scope = { axes: [], parameters: [] };
type Declared = readonly { readonly role: 'declared'; readonly id: string; readonly label: string }[];

function options(scope: Scope, declared: Declared = []) {
  return { operations: CANDIDATE_MATH_OPERATIONS,
    names: { axes: new Set(scope.axes), parameters: new Set(scope.parameters), declared, coefficients: [] } };
}
const text = (source: string, scope: Scope = VALUE, declared: Declared = []): MathNode => parseMathText(source, options(scope, declared));
const latex = (source: string, scope: Scope = VALUE): MathNode => decodeMathJson(parseMathLatex(source),
  { ...options(scope), allowRenderedProducts: true });
const toLatex = (node: MathNode): string => serializeMathLatex(displayMathJson(node, CANDIDATE_MATH_BY_ID));
const toText = (node: MathNode): string => formatMathText(node, CANDIDATE_MATH_BY_ID);
const read = (source: string, notation: 'text' | 'latex', scope: Scope = VALUE): MathNode =>
  notation === 'text' ? text(source, scope) : latex(source, scope);
/** The problem a parser reports, or null when the input is accepted. */
function problem(action: () => unknown): MathInputProblem | null {
  try { action(); return null; } catch (error) {
    if (error instanceof MathInputProblem) return error;
    throw error;
  }
}
function storedRoundTrip(source: string, notation: 'text' | 'latex', scope: Scope = VALUE): void {
  const stored: StoredMathExpression = { format: MATH_INPUT_FORMAT, source, inputNotation: notation, angleUnit: 'degree',
    expression: read(source, notation, scope) };
  const saved: unknown = JSON.parse(JSON.stringify(stored));
  expect(decodeStoredMath(saved, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
    parseSource: (value, kind) => read(value, kind, scope) })).toEqual(stored);
}
/** Text → structured → text keeps the same expression and the same structured display. */
function notationRoundTrip(original: MathNode, scope: Scope = VALUE): { readonly structured: string; readonly plain: string } {
  const structured = convertMathNotation(original, toLatex, source => latex(source, scope));
  const plain = convertMathNotation(structured.expression, toText, source => text(source, scope));
  expect(structured.expression).toEqual(original);
  expect(plain.expression).toEqual(original);
  expect(convertMathNotation(plain.expression, toLatex, source => latex(source, scope)).source).toBe(structured.source);
  return { structured: structured.source, plain: plain.source };
}

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const identity = { documentId: 'number-notation', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 };
const request = (source: string, notation: 'text' | 'latex'): MathWorkRequest => ({ identity, source, notation, angleUnit: 'radian', coefficients: [] });
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
/** The application's own calculation of a coordinate field, as the editor sends it (optionally through JSON, like a saved file). */
function evaluate(input: MathWorkRequest, throughJson = false): { readonly reply: MathExecutionReply; readonly evaluation: MathEvaluation } {
  const envelope = createMathWorkEnvelope(1, input);
  const sent: unknown = throughJson ? JSON.parse(JSON.stringify(envelope)) : envelope;
  const reply = executeMathWorkRequest(sent, backend);
  return { reply, evaluation: decodeMathWorkReply(reply, input, context).result.evaluation };
}
function exactValue(source: string, notation: 'text' | 'latex' = 'text'): { readonly numerator: bigint; readonly denominator: bigint } | null {
  const { evaluation } = evaluate(request(source, notation));
  if (evaluation.status !== 'value' || evaluation.kind !== 'real' || evaluation.exact === null) throw new Error(JSON.stringify(evaluation));
  return rationalOfExpression(evaluation.exact);
}
/** Switch the notation, save the switched definition as JSON, reopen it and calculate again. */
function recomputeAfterSwitch(source: string, notation: 'text' | 'latex'): { readonly shown: string; readonly first: MathEvaluation; readonly again: MathEvaluation } {
  const target = notation === 'text' ? 'latex' : 'text';
  const first = evaluate({ ...request(source, notation), presentationNotation: target });
  const presentation = first.reply.presentation;
  if (presentation === undefined || presentation === null) throw new Error(JSON.stringify(first.evaluation));
  const again = evaluate({ ...request(presentation.source, target), definition: presentation }, true);
  return { shown: presentation.source, first: first.evaluation, again: again.evaluation };
}
/** Evaluate through the real function-plot path: saved source, reparse at the boundary, compiled tape. */
function plotValue(source: string, notation: 'text' | 'latex', point: readonly number[]): number {
  const definition = createFunctionMathSource(source, notation, 'radian', { ...SPACE, coefficients: [] }, backend);
  const saved: unknown = JSON.parse(JSON.stringify(definition));
  const tape = compileFunctionScalar(saved, [...SPACE.axes], [], { backend, shouldStop: () => undefined });
  return createScalarSampler(tape)(point);
}

// Independent values: a.b(c) = (abc − ab)/(10^|b|·(10^|c| − 1)), reduced by hand.
const REPEATING = [
  ['0.1(6)', 1n, 6n], ['0.(3)', 1n, 3n], ['1.(142857)', 8n, 7n], ['12.34(56)', 61111n, 4950n],
  ['.5(3)', 8n, 15n], ['0.(06)', 2n, 33n], ['2.5(0)', 5n, 2n], ['0.(9)', 1n, 1n],
] as const;

describe('通常入力の循環小数を丸めない有理数として読む（MC-19c、Q1=A）', () => {
  it.each(REPEATING)('%s は既約分数 %s/%s と同じ式になり、厳密な値を返す', (source, numerator, denominator) => {
    const fraction = denominator === 1n ? String(numerator) : `${String(numerator)}/${String(denominator)}`;
    expect(text(source)).toEqual(text(fraction));
    expect(exactValue(source)).toEqual({ numerator, denominator });
  });
  it('全角の ０．１（６） も同じ循環小数として読む', () => {
    expect(text('０．１（６）')).toEqual(text('1/6'));
  });
  it.each([['0.1(6)*6', 1n], ['0.(3)+0.(6)', 1n], ['1.(142857)*7', 8n], ['0.(3)%*300', 1n]] as const)(
    '%s は途中で丸めず、ちょうど %s になる', (source, value) => {
      expect(exactValue(source)).toEqual({ numerator: value, denominator: 1n });
    });
  it('関数作図の式でも同じ値として使える', () => {
    expect(plotValue('X*0.(3)', 'text', [3, 0, 0])).toBeCloseTo(1, 12);
    expect(plotValue('Y-0.1(6)', 'text', [0, 1, 0])).toBeCloseTo(5 / 6, 12);
  });
  it('構造入力へ切り替えると分数で表示し、戻しても保存しても同じ式になる', () => {
    const { structured, plain } = notationRoundTrip(text('0.1(6)+1'));
    expect(structured).toContain(String.raw`\frac{1}{6}`);
    expect(plain).toBe('Add(Divide(1,6),1)');
    storedRoundTrip('0.1(6)+1', 'text');
    const { shown, first, again } = recomputeAfterSwitch('0.1(6)+1', 'text');
    expect(shown).toContain(String.raw`\frac{1}{6}`);
    expect(again).toEqual(first);
    expect(first).toMatchObject({ status: 'value', kind: 'real' });
  });
  it('整数・小数・繰り返す数字を合わせて2048桁までは読み、それを超えると理由付きで断る', () => {
    const within = `0.${'1'.repeat(1447)}(${'2'.repeat(600)})`, over = `0.${'1'.repeat(1500)}(${'2'.repeat(600)})`;
    expect(text(within)).toMatchObject({ kind: 'operation', operation: 'divide' });
    const failure = problem(() => text(over));
    expect(failure?.code).toBe('budget');
    expect(failure?.message).toContain('循環小数の桁が多すぎます');
    expect(failure?.message).toContain('2048桁');
  });
  it.each(['0.1(6a)', '0.1()', '0.1(1.5)', '0.1(x)', '0.(6+1)', '2.(-3)'])('括弧の中が数字だけでない %s は理由付きで断る', source => {
    const failure = problem(() => text(source));
    expect(failure?.code).toBe('syntax');
    expect(failure?.message).toContain('循環小数は、小数点の後で繰り返す数字だけを括弧で囲んで');
  });
  it.each(['2(3)', '1e2(3)', '1.5e2(3)', '0.1 (6)'])('小数点の無い数・指数つき・空白を挟んだ %s は循環小数にせず従来どおり断る', source => {
    const failure = problem(() => text(source));
    expect(failure?.code).toBe('syntax');
    expect(failure?.message).not.toContain('循環小数');
  });
});

// The structured form of the same values: an overline over the repeating digits (Q1=A, approved 09:52).
const STRUCTURED_REPEATING = [
  [String.raw`0.1\overline{6}`, '0.1(6)', 1n, 6n], [String.raw`0.\overline{3}`, '0.(3)', 1n, 3n],
  [String.raw`1.\overline{142857}`, '1.(142857)', 8n, 7n], [String.raw`12.34\overline{56}`, '12.34(56)', 61111n, 4950n],
  [String.raw`0.\bar{3}`, '0.(3)', 1n, 3n], [String.raw`0.\overline{06}`, '0.(06)', 2n, 33n],
] as const;

describe('構造入力では小数の直後の数字の上線を循環小数として読む（MC-19c、Q1=A、統括の承認 09:52）', () => {
  it.each(STRUCTURED_REPEATING)('%s は通常入力 %s と同じ式で、値は %s/%s', (structured, plain, numerator, denominator) => {
    expect(latex(structured)).toEqual(text(plain));
    expect(exactValue(structured, 'latex')).toEqual({ numerator, denominator });
  });
  it.each([[String.raw`0.1\overline{6}\times 6`, 1n], [String.raw`0.\overline{3}+0.\overline{6}`, 1n]] as const)(
    '%s は途中で丸めず、ちょうど %s になる', (source, value) => {
      expect(exactValue(source, 'latex')).toEqual({ numerator: value, denominator: 1n });
    });
  it('関数作図・保存・再読込み・通常入力への切替で同じ値を保つ', () => {
    expect(plotValue(String.raw`X\cdot 0.\overline{3}`, 'latex', [3, 0, 0])).toBeCloseTo(1, 12);
    storedRoundTrip(String.raw`0.1\overline{6}+1`, 'latex');
    const { shown, first, again } = recomputeAfterSwitch(String.raw`0.1\overline{6}+1`, 'latex');
    expect(shown).toBe('Add(Divide(1,6),1)');
    expect(again).toEqual(first);
    expect(first).toMatchObject({ status: 'value', kind: 'real' });
  });
  it('上線の数字を合わせて桁の上限を超えると理由付きで断る', () => {
    const failure = problem(() => latex(`0.${'1'.repeat(1500)}\\overline{${'2'.repeat(600)}}`));
    expect(failure?.code).toBe('budget');
    expect(failure?.message).toContain('循環小数の桁が多すぎます');
  });
});

describe('上線は小数の循環以外では従来どおり共役のまま', () => {
  it('式の上の上線と整数に続く上線は共役（整数と共役の積）のまま読む', () => {
    expect(latex(String.raw`\overline{3+4\mathrm{i}}`)).toEqual(text('conjugate(3+4*i)'));
    expect(latex(String.raw`\bar{2}`)).toEqual(text('conjugate(2)'));
    expect(latex(String.raw`2\overline{3}`)).toEqual(text('2*conjugate(3)'));
  });
  it('小数の直後でも、上線の中が数字だけでない形・波括弧の無い形・指数つきの数は共役との積のまま読む（統括の選択 (a)）', () => {
    expect(latex(String.raw`0.1\overline{1.5}`)).toEqual(text('0.1*conjugate(1.5)'));
    expect(latex(String.raw`0.5\overline{3+4\mathrm{i}}`)).toEqual(text('0.5*conjugate(3+4*i)'));
    expect(latex(String.raw`0.1\overline{6e1}`)).toEqual(text('0.1*conjugate(6e1)'));
    expect(latex(String.raw`0.1\overline6`)).toEqual(text('0.1*conjugate(6)'));
    expect(latex(String.raw`1e2\overline{3}`)).toEqual(text('1e2*conjugate(3)'));
  });
  it('構造入力の丸括弧 0.1(6) は従来どおり掛け算で、循環小数にしない', () => {
    expect(latex('0.1(6)')).toEqual(text('0.1*6'));
  });
});

describe('百分率 % を構造入力でも ÷100 として読み書きする（MC-19c）', () => {
  it.each([
    [String.raw`50\%`, '50%'], [String.raw`\left(1+2\right)\%`, '(1+2)%'], [String.raw`2^{50\%}`, '2^(50%)'],
    [String.raw`12.5\%\times 8`, '12.5%*8'], [String.raw`3!\%`, '3!%'], [String.raw`200\%`, '200%'],
  ])('構造入力 %s は通常入力 %s と同じ式になる', (structured, plain) => {
    expect(latex(structured)).toEqual(text(plain));
  });
  it.each([[String.raw`50\%`, 1n, 2n], [String.raw`12.5\%\times 8`, 1n, 1n], [String.raw`200\%`, 2n, 1n], ['25%', 1n, 4n]] as const)(
    '%s を厳密な値 %s/%s で計算する', (source, numerator, denominator) => {
      expect(exactValue(source, source.includes('\\') ? 'latex' : 'text')).toEqual({ numerator, denominator });
    });
  it('通常⇄構造の切替・保存・再読込みで意味と値を保つ', () => {
    const { structured } = notationRoundTrip(text('50%+X', SPACE), SPACE);
    expect(structured).toContain(String.raw`\frac{50}{100}`);
    storedRoundTrip(String.raw`50\%`, 'latex');
    storedRoundTrip('50%', 'text');
    const fromStructured = recomputeAfterSwitch(String.raw`12.5\%\times 8`, 'latex');
    expect(fromStructured.again).toEqual(fromStructured.first);
    expect(fromStructured.first).toMatchObject({ status: 'value', kind: 'real', coordinate: 1 });
  });
  it('関数作図の構造入力でも ÷100 として計算する', () => {
    expect(plotValue(String.raw`X\cdot 50\%`, 'latex', [4, 0, 0])).toBeCloseTo(2, 12);
  });
  it('LaTeX の注釈記号として扱われる裸の % は従来どおり断る', () => {
    expect(problem(() => latex('50%'))?.code).toBe('syntax');
  });
});

describe('比 a:b を比の値 a÷b として読む（MC-19c、Q1=A）', () => {
  it.each([
    ['1:2', 'text', '1/2', 1n, 2n], ['3:4', 'latex', '3/4', 3n, 4n], ['１：２', 'text', '1/2', 1n, 2n],
    ['1∶4', 'text', '1/4', 1n, 4n], ['(1+2):3', 'text', '(1+2)/3', 1n, 1n], ['1+2:3', 'text', '(1+2)/3', 1n, 1n],
    ['2*3:4', 'text', '(2*3)/4', 3n, 2n], ['1:2+3', 'text', '1/(2+3)', 1n, 5n], ['2^2:8', 'text', '(2^2)/8', 1n, 2n],
    ['0.5:1.5', 'text', '0.5/1.5', 1n, 3n], ['0.(3):2', 'text', '(1/3)/2', 1n, 6n], ['50%:2', 'text', '(50%)/2', 1n, 4n],
    ['1+2:3', 'latex', '(1+2)/3', 1n, 1n], [String.raw`\frac{1}{2}:\frac{3}{4}`, 'latex', '(1/2)/(3/4)', 2n, 3n],
  ] as const)('%s（%s）は %s と同じ式で、値は %s/%s', (source, notation, division, numerator, denominator) => {
    expect(read(source, notation)).toEqual(text(division));
    expect(exactValue(source, notation)).toEqual({ numerator, denominator });
  });
  it('比例式 a:b=c:d は2つの比の値を比べる', () => {
    expect(text('1:2=2:4')).toEqual(text('1/2=2/4'));
    expect(evaluate(request('1:2=2:4', 'text')).evaluation).toMatchObject({ status: 'value', kind: 'boolean',
      expression: { kind: 'constant', name: 'true' } });
    expect(evaluate(request('1:2=2:3', 'latex')).evaluation).toMatchObject({ status: 'value', kind: 'boolean',
      expression: { kind: 'constant', name: 'false' } });
  });
  it.each([
    ['1:2:3', 'text', '2つの項'], ['1:30:00', 'text', '2つの項'], ['1:2:3', 'latex', '2つの項'],
    ['12:05', 'text', '時刻には対応していない'], ['05:1', 'text', '時刻には対応していない'], ['12:05', 'latex', '時刻には対応していない'],
    ['[1:2]', 'text', '一覧や集合の要素'], ['[1,2:3]', 'text', '一覧や集合の要素'], ['{x:x>0}', 'text', '一覧や集合の要素'],
    ['[[1:2,3]]', 'text', '一覧や集合の要素'], [String.raw`\left[1:2\right]`, 'latex', '一覧や集合の要素'],
    [String.raw`\left\{x:x>0\right\}`, 'latex', '一覧や集合の要素'], [String.raw`\begin{pmatrix}1:2&3\end{pmatrix}`, 'latex', '一覧や集合の要素'],
    ['x:=1', 'text', '「:=」による定義'], ['a:=1', 'latex', '「:=」による定義'],
  ] as const)('紛らわしい %s（%s）は理由付きで断る', (source, notation, reason) => {
    const failure = problem(() => read(source, notation));
    expect(failure?.code).toBe('syntax');
    expect(failure?.message).toContain(reason);
  });
  it('括弧や関数の中に書いた比は一覧・集合・行列の要素でも使える', () => {
    expect(text('[(1:2),3]')).toEqual(text('[1/2,3]'));
    expect(latex(String.raw`\left[\left(1:2\right),3\right]`)).toEqual(text('[1/2,3]'));
    expect(text('[sqrt(1:4)]')).toEqual(text('[sqrt(1/4)]'));
    expect(exactValue('sqrt(1:4)')).toEqual({ numerator: 1n, denominator: 2n });
    expect(latex(String.raw`\begin{cases}1:2&1<2\end{cases}`)).toEqual(text('which(1<2,1/2)'));
  });
  it('0 で割る比は値にせず、定義域の外として返す', () => {
    expect(evaluate(request('1:0', 'text')).evaluation.status).toBe('invalid');
  });
  it('通常⇄構造の切替・保存・再読込みで意味と値を保つ', () => {
    const { structured, plain } = notationRoundTrip(text('1:2'));
    expect(structured).toBe(String.raw`\frac{1}{2}`);
    expect(plain).toBe('Divide(1,2)');
    storedRoundTrip('3:4', 'latex');
    storedRoundTrip('１：２', 'text');
    const { again, first } = recomputeAfterSwitch('3:4', 'latex');
    expect(again).toEqual(first);
    expect(first).toMatchObject({ status: 'value', kind: 'real', coordinate: 0.75 });
  });
  it('関数作図の式でも比の値として計算する', () => {
    expect(plotValue('X:2', 'text', [3, 0, 0])).toBeCloseTo(1.5, 12);
    expect(plotValue('X:2', 'latex', [3, 0, 0])).toBeCloseTo(1.5, 12);
  });
  it('構造入力の空白 \\: は比にせず従来どおりの積、\\colon は従来どおり断る', () => {
    expect(latex(String.raw`2\:3`)).toEqual(latex(String.raw`2\,3`));
    expect(exactValue(String.raw`2\:3`, 'latex')).toEqual({ numerator: 6n, denominator: 1n });
    expect(problem(() => latex(String.raw`1\colon 2`))).not.toBeNull();
  });
});

describe('座標系を cartesian・cylindrical・spherical の名前で選ぶ（MC-19c、Q3=A）', () => {
  it.each([
    ['gradient(X^2*Z,[X,Y,Z],cylindrical)', 'gradient(X^2*Z,[X,Y,Z],1)', 'text', SPACE],
    ['laplacian(X^2,[X,Y,Z],spherical)', 'laplacian(X^2,[X,Y,Z],2)', 'text', SPACE],
    ['divergence([X,0,0],[X,Y,Z],cartesian)', 'divergence([X,0,0],[X,Y,Z],0)', 'text', SPACE],
    ['curl([0,X,0],[X,Y,Z],cylindrical)', 'curl([0,X,0],[X,Y,Z],1)', 'text', SPACE],
    ['laplacianat(r^2,[r,t,p],[[2,1,0],cylindrical])', 'laplacianat(r^2,[r,t,p],[[2,1,0],1])', 'text', VALUE],
    ['gradientat(r^2,[r,t,p],[[2,1,0],spherical])', 'gradientat(r^2,[r,t,p],[[2,1,0],2])', 'text', VALUE],
    [String.raw`\operatorname{gradient}\left(X^2Z,\left[X,Y,Z\right],\text{cylindrical}\right)`, 'gradient(X^2*Z,[X,Y,Z],1)', 'latex', SPACE],
    [String.raw`\operatorname{laplacian}\left(X^2,\left[X,Y,Z\right],\mathrm{spherical}\right)`, 'laplacian(X^2,[X,Y,Z],2)', 'latex', SPACE],
    [String.raw`\operatorname{laplacianat}\left(r^2,\left[r,t,p\right],\left[\left[2,1,0\right],\text{cylindrical}\right]\right)`,
      'laplacianat(r^2,[r,t,p],[[2,1,0],1])', 'latex', VALUE],
  ] as const)('%s は番号の形 %s と同じ式になる', (named, numbered, notation, scope) => {
    expect(read(named, notation, scope)).toEqual(text(numbered, scope));
  });
  it('番号で入力した座標系も、通常・構造の表示では名前で示し、切替と保存で同じ式に戻る', () => {
    const plotted = text('gradient(X^2*Z,[X,Y,Z],1)', SPACE);
    expect(toText(plotted)).toBe('Gradient(Multiply(Power(X,2),Z),List(X,Y,Z),cylindrical)');
    expect(notationRoundTrip(plotted, SPACE).structured).toContain(String.raw`,\text{cylindrical}\right)`);
    const at = text('laplacianat(r^2,[r,t,p],[[2,1,0],2])');
    expect(toText(at)).toBe('laplacianat(Power(r,2),[r,t,p],List(List(2,1,0),spherical))');
    expect(notationRoundTrip(at).structured).toContain(String.raw`\text{spherical}`);
    expect(toText(text('divergence([X,0,0],[X,Y,Z])', SPACE))).toBe('Divergence(List(X,0,0),List(X,Y,Z))');
    storedRoundTrip('gradient(X^2*Z,[X,Y,Z],cylindrical)', 'text', SPACE);
    storedRoundTrip(String.raw`\operatorname{laplacianat}\left(r^2,\left[r,t,p\right],\left[\left[2,1,0\right],\text{cylindrical}\right]\right)`, 'latex');
  });
  it('関数作図では名前で選んだ座標系の式を番号と同じ値で計算する', () => {
    expect(plotValue('laplacian(X^2,[X,Y,Z],cylindrical)', 'text', [2, 1, 0])).toBeCloseTo(4, 11);
    expect(plotValue('laplacian(X^2,[X,Y,Z],spherical)', 'text', [2, 1, 0])).toBeCloseTo(6, 11);
  });
  it('同じ名前の記号を宣言した式では、その記号の意味を変えない', () => {
    const declared = [{ role: 'declared' as const, id: 'symbol:cylindrical', label: 'cylindrical' }];
    expect(text('gradient(X^2,[X,Y,Z],cylindrical)', SPACE, declared)).toMatchObject({ operands: [{}, {},
      { kind: 'symbol', reference: { role: 'declared', id: 'symbol:cylindrical' } }] });
  });
  it.each([
    ['gradient(X^2,[X,Y,Z],polar)', SPACE, '記号「polar」の意味を指定してください'],
    ['cylindrical+1', VALUE, '記号「cylindrical」の意味を指定してください'],
    ['jacobianat(r,[r,t,p],[[1,1,1],cylindrical])', VALUE, '座標系の指定は勾配・発散・回転・ラプラシアンで使用してください'],
    ['gradientat(r,[r,t,p],[[1,1,1],3])', VALUE, 'cylindrical（円柱 r,θ,z）'],
  ] as const)('選ぶ位置でない名前・知らない名前・対応しない演算 %s は理由付きで断る', (source, scope, reason) => {
    expect(problem(() => text(source, scope))?.message).toContain(reason);
  });
});

// The exact runtime recalculates a saved, switched definition exactly as the Worker would (one batch per turn).
const engine = sharedExactEngine(exactRuntimeBatch(
  fileURLToPath(new URL('./exactRuntime/cas_vector_calculus_test.py', import.meta.url)), 60_000));
// Independent values: cylindrical Δr² = (1/r)∂r(r·2r) = 4, spherical Δr² = (1/r²)∂r(r²·2r) = 6,
// cylindrical curl of (0,r,0) has e_z component (1/r)∂r(r·r) = 2, spherical ∂r(r²) = 2r = 4 at r=2.
const EXACT = [
  ['laplacianat(r^2,[r,t,p],[[2,1,0],cylindrical])', 4],
  ['laplacianat(r^2,[r,t,p],[[2,1,0],spherical])', 6],
  ['component(curlat([0,r,0],[r,t,p],[[2,1,0],cylindrical]),3)', 2],
  ['component(gradientat(r^2,[r,t,p],[[2,1,0],spherical]),1)', 4],
] as const;
const exactRequest = (source: string): MathWorkRequest => ({ ...request(source, 'text'), presentationNotation: 'latex' });
let exactReplies: readonly MathExecutionReply[], reopened: readonly MathExecutionReply[];
beforeAll(async () => {
  exactReplies = await Promise.all(EXACT.map(([source]) => executeExactMathWorkRequest(
    createMathWorkEnvelope(1, exactRequest(source)), { backend, engine, shouldStop: () => undefined })));
  // Reopen each switched structured definition from JSON and calculate it again in one more batch.
  reopened = await Promise.all(exactReplies.map((reply, index) => {
    if (reply.presentation === undefined || reply.presentation === null) throw new Error(JSON.stringify(reply.evaluation));
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...exactRequest(EXACT[index][0]),
      source: reply.presentation.source, notation: 'latex', definition: reply.presentation, presentationNotation: 'text' })));
    return executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
  }));
}, 180_000);

describe('名前で選んだ座標系を厳密な計算で確かめ、構造入力の保存から再計算しても同じ値になる', () => {
  it.each(EXACT)('%s は %s', (source, value) => {
    const index = EXACT.findIndex(entry => entry[0] === source), input = exactRequest(source);
    const result = decodeMathWorkReply(exactReplies[index], input, context).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
    expect(result.evaluation.coordinate).toBeCloseTo(value, 12);
    expect(result.definition?.source).toBe(source);
    const presentation = exactReplies[index].presentation, again = reopened[index];
    expect(presentation?.source).toMatch(/\\text\{(cylindrical|spherical)\}/u);
    expect(again.evaluation).toEqual(exactReplies[index].evaluation);
    if (again.presentation === undefined || again.presentation === null || exactReplies[index].expression === null) {
      throw new Error(JSON.stringify(again.evaluation));
    }
    expect(sameMathMeaning(exactReplies[index].expression, again.presentation.expression)).toBe(true);
    expect(again.presentation.source).toMatch(/,(cylindrical|spherical)\)/u);
  });
});
