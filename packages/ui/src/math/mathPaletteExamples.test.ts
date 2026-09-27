import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { findHelpTopic } from '@pointercad/help-content';
import { createFunctionCurveEvaluator } from '@pointercad/expression/math/geometry';
import {
  createFunctionMathSource,
  createMathBackend,
  executeMathWorkRequest,
  executeFunctionPointWorkRequest,
  executeExactMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  MathInputProblem,
  type MathEvaluation,
  type MathNode,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import {
  MATH_PALETTE_DRAFT, MATH_PALETTE_HELP_TOPIC, mathPaletteAvailability,
  type MathPaletteArgumentType, type MathPaletteCatalogItem, type MathPaletteExample,
} from './mathPalette.js';
import { MATH_PALETTE_BASIC } from './mathPaletteBasic.js';
import { MATH_PALETTE_BASIC_EXAMPLES } from './mathPaletteBasicExamples.js';
import { MATH_PALETTE_CALCULUS } from './mathPaletteCalculus.js';
import { MATH_PALETTE_CALCULUS_EXAMPLES } from './mathPaletteCalculusExamples.js';
import { MATH_PALETTE_SETS_LOGIC } from './mathPaletteSetsLogic.js';
import { MATH_PALETTE_SETS_LOGIC_EXAMPLES } from './mathPaletteSetsLogicExamples.js';
import { MATH_INPUT_PALETTE, MATH_PALETTE_EXAMPLES, mathPaletteExampleSource } from './mathPaletteExamples.js';

/** Drafts with a calculation but without a public example. MC-19b published derivative and partial with plotting examples. */
const DRAFT_EXECUTION_PROBES: readonly MathPaletteExample[] = [];
const ALL_PROBES = [...MATH_PALETTE_EXAMPLES, ...DRAFT_EXECUTION_PROBES];
let backend: MathExecutionBackend;
const exactResults = new Map<string, Awaited<ReturnType<typeof executeExactMathWorkRequest>>>();
/** Examples whose real calculation actually reached the fixed exact runtime. */
const exactRuntimeIds = new Set<string>();
interface PendingCalculation {
  readonly expression: MathNode;
  readonly angleUnit: 'degree' | 'radian';
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}
function paletteRequest(example: typeof MATH_PALETTE_EXAMPLES[number]) {
  return { identity: { documentId: 'palette', documentVersion: 1, editorId: example.id, inputRevision: 1 },
    source: mathPaletteExampleSource(example), notation: 'latex' as const, angleUnit: 'degree' as const, coefficients: [],
    ...(example.functionContext === undefined ? {} : { functionScope: { axes: example.functionContext.axes, parameters: example.functionContext.parameters } }) };
}
beforeAll(async () => {
  backend = createMathBackend();
  // Reject missing placeholders and wrong notation before starting any exact runtime.
  for (const example of ALL_PROBES) {
    const parsed = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: paletteRequest(example) }, backend);
    expect(parsed.expression, `${example.id}: ${JSON.stringify(parsed.evaluation)}`).not.toBeNull();
  }
  const queue: PendingCalculation[] = [];
  const pending = ALL_PROBES.filter(example => example.exact).map(example => {
    const request = paletteRequest(example);
    return executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, {
      backend, shouldStop: () => undefined,
      engine: { evaluate: (expression, angleUnit) => new Promise<unknown>((resolve, reject) => {
        exactRuntimeIds.add(example.id);
        queue.push({ expression, angleUnit, resolve, reject });
      }) },
    }).then(reply => { exactResults.set(example.id, reply); });
  });
  const started = performance.now(); let batches = 0;
  try {
    // Every request still runs through the real runtime and the public reply decoder.
    // Eight requests amortize imports while retaining the existing 30-second subprocess bound.
    for (let start = 0; start < queue.length; start += 8) {
      const batch = queue.slice(start, start + 8);
      const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_probability_test.py', import.meta.url));
      const result = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
        input: JSON.stringify(batch.map(({ expression, angleUnit }) => ({ expression, angleUnit }))),
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
      if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || result.error?.message);
      const replies: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(replies) || replies.length !== batch.length) throw new Error('計算の返信数が不正です。');
      batch.forEach((request, index) => request.resolve(replies[index]));
      batches++;
    }
    await Promise.all(pending);
  } catch (error) {
    queue.forEach(request => { request.reject(error); });
    await Promise.allSettled(pending);
    throw error;
  }
  console.log('[実測] 数学パレットの実計算', JSON.stringify({ requests: queue.length, batches, milliseconds: performance.now() - started }));
}, 180_000);
/** ±・∓ の status:'multiple' 候補（各候補は独立に評価済みの数値の式）を実数へ変換する。分数・符号反転を含む。 */
function candidateNumber(node: MathNode): number {
  if (node.kind === 'number') return Number(node.decimal);
  if (node.kind === 'operation' && node.operation === 'negate' && node.operands.length === 1) return -candidateNumber(node.operands[0]);
  if (node.kind === 'operation' && node.operation === 'divide' && node.operands.length === 2) {
    return candidateNumber(node.operands[0]) / candidateNumber(node.operands[1]);
  }
  throw new Error(`候補の数値を読み取れません: ${JSON.stringify(node)}`);
}
describe('公開パレットの実テンプレートを構造入力と同じ経路で評価する', () => {
  it.each(MATH_PALETTE_EXAMPLES)('$idの記号と引数が期待した数値・型になる', example => {
    const request = paletteRequest(example);
    const envelope = { kind: 'evaluate-math' as const, serial: 1, request };
    const raw = example.exact ? exactResults.get(example.id) : executeMathWorkRequest(envelope, backend);
    if (raw === undefined) throw new Error(`実計算の返信がありません: ${example.id}`);
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.definition?.source, JSON.stringify(result.evaluation)).toBe(request.source);
    if (example.functionContext !== undefined) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'function' });
      expect(verifyFunctionContext(example)).toBe(true);
    } else if (example.expected === 'unevaluated') {
      expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
      expect(result.definition?.expression).toEqual(raw.expression);
      expect(JSON.stringify(result.definition?.expression)).toContain('partial-equations');
      expect(request.source).toContain('[[u,[0,t],3]]');
    } else if (typeof example.expected === 'number') {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
      expect(result.evaluation.coordinate).toBeCloseTo(example.expected, 11);
    } else if (typeof example.expected === 'object') {
      // ±・∓ never collapse to one status:'value'; the catalog's expected candidates stay in order.
      expect(result.evaluation).toMatchObject({ status: 'multiple', exhaustive: true });
      if (result.evaluation.status !== 'multiple') throw new Error(JSON.stringify(result.evaluation));
      expect(result.evaluation.candidates.map(candidateNumber)).toEqual(example.expected.candidates);
    } else if (example.expected === 'antiderivative') {
      // MC-04c: an indefinite integral's real answer is the antiderivative family F+C, delivered as kind:'function'
      // (mathPaletteGroups.ts's 'antiderivative' only distinguishes it inside the catalog). Confirmed the same way
      // exactIndefiniteIntegrals.test.ts's own antiderivative() helper does: a lambda bound to the source
      // integral's own variable with an unrestricted domain, never a plain numeric or a generic mapping.
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'function' });
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'function') throw new Error(JSON.stringify(result.evaluation));
      const fn = result.evaluation.expression, root = result.definition?.expression;
      if (fn.kind !== 'binder' || root?.kind !== 'binder') throw new Error(JSON.stringify(fn));
      expect(fn).toMatchObject({ operation: 'lambda', bindings: [{ variable: root.bindings[0].variable, domain: { kind: 'unrestricted' } }] });
      expect(fn.bindings).toHaveLength(1);
    } else expect(result.evaluation).toMatchObject({ status: 'value', kind: example.expected });
  });
  it('公開項目には評価対象の実例と登録済みの演算があり、未検査の下書きは含まない', () => {
    const ids = new Set(MATH_PALETTE_EXAMPLES.map(example => `mathPaletteExamples:${example.id}`));
    expect(new Set(MATH_INPUT_PALETTE.map(item => item.id)).size).toBe(MATH_INPUT_PALETTE.length);
    for (const item of MATH_INPUT_PALETTE) expect(mathPaletteAvailability(item, new Set(CANDIDATE_MATH_BY_ID.keys()), ids), item.id).toBe(true);
  });
});

