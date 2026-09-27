import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { decodeMathJson } from './decodeMathJson.js';
import { decodeStoredMath } from './decodeStoredMath.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { executeExactMathWorkRequest, type ExactMathEngine } from './exactMathWorkExecution.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';
import { formatMathText } from './formatMathText.js';
import { MATH_INPUT_FORMAT, MathInputProblem, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { decodeMathExpressionStorage } from './mathExpressionStorage.js';
import { EXTENDED_OPERATION_DEFINITIONS, EXTENDED_OPERATION_IDS, pendingExtendedOperationMessage,
  pendingExtendedOperations } from './mathExtendedOperations.js';
import { convertMathNotation, displayMathJson, sameMathMeaning } from './mathNotationConversion.js';
import { CANDIDATE_MATH_BY_ID, CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { parseMathText } from './mathTextSyntax.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { LOWERINGS as TOTAL_DIFFERENTIAL_LOWERINGS } from './totalDifferential.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

/** Registry entries before MC-10 (2026-09-24). Saved documents depend on these IDs and heads. */
const EXISTING_OPERATIONS = `
absolute:Abs add:Add airyai:AiryAi airyaiprime:AiryAiPrime airybi:AiryBi airybiprime:AiryBiPrime and:And arccos:Arccos
arccot:Arccot arccsc:Arccsc arcosh:Arcosh arcoth:Arcoth arcsch:Arcsch arcsec:Arcsec arcsin:Arcsin arctan-two:Arctan2
arctan:Arctan argument:Arg arsech:Arsech arsinh:Arsinh artanh:Artanh besseli:BesselI besselj:BesselJ besselk:BesselK
bessely:BesselY beta-cdf:BetaCdf beta-distribution:BetaDistribution beta-pdf:BetaPdf beta-quantile:BetaQuantile
beta:Beta binomial-cdf:BinomialCdf binomial-distribution:BinomialDistribution binomial-pmf:BinomialPmf
binomial-quantile:BinomialQuantile binomial:Binomial ceiling:Ceil
characteristic-coefficients:CharacteristicCoefficients chi-square-cdf:ChiSquareCdf chi-square-pdf:ChiSquarePdf
chi-square-quantile:ChiSquareQuantile chisquare-distribution:ChiSquareDistribution circulation:Circulation cis:Cis
clamp:Clamp coefficient-reference:PcadCoefficient column-space:ColumnSpace complex:Complex component:Component
conditional-probability:ConditionalProbability congruent-modulo:CongruentModulo conjugate-transpose:ConjugateTranspose
conjugate:Conjugate correlation:Correlation cos:Cos cosh:Cosh cot:Cot coth:Coth cross:Cross csc:Csc csch:Csch
curl-at:CurlAt curl:Curl delimiter:Delimiter determinant:Determinant dft:DFT difference-at:DifferenceAt
differentiate-at:DerivativeAt differentiate:D divergence-at:DivergenceAt divergence:Divergence divide:Divide
divides:Divides divisors:Divisors dot-token:PcadDotToken dot:Dot double-factorial:Factorial2 eigenspace:Eigenspace
eigenvalues:Eigenvalues element:Element elliptice:EllipticE ellipticeinc:EllipticEinc ellipticf:EllipticF
elliptick:EllipticK ellipticpi:EllipticPi ellipticpiinc:EllipticPiinc equal:Equal equivalent:Equivalent erf:Erf
erfc:Erfc euler-totient:EulerTotient event-probability:Probability exists:Exists expectation:Expectation
exponential-cdf:ExponentialCdf exponential-distribution:ExponentialDistribution exponential-pdf:ExponentialPdf
exponential-quantile:ExponentialQuantile exponential:Exp f-cdf:FCdf f-distribution:FDistribution f-pdf:FPdf
f-quantile:FQuantile factorial:Factorial fft:FFT finite-distribution:FiniteDistribution floor:Floor
flux-integral:FluxIntegral for-all:ForAll fourier-cosine:FourierCos fourier-series:FourierSeries
fourier-sine:FourierSin fourier-transform:Fourier fourier-value:FourierAt gamma-cdf:GammaCdf
gamma-distribution:GammaDistribution gamma-pdf:GammaPdf gamma-quantile:GammaQuantile gamma:Gamma gcd:GCD
given-probability:GivenProbability gradient-at:GradientAt gradient:Gradient greater-equal:GreaterEqual greater:Greater
hadamard-product:HadamardProduct hessian-at:HessianAt hessian:Hessian idft:IDFT ifft:IFFT imaginary-part:Im
implicit-operation:InvisibleOperator implies:Implies independent-distributions:IndependentDistributions
independent-events:IndependentEvents independent-variables:IndependentVariables integer-quotient:IntegerQuotient
integer-remainder:IntegerRemainder integrate:Integrate intersection:Intersection interval:Interval
inverse-fourier-transform:InverseFourier inverse-laplace-transform:InverseLaplace inverse-matrix:Inverse
is-prime:IsPrime jacobian-at:JacobianAt jacobian:Jacobian joint-finite-distribution:JointFiniteDistribution
kronecker-delta:KroneckerDelta lambda:Function lambertw:LambertW laplace-transform:Laplace laplacian-at:LaplacianAt
laplacian:Laplacian lcm:LCM legendre:Legendre less-equal:LessEqual less:Less levi-civita:LeviCivita
limit-infimum:LimInf limit-supremum:LimSup limit:Limit line-integral:LineIntegral
linear-solution-space:LinearSolutionSpace linear-solve:LinearSolve list:List log-base:Log log-ten:Lg log-two:Lb
lu-l:LuL lu-p:LuP lu-u:LuU maclaurin:Maclaurin mapping-compose:ComposeMaps mapping-image:MapImage
mapping-inverse:InverseMap mapping-preimage:MapPreimage mapping-value:MapAt mapping:Mapping matrix:Matrix maximum:Max
mean:Mean median:Median minimum:Min modes:Modes modulo:Mod multiply:Multiply natural-log:Ln negate:Negate
next-prime:NextPrime norm:Norm normal-cdf:NormalCdf normal-distribution:NormalDistribution normal-pdf:NormalPdf
normal-quantile:NormalQuantile not-equal:NotEqual not:Not null-space:NullSpace numerical-roots:NumericRoots
ode-value:ODEAt open-endpoint:Open or:Or partial-equations:PDE permutations:Permutations poisson-cdf:PoissonCdf
poisson-distribution:PoissonDistribution poisson-pmf:PoissonPmf poisson-quantile:PoissonQuantile polygamma:Polygamma
polynomial-roots:PolynomialRoots population-covariance:PopulationCovariance
population-standard-deviation:PopulationStandardDeviation population-variance:PopulationVariance power:Power
prime-factors:PrimeFactors probability-variance:ProbabilityVariance product:Product qr-q:QrQ qr-r:QrR
quantile:Quantile r-squared:RSquared random-correlation:RandomCorrelation random-covariance:RandomCovariance
random-expectation:RandomExpectation random-variance:RandomVariance rank:Rank real-part:Re reciprocal:Reciprocal
recurrence-value:RecurrenceValue regression-intercept:RegressionIntercept regression-slope:RegressionSlope
root-interval:RootInterval root:Root round:Round row-reduce:RowReduce row-space:RowSpace
sample-covariance:SampleCovariance sample-standard-deviation:SampleStandardDeviation sample-variance:SampleVariance
sec:Sec sech:Sech sequence-value:SequenceValue series-coefficient:SeriesCoefficient set-infimum:Inf set-maximum:SetMax
set-minimum:SetMin set-minus:SetMinus set-supremum:Sup set:Set sign:Sign sin:Sin singular-values:SingularValues
sinh:Sinh solution-value:Solution solve-equation:Solve solve-ode:ODESolve solve-system:SolveSystem sqrt:Sqrt
square:Square subtract:Subtract sum:Sum surface-integral:SurfaceIntegral svd-s:SvdS svd-u:SvdU svd-v:SvdV
system-solution:SystemSolution t-cdf:TCdf t-distribution:TDistribution t-pdf:TPdf t-quantile:TQuantile tan:Tan
tanh:Tanh taylor:Taylor tensor-contract:TensorContract tensor-element:TensorElement tensor-permute:TensorPermute
tensor-product:TensorProduct tensor-shape:TensorShape times-token:PcadTimesToken trace:Trace
transform-value:TransformAt transpose:Transpose tuple:Tuple uniform-cdf:UniformCdf
uniform-distribution:UniformDistribution uniform-pdf:UniformPdf uniform-quantile:UniformQuantile union:Union
volume-integral:VolumeIntegral which:Which z-transform:ZTransform zeta:Zeta zetaderivative:ZetaDerivative
`.trim().split(/\s+/u).map(pair => {
  const [id = '', head = ''] = pair.split(':');
  return [id, head] as const;
});

/** Plan MC-10: 14 operations and, by the user's answer Q4=A, the total differential at a point. */
const EXPECTED = [
  ['plus-minus', 'PlusMinus', 1, 2, 'MC-11'], ['minus-plus', 'MinusPlus', 1, 2, 'MC-11'],
  ['cardinality', 'Cardinality', 1, 1, 'MC-12'], ['projection', 'Projection', 2, 2, 'MC-16'],
  ['identity-matrix', 'IdentityMatrix', 1, 1, 'MC-18'], ['zero-matrix', 'ZeroMatrix', 1, 2, 'MC-18'],
  ['not-element', 'NotElement', 2, 2, 'MC-23'], ['subset', 'Subset', 2, 2, 'MC-23'],
  ['subset-equal', 'SubsetEqual', 2, 2, 'MC-23'], ['superset', 'Superset', 2, 2, 'MC-23'],
  ['superset-equal', 'SupersetEqual', 2, 2, 'MC-23'], ['complement', 'Complement', 2, 2, 'MC-23'],
  ['cartesian-product', 'CartesianProduct', 2, 16, 'MC-23'], ['approximately-equal', 'ApproxEqual', 2, 3, 'MC-24'],
  ['total-differential-at', 'TotalDifferentialAt', 3, 3, 'MC-30'],
  ['closed-line-integral', 'ClosedLineIntegral', 4, 4, 'MC-19'], ['closed-circulation', 'ClosedCirculation', 4, 4, 'MC-19'],
  ['closed-surface-integral', 'ClosedSurfaceIntegral', 4, 4, 'MC-19'], ['closed-flux-integral', 'ClosedFluxIntegral', 4, 4, 'MC-19'],
] as const;

const TOTAL_DIFFERENTIAL = 'totaldifferentialat(Function(x^2+y^2,x,y),[1,2],[1/10,1/5])';
/** Every operation is read at its smallest and largest operand count at least once. */
const EXAMPLES = [
  ['plus-minus', 'plusminus(1,2)', 2], ['plus-minus', 'plusminus(3)', 1],
  ['minus-plus', 'minusplus(1,2)', 2], ['minus-plus', 'minusplus(3)', 1],
  ['cardinality', 'cardinality({1,2,3})', 1], ['projection', 'projection([1,2],[3,4])', 2],
  ['identity-matrix', 'identitymatrix(3)', 1], ['zero-matrix', 'zeromatrix(2)', 1], ['zero-matrix', 'zeromatrix(2,3)', 2],
  ['not-element', 'notelement(3,{1,2})', 2], ['subset', 'subset({1},{1,2})', 2],
  ['subset-equal', 'subsetequal({1},{1,2})', 2], ['superset', 'superset({1,2},{1})', 2],
  ['superset-equal', 'supersetequal({1,2},{1})', 2], ['complement', 'complement(interval(0,1),ℝ)', 2],
  ['cartesian-product', 'cartesianproduct({1,2},{3,4})', 2],
  ['cartesian-product', `cartesianproduct(${Array.from({ length: 16 }, (_, index) => `{${index}}`).join(',')})`, 16],
  ['approximately-equal', 'approxequal(1,1.05,0.1)', 3], ['approximately-equal', 'approxequal(1,1.05)', 2],
  ['total-differential-at', TOTAL_DIFFERENTIAL, 3],
] as const;

/**
 * Expectations follow each operation's status. An implementing task marks its own entries 'implemented' in
 * mathExtendedOperations.ts; these checks then stop requiring the pending behavior for that operation only,
 * and the implementing task's own tests cover its values.
 */
const PENDING = new Set(EXTENDED_OPERATION_DEFINITIONS.filter(value => value.status === 'pending').map(value => value.id));
const pendingOnly = (...ids: readonly string[]): readonly string[] => ids.filter(id => PENDING.has(id));
const pendingReply = (...ids: readonly string[]) => ({ status: 'invalid', reason: 'unsupported',
  detail: `「${ids.map(id => EXTENDED_OPERATION_DEFINITIONS.find(value => value.id === id)?.label).join('」「')}」の計算にはまだ対応していません。` });

/**
 * An operation alone, under an outer 0, inside another operation, in a selected or discarded component, as a
 * numeric argument or cell, and as a condition, with the operation that is reported.
 */
const EVALUATIONS = [
  ['plusminus(1,2)', 'plus-minus'], ['0*plusminus(1,2)', 'plus-minus'], ['plusminus(1,2)*0', 'plus-minus'],
  ['sum(plusminus(i,1),i,1,3)', 'plus-minus'], ['component([plusminus(1,2),5],2)', 'plus-minus'],
  ['tensorshape([plusminus(1,2),5])', 'plus-minus'], ['gamma(plusminus(3,1))', 'plus-minus'],
  ['minusplus(3)', 'minus-plus'], ['0*minusplus(3)', 'minus-plus'],
  ['cardinality({1,2,3})', 'cardinality'], ['0*cardinality({1,2,3})', 'cardinality'],
  ['component([5,cardinality({1,2})],1)', 'cardinality'], ['tensorelement([5,cardinality({1,2})],[1])', 'cardinality'],
  ['projection([1,2],[3,4])', 'projection'], ['0*norm(projection([1,2],[3,4]))', 'projection'],
  ['component(projection([1,2],[3,4]),1)', 'projection'],
  ['identitymatrix(3)', 'identity-matrix'], ['0*det(identitymatrix(3))', 'identity-matrix'],
  ['component(identitymatrix(3),1,1)', 'identity-matrix'],
  ['zeromatrix(2,3)', 'zero-matrix'], ['0*trace(zeromatrix(2))', 'zero-matrix'], ['component(zeromatrix(2,3),1,2)', 'zero-matrix'],
  ['notelement(3,{1,2})', 'not-element'], ['which(notelement(3,{1,2}),1,true,1)', 'not-element'],
  ['subset({1},{1,2})', 'subset'], ['which(subset({1},{1,2}),1,true,1)', 'subset'],
  ['subsetequal({1},{1,2})', 'subset-equal'], ['superset({1,2},{1})', 'superset'], ['supersetequal({1,2},{1})', 'superset-equal'],
  ['complement(interval(0,1),ℝ)', 'complement'], ['element(2,complement(interval(0,1),ℝ))', 'complement'],
  ['cartesianproduct({1,2},{3,4})', 'cartesian-product'], ['{1,2}×{3,4}', 'cartesian-product'],
  ['approxequal(1,1.05,0.1)', 'approximately-equal'], ['approxequal(1,1.05)', 'approximately-equal'],
  ['which(approxequal(1,1.05,0.1),1,true,1)', 'approximately-equal'],
  [TOTAL_DIFFERENTIAL, 'total-differential-at'], [`0*${TOTAL_DIFFERENTIAL}`, 'total-differential-at'],
  [`component([${TOTAL_DIFFERENTIAL},5],2)`, 'total-differential-at'], [`tensorshape([${TOTAL_DIFFERENTIAL}])`, 'total-differential-at'],
] as const;

const names = { axes: new Set<never>(), parameters: new Set<never>(), declared: [], coefficients: [] };
const options = { names, operations: CANDIDATE_MATH_OPERATIONS };
const text = (source: string): MathNode => parseMathText(source, options);
const identity = { documentId: 'extended-operations', documentVersion: 1, editorId: 'value', inputRevision: 1 };
const request = (source: string): MathWorkRequest => ({ identity, source, notation: 'text', angleUnit: 'radian', coefficients: [] });
const runtime = new URL('./exactRuntime/', import.meta.url);
const pythonEnvironment = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
let backend: MathExecutionBackend;
const latex = (node: MathNode): string => backend.serializeLatex(displayMathJson(node, backend.operationsById));
const fromLatex = (source: string): MathNode => decodeMathJson(backend.parseLatex(source), { ...options, allowRenderedProducts: true });
const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });

