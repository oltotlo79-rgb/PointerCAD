import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createMathBackend } from './createMathBackend.js';
import { decodeMathJson } from './decodeMathJson.js';
import { decodeStoredMath } from './decodeStoredMath.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { formatMathText } from './formatMathText.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { MATH_INPUT_FORMAT, MathInputProblem, type MathAxis, type MathNode, type MathParameter,
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

/** Scopes of the real editors: implicit surface, Z=f(X,Y), parametric curve, and a coordinate/coefficient field. */
interface Scope { readonly axes: readonly MathAxis[]; readonly parameters: readonly MathParameter[] }
const SPACE: Scope = { axes: ['X', 'Y', 'Z'], parameters: [] };
const PLANE: Scope = { axes: ['X', 'Y'], parameters: [] };
const CURVE: Scope = { axes: [], parameters: ['T'] };
const VALUE: Scope = { axes: [], parameters: [] };
const DECLARED_X = [{ role: 'declared' as const, id: 'symbol:x', label: 'x' }];

function options(scope: Scope, declared: typeof DECLARED_X = []) {
  return { operations: CANDIDATE_MATH_OPERATIONS,
    names: { axes: new Set(scope.axes), parameters: new Set(scope.parameters), declared, coefficients: [] } };
}
const text = (source: string, scope: Scope = SPACE): MathNode => parseMathText(source, options(scope));
const latex = (source: string, scope: Scope = SPACE): MathNode => decodeMathJson(parseMathLatex(source),
  { ...options(scope), allowRenderedProducts: true });
const toLatex = (node: MathNode): string => serializeMathLatex(displayMathJson(node, CANDIDATE_MATH_BY_ID));
const toText = (node: MathNode): string => formatMathText(node, CANDIDATE_MATH_BY_ID);
/** The problem a parser reports, or null when the input is accepted. */
function problem(read: () => MathNode): MathInputProblem | null {
  try { read(); return null; } catch (error) {
    if (error instanceof MathInputProblem) return error;
    throw error;
  }
}

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
/** Evaluate through the real function-plot path: saved source, reparse at the boundary, compiled tape. */
function plotValue(source: string, notation: 'text' | 'latex', scope: Scope, point: readonly number[],
  angleUnit: 'degree' | 'radian' = 'radian'): number {
  const definition = createFunctionMathSource(source, notation, angleUnit, { ...scope, coefficients: [] }, backend);
  const saved: unknown = JSON.parse(JSON.stringify(definition));
  const tape = compileFunctionScalar(saved, [...scope.axes, ...scope.parameters], [], { backend, shouldStop: () => undefined });
  return createScalarSampler(tape)(point);
}
function storedRoundTrip(source: string, notation: 'text' | 'latex', scope: Scope): void {
  const expression = notation === 'text' ? text(source, scope) : latex(source, scope);
  const stored: StoredMathExpression = { format: MATH_INPUT_FORMAT, source, inputNotation: notation, angleUnit: 'degree', expression };
  const saved: unknown = JSON.parse(JSON.stringify(stored));
  expect(decodeStoredMath(saved, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
    parseSource: (value, kind) => kind === 'text' ? text(value, scope) : latex(value, scope) })).toEqual(stored);
}
function notationRoundTrip(original: MathNode, scope: Scope): { readonly structured: string; readonly plain: string } {
  const structured = convertMathNotation(original, toLatex, source => latex(source, scope));
  const plain = convertMathNotation(structured.expression, toText, source => text(source, scope));
  expect(structured.expression).toEqual(original);
  expect(plain.expression).toEqual(original);
  expect(convertMathNotation(plain.expression, toLatex, source => latex(source, scope)).source).toBe(structured.source);
  return { structured: structured.source, plain: plain.source };
}