/** MC-03b着手前の公開パレット272項目の表示順。目録から生成しない独立した控え。 */
const PUBLISHED_BEFORE_MC03B: readonly string[] = [
  'mapping', 'mapping-value', 'mapping-compose', 'mapping-inverse', 'mapping-image', 'mapping-preimage',
  'limit-supremum', 'limit-infimum', 'set-supremum', 'set-infimum', 'set-maximum', 'set-minimum', 'solve-ode',
  'ode-value', 'numerical-roots', 'root-interval', 'solve-system', 'system-solution', 'solve-equation',
  'polynomial-roots', 'solution-value', 'fourier-series', 'fourier-value', 'fourier-cosine', 'fourier-sine',
  'fourier-transform', 'inverse-fourier-transform', 'laplace-transform', 'inverse-laplace-transform', 'z-transform',
  'transform-value', 'dft', 'idft', 'fft', 'ifft', 'zeta', 'zetaderivative', 'elliptick', 'elliptice', 'ellipticf',
  'ellipticeinc', 'ellipticpi', 'ellipticpiinc', 'airyai', 'airybi', 'airyaiprime', 'airybiprime', 'lambertw',
  'besselj', 'bessely', 'besseli', 'besselk', 'beta', 'gamma', 'polygamma', 'erf', 'erfc', 'legendre',
  'series-coefficient', 'taylor', 'maclaurin', 'sequence-value', 'difference-at', 'recurrence-value',
  'event-probability', 'given-probability', 'random-expectation', 'random-variance', 'random-covariance',
  'random-correlation', 'independent-events', 'independent-variables', 'chi-square-pdf', 'chi-square-cdf',
  'chi-square-quantile', 't-pdf', 't-cdf', 't-quantile', 'f-pdf', 'f-cdf', 'f-quantile', 'gamma-pdf', 'gamma-cdf',
  'gamma-quantile', 'beta-pdf', 'beta-cdf', 'beta-quantile', 'normal-pdf', 'normal-cdf', 'normal-quantile',
  'expectation', 'probability-variance', 'conditional-probability', 'uniform-pdf', 'uniform-cdf', 'uniform-quantile',
  'exponential-pdf', 'exponential-cdf', 'exponential-quantile', 'binomial-quantile', 'poisson-quantile',
  'poisson-pmf', 'poisson-cdf', 'svd-u', 'svd-s', 'svd-v', 'eigenspace', 'tensor-product', 'hadamard-product',
  'tensor-contract', 'tensor-permute', 'tensor-shape', 'tensor-element', 'kronecker-delta', 'levi-civita',
  'integer-quotient', 'integer-remainder', 'divides', 'congruent-modulo', 'is-prime', 'next-prime', 'prime-factors',
  'divisors', 'euler-totient', 'binomial-pmf', 'binomial-cdf', 'singular-values', 'eigenvalues', 'row-reduce',
  'qr-q', 'qr-r', 'lu-p', 'lu-l', 'lu-u', 'characteristic-coefficients', 'null-space', 'column-space', 'row-space',
  'linear-solve', 'linear-solution-space', 'mean', 'median', 'modes', 'quantile', 'population-variance',
  'sample-variance', 'population-standard-deviation', 'sample-standard-deviation', 'population-covariance',
  'sample-covariance', 'correlation', 'regression-slope', 'regression-intercept', 'r-squared', 'reciprocal',
  'double-factorial', 'permutations', 'clamp', 'arccot', 'arcsec', 'arccsc', 'atan2', 'coth', 'sech', 'csch',
  'arcoth', 'arsech', 'arcsch', 'component', 'fraction', 'power', 'square-root', 'nth-root', 'factorial', 'absolute',
  'sin', 'cos', 'tan', 'arcsin', 'log-natural', 'log-ten', 'log-base', 'sinh', 'sum', 'product', 'integral',
  'matrix', 'pi', 'imaginary-unit',
  'arccos', 'arctan', 'cot', 'sec', 'csc',
  'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh',
  'exponential', 'log-two', 'floor', 'ceiling', 'round',
  'sign', 'minimum', 'maximum', 'binomial', 'gcd',
  'lcm', 'modulo', 'argument', 'cis', 'real-part',
  'imaginary-part', 'conjugate', 'limit', 'determinant', 'transpose',
  'conjugate-transpose', 'inverse-matrix', 'trace', 'rank', 'gradient-at',
  'divergence-at', 'curl-at', 'laplacian-at', 'jacobian-at', 'hessian-at',
  'line-integral', 'circulation', 'surface-integral', 'flux-integral', 'volume-integral',
  'derivative-at', 'infinite-sum', 'infinite-product', 'union', 'intersection',
  'cases', 'equal', 'not-equal', 'less', 'less-equal',
  'greater', 'greater-equal', 'and', 'or', 'not',
  'implies', 'equivalent', 'empty-set', 'natural-numbers', 'integer-numbers',
  'rational-numbers', 'real-numbers', 'complex-numbers', 'element', 'set-minus',
  'normal-distribution', 'uniform-distribution', 'exponential-distribution', 'gamma-distribution', 'beta-distribution',
  'chisquare-distribution', 't-distribution', 'f-distribution', 'binomial-distribution', 'poisson-distribution',
  'finite-distribution', 'joint-finite-distribution', 'independent-distributions',
];
const RESULT_TYPES: ReadonlySet<string> = new Set(['real', 'complex', 'boolean', 'vector', 'matrix', 'tensor', 'infinite-bound',
  'set', 'interval', 'function', 'distribution', 'symbolic', 'series', 'transform', 'fourier-series', 'equation-system',
  'root-intervals', 'ode-solutions', 'candidates', 'antiderivative']);