function problem(action: () => unknown): MathInputProblem {
  try { action(); } catch (error) {
    if (error instanceof MathInputProblem) return error;
    throw error;
  }
  throw new Error('例外が発生しませんでした。');
}

/** The real fixed runtime (vendored SymPy) calculates exactly the prepared expressions the Worker would send. */
const calculated = new Map<string, unknown>();
function calculate(payloads: readonly { readonly expression: MathNode; readonly angleUnit: 'degree' | 'radian' }[]): readonly unknown[] {
  const results: unknown[] = [];
  for (let start = 0; start < payloads.length; start += 64) {
    const chunk = payloads.slice(start, start + 64);
    const result = spawnExactRuntime(['-B', '-X', 'utf8', fileURLToPath(new URL('cas_mappings_test.py', runtime)), '--batch'], {
      input: JSON.stringify(chunk), encoding: 'utf8', timeout: 90_000, maxBuffer: 4_000_000, env: pythonEnvironment,
    });
    if (result.error !== undefined || result.status !== 0) throw new Error(`実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stderr}`);
    const decoded: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(decoded) || decoded.length !== chunk.length) throw new Error('実計算の返信数が一致しません。');
    const values: readonly unknown[] = decoded;
    results.push(...values);
  }
  return results;
}
const replay: ExactMathEngine = {
  evaluate: (expression, angleUnit) => {
    const key = JSON.stringify({ expression, angleUnit });
    return calculated.has(key) ? Promise.resolve(calculated.get(key)) : Promise.reject(new Error(`実計算していない入力です: ${key}`));
  },
};

