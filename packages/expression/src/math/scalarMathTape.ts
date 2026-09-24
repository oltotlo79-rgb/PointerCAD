import { besselKind, type BesselKind } from './besselFunctions.js';
import { besselSample } from './besselScalar.js';
import { airyFunction } from './airyFunctions.js';
import { zetaOrder,zetaDerivativeOrder } from './zetaFunctions.js';
import { zetaSample } from './zetaIntervals.js';
import type { AiryKind } from './airyNumeric.js';
import { airySample } from './airyIntervals.js';
import { lambertWSample } from './lambertWIntervals.js';
import type { EllipticKind } from './ellipticNumeric.js';
import { ellipticMidpoint } from './ellipticIntervals.js';
import { ellipticOperation,ellipticPartialValue } from './ellipticPartials.js';
import { realLambertBranch } from './lambertWFunctions.js';
import type { RealLambertBranch } from './lambertWNumeric.js';
/** Compile a scalar geometry expression once. This VM never generates JavaScript source. */
import { MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';
import { engineSymbolOf } from './mathSymbolScope.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';
import { exactDegreeTrig } from './exactDegreeTrig.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';
import type { MathInterval } from './mathInterval.js';
import { lowerReciprocalHyperbolic } from './hyperbolicOperations.js';
import { normalizeElementaryOperation } from './elementaryMathNormalization.js';
import { validateElementaryDomains } from './elementaryMathDomains.js';
import { validateMathDomains } from './realRootDomains.js';
import { lowerLegendrePolynomial } from './legendrePolynomial.js';
import { errorFunctionSample } from './errorFunctionIntervals.js';
import { gammaFunctionSample } from './gammaFunctionIntervals.js';
import { betaFunctionSample } from './betaFunctionIntervals.js';
import { polygammaSample } from './polygammaIntervals.js';
import { MAX_POLYGAMMA_ORDER } from './polygammaCoefficients.js';

export type ScalarInput = 'X' | 'Y' | 'Z' | 'T' | 'U' | 'V';
type Unary = 'negate' | 'sqrt' | 'absolute' | 'sign' | 'floor' | 'ceiling' | 'square'
  | 'exponential' | 'natural-log' | 'log-two' | 'log-ten' | 'sin' | 'cos' | 'tan'
  | 'cot' | 'sec' | 'csc' | 'arcsin' | 'arccos' | 'arctan' | 'sinh' | 'cosh' | 'tanh'
  | 'arsinh' | 'arcosh' | 'artanh' | 'erf' | 'erfc' | 'gamma';
type Binary = 'subtract' | 'divide' | 'power' | 'root' | 'log-base' | 'beta';
type Variadic = 'add' | 'multiply' | 'minimum' | 'maximum';
export type ScalarComparison = 'equal' | 'not-equal' | 'less' | 'less-equal' | 'greater' | 'greater-equal';
export type ScalarCondition =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'not'; readonly operand: ScalarCondition }
  | { readonly kind: 'and'; readonly operands: readonly ScalarCondition[] }
  | { readonly kind: 'or'; readonly operands: readonly ScalarCondition[] }
  | { readonly kind: 'comparison'; readonly operation: ScalarComparison; readonly operands: readonly ScalarTape[];
      readonly dynamic: boolean };