// Each ∇ form, its named operation with the explicit variable list, and an independently derived value at (2,3,4).
const NABLA_FORMS = [
  ['∇(X^2+3*Y^2+Z^3)', String.raw`\nabla\left(X^2+3Y^2+Z^3\right)`, 'gradient(X^2+3*Y^2+Z^3,[X,Y,Z])', 1, 4],
  ['∇_[Y,X](X^2+3*Y^2)', String.raw`\nabla_{[Y,X]}\left(X^2+3Y^2\right)`, 'gradient(X^2+3*Y^2,[Y,X])', 1, 18],
  ['∇·[X^2,X*Y,Z^3]', String.raw`\nabla\cdot\left[X^2,XY,Z^3\right]`, 'divergence([X^2,X*Y,Z^3],[X,Y,Z])', 0, 54],
  ['∇_[X,Y,Z]·[X^2,X*Y,Z^3]', String.raw`\nabla_{[X,Y,Z]}\cdot[X^2,XY,Z^3]`, 'divergence([X^2,X*Y,Z^3],[X,Y,Z])', 0, 54],
  ['∇×[-Y,X,0]', String.raw`\nabla\times\left[-Y,X,0\right]`, 'curl([-Y,X,0],[X,Y,Z])', 3, 2],
  ['∇_[X,Y,Z]×[0,0,X*Y]', String.raw`\nabla_{[X,Y,Z]}\times[0,0,XY]`, 'curl([0,0,X*Y],[X,Y,Z])', 2, -3],
  ['∇²(X^2*Y+Z^3)', String.raw`\nabla^{2}\left(X^2Y+Z^3\right)`, 'laplacian(X^2*Y+Z^3,[X,Y,Z])', 0, 30],
  ['∇^2(X^2*Y+Z^3)', String.raw`\nabla^2_{[X,Y,Z]}\left(X^2Y+Z^3\right)`, 'laplacian(X^2*Y+Z^3,[X,Y,Z])', 0, 30],
  ['∇²_[Z,X](X^2*Y+Z^3)', String.raw`\nabla_{[Z,X]}^{2}\left(X^2Y+Z^3\right)`, 'laplacian(X^2*Y+Z^3,[Z,X])', 0, 30],
  ['∇_[X]^2(X^3)', String.raw`∇_{[X]}²\left(X^3\right)`, 'laplacian(X^3,[X])', 0, 12],
  ['∇·∇(X^2+3*Y^2+Z^3)', String.raw`\nabla\cdot\nabla\left(X^2+3Y^2+Z^3\right)`,
    'divergence(gradient(X^2+3*Y^2+Z^3,[X,Y,Z]),[X,Y,Z])', 0, 32],
] as const;
const scalar = (source: string, component: number): string => component === 0 ? source : `component(${source},${component})`;