beforeAll(async () => {
  backend = createMathBackend();
  const requested: { readonly expression: MathNode; readonly angleUnit: 'degree' | 'radian' }[] = [];
  const recorder: ExactMathEngine = {
    evaluate: (expression, angleUnit) => {
      requested.push({ expression, angleUnit });
      return Promise.resolve({ status: 'stopped', reason: 'budget', coordinateAuthorized: false });
    },
  };
  for (const [source] of EVALUATIONS) {
    await executeExactMathWorkRequest(createMathWorkEnvelope(1, request(source)), { backend, engine: recorder, shouldStop: () => undefined });
  }
  const results = calculate(requested);
  requested.forEach((payload, index) => { calculated.set(JSON.stringify(payload), results[index]); });
}, 120_000);

describe('新規演算15件を登録し、既存の演算IDと見出しを変えない', () => {
  it('計画MC-10の15件をID・見出し・引数数・担当タスクのとおり登録し、状態は計算しない・実装済みのどちらかにする', () => {
    expect(EXTENDED_OPERATION_DEFINITIONS.map(value => [value.id, value.head, value.minimumArguments, value.maximumArguments, value.task]))
      .toEqual(EXPECTED);
    for (const value of EXTENDED_OPERATION_DEFINITIONS) {
      expect(['pending', 'implemented']).toContain(value.status);
      expect(CANDIDATE_MATH_BY_ID.get(value.id)).toEqual({ id: value.id, engineHead: value.head,
        minimumArguments: value.minimumArguments, maximumArguments: value.maximumArguments, structural: undefined, pure: true });
      expect(CANDIDATE_MATH_OPERATIONS.get(value.head)?.id).toBe(value.id);
    }
    expect([...EXTENDED_OPERATION_IDS]).toEqual(EXPECTED.map(([id]) => id));
  });
  it('既存292件のIDと見出しを1件も変えない', () => {
    expect(EXISTING_OPERATIONS).toHaveLength(292);
    for (const [id, head] of EXISTING_OPERATIONS) expect(CANDIDATE_MATH_BY_ID.get(id)?.engineHead, id).toBe(head);
  });
  it('新規のIDと見出しは既存の演算と重ならず、見出しの小文字も登録全体で一意にする', () => {
    const ids = new Set(EXISTING_OPERATIONS.map(([id]) => id));
    const heads = new Set(EXISTING_OPERATIONS.map(([, head]) => head.toLowerCase()));
    for (const value of EXTENDED_OPERATION_DEFINITIONS) {
      expect(ids.has(value.id), value.id).toBe(false);
      expect(heads.has(value.head.toLowerCase()), value.head).toBe(false);
    }
    const lower = [...CANDIDATE_MATH_OPERATIONS.keys()].map(head => head.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    expect(CANDIDATE_MATH_BY_ID.size).toBe(CANDIDATE_MATH_OPERATIONS.size);
  });
});

describe('新規演算を通常入力・構造入力で読み、保存し、表記を往復する', () => {
  it.each(EXAMPLES)('%s: %s を見出しの小文字の関数として読む', (id, source, count) => {
    const node = text(source);
    expect(node).toMatchObject({ kind: 'operation', operation: id });
    expect(node.kind === 'operation' ? node.operands : []).toHaveLength(count);
    expect(pendingExtendedOperations(node).map(value => value.id)).toEqual(pendingOnly(id));
  });
  it('全微分の関数は局所変数を束縛し、位置と増分を順序どおりの一覧として保つ', () => {
    expect(text(TOTAL_DIFFERENTIAL)).toMatchObject({ kind: 'operation', operation: 'total-differential-at', operands: [
      { kind: 'binder', operation: 'lambda', bindings: [{ variable: { role: 'bound', label: 'x' } }, { variable: { role: 'bound', label: 'y' } }] },
      { kind: 'operation', operation: 'list', operands: [{ decimal: '1' }, { decimal: '2' }] },
      { kind: 'operation', operation: 'list', operands: [{ operation: 'divide' }, { operation: 'divide' }] },
    ] });
  });
  it.each(EXPECTED)('%s(%s)は引数が%i〜%i個の範囲外なら読まない', (_id, head, minimum, maximum) => {
    const call = (count: number): string => `${head.toLowerCase()}(${Array.from({ length: count }, (_, index) => String(index + 1)).join(',')})`;
    expect(problem(() => text(call(minimum - 1))).code).toBe('syntax');
    expect(problem(() => text(call(maximum + 1))).code).toBe('syntax');
  });
  it.each(EXAMPLES)('%s: %s を保存形式から復元し、ファイルの読込みでも同じ定義にする', (_id, source) => {
    for (const notation of ['text', 'latex'] as const) {
      const visible = notation === 'text' ? source : latex(text(source));
      const expression = notation === 'text' ? text(visible) : fromLatex(visible);
      const stored: StoredMathExpression = { format: MATH_INPUT_FORMAT, source: visible, inputNotation: notation, angleUnit: 'radian', expression };
      const saved: unknown = JSON.parse(JSON.stringify(stored));
      expect(decodeStoredMath(saved, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
        parseSource: (value, kind) => kind === 'text' ? text(value) : fromLatex(value) })).toEqual(stored);
      expect(decodeMathExpressionStorage(saved, visible)).toEqual(stored);
    }
  });
  it.each(EXAMPLES)('%s: %s を通常入力と構造入力の間で意味を変えずに往復する', (_id, source) => {
    const original = text(source);
    const structured = convertMathNotation(original, latex, fromLatex);
    const plain = convertMathNotation(structured.expression, node => formatMathText(node, CANDIDATE_MATH_BY_ID), text);
    expect(sameMathMeaning(original, plain.expression)).toBe(true);
    expect(pendingExtendedOperations(structured.expression)).toEqual(pendingExtendedOperations(original));
  });
});

