/** Compile a scalar geometry expression once. This VM never generates JavaScript source. */
import { MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';
import { engineSymbolOf } from './mathSymbolScope.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';
import { exactDegreeTrig } from './exactDegreeTrig.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';
import type { MathInterval } from './mathInterval.js';

export type ScalarInput = 'X' | 'Y' | 'Z' | 'T' | 'U' | 'V';
type Unary = 'negate' | 'sqrt' | 'absolute' | 'sign' | 'floor' | 'ceiling' | 'square'
  | 'exponential' | 'natural-log' | 'log-two' | 'log-ten' | 'sin' | 'cos' | 'tan'
  | 'cot' | 'sec' | 'csc' | 'arcsin' | 'arccos' | 'arctan' | 'sinh' | 'cosh' | 'tanh'
  | 'arsinh' | 'arcosh' | 'artanh';
type Binary = 'subtract' | 'divide' | 'power' | 'root' | 'log-base';
type Variadic = 'add' | 'multiply' | 'minimum' | 'maximum';
type Instruction =
  | { readonly kind: 'constant'; readonly value: number; readonly enclosure: MathInterval | null }
  | { readonly kind: 'input'; readonly slot: number }
  | { readonly kind: 'unary'; readonly operation: Unary; readonly value: number }
  | { readonly kind: 'binary'; readonly operation: Binary; readonly left: number; readonly right: number;
      readonly negativeConstantRootAllowed: boolean }
  | { readonly kind: 'rational-power'; readonly base: number; readonly exponent: number;
      readonly exact: ExactRational; readonly sign: -1 | 0 | 1; readonly oddNumerator: boolean; readonly oddDenominator: boolean }
  | { readonly kind: 'variadic'; readonly operation: Variadic; readonly values: readonly number[] };

const UNARY: ReadonlySet<string> = new Set<Unary>(['negate', 'sqrt', 'absolute', 'sign', 'floor', 'ceiling', 'square',
  'exponential', 'natural-log', 'log-two', 'log-ten', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh']);
const BINARY: ReadonlySet<string> = new Set<Binary>(['subtract', 'divide', 'power', 'root', 'log-base']);
const VARIADIC: ReadonlySet<string> = new Set<Variadic>(['add', 'multiply', 'minimum', 'maximum']);
function unaryOf(value: string): value is Unary { return UNARY.has(value); }
function binaryOf(value: string): value is Binary { return BINARY.has(value); }
function variadicOf(value: string): value is Variadic { return VARIADIC.has(value); }

export interface ScalarTape {
  readonly inputs: readonly ScalarInput[];
  readonly instructions: readonly Instruction[];
  readonly output: number;
  readonly angleUnit: 'degree' | 'radian';
}

export interface ScalarCompileOptions {
  readonly inputs: readonly ScalarInput[];
  readonly angleUnit: 'degree' | 'radian';
  /** In the math Worker: high-precision evaluation, followed by explicit finite-real conversion. */
  readonly evaluateConstant: (expression: MathNode) => number;
  readonly resolveExactSymbol?: (node: Extract<MathNode, { kind: 'symbol' }>) => ExactRational | null;
}

function dynamicName(reference: MathSymbolReference): ScalarInput | null {
  return reference.role === 'axis' || reference.role === 'parameter' ? reference.name : null;
}

export function compileScalarMath(expression: MathNode, options: ScalarCompileOptions): ScalarTape {
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
    if (instructions.length >= 4096) throw new MathInputProblem('budget', '作図する数式が複雑すぎます。');
    instructions.push(instruction);
    return instructions.length - 1;
  }
  function emit(node: MathNode): number {
    const existing = emitted.get(node);
    if (existing !== undefined) return existing;
    let index: number;
    const constant = !depends(node), exact = constant ? rationalOfExpression(node, options.resolveExactSymbol) : null;
    // Keep elementary operations when their result is irrational. A rounded sample is not an exact enclosure.
    const retainOperation = constant && exact === null && node.kind === 'operation'
      && (unaryOf(node.operation) || binaryOf(node.operation) || variadicOf(node.operation));
    if (constant && !retainOperation) {
      const value = options.evaluateConstant(node);
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
      const operands = node.operands.map(emit);
      const exponentNode = node.operands[1];
      const exactExponent = node.operation === 'power' && exponentNode && !depends(exponentNode)
        ? rationalOfExpression(exponentNode, options.resolveExactSymbol) : null;
      if (exactExponent && operands.length === 2 && operands[0] !== undefined && exponentNode) {
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
  const output = emit(expression);
  return { inputs: [...options.inputs], instructions, output, angleUnit: options.angleUnit };
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
    case 'subtract': return left - right;
    case 'divide': return left / right;
    case 'power': return left === 0 && right === 0 ? NaN : left ** right;
    case 'root': return right === 0 ? NaN : left < 0 && Number.isSafeInteger(right) && right % 2 !== 0 ? -((-left) ** (1 / right)) : left ** (1 / right);
    case 'log-base': return left > 0 && right > 0 && right !== 1 ? Math.log(left) / Math.log(right) : NaN;
  }
}

/** One scratch buffer per sampler; never shared between workers or simultaneous jobs. */
export function createScalarTapeEvaluation(tape: ScalarTape): {
  readonly evaluate: (inputs: readonly number[]) => number; readonly values: Float64Array;
} {
  const values = new Float64Array(tape.instructions.length);
  const degree = tape.angleUnit === 'degree', toRadians = degree ? Math.PI / 180 : 1;
  const evaluate = (inputs: readonly number[]): number => {
    if (inputs.length !== tape.inputs.length || inputs.some(value => !Number.isFinite(value))) return NaN;
    for (let index = 0; index < tape.instructions.length; index += 1) {
      const instruction = tape.instructions[index];
      if (!instruction) return NaN;
      let value: number;
      if (instruction.kind === 'constant') value = instruction.value;
      else if (instruction.kind === 'input') value = inputs[instruction.slot] ?? NaN;
      else if (instruction.kind === 'unary') value = unary(instruction.operation, values[instruction.value] ?? NaN, toRadians, degree);
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