describe('∇ の記法を既存の勾配・発散・回転・ラプラシアンへ読み取る（MC-19b、Q4=A）', () => {
  it.each(NABLA_FORMS)('%s と構造入力 %s は %s と同じ演算・変数の順序になる', (plain, structured, named) => {
    const expected = text(named);
    expect(text(plain)).toEqual(expected);
    expect(latex(structured)).toEqual(expected);
  });
  it.each(NABLA_FORMS)('%s を関数作図の実計算で独立した解析値と照合する', (plain, structured, named, component, value) => {
    expect(plotValue(scalar(plain, component), 'text', SPACE, [2, 3, 4])).toBeCloseTo(value, 11);
    expect(plotValue(scalar(named, component), 'text', SPACE, [2, 3, 4])).toBeCloseTo(value, 11);
    const structuredScalar = component === 0 ? structured : String.raw`\operatorname{component}\left(${structured},${component}\right)`;
    expect(plotValue(structuredScalar, 'latex', SPACE, [2, 3, 4])).toBeCloseTo(value, 11);
  });
  it.each(NABLA_FORMS)('%s を通常→構造→通常と戻し、保存の再読込みでも同じ意味を保つ', (plain, structured) => {
    const { structured: shown } = notationRoundTrip(text(plain), SPACE);
    expect(shown).toContain(String.raw`\nabla_{`);
    storedRoundTrip(plain, 'text', SPACE);
    storedRoundTrip(structured, 'latex', SPACE);
  });
  it('構造入力の表示は変数の一覧を下付きで必ず示し、発散・回転・ラプラシアンを記号で区別する', () => {
    expect(toLatex(text('gradient(X^2,[X,Y])'))).toBe(String.raw`\nabla_{\left[X,Y\right]}\left({\left(X\right)}^{2}\right)`);
    expect(toLatex(text('divergence([X,Y],[X,Y])'))).toBe(String.raw`\nabla_{\left[X,Y\right]}\cdot \left(\left[X,Y\right]\right)`);
    expect(toLatex(text('curl([-Y,X,0],[X,Y,Z])'))).toContain(String.raw`\nabla_{\left[X,Y,Z\right]}\times \left(`);
    expect(toLatex(text('laplacian(X^3,[X])'))).toBe(String.raw`\nabla_{\left[X\right]}^{2}\left({\left(X\right)}^{3}\right)`);
    // The text form keeps the named operation, which can be typed without the ∇ glyph.
    expect(toText(text('∇²(X^3)'))).toBe('Laplacian(Power(X,3),List(X,Y,Z))');
  });
  it('MC-29 の座標系の引数を持つ形は従来の名前の表示のまま往復し、∇ の下付きと衝突しない', () => {
    for (const source of ['gradient(X^2*Z,[X,Y,Z],1)', 'divergence([X,0,0],[X,Y,Z],2)', 'laplacian(X^2,[X,Y,Z],1)']) {
      const { structured } = notationRoundTrip(text(source), SPACE);
      expect(structured).toContain(String.raw`\operatorname{`);
      expect(structured).not.toContain(String.raw`\nabla`);
    }
    expect(plotValue('laplacian(X^2,[X,Y,Z],1)', 'text', SPACE, [2, 1, 0])).toBeCloseTo(4, 11);
  });
  it('画面の台本と同じ component(gradient(X^3,[X]),1) を構造入力で表示しても同じ式に戻る', () => {
    const original = text('component(gradient(X^3,[X]),1)', { axes: ['X'], parameters: [] });
    const { structured, plain } = notationRoundTrip(original, { axes: ['X'], parameters: [] });
    expect(structured).toContain(String.raw`\nabla_{\left[X\right]}`);
    expect(plain).toBe('Component(Gradient(Power(X,3),List(X)),1)');
  });
  it('一覧を省略した ∇ は関数作図の軸（X・Y・Z のうちその作図の軸）だけを補う', () => {
    expect(text('∇(X^2+Y^2)', PLANE)).toEqual(text('gradient(X^2+Y^2,[X,Y])', PLANE));
    expect(plotValue('component(∇(X^2+Y^2),2)', 'text', PLANE, [2, 3])).toBeCloseTo(6, 12);
    expect(latex(String.raw`\nabla\cdot\left[X,Y\right]`, PLANE)).toEqual(text('divergence([X,Y],[X,Y])', PLANE));
    expect(text('∇·[X^2]', { axes: ['X'], parameters: [] })).toEqual(text('divergence([X^2],[X])', { axes: ['X'], parameters: [] }));
  });
  it.each([
    ['∇(T^3)', 'text', CURVE], [String.raw`\nabla\left(T^3\right)`, 'latex', CURVE],
    ['∇(x^2)', 'text', VALUE], ['∇·[1,2]', 'text', VALUE], [String.raw`\nabla^{2}\left(x\right)`, 'latex', VALUE],
  ] as const)('一覧の無い %s（媒介変数だけ・単独の入力）は理由付きで断る', (source, notation, scope) => {
    const failure = problem(() => notation === 'text' ? text(source, scope) : latex(source, scope));
    expect(failure?.message).toContain('∇_[x,y,z]');
    expect(failure?.message).toContain('関数作図');
  });
  it('媒介変数の作図は一覧を書けば使え、単独の入力の自由な名前は従来どおり意味を尋ねる', () => {
    expect(plotValue('component(∇_[T](T^3),1)', 'text', CURVE, [2])).toBeCloseTo(12, 12);
    expect(problem(() => text('∇_[x](x^2)', VALUE))?.message).toContain('記号「x」の意味を指定してください');
  });
  it.each([
    ['∇_x(X^2)', 'text'], ['∇ _[X](X^2)', 'text'], ['∇_(X)(X^2)', 'text'], ['∇^3(X)', 'text'], ['∇^X(X)', 'text'],
    [String.raw`\nabla_{X}\left(X^2\right)`, 'latex'], [String.raw`\nabla^{3}\left(X\right)`, 'latex'],
    [String.raw`\nabla_{[X]}_{[Y]}\left(X\right)`, 'latex'], [String.raw`\nabla`, 'latex'], ['∇', 'text'],
  ] as const)('%s のような不足・不明な ∇ を推測で補わず拒否する', (source, notation) => {
    expect(problem(() => notation === 'text' ? text(source) : latex(source))).not.toBeNull();
  });
  it('角度の単位は ∇ でも微分ごとに適用する', () => {
    expect(plotValue('component(∇_[X](sin(X)),1)', 'text', SPACE, [30, 0, 0], 'degree'))
      .toBeCloseTo(Math.PI / 180 * Math.cos(Math.PI / 6), 14);
  });
  it('作図の公開の返信で原式と ∇ の表示・保存を保つ', () => {
    const request: MathWorkRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'function', inputRevision: 1 },
      source: '∇·[X^2,X*Y,Z^3]', notation: 'text', angleUnit: 'radian', coefficients: [], presentationNotation: 'latex',
      functionScope: { axes: ['X', 'Y', 'Z'], parameters: [] } };
    const raw = executeMathWorkRequest(createMathWorkEnvelope(1, request), backend);
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    expect(result.definition?.source).toBe('∇·[X^2,X*Y,Z^3]');
    expect(raw.presentation?.source).toContain(String.raw`\nabla_{\left[X,Y,Z\right]}\cdot`);
    if (raw.expression === null || raw.presentation == null) throw new Error(JSON.stringify(raw.evaluation));
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
  });
});