describe('実装前の新規演算は、0倍・成分選択・場合分けの中でも値にしない', () => {
  it.each(EVALUATIONS)('%s は、%s を計算しない間は通常の計算でも未対応とし、値や候補にしない', (source, id) => {
    const input = request(source);
    const { definition, evaluation } = decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend),
      input, context()).result;
    expect(definition?.source).toBe(source);
    if (PENDING.has(id)) expect(evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
  it.each(EVALUATIONS)('%s は、%s を計算しない間は追加計算部でも演算名を示して未対応とし、0へ簡約しない', async (source, id) => {
    const input = request(source);
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { backend, engine: replay, shouldStop: () => undefined });
    const { evaluation } = decodeMathWorkReply(reply, input, context()).result;
    // Once implemented, the result must at least stop calling the operation unimplemented.
    if (PENDING.has(id)) expect(evaluation).toEqual(pendingReply(id));
    else expect(evaluation).not.toEqual(pendingReply(id));
  });
  it('準備処理は計算しない演算を成分の選択・数の検査・条件の判定より前に演算名付きで拒否し、選ばれない枝は従来どおり計算しない', () => {
    const prepare = (source: string) => prepareMathCalculation(text(source), { resolve: () => null, angleUnit: 'radian' });
    for (const [source, id] of [['component([plusminus(1,2),5],2)', 'plus-minus'], ['gamma(plusminus(3,1))', 'plus-minus'],
      ['which(approxequal(1,1.05,0.1),1,true,1)', 'approximately-equal'], ['component(identitymatrix(3),1,1)', 'identity-matrix']] as const) {
      if (!PENDING.has(id)) continue;
      const rejected = problem(() => prepare(source));
      expect([rejected.code, rejected.message]).toEqual(['unsupported', pendingReply(id).detail]);
    }
    expect(prepare('which(1<2,3,2<1,plusminus(1,2))')).toEqual({ status: 'ready', expression: { kind: 'number', decimal: '3' } });
  });
  it('選ばれない場合分けの枝は従来どおり計算せず、選んだ枝の値を返す', async () => {
    const input = request('which(1<2,3,2<1,plusminus(1,2))');
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { backend, engine: replay, shouldStop: () => undefined });
    expect(decodeMathWorkReply(reply, input, context()).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
  });
  it('追加計算部の未対応だけを演算名付きの理由に変え、返信の形式と他の理由は従来どおり検査する', () => {
    const unsupported = { status: 'invalid', reason: 'unsupported', coordinateAuthorized: false };
    const both = text('0*plusminus(1,2)+cardinality({1})'), named = pendingOnly('plus-minus', 'cardinality');
    if (named.length === 0) expect(decodeExactMathResult(unsupported, both, context())).toEqual(unsupported);
    else {
      const pending = problem(() => decodeExactMathResult(unsupported, both, context()));
      expect(pending.code).toBe('unsupported');
      expect(pending.message).toBe(pendingReply(...named).detail);
    }
    expect(decodeExactMathResult(unsupported, text('1+2'), context())).toEqual(unsupported);
    expect(decodeExactMathResult({ ...unsupported, reason: 'domain' }, text('1/0+plusminus(1,2)'), context()))
      .toEqual({ ...unsupported, reason: 'domain' });
    expect(problem(() => decodeExactMathResult({ ...unsupported, coordinateAuthorized: true }, text('plusminus(1,2)'), context())).code)
      .toBe('syntax');
    expect(problem(() => decodeExactMathResult({ ...unsupported, detail: 'x' }, text('plusminus(1,2)'), context())).code).toBe('syntax');
  });
  it('束縛変数の本体・範囲・集合の中の未実装演算も登録順に見つける', () => {
    expect(pendingExtendedOperations(text('sum(plusminus(i,1),i,1,cardinality({1,2}))')).map(value => value.id))
      .toEqual(pendingOnly('plus-minus', 'cardinality'));
    expect(pendingExtendedOperations(text('forall(x,complement({1},{1,2}),x==x)')).map(value => value.id))
      .toEqual(pendingOnly('complement'));
    expect(pendingExtendedOperations(text('totaldifferentialat(Function(minusplus(x)*y,x,y),[1,2],[1,1])')).map(value => value.id))
      .toEqual(pendingOnly('minus-plus', 'total-differential-at'));
    expect(pendingExtendedOperationMessage(text('1+2'))).toBeNull();
  });
});