export interface ScalarConditionValue { readonly truth: boolean | null; readonly boundary: boolean }
export interface ScalarPiecewiseBranch { readonly condition: ScalarCondition; readonly value: ScalarTape }
type Instruction =
  | { readonly kind: 'piecewise'; readonly branches: readonly ScalarPiecewiseBranch[]; readonly interior: boolean;
      /** No unconditional operands: older derivative consumers conservatively return unknown. */
      readonly operation: 'which'; readonly values: readonly [] }
  | { readonly kind: 'constant'; readonly value: number; readonly enclosure: MathInterval | null }
  | { readonly kind: 'input'; readonly slot: number }
  | { readonly kind: 'unary'; readonly operation: Unary; readonly value: number }
  | { readonly kind: 'polygamma'; readonly order: number; readonly value: number }
  | { readonly kind: 'bessel'; readonly family: BesselKind; readonly order: number; readonly value: number }
  | { readonly kind: 'airy'; readonly family: AiryKind; readonly prime: boolean; readonly value: number }
  | { readonly kind: 'zeta'; readonly order: number; readonly value: number }
  | { readonly kind: 'lambertw'; readonly branch: RealLambertBranch; readonly value: number }
  | { readonly kind: 'elliptic'; readonly family: EllipticKind; readonly orders:readonly number[]; readonly values: readonly number[] }
  | { readonly kind: 'binary'; readonly operation: Binary; readonly left: number; readonly right: number;
      readonly negativeConstantRootAllowed: boolean }
  | { readonly kind: 'rational-power'; readonly base: number; readonly exponent: number;
      readonly exact: ExactRational; readonly sign: -1 | 0 | 1; readonly oddNumerator: boolean; readonly oddDenominator: boolean }
  | { readonly kind: 'variadic'; readonly operation: Variadic; readonly values: readonly number[] };