describe('微分方程式のドット表記は独立変数についての微分としてだけ読む（Q4=A）', () => {
  const DOTTED = String.raw`\operatorname{odesolve}([\ddot{y}=6*t],t,[y],[[y,0,0],[\dot{y},0,1]])`;
  const NAMED = 'odesolve([diff(y,t,t)=6*t],t,[y],[[y,0,0],[diff(y,t),0,1]])';
  it('ẏ・ÿ を diff の1階・2階と同じ意味にし、初期条件の ẏ も同じ微分にする', () => {
    expect(sameMathMeaning(latex(DOTTED, VALUE), text(NAMED, VALUE))).toBe(true);
    expect(sameMathMeaning(latex(String.raw`\operatorname{odesolve}([\dot{y}=y],x,[y],[[y,0,2]])`, VALUE),
      text('odesolve([diff(y,x)=y],x,[y],[[y,0,2]])', VALUE))).toBe(true);
    expect(sameMathMeaning(latex(String.raw`\operatorname{odesolve}([\dddot{y}=0,\ddddot{z}=y],x,[y,z],[])`, VALUE),
      text('odesolve([diff(y,x,x,x)=0,diff(z,x,x,x,x)=y],x,[y,z],[])', VALUE))).toBe(true);
  });
  it('ドット表記の式を通常入力へ切り替えても同じ意味で往復し、保存の再読込みで一致する', () => {
    const { plain } = notationRoundTrip(latex(DOTTED, VALUE), VALUE);
    expect(plain).toContain('D(y,t,t)');
    storedRoundTrip(DOTTED, 'latex', VALUE);
  });
  it.each([
    [String.raw`\dot{y}`, 'ドット表記'], [String.raw`\dot{y}+1`, 'ドット表記'], [String.raw`\ddot{x}`, 'ドット表記'],
    [String.raw`y'`, '短い微分'], [String.raw`\frac{dy}{dx}`, 'dy/dx'],
  ])('微分方程式の外の %s は内部名を出さず理由付きで断る', (source, reason) => {
    const failure = problem(() => latex(source, VALUE));
    expect(failure?.message).toContain(reason);
    expect(failure?.message).toContain('微分方程式');
    expect(failure?.message).not.toContain('Pcad');
  });
  it('通常入力の y′ も微分方程式の外では同じ理由で断る', () => {
    expect(problem(() => text("y'", VALUE))?.message).toContain('微分方程式（odesolve・pde）の中だけ');
  });
  it.each([
    String.raw`\operatorname{pde}([\dot{u}=\operatorname{diff}(u,x,x)],[x,t],[u],[])`,
    String.raw`\operatorname{odesolve}([\dot{z}=y],t,[y],[])`,
    String.raw`\operatorname{odesolve}([\dot{y}'=y],t,[y],[])`,
    String.raw`\operatorname{odesolve}([\dot{2}=y],t,[y],[])`,
    String.raw`\operatorname{odesolve}([\dot{y+1}=y],t,[y],[])`,
  ])('独立変数が決まらない・求める関数でない %s を拒否する', source => {
    expect(problem(() => latex(source, VALUE))).not.toBeNull();
  });
  it('丸括弧の \\dot(…) は従来の内積の呼出しのまま変えない', () => {
    expect(latex(String.raw`\dot\left([1,2],[3,4]\right)`, VALUE)).toEqual(text('dot([1,2],[3,4])', VALUE));
  });
});