describe('新規演算の結果の型から「·」「×」の意味を決める', () => {
  it.each([
    ['{1,2}×{3,4}', 'cartesian-product'], ['interval(0,1)×ℝ', 'cartesian-product'],
    ['complement({1},{1,2})×cartesianproduct({1},{2})', 'cartesian-product'], ['{1}×{2}×{3}', 'cartesian-product'],
  ])('集合同士の%sは%sとして読む', (source, operation) => {
    expect(text(source)).toMatchObject({ kind: 'operation', operation });
  });
  it.each(['{1,2}·{3,4}', '{1,2}×2', 'ℝ×[1,2]', 'subset({1},{1,2})×2', 'approxequal(1,1,0.1)·2'])(
    '%s は型が合わないため掛け算・内積・直積のどれにも推測しない', source => {
      expect(problem(() => text(source)).code).toBe('unsupported');
    });
  it.each([
    ['2·plusminus(1,2)', 'plus-minus', 'multiply'], ['minusplus(1,2)×2', 'minus-plus', 'multiply'],
    ['3·cardinality({1,2})', 'cardinality', 'multiply'], [`${TOTAL_DIFFERENTIAL}×2`, 'total-differential-at', 'multiply'],
    ['[1,2]·projection([1,2],[3,4])', 'projection', 'dot'], ['component(identitymatrix(3),1)·[1,2,3]', 'identity-matrix', 'dot'],
    ['component(zeromatrix(2,3),2)·[1,2,3]', 'zero-matrix', 'dot'],
  ])('%s は、%s を計算しない間は結果の型を使わず積を推測せず、実装後は%sとして読む', (source, id, operation) => {
    if (PENDING.has(id)) expect(problem(() => text(source)).code).toBe('unsupported');
    else expect(text(source)).toMatchObject({ kind: 'operation', operation });
  });
  it('実装済みにした演算だけが結果の型で「·」「×」を決め、形が合わなければ推測しない', async () => {
    vi.resetModules();
    vi.doMock('./mathExtendedOperations.js', async importOriginal => {
      const actual = await importOriginal<typeof import('./mathExtendedOperations.js')>();
      return { ...actual, EXTENDED_OPERATION_DEFINITIONS: actual.EXTENDED_OPERATION_DEFINITIONS
        .map(value => ({ ...value, status: 'implemented' as const })) };
    });
    try {
      const { resolveTypedMathProduct } = await import('./mathProductTypes.js');
      const resolve = (token: 'times' | 'dot', left: string, right: string) =>
        resolveTypedMathProduct(token, [text(left), text(right)], () => true);
      expect([
        resolve('dot', '2', 'plusminus(1,2)'), resolve('times', 'minusplus(1,2)', '2'), resolve('dot', '3', 'cardinality({1,2})'),
        resolve('times', TOTAL_DIFFERENTIAL, '2'), resolve('dot', '[1,2]', 'projection([1,2],[3,4])'),
        resolve('times', 'projection([1,2,3],[0,0,1])', '[1,0,0]'), resolve('dot', 'component(identitymatrix(3),1)', '[1,2,3]'),
        resolve('dot', 'component(zeromatrix(2,3),2)', '[1,2,3]'), resolve('dot', 'component(zeromatrix(2),1)', '[1,2]'),
      ]).toEqual(['multiply', 'multiply', 'multiply', 'multiply', 'dot', 'cross', 'dot', 'dot', 'dot']);
      expect([
        resolve('dot', '[1,2]', 'projection([1,2,3],[1,2,3])'), resolve('dot', 'projection([1,2],[3,4,5])', '[1,2]'),
        resolve('dot', 'component(zeromatrix(2,3),1)', '[1,2]'), resolve('dot', 'component(identitymatrix(2.5),1)', '[1,2]'),
        resolve('dot', 'component(identitymatrix(0),1)', '[1]'), resolve('times', 'plusminus([1,2],3)', '2'),
        resolve('times', 'subset({1},{1,2})', '2'), resolve('dot', 'approxequal(1,1,0.1)', '2'),
      ]).toEqual([null, null, null, null, null, null, null, null]);
    } finally {
      vi.doUnmock('./mathExtendedOperations.js');
      vi.resetModules();
    }
  });
});