const UNARY: ReadonlySet<string> = new Set<Unary>(['negate', 'sqrt', 'absolute', 'sign', 'floor', 'ceiling', 'square',
  'exponential', 'natural-log', 'log-two', 'log-ten', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh', 'erf', 'erfc', 'gamma']);
const BINARY: ReadonlySet<string> = new Set<Binary>(['subtract', 'divide', 'power', 'root', 'log-base', 'beta']);
const VARIADIC: ReadonlySet<string> = new Set<Variadic>(['add', 'multiply', 'minimum', 'maximum']);
function unaryOf(value: string): value is Unary { return UNARY.has(value); }
function binaryOf(value: string): value is Binary { return BINARY.has(value); }
function variadicOf(value: string): value is Variadic { return VARIADIC.has(value); }

export interface ScalarTape {
  readonly inputs: readonly ScalarInput[];
  readonly instructions: readonly Instruction[];
  readonly output: number;
  readonly angleUnit: 'degree' | 'radian';
  /** Original domains and differentiability obligations retained after symbolic rewriting. */
  readonly domainGuards?: readonly number[];
}

export interface ScalarCompileOptions {
  readonly inputs: readonly ScalarInput[];
  readonly angleUnit: 'degree' | 'radian';
  /** In the math Worker: high-precision evaluation, followed by explicit finite-real conversion. */
  readonly evaluateConstant: (expression: MathNode) => number;
  readonly resolveExactSymbol?: (node: Extract<MathNode, { kind: 'symbol' }>) => ExactRational | null;
  readonly domainGuards?: readonly MathNode[];
}

function dynamicName(reference: MathSymbolReference): ScalarInput | null {
  return reference.role === 'axis' || reference.role === 'parameter' ? reference.name : null;
}

export function compileScalarMath(expression: MathNode, options: ScalarCompileOptions): ScalarTape {
  return compileTape(expression, options, { remaining: 4096 }, 0);
}

/** Compile a domain predicate with exactly the same grammar and budgets as which. */
export function compileScalarCondition(expression: MathNode, options: Omit<ScalarCompileOptions, 'domainGuards'>): ScalarCondition {
  const tape = compileScalarMath({ kind: 'operation', operation: 'which',
    operands: [expression, { kind: 'number', decimal: '0' }] }, options);
  const selection = tape.instructions[tape.output];
  if (selection.kind !== 'piecewise' || selection.branches.length !== 1) {
    throw new MathInputProblem('unsupported', '作図範囲の条件を確定できません。');
  }
  return selection.branches[0].condition;
}

function compileTape(expression: MathNode, options: ScalarCompileOptions, budget: { remaining: number }, depth: number): ScalarTape {
  if (depth > 64) throw new MathInputProblem('budget', '場合分けの式の入れ子が深すぎます。');
  if (new Set(options.inputs).size !== options.inputs.length) throw new MathInputProblem('syntax', '変数の指定が重複しています。');
  const instructions: Instruction[] = [];
  const dynamic = new Map<MathNode, boolean>();
  const emitted = new Map<MathNode, number>();
  const inputSlots = new Map(options.inputs.map((name, index) => [name, index]));
  const sharedInputs = new Map<string, number>();
  function depends(node: MathNode): boolean {
    const previous = dynamic.get(node);
    if (previous !== undefined) return previous;
    let result = false;
    if (node.kind === 'symbol') result = dynamicName(node.reference) !== null;
    else if (node.kind === 'operation') result = node.operands.some(depends);
    else if (node.kind === 'binder') {
      result = depends(node.body) || node.bindings.some(binding => {
        if (binding.domain.kind === 'unrestricted') return false;
        if (binding.domain.kind === 'set') return depends(binding.domain.value);
        return depends(binding.domain.lower) || depends(binding.domain.upper)
          || (binding.domain.step !== null && depends(binding.domain.step));
      });
    }
    dynamic.set(node, result);
    return result;
  }
  function append(instruction: Instruction): number {
    if (--budget.remaining < 0) throw new MathInputProblem('budget', '作図する数式が複雑すぎます。');
    instructions.push(instruction);
    return instructions.length - 1;
  }
  function child(node: MathNode): ScalarTape {
    return compileTape(node, { ...options, domainGuards: [] }, budget, depth + 1);
  }
  function constantValue(node: MathNode): number | null {
    try { return options.evaluateConstant(node); }
    catch (error) {
      if (depth === 0 || !(error instanceof MathInputProblem) || error.code !== 'domain') throw error;
      // A failed conversion may mean unresolved, not outside the domain. Only a
      // separate proof of invalid arithmetic permits an empty branch enclosure.
      // Do not use an inactive nested which branch as such a proof.
      const pending = [node];
      while (pending.length > 0) {
        const value = pending.pop();
        if (value?.kind === 'operation') {
          if (value.operation === 'which' || value.operation === 'which-derivative') throw error;
          pending.push(...value.operands);
        } else if (value?.kind === 'binder') throw error;
      }
      try { validateElementaryDomains(node, options.angleUnit); validateMathDomains(node); }
      catch (proof) {
        if (proof instanceof MathInputProblem && proof.code === 'domain') return null;
        throw proof;
      }
      throw error;
    }
  }
  function condition(node: MathNode, level = 0): ScalarCondition {
    if (--budget.remaining < 0 || level > 64) throw new MathInputProblem('budget', '場合分けの条件が複雑すぎます。');
    if (node.kind === 'constant' && (node.name === 'true' || node.name === 'false')) {
      return { kind: 'boolean', value: node.name === 'true' };
    }
    if (node.kind === 'operation') {
      if (node.operation === 'not' && node.operands.length === 1) return { kind: 'not', operand: condition(node.operands[0], level + 1) };
      if ((node.operation === 'and' || node.operation === 'or') && node.operands.length >= 2) {
        return { kind: node.operation, operands: node.operands.map(value => condition(value, level + 1)) };
      }
      const operation = node.operation;
      if (node.operands.length >= 2 && (operation === 'equal' || operation === 'not-equal' || operation === 'less'
          || operation === 'less-equal' || operation === 'greater' || operation === 'greater-equal')) {
        return { kind: 'comparison', operation, operands: node.operands.map(child), dynamic: node.operands.some(depends) };
      }
    }
    throw new MathInputProblem('unsupported', '場合分けの条件には比較、かつ、または、否定を指定してください。');
  }
  function emit(node: MathNode): number {
    const existing = emitted.get(node);
    if (existing !== undefined) return existing;
    if (node.kind === 'operation' && (node.operation === 'which' || node.operation === 'which-derivative')) {
      if (node.operands.length < 2 || node.operands.length % 2 !== 0) {
        throw new MathInputProblem('syntax', '場合分けは条件と値を対で指定してください。');
      }
      const branches: ScalarPiecewiseBranch[] = [];
      for (let index = 0; index < node.operands.length; index += 2) {
        branches.push({ condition: condition(node.operands[index]), value: child(node.operands[index + 1]) });
      }
      // Keep dependencies visible to consumers that inspect only the outer tape.
      const pending = [...node.operands];
      while (pending.length > 0) {
        const value = pending.pop();
        if (value?.kind === 'symbol' && dynamicName(value.reference) !== null) emit(value);
        else if (value?.kind === 'operation') pending.push(...value.operands);
      }
      const index = append({ kind: 'piecewise', operation: 'which', values: [], branches, interior: node.operation === 'which-derivative' });
      emitted.set(node, index);
      return index;
    }
    // An undecided which bypasses global preparation; retain the same scalar
    // aliases inside and around its branches without selecting vector components.
    if (node.kind === 'operation' && ['reciprocal', 'arccot', 'arcsec', 'arccsc', 'clamp'].includes(node.operation)) {
      const index = emit(normalizeElementaryOperation(node, options.angleUnit));
      emitted.set(node, index);
      return index;
    }
    const polynomial = lowerLegendrePolynomial(node);
    if (polynomial !== null) {
      const index = emit(polynomial);
      emitted.set(node, index);
      return index;
    }
    const hyperbolic = lowerReciprocalHyperbolic(node);
    if (hyperbolic !== null) {
      const index = emit(hyperbolic);
      emitted.set(node, index);
      return index;
    }
    let index: number;
    const constant = !depends(node), exact = constant ? rationalOfExpression(node, options.resolveExactSymbol) : null;
    // Keep elementary operations when their result is irrational. A rounded sample is not an exact enclosure.
    const retainOperation = constant && exact === null && node.kind === 'operation'
      && (unaryOf(node.operation) || binaryOf(node.operation) || variadicOf(node.operation) || node.operation === 'polygamma' || node.operation === 'lambertw' || node.operation==='zetaderivative' || airyFunction(node.operation) !== null || besselKind(node.operation) !== null || ellipticOperation(node.operation) !== null || zetaOrder(node.operation) !== null);
    if (constant && !retainOperation) {
      const value = constantValue(node);
      if (value === null) {
        index = append({ kind: 'constant', value: NaN, enclosure: null });
        emitted.set(node, index);
        return index;
      }
      if (!Number.isFinite(value)) throw new MathInputProblem('syntax', '作図式の定数部分は有限の実数にしてください。');
      const enclosure = exact !== null ? exactDoubleInterval(exact) : node.kind === 'constant' && node.name === 'pi'
        ? { lower: 3.141592653589793, upper: 3.1415926535897936 } : node.kind === 'constant' && node.name === 'e'
          ? { lower: 2.718281828459045, upper: 2.7182818284590455 } : null;
      if (enclosure !== null && (value < enclosure.lower || value > enclosure.upper)) {
        throw new MathInputProblem('syntax', '作図式の定数の計算値が、元の式から求めた範囲と一致しません。');
      }
      index = append({ kind: 'constant', value, enclosure });
    } else if (node.kind === 'symbol') {
      const name = dynamicName(node.reference);
      const slot = name === null ? undefined : inputSlots.get(name);
      if (slot === undefined) throw new MathInputProblem('syntax', `変数「${name}」の値または範囲を指定してください。`);
      const key = engineSymbolOf(node.reference);
      index = sharedInputs.get(key) ?? append({ kind: 'input', slot });
      sharedInputs.set(key, index);
    } else if (node.kind === 'operation') {
      if(node.operation==='zetaderivative') {
        const order=node.operands.length===2?zetaDerivativeOrder(node.operands[0]):null;
        if(order===null)throw new MathInputProblem('budget','ゼータ関数の微分の次数を0から17までの整数で確定してください。');
        index=append({kind:'zeta',order,value:emit(node.operands[1])});
        emitted.set(node,index);return index;
      }
      const operands = node.operands.map(emit);
      const exponentNode = node.operands[1];
      const exactExponent = node.operation === 'power' && exponentNode && !depends(exponentNode)
        ? rationalOfExpression(exponentNode, options.resolveExactSymbol) : null;
      const bessel = besselKind(node.operation);
      const airy = airyFunction(node.operation);
      const elliptic = ellipticOperation(node.operation);
      const zeta = zetaOrder(node.operation);
      if(zeta!==null&&operands.length===1) {
        index=append({kind:'zeta',order:zeta,value:operands[0]});
      } else if (elliptic !== null) {
        if(operands.length!==elliptic.orders.length)throw new MathInputProblem('domain','楕円積分の引数の数が一致しません。');
        index = append({ kind: 'elliptic', family: elliptic.family, orders:elliptic.orders, values: operands });
      } else if (airy !== null && operands.length === 1) {
        index = append({ kind: 'airy', family: airy.family, prime: airy.prime, value: operands[0] });
      } else if (node.operation === 'lambertw' && operands.length === 2) {
        index = append({ kind: 'lambertw', branch: realLambertBranch(node.operands[0]), value: operands[1] });
      } else if (bessel !== null && operands.length === 2) {
        const order = rationalOfExpression(node.operands[0], options.resolveExactSymbol);
        if (order === null || order.denominator !== 1n || order.numerator < -128n || order.numerator > 128n) {
          throw new MathInputProblem('unsupported', 'Bessel関数の次数を-128から128までの整数で確定してください。');
        }
        index = append({ kind: 'bessel', family: bessel, order: Number(order.numerator), value: operands[1] });
      } else if (node.operation === 'polygamma' && operands.length === 2) {
        const order = rationalOfExpression(node.operands[0], options.resolveExactSymbol);
        if (order === null || order.denominator !== 1n || order.numerator < 0n || order.numerator > BigInt(MAX_POLYGAMMA_ORDER)) {
          throw new MathInputProblem('domain', 'Gamma関数の微分の次数は0から17までの整数で指定してください。');
        }
        index = append({ kind: 'polygamma', order: Number(order.numerator), value: operands[1] });
      } else if (exactExponent && operands.length === 2 && operands[0] !== undefined && exponentNode) {
        index = append({ kind: 'rational-power', base: operands[0], exponent: options.evaluateConstant(exponentNode),
          exact: exactExponent,
          sign: exactExponent.numerator < 0n ? -1 : exactExponent.numerator === 0n ? 0 : 1,
          oddNumerator: exactExponent.numerator % 2n !== 0n, oddDenominator: exactExponent.denominator % 2n !== 0n });
      } else if (unaryOf(node.operation) && operands.length === 1 && operands[0] !== undefined) {
        index = append({ kind: 'unary', operation: node.operation, value: operands[0] });
      } else if (binaryOf(node.operation) && operands.length === 2 && operands[0] !== undefined && operands[1] !== undefined) {
        const degree=node.operation==='root'&&exponentNode&&!depends(exponentNode)
          ?rationalOfExpression(exponentNode,options.resolveExactSymbol):null;
        index = append({ kind: 'binary', operation: node.operation, left: operands[0], right: operands[1],
          negativeConstantRootAllowed:degree?.denominator===1n&&degree.numerator%2n!==0n });
      } else if (variadicOf(node.operation) && operands.length >= 1) {
        index = append({ kind: 'variadic', operation: node.operation, values: operands });
      } else throw new MathInputProblem('unsupported', `作図中に変化する演算「${node.operation}」の計算方法を確認してください。`);
    } else throw new MathInputProblem('unsupported', '変数を含む積分などは、先に解析した式への変換が必要です。');
    emitted.set(node, index);
    return index;
  }
  const domainGuards = options.domainGuards?.map(emit);
  const output = emit(expression);
  return { inputs: [...options.inputs], instructions, output, angleUnit: options.angleUnit,
    ...(domainGuards === undefined || domainGuards.length === 0 ? {} : { domainGuards }) };
}

function circular(operation: 'sin' | 'cos' | 'tan' | 'cot' | 'sec' | 'csc', value: number,
  toRadians: number, degree: boolean): number {
  const quarter = exactDegreeTrig(value, degree);
  switch (operation) {
    case 'sin': return quarter?.sin ?? Math.sin(value * toRadians);
    case 'cos': return quarter?.cos ?? Math.cos(value * toRadians);
    case 'tan': return quarter === null ? Math.tan(value * toRadians) : quarter.sin / quarter.cos;
    case 'cot': return quarter === null ? 1 / Math.tan(value * toRadians) : quarter.cos / quarter.sin;
    case 'sec': return 1 / (quarter?.cos ?? Math.cos(value * toRadians));
    case 'csc': return 1 / (quarter?.sin ?? Math.sin(value * toRadians));
  }
}
function unary(operation: Unary, value: number, toRadians: number, degree: boolean): number {
  switch (operation) {
    case 'gamma': return gammaFunctionSample(value);
    case 'erf': case 'erfc': return errorFunctionSample(operation, value);
    case 'negate': return -value;
    case 'sqrt': return Math.sqrt(value);
    case 'square': return value * value;
    case 'absolute': return Math.abs(value);
    case 'sign': return Math.sign(value);
    case 'floor': return Math.floor(value);
    case 'ceiling': return Math.ceil(value);
    case 'exponential': return Math.exp(value);
    case 'natural-log': return Math.log(value);
    case 'log-two': return Math.log2(value);
    case 'log-ten': return Math.log10(value);
    case 'sin': case 'cos': case 'tan': case 'cot': case 'sec': case 'csc':
      return circular(operation, value, toRadians, degree);
    case 'arcsin': return Math.asin(value) / toRadians;
    case 'arccos': return Math.acos(value) / toRadians;
    case 'arctan': return Math.atan(value) / toRadians;
    case 'sinh': return Math.sinh(value);
    case 'cosh': return Math.cosh(value);
    case 'tanh': return Math.tanh(value);
    case 'arsinh': return Math.asinh(value);
    case 'arcosh': return Math.acosh(value);
    case 'artanh': return Math.atanh(value);
  }
}
function binary(operation: Binary, left: number, right: number): number {
  switch (operation) {
    case 'beta': return betaFunctionSample(left, right);
    case 'subtract': return left - right;
    case 'divide': return left / right;
    case 'power': return left === 0 && right === 0 ? NaN : left ** right;
    case 'root': return right === 0 ? NaN : left < 0 && Number.isSafeInteger(right) && right % 2 !== 0 ? -((-left) ** (1 / right)) : left ** (1 / right);
    case 'log-base': return left > 0 && right > 0 && right !== 1 ? Math.log(left) / Math.log(right) : NaN;
  }
}

/** Conditions are separate from scalar arithmetic; a root equality is still unsupported. */
export function createScalarConditionSampler(condition: ScalarCondition): (inputs: readonly number[]) => ScalarConditionValue {
  if (condition.kind === 'boolean') return () => ({ truth: condition.value, boundary: false });
  if (condition.kind === 'not') {
    const evaluate = createScalarConditionSampler(condition.operand);
    return inputs => { const result = evaluate(inputs); return { ...result, truth: result.truth === null ? null : !result.truth }; };
  }
  if (condition.kind === 'and' || condition.kind === 'or') {
    const operands = condition.operands.map(createScalarConditionSampler);
    return inputs => {
      let boundary = false;
      for (const evaluate of operands) {
        const result = evaluate(inputs); boundary ||= result.boundary;
        if (result.truth === null) return { truth: null, boundary };
        if (result.truth === (condition.kind === 'or')) return { truth: result.truth, boundary };
      }
      return { truth: condition.kind === 'and', boundary };
    };
  }
  const operands = condition.operands.map(createScalarSampler);
  return inputs => {
    const values = operands.map(evaluate => evaluate(inputs));
    if (values.some(value => !Number.isFinite(value))) return { truth: null, boundary: true };
    let truth = true, boundary = false;
    for (let i = 1; i < values.length; i++) {
      for (let j = condition.operation === 'not-equal' ? 0 : i - 1; j < i; j++) {
        const a = values[j], b = values[i];
        boundary ||= condition.dynamic && a === b;
        truth &&= condition.operation === 'equal' ? a === b : condition.operation === 'not-equal' ? a !== b
          : condition.operation === 'less' ? a < b : condition.operation === 'less-equal' ? a <= b
            : condition.operation === 'greater' ? a > b : a >= b;
      }
    }
    return { truth, boundary };
  };
}

function createPiecewiseSampler(instruction: Extract<Instruction, { kind: 'piecewise' }>): (inputs: readonly number[]) => number {
  const branches = instruction.branches.map(branch => ({ condition: createScalarConditionSampler(branch.condition), value: createScalarSampler(branch.value) }));
  return inputs => {
    for (const branch of branches) {
      const result = branch.condition(inputs);
      if (result.truth === null || instruction.interior && result.boundary) return NaN;
      if (result.truth) return branch.value(inputs);
    }
    return NaN;
  };
}

/** One scratch buffer per sampler; never shared between workers or simultaneous jobs. */
export function createScalarTapeEvaluation(tape: ScalarTape): {
  readonly evaluate: (inputs: readonly number[]) => number; readonly values: Float64Array;
} {
  const values = new Float64Array(tape.instructions.length);
  const piecewise = new Map(tape.instructions.flatMap((instruction, index) => instruction.kind === 'piecewise'
    ? [[index, createPiecewiseSampler(instruction)] as const] : []));
  const degree = tape.angleUnit === 'degree', toRadians = degree ? Math.PI / 180 : 1;
  const evaluate = (inputs: readonly number[]): number => {
    if (inputs.length !== tape.inputs.length || inputs.some(value => !Number.isFinite(value))) return NaN;
    for (let index = 0; index < tape.instructions.length; index += 1) {
      const instruction = tape.instructions[index];
      if (!instruction) return NaN;
      let value: number;
      if (instruction.kind === 'piecewise') value = piecewise.get(index)?.(inputs) ?? NaN;
      else if (instruction.kind === 'constant') value = instruction.value;
      else if (instruction.kind === 'input') value = inputs[instruction.slot] ?? NaN;
      else if (instruction.kind === 'unary') value = unary(instruction.operation, values[instruction.value] ?? NaN, toRadians, degree);
      else if (instruction.kind === 'polygamma') value = polygammaSample(instruction.order, values[instruction.value] ?? NaN);
      else if (instruction.kind === 'bessel') value = besselSample(instruction.family, instruction.order, values[instruction.value] ?? NaN);
      else if (instruction.kind === 'airy') value = airySample(instruction.family, instruction.prime, values[instruction.value] ?? NaN);
      else if (instruction.kind === 'zeta') value = zetaSample(instruction.order, values[instruction.value] ?? NaN);
      else if (instruction.kind === 'lambertw') value = lambertWSample(instruction.branch, values[instruction.value] ?? NaN);
      else if (instruction.kind === 'elliptic') value = ellipticMidpoint(ellipticPartialValue(instruction.family,
        instruction.values.map(index => ({lower:values[index]??NaN,upper:values[index]??NaN})),instruction.orders,degree));
      else if (instruction.kind === 'binary') {
        const left=values[instruction.left]??NaN;
        // A constant exponent without exact rational proof may round to an integer
        // (e.g. 1 + sin(1e-30)). It cannot grant a real branch for a negative base.
        value=left<0&&tape.instructions[instruction.right]?.kind==='constant'
          &&(instruction.operation==='power'||instruction.operation==='root'&&!instruction.negativeConstantRootAllowed)
          ? NaN:binary(instruction.operation,left,values[instruction.right]??NaN);
      }
      else if (instruction.kind === 'rational-power') {
        const base = values[instruction.base] ?? NaN;
        value = base === 0 ? instruction.sign === 1 ? 0 : NaN : base < 0
          ? instruction.oddDenominator ? (instruction.oddNumerator ? -1 : 1) * ((-base) ** instruction.exponent) : NaN
          : base ** instruction.exponent;
      }
      else {
        value = instruction.operation === 'multiply' ? 1 : instruction.operation === 'minimum' ? Infinity : instruction.operation === 'maximum' ? -Infinity : 0;
        for (const operand of instruction.values) {
          const item = values[operand] ?? NaN;
          if (instruction.operation === 'add') value += item;
          else if (instruction.operation === 'multiply') value *= item;
          else if (instruction.operation === 'minimum') value = Math.min(value, item);
          else value = Math.max(value, item);
        }
      }
      if (!Number.isFinite(value)) return NaN;
      values[index] = value;
    }
    return values[tape.output] ?? NaN;
  };
  return { evaluate, values };
}

export function createScalarSampler(tape: ScalarTape): (inputs: readonly number[]) => number {
  return createScalarTapeEvaluation(tape).evaluate;
}