describe('d/dx・∂/∂x は既存の変数について微分し、自由な名前を束縛しない（Q4=A）', () => {
  it.each([
    [String.raw`\frac{\mathrm{d}}{\mathrm{d}T}{(T+2)^3}`, 'diff((T+2)^3,T)', CURVE, [0], 12],
    [String.raw`\frac{\mathrm{d}}{\mathrm{d}T}{(T+2)^3}`, 'diff((T+2)^3,T)', CURVE, [1], 27],
    [String.raw`\frac{\partial}{\partial X}{X^2*Y}`, 'diff(X^2*Y,X)', SPACE, [2, 3, 4], 12],
    [String.raw`\frac{\partial}{\partial X}\frac{\partial}{\partial Y}{X^2*Y^3}`, 'diff(diff(X^2*Y^3,Y),X)', SPACE, [2, 3, 4], 108],
  ] as const)('%s を関数作図の実計算で独立した導関数の値と照合する', (structured, named, scope, point, value) => {
    expect(latex(structured, scope)).toEqual(text(named, scope));
    expect(plotValue(structured, 'latex', scope, point)).toBeCloseTo(value, 11);
    expect(plotValue(named, 'text', scope, point)).toBeCloseTo(value, 11);
  });
  it('作図・微分方程式・宣言した記号の既存の微分は、束縛しない判断で意味が変わらない', () => {
    const plotted = text('diff(X^3,X,X)');
    expect(plotted).toMatchObject({ kind: 'operation', operation: 'differentiate',
      operands: [{ kind: 'operation', operation: 'power' }, { reference: { role: 'axis', name: 'X' } }, { reference: { role: 'axis', name: 'X' } }] });
    const ode = text('odesolve([diff(y,x)=y],x,[y],[[y,0,2]])', VALUE);
    expect(JSON.stringify(ode)).toContain('"operation":"differentiate"');
    const declared = parseMathText('diff(x^2,x)', options(VALUE, DECLARED_X));
    expect(declared).toMatchObject({ operation: 'differentiate', operands: [{}, { reference: { role: 'declared', id: 'symbol:x' } }] });
    storedRoundTrip(String.raw`\frac{\mathrm{d}}{\mathrm{d}T}{(T+2)^3}`, 'latex', CURVE);
    storedRoundTrip('diff(X^2*Y,X)', 'text', SPACE);
    const { structured } = notationRoundTrip(latex(String.raw`\frac{\partial}{\partial X}{X^2*Y}`), SPACE);
    expect(structured).toContain(String.raw`\operatorname{diff}`);
  });
  it.each([
    [String.raw`\frac{\mathrm{d}}{\mathrm{d}x}{x^2}`, 'latex'], [String.raw`\frac{\partial}{\partial y}{x*y}`, 'latex'],
    ['diff(x^2,x)', 'text'], ['diff(X^2,X)', 'text'],
  ] as const)('単独の入力の %s は変数を作らず、作図の変数か derivativeat を使う理由で断る', (source, notation) => {
    const failure = problem(() => notation === 'text' ? text(source, VALUE) : latex(source, VALUE));
    expect(failure?.message).toContain('微分する変数「');
    expect(failure?.message).toContain('derivativeat(式,変数,位置,回数)');
  });
});