describe('追加計算部の拒否一覧と振り分け表を登録表と一致させる', () => {
  const casInput = readFileSync(new URL('cas_input.py', runtime), 'utf8');
  const dispatch = readFileSync(new URL('cas_extended_dispatch.py', runtime), 'utf8');
  /** Each task's module, connected through cas_extended_dispatch.py and shipped by localExactMathEngine.ts. */
  const MODULES = [['cas_cardinality', 'MC-12'], ['cas_vector_projection', 'MC-16'], ['cas_matrix_constructors', 'MC-18'],
    ['cas_set_relations', 'MC-23'], ['cas_logic_extended', 'MC-24']] as const;
  const modules = new Map(MODULES.map(([name]) => [name, readFileSync(new URL(`${name}.py`, runtime), 'utf8')]));
  it('cas_input.pyは全ての新規演算を子の復号より前に振り分けへ渡し、量化の束縛も振り分けへ渡す', () => {
    expect(casInput).toMatch(/^from cas_extended_dispatch import OPERATIONS as EXTENDED, extended_operation, quantifier\r?$/mu);
    expect(casInput).toMatch(/^ {8}if operation in EXTENDED:\r?\n {12}return extended_operation\(self, operation, operands, scope, depth, fields, reference_key, CasInputProblem\)\r?$/mu);
    expect(casInput).toMatch(/^ {8}if operation in \('for-all', 'exists'\):\r?\n {12}return quantifier\(self, value, outer_scope, depth, fields, reference_key, CasInputProblem\)\r?$/mu);
    const route = casInput.indexOf('        if operation in EXTENDED:'), which = casInput.indexOf("        if operation == 'which':");
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(which);
  });
  it('cas_extended_dispatch.pyの表はID・引数数・担当タスクが登録表と一致する', () => {
    const table = [...dispatch.matchAll(/^ {4}'([a-z-]+)': \((\d+), (\d+), '(MC-\d+)'\),$/gmu)]
      .map(match => [match[1], Number(match[2]), Number(match[3]), match[4]]);
    expect(table).toEqual(EXTENDED_OPERATION_DEFINITIONS.map(value => [value.id, value.minimumArguments, value.maximumArguments, value.task]));
  });
  it('変更した計算用ファイルは全ての改行をCRLFにしても配布時の読込み上限内にある', () => {
    // The loader's 32,768-character limit is asserted against the shipped list by localExactMathSources.test.ts.
    // A Windows checkout can turn every line break into CRLF, so check that worst case here as well.
    for (const source of [casInput, dispatch, ...modules.values()]) {
      expect(source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n').length).toBeLessThanOrEqual(32_768);
    }
  });
  it('振り分けは各タスクのモジュールの実装だけを集め、計算しない演算を未対応とし、引数の数を確かめ、接続した実装と量化だけを呼ぶ', () => {
    const operations = Object.fromEntries(EXTENDED_OPERATION_DEFINITIONS.map(value => [value.id, [value.task, value.status]]));
    const script = [
      'import json, sys',
      'sys.dont_write_bytecode = True',
      `sys.path.insert(0, ${JSON.stringify(fileURLToPath(runtime))})`,
      'import cas_extended_dispatch as dispatch',
      ...MODULES.map(([name]) => `import ${name}`),
      `OPERATIONS = json.loads(${JSON.stringify(JSON.stringify(operations))})`,
      `TASKS = ${JSON.stringify(Object.fromEntries(MODULES))}`,
      `TABLES = {${MODULES.map(([name]) => `'${name}': ${name}.IMPLEMENTATIONS`).join(', ')}}`,
      'class Problem(Exception):',
      '    def __init__(self, code, detail):',
      '        super().__init__(detail)',
      '        self.code = code',
      'def attempt(operation, count):',
      '    try:',
      '        return dispatch.extended_operation(None, operation, [None] * count, {}, 0, None, None, Problem)',
      '    except Problem as error:',
      '        return error.code',
      'def quantify(operation):',
      '    if operation in dispatch.QUANTIFIERS:',
      "        return 'connected'",
      '    try:',
      "        return dispatch.quantifier(None, {'operation': operation}, {}, 0, None, None, Problem)",
      '    except Problem as error:',
      '        return error.code',
      'owners = {}',
      'for name, table in TABLES.items():',
      '    for key in table:',
      '        owners.setdefault(key, []).append(name)',
      "pending = [key for key, value in OPERATIONS.items() if value[1] == 'pending' and key not in dispatch.IMPLEMENTATIONS]",
      'report = {',
      "    'wrongTask': sorted(key for name, table in TABLES.items() for key in table if OPERATIONS.get(key, [None])[0] != TASKS[name]),",
      "    'duplicated': sorted(key for key, names in owners.items() if len(names) > 1),",
      "    'unmarked': sorted(key for key in owners if OPERATIONS.get(key, [None, None])[1] != 'implemented'),",
      "    'merged': sorted(dispatch.IMPLEMENTATIONS) == sorted(owners),",
      "    'pendingNotRejected': sorted(key for key in pending if attempt(key, dispatch.OPERATIONS[key][0]) != 'unsupported'),",
      "    'unknownQuantifiers': sorted(set(dispatch.QUANTIFIERS) - {'for-all', 'exists'}),",
      "    'quantifiersNotRejected': sorted(name for name in ('for-all', 'exists') if quantify(name) not in ('unsupported', 'connected')),",
      "    'checks': {'projection-too-few': attempt('projection', 1), 'product-too-many': attempt('cartesian-product', 17),",
      "               'not-registered': attempt('add', 2)},",
      '}',
      "dispatch.IMPLEMENTATIONS['subset'] = lambda decoder, operation, operands, *rest: operation + str(len(operands))",
      "dispatch.QUANTIFIERS['exists'] = lambda decoder, value, *rest: 'quantified ' + value['operation']",
      "report['checks']['connected'] = attempt('subset', 2)",
      "report['checks']['quantified'] = dispatch.quantifier(None, {'operation': 'exists'}, {}, 0, None, None, Problem)",
      'print(json.dumps(report))',
    ].join('\n');
    const result = spawnExactRuntime(['-B', '-X', 'utf8', '-'], { input: script, encoding: 'utf8', timeout: 60_000, env: pythonEnvironment });
    if (result.error !== undefined || result.status !== 0) throw new Error(`振り分けの確認に失敗しました。\n${result.stderr}`);
    const decoded: unknown = JSON.parse(result.stdout);
    expect(decoded).toEqual({ wrongTask: [], duplicated: [], unmarked: [], merged: true, pendingNotRejected: [], unknownQuantifiers: [],
      quantifiersNotRejected: [], checks: { 'projection-too-few': 'syntax', 'product-too-many': 'syntax', 'not-registered': 'syntax',
        connected: 'subset2', quantified: 'quantified exists' } });
  });
});

describe('TypeScriptで計算する後続タスクの接続口', () => {
  async function preparation(implemented: boolean): Promise<typeof prepareMathCalculation> {
    vi.resetModules();
    vi.doMock('./mathExtendedOperations.js', async importOriginal => {
      const actual = await importOriginal<typeof import('./mathExtendedOperations.js')>();
      return { ...actual, EXTENDED_OPERATION_DEFINITIONS: actual.EXTENDED_OPERATION_DEFINITIONS.map(value =>
        value.id === 'total-differential-at' ? { ...value, status: implemented ? 'implemented' as const : 'pending' as const } : value) };
    });
    // A stand-in rewrite: the value 7, or the same operation again when the first coordinate is 99.
    vi.doMock('./totalDifferential.js', () => ({ LOWERINGS: {
      'total-differential-at': (node: Extract<MathNode, { kind: 'operation' }>): MathNode => {
        const point = node.operands[1], first = point?.kind === 'operation' ? point.operands[0] : undefined;
        return first?.kind === 'number' && first.decimal === '99' ? node : { kind: 'number', decimal: '7' };
      } } }));
    try {
      return (await import('./prepareMathCalculation.js')).prepareMathCalculation;
    } finally {
      vi.doUnmock('./mathExtendedOperations.js');
      vi.doUnmock('./totalDifferential.js');
    }
  }
  it('置き換え表は全微分（MC-30）の演算だけを持つ', () => {
    for (const id of Object.keys(TOTAL_DIFFERENTIAL_LOWERINGS)) {
      expect(EXTENDED_OPERATION_DEFINITIONS.find(value => value.id === id)?.task, id).toBe('MC-30');
    }
  });
  it('実装済みにした演算だけ、置き換えが他の準備より前に束縛や集合の中まで効き、同じ演算へ戻る置き換えは拒否する', async () => {
    try {
      const settings = { resolve: () => null, angleUnit: 'radian' as const };
      const implemented = await preparation(true);
      expect(implemented(text(TOTAL_DIFFERENTIAL), settings)).toEqual({ status: 'ready', expression: { kind: 'number', decimal: '7' } });
      expect(implemented(text(`{${TOTAL_DIFFERENTIAL}}`), { ...settings, deferSets: true }))
        .toEqual({ status: 'ready', expression: { kind: 'operation', operation: 'set', operands: [{ kind: 'number', decimal: '7' }] } });
      expect(implemented(text(`sum(${TOTAL_DIFFERENTIAL}*i,i,1,2)`), settings)).toMatchObject({ status: 'ready',
        expression: { kind: 'binder', operation: 'sum', body: { operation: 'multiply', operands: [{ decimal: '7' }, { kind: 'symbol' }] } } });
      // The freshly imported modules have their own MathInputProblem class, so compare the problem code.
      const codeOf = (action: () => unknown): unknown => {
        try { action(); } catch (error) { return error !== null && typeof error === 'object' && 'code' in error ? error.code : error; }
        return '例外なし';
      };
      expect(codeOf(() => implemented(text('totaldifferentialat(Function(x,x),[99],[1])'), settings))).toBe('syntax');
      const pending = await preparation(false);
      expect(codeOf(() => pending(text(TOTAL_DIFFERENTIAL), settings))).toBe('unsupported');
    } finally {
      vi.resetModules();
    }
  });
});