const ARGUMENT_TYPES: ReadonlySet<string> = new Set([...RESULT_TYPES, 'integer', 'natural', 'probability', 'angle',
  'expression', 'variable', 'variable-list', 'condition', 'equation-list', 'list']);
const DOMAINS = [
  { items: MATH_PALETTE_BASIC, examples: MATH_PALETTE_BASIC_EXAMPLES },
  { items: MATH_PALETTE_CALCULUS, examples: MATH_PALETTE_CALCULUS_EXAMPLES },
  { items: MATH_PALETTE_SETS_LOGIC, examples: MATH_PALETTE_SETS_LOGIC_EXAMPLES },
] as const;
const helpTopic = findHelpTopic(MATH_PALETTE_HELP_TOPIC);
if (helpTopic === undefined) throw new Error(`説明の章がありません: ${MATH_PALETTE_HELP_TOPIC}`);
/** HelpMarkdown と同じ規則で読み取る説明の見出し。 */
const HELP_HEADINGS: ReadonlySet<string> = new Set(readFileSync(new URL(`../../../help-content/${helpTopic.path}`, import.meta.url), 'utf8')
  .split(/\r?\n/u).flatMap(line => /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line)?.slice(2, 3) ?? []));

function draftItem(id: string): MathPaletteCatalogItem {
  const item = MATH_PALETTE_DRAFT.find(entry => entry.id === id);
  if (item === undefined) throw new Error(`目録にない実例です: ${id}`);
  return item;
}
/** #0 は1つ、#? は出現ごとに1つの引数。 */
function argumentCount(template: string): number {
  return (template.includes('#0') ? 1 : 0) + (template.match(/#\?/gu)?.length ?? 0);
}
function exampleArguments(example: MathPaletteExample): readonly string[] {
  return draftItem(example.id).template.includes('#0') ? [example.selection, ...example.slots] : example.slots;
}
function withArgument(example: MathPaletteExample, index: number, value: string): MathPaletteExample {
  if (draftItem(example.id).template.includes('#0')) {
    if (index === 0) return { ...example, selection: value };
    index -= 1;
  }
  return { ...example, slots: example.slots.map((slot, position) => position === index ? value : slot) };
}

/** 引数型の照合と関数作図の判定に使う計算部。負荷で変わる時間の上限を外し、判定を計算の結果だけで決める。 */
let unbounded: MathExecutionBackend;
beforeAll(() => {
  unbounded = { ...createMathBackend(), withinDeadline: <T>(operation: () => T extends Promise<unknown> ? never : T): T => operation() };
});
function nativeEvaluation(source: string): MathEvaluation {
  const request = { identity: { documentId: 'palette-argument', documentVersion: 1, editorId: 'argument', inputRevision: 1 },
    source, notation: 'latex' as const, angleUnit: 'degree' as const, coefficients: [] };
  return executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, unbounded).evaluation;
}
function sameKind(type: MathPaletteArgumentType, kind: string): boolean {
  if (type === kind) return true;
  if (type === 'tensor') return kind === 'vector' || kind === 'matrix';
  if (type === 'set') return kind === 'interval';
  return kind === 'real' && (type === 'complex' || type === 'angle' || type === 'integer' || type === 'natural' || type === 'probability');
}
/** 前の演算の結果を渡す引数は、その演算を作る目録の項目の結果型で照合する。 */
const OPERATION_HEAD = /^\\operatorname\{([A-Za-z]+)\}/u;
const PRODUCERS = new Map(MATH_PALETTE_DRAFT.flatMap(item => {
  const head = OPERATION_HEAD.exec(item.template)?.[1];
  return head === undefined ? [] : [[head, item] as const];
}));
/** 値として計算しない引数（式・変数名・条件・一覧・分布の指定）の形。 */
const SHAPES: Partial<Readonly<Record<MathPaletteArgumentType, RegExp>>> = {
  expression: /\S/u,
  variable: /^[A-Za-z]$/u,
  'variable-list': /^\[[A-Za-z](?:,[A-Za-z])*\]$/u,
  condition: /[=<>]/u,
  'equation-list': /^\[.*=.*\]$/u,
  list: /^\[.*\]$/u,
  distribution: /^\\operatorname\{[a-z]+distributions?\}/u,
};
function argumentProblem(type: MathPaletteArgumentType, value: string): string | null {
  const producer = type === 'expression' ? undefined : PRODUCERS.get(OPERATION_HEAD.exec(value)?.[1] ?? '');
  if (producer !== undefined) return sameKind(type, producer.resultType) ? null : `${producer.id}の結果型は${producer.resultType}`;
  const shape = SHAPES[type];
  if (shape !== undefined) return shape.test(value) ? null : `${type}の形ではありません`;
  const evaluation = nativeEvaluation(value);
  if (evaluation.status !== 'value' || !sameKind(type, evaluation.kind)) return JSON.stringify(evaluation);
  if (evaluation.kind !== 'real') return null;
  const number = evaluation.coordinate;
  if (type === 'integer' && !Number.isInteger(number)) return `整数ではありません: ${number}`;
  if (type === 'natural' && !(Number.isInteger(number) && number >= 0)) return `0以上の整数ではありません: ${number}`;
  if (type === 'probability' && !(number >= 0 && number <= 1)) return `0以上1以下ではありません: ${number}`;
  return null;
}

const FUNCTION_SCOPE = { axes: [], parameters: ['T'], coefficients: [] } as const;
/** 引数へ作図の変数Tを加えた式。T=0で元の実例と同じ値になる。並びと行列は最初の数にだけ加える。 */
function withVariable(type: MathPaletteArgumentType, value: string): string | null {
  if (type === 'real' || type === 'angle' || type === 'integer' || type === 'natural' || type === 'probability'
    || type === 'complex' || type === 'expression') return String.raw`\left(${value}+T\right)`;
  if (type !== 'vector' && type !== 'matrix' && type !== 'tensor') return null;
  const first = /-?\d+(?:\.\d+)?/u.exec(value);
  if (first === null) return null;
  return `${value.slice(0, first.index)}\\left(${first[0]}+T\\right)${value.slice(first.index + first[0].length)}`;
}
function functionSources(example: MathPaletteExample, item: MathPaletteCatalogItem): readonly string[] {
  const values = exampleArguments(example);
  if (values.length === 0) return [String.raw`\left(${mathPaletteExampleSource(example)}+T\right)`];
  return values.flatMap((value, index) => {
    const type = item.argumentTypes[index];
    const changed = type === undefined ? null : withVariable(type, value);
    return changed === null ? [] : [mathPaletteExampleSource(withArgument(example, index, changed))];
  });
}
/** 実際の関数作図と同じ翻訳（曲線のX成分）でT=0の値を求める。翻訳できない式は null。 */
function functionValueAtZero(source: string): number | null {
  try {
    const output = createFunctionMathSource(source, 'latex', 'degree', FUNCTION_SCOPE, unbounded);
    const zero = createFunctionMathSource('0', 'latex', 'degree', FUNCTION_SCOPE, unbounded);
    const point = createFunctionCurveEvaluator([output, zero, zero], 'T', [], { backend: unbounded, shouldStop: () => undefined }).point(0);
    return point === null ? Number.NaN : point[0];
  } catch (error) {
    if (error instanceof MathInputProblem) return null;
    throw error;
  }
}

/** Read the actual parsed operations, including binding domains; registration alone is not implementation evidence. */
function operationIds(source: MathNode): ReadonlySet<string> {
  const ids = new Set<string>(), pending = [source];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.kind === 'operation') { ids.add(node.operation); pending.push(...node.operands); }
    if (node.kind === 'binder') {
      ids.add(node.operation); pending.push(node.body);
      for (const binding of node.bindings) {
        const domain = binding.domain;
        if (domain.kind === 'set') pending.push(domain.value);
        if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper);
          if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return ids;
}

/** Three-axis samples use the point Worker: F(X,Y,Z)-expected+(Z-z) must have its unique root at z.
 * The sample polynomials are increasing in Z on the one-unit box. This evaluates the real geometry tape,
 * including its derivative/domain guards; accepting a function declaration alone is not sufficient. */
function verifyFunctionContext(example: MathPaletteExample): boolean {
  const context = example.functionContext;
  if (context === undefined) return false;
  const source = mathPaletteExampleSource(example), scope = { axes: context.axes, parameters: context.parameters, coefficients: [] };
  expect(context.samples.length).toBeGreaterThan(0);
  for (const sample of context.samples) {
    expect(sample.components.length).toBeGreaterThan(0);
    for (const component of sample.components) {
      const scalar = component.indices.length === 0 ? source
        : String.raw`\operatorname{component}\left(${source},${component.indices.join(',')}\right)`;
      if (context.parameters.length === 1 && context.axes.length === 0) {
        const output = createFunctionMathSource(scalar, 'latex', 'degree', scope, unbounded);
        const zero = createFunctionMathSource('0', 'latex', 'degree', scope, unbounded);
        const value = createFunctionCurveEvaluator([output, zero, zero], context.parameters[0], [],
          { backend: unbounded, shouldStop: () => undefined }).point(sample.point[0]);
        expect(value?.[0], scalar).toBeCloseTo(component.value, 11);
      } else {
        expect(context.axes).toEqual(['X', 'Y', 'Z']);
        expect(context.parameters).toEqual([]);
        const [x, y, z] = sample.point;
        const equation = String.raw`\left(${scalar}\right)-(${component.value})+Z-(${z})`;
        const expression = createFunctionMathSource(equation, 'latex', 'degree', scope, unbounded);
        const reply = executeFunctionPointWorkRequest({ kind: 'solve-function-points', serial: 1, request: {
          identity: paletteRequest(example).identity, expression, coefficients: [],
          minimum: [x - 1, y - 1, z - 1], maximum: [x + 1, y + 1, z + 1], tolerance: 1e-8,
          known: [{ axis: 'X', value: x }, { axis: 'Y', value: y }],
        } }, unbounded);
        expect(reply.result.status, `${scalar}: ${JSON.stringify(reply.result)}`).toBe('ready');
        if (reply.result.status !== 'ready') throw new Error(JSON.stringify(reply.result));
        expect(reply.result.exhaustive).toBe(true);
        expect(reply.result.candidates).toHaveLength(1);
        const point = reply.result.candidates[0].point;
        sample.point.forEach((expected, index) => { expect(point[index], scalar).toBeCloseTo(expected, 7); });
      }
    }
  }
  return true;
}

describe('目録の欄（引数型・結果型・計算方式・関数作図での利用・説明の節）と分野別ファイル', () => {
  it('着手前の公開272項目は件数と表示順を保ち、新しい項目はその後ろに続く', () => {
    const ids = MATH_INPUT_PALETTE.map(item => item.id);
    expect(PUBLISHED_BEFORE_MC03B).toHaveLength(272);
    expect(ids.slice(0, PUBLISHED_BEFORE_MC03B.length)).toEqual(PUBLISHED_BEFORE_MC03B);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(272, 279)).toEqual(['gradient', 'divergence', 'curl', 'laplacian', 'jacobian', 'hessian', 'partial-equations']);
    expect(ids.slice(279, 282)).toEqual(['dot', 'cross', 'norm']);
    expect(ids.slice(282, 284)).toEqual(['derivative', 'partial']);
    // MC-02d: e, projection・単位/零行列・全微分, 集合の関係7件・≈・要素数・真偽の定数 (16 items; ∞ dropped, see report).
    expect(ids.slice(284, 300)).toEqual([
      'e',
      'projection', 'identity-matrix', 'zero-matrix', 'total-differential-at',
      'not-element', 'subset', 'subset-equal', 'superset', 'superset-equal', 'complement', 'cartesian-product',
      'approximately-equal', 'cardinality', 'true', 'false',
    ]);
    // MC-02e: ±・∓（基本、候補を返す）、閉じた線・面積分4件（微積分、MC-19d実装分）、∀・∃（集合・論理、MC-24実装分）。
    // 分野別ファイルの連結順（基本→微積分→集合・論理）どおりに、各ファイルの末尾へ足した順で続く。
    // MC-04c: 不定積分（原始関数）1件は微積分ファイルの末尾（closed-flux-integralの後ろ）に続けて足したため、
    // 集合・論理ファイルの∀・∃より前、閉じた面積分より後ろに並ぶ（計309項目）。
    expect(ids.slice(300)).toEqual([
      'plus-minus', 'minus-plus',
      'closed-line-integral', 'closed-circulation', 'closed-surface-integral', 'closed-flux-integral',
      'indefinite-integral',
      'for-all', 'exists',
    ]);
  });
  it('下書きは分野別3ファイルの連結で、実例は同じ分野のファイルの項目だけを使う', () => {
    expect(MATH_PALETTE_DRAFT).toEqual(DOMAINS.flatMap(domain => domain.items));
    expect(new Set(MATH_PALETTE_DRAFT.map(item => item.id)).size).toBe(MATH_PALETTE_DRAFT.length);
    for (const domain of DOMAINS) {
      const own = new Set(domain.items.map(item => item.id));
      for (const example of domain.examples) expect(own.has(example.id), example.id).toBe(true);
    }
    expect(MATH_PALETTE_EXAMPLES).toHaveLength(DOMAINS.reduce((count, domain) => count + domain.examples.length, 0));
  });
  it.each(MATH_PALETTE_DRAFT)('$idの目録の欄が欠けておらず、説明の節が実在する', item => {
    expect(item.label.length * item.meaning.length).toBeGreaterThan(0);
    expect(item.domain.trim().length, item.id).toBeGreaterThan(0);
    expect(item.domain).not.toMatch(/^math\.paletteDomain\./u);
    expect(item.argumentTypes, item.template).toHaveLength(argumentCount(item.template));
    for (const type of item.argumentTypes) expect(ARGUMENT_TYPES.has(type), type).toBe(true);
    expect(RESULT_TYPES.has(item.resultType), item.resultType).toBe(true);
    expect(['native', 'exact-runtime']).toContain(item.method);
    expect(typeof item.functionUse).toBe('boolean');
    expect(HELP_HEADINGS.has(item.help), `説明の見出し「${item.help}」`).toBe(true);
  });
  it.each(MATH_PALETTE_EXAMPLES)('$idの引数型・結果型・計算方式・関数作図での利用が実例の計算と一致する', example => {
    const item = draftItem(example.id);
    const expected = example.expected;
    expect(item.resultType).toBe(expected === 'unevaluated' ? 'symbolic' : typeof expected === 'number' ? 'real'
      : typeof expected === 'object' ? 'candidates' : expected);
    expect(item.method, '実例の計算で追加計算部を使ったか').toBe(exactRuntimeIds.has(example.id) ? 'exact-runtime' : 'native');
    const values = exampleArguments(example);
    expect(values).toHaveLength(item.argumentTypes.length);
    values.forEach((value, index) => {
      const type = item.argumentTypes[index];
      if (type === undefined) throw new Error(`${example.id}: 引数型がありません`);
      expect(argumentProblem(type, value), `${index + 1}番目の引数「${value}」は${type}`).toBeNull();
    });
    const usable = example.functionContext !== undefined ? (verifyFunctionContext(example) ? [mathPaletteExampleSource(example)] : [])
      : typeof expected !== 'number' ? [] : functionSources(example, item).filter(source => {
      const value = functionValueAtZero(source);
      if (value === null) return false;
      expect(Math.abs(value - expected), `関数作図の値: ${source}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
      return true;
    });
    expect(usable.length > 0, `関数作図で使えた式: ${JSON.stringify(usable)}`).toBe(item.functionUse);
  });
  it.each(['dot', 'cross', 'norm'])('%sは実計算の例を伴って末尾へ公開する', id => {
    const published = MATH_INPUT_PALETTE.find(item => item.id === id);
    expect(published?.acceptanceIds).toEqual([`mathPaletteExamples:${id}`]);
    expect(published?.domain).not.toContain('実装待ち');
    expect(MATH_INPUT_PALETTE.findIndex(item => item.id === id)).toBeGreaterThan(MATH_INPUT_PALETTE.findIndex(item => item.id === 'hessian'));
    expect(exactResults.get(id)?.evaluation.status).toBe('value');
  });
  it.each(['derivative', 'partial'])('%sは作図の変数で微分する実例を伴って末尾へ公開し、下書きの記述を残さない', id => {
    const published = MATH_INPUT_PALETTE.find(item => item.id === id);
    expect(published?.acceptanceIds).toEqual([`mathPaletteExamples:${id}`]);
    expect(published?.domain).not.toContain('下書き');
    expect(published?.resultType).toBe('real');
    expect(MATH_PALETTE_EXAMPLES.find(example => example.id === id)?.functionContext?.samples.length).toBeGreaterThan(0);
    expect(MATH_INPUT_PALETTE.findIndex(item => item.id === id)).toBeGreaterThan(MATH_INPUT_PALETTE.findIndex(item => item.id === 'norm'));
  });
  it('下書きを含む全項目に実計算の照合先がある', () => {
    expect(new Set(ALL_PROBES.map(probe => probe.id)).size).toBe(ALL_PROBES.length);
    expect(ALL_PROBES.map(probe => probe.id).sort()).toEqual(MATH_PALETTE_DRAFT.map(item => item.id).sort());
  });
  it.each(MATH_PALETTE_DRAFT)('$idの方式と作図可否を下書きも含め実装と照合する', item => {
    const probe = ALL_PROBES.find(entry => entry.id === item.id);
    if (probe === undefined) throw new Error(`実装の照合先がありません: ${item.id}`);
    const request = paletteRequest(probe);
    const native = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, unbounded);
    const result = probe.exact ? exactResults.get(item.id) : native;
    if (result === undefined) throw new Error(`実装の返信がありません: ${item.id}`);
    expect(native.expression).not.toBeNull();
    const operations = native.expression === null ? new Set<string>() : operationIds(native.expression);
    for (const operation of item.requiredOperations) expect(operations.has(operation), `${item.id}: ${operation}`).toBe(true);
    if (probe.expected === 'unevaluated') {
      expect(item.id).toBe('partial-equations');
      expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
    } else if (typeof probe.expected === 'object') {
      // ±・∓ never collapse to one status:'value' (mathPaletteGroups.ts's 'candidates' resultType).
      expect(result.evaluation.status, JSON.stringify(result.evaluation)).toBe('multiple');
    } else expect(result.evaluation.status, JSON.stringify(result.evaluation)).toBe('value');
    expect(item.method, '実物の追加計算部への配送').toBe(exactRuntimeIds.has(item.id) ? 'exact-runtime' : 'native');
    const usable = probe.functionContext !== undefined ? verifyFunctionContext(probe)
      : typeof probe.expected === 'number' && functionSources(probe, item).some(source => functionValueAtZero(source) !== null);
    expect(item.functionUse, '実物の作図翻訳と評価').toBe(usable);
  });

});