describe('引数の一覧の無い ∮・∯ と閉じた体積分 ∰ は、普通の積分として計算せず理由付きで断る', () => {
  it.each([
    ['∮', 'text'], ['∯', 'text'], ['circulation([-y,x],[x,y],[cos(t),sin(t)],t,0,360)+∮', 'text'],
    [String.raw`\oint`, 'latex'], [String.raw`\oiint`, 'latex'], [String.raw`\oiiint`, 'latex'], ['∮', 'latex'], ['∯', 'latex'],
  ] as const)('%s', (source, notation) => {
    const failure = problem(() => notation === 'text' ? text(source, VALUE) : latex(source, VALUE));
    expect(failure?.code).toBe('unsupported');
    expect(failure?.message).toContain('引数の一覧を続けて指定してください');
    expect(failure?.message).toContain('closedcirculation');
  });
});

const engine = sharedExactEngine(exactRuntimeBatch(
  fileURLToPath(new URL('./exactRuntime/cas_vector_calculus_test.py', import.meta.url)), 60_000));
const exactRequest = (source: string, notation: 'text' | 'latex'): MathWorkRequest => ({
  identity: { documentId: 'analysis-notation', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 },
  source, notation, angleUnit: 'radian', coefficients: [] });
const EXACT_CASES = [
  // ÿ=6t, y(0)=0, ẏ(0)=1 gives y=t³+t, so y(2)=10.
  [String.raw`\operatorname{component}(\operatorname{odeat}(\operatorname{odesolve}([\ddot{y}=6*t],t,[y],[[y,0,0],[\dot{y},0,1]]),1,[],2),1)`, 'latex', 10],
  ['component(odeat(odesolve([diff(y,t,t)=6*t],t,[y],[[y,0,0],[diff(y,t),0,1]]),1,[],2),1)', 'text', 10],
  // The value recommended when d/dx has no plotting variable: d/dx x³ at 2.
  ['derivativeat(x^3,x,2)', 'text', 12],
  // An existing unambiguous way to write the total differential: ⟨∇f(p), δ⟩ equals totaldifferentialat.
  ['dot(gradientat(x^2+y^2,[x,y],[1,2]),[1/10,1/5])', 'text', 1],
  ['totaldifferentialat(Function(x^2+y^2,x,y),[1,2],[1/10,1/5])', 'text', 1],
] as const;
let exactReplies: readonly MathExecutionReply[];
beforeAll(async () => {
  exactReplies = await Promise.all(EXACT_CASES.map(([source, notation]) => executeExactMathWorkRequest(
    createMathWorkEnvelope(1, exactRequest(source, notation)), { backend, engine, shouldStop: () => undefined })));
}, 180_000);

describe('ドット表記の微分方程式・位置での微分・全微分の既存表記を厳密な計算で確かめる', () => {
  it.each(EXACT_CASES)('%s の公開の返信は %s 入力で値 %s を返す', (source, notation, value) => {
    const request = exactRequest(source, notation);
    const raw = exactReplies[EXACT_CASES.findIndex(entry => entry[0] === source)];
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
    expect(result.evaluation.coordinate).toBeCloseTo(value, 12);
    expect(result.definition?.source).toBe(source);
  });
  it('ドット表記と diff の微分方程式は同じ意味の式として同じ値になる', () => {
    const [dotted, named] = exactReplies;
    if (dotted.expression === null || named.expression === null) throw new Error('式がありません。');
    expect(sameMathMeaning(dotted.expression, named.expression)).toBe(true);
    expect(dotted.evaluation).toEqual(named.evaluation);
  });
});
