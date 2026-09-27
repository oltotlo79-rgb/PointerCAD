import { besselValueRange } from './besselScalar.js';
import { airyRanges } from './airyIntervals.js';
import { zetaDerivativeRanges } from './zetaIntervals.js';
import { lambertWValueRange } from './lambertWIntervals.js';
import { ellipticPartialValue } from './ellipticPartials.js';
/** Conservative domain/range evaluation for the same VM used to sample geometry. */
import type { ScalarTape, ScalarCondition, ScalarConditionValue, ScalarComparison } from './scalarMathTape.js';
import { intervalAbsolute, intervalLogDomain, intervalMultiply, intervalSqrt, intervalSquare,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { intervalUnion, unionAdd, unionSubtract, unionMultiply, unionDivide, unionMap, unionCombine,
  unionReciprocal, unionFlatMap, type IntervalUnion } from './mathIntervalUnion.js';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';
import { exponentialRange } from './exponentialIntervals.js';
import { hyperbolicRange } from './hyperbolicIntervals.js';
import { errorFunctionRange } from './errorFunctionIntervals.js';
import { gammaFunctionRanges } from './gammaFunctionIntervals.js';
import { betaFunctionValueRange } from './betaFunctionIntervals.js';
import { polygammaRange } from './polygammaIntervals.js';

type Instruction = ScalarTape['instructions'][number];
const UNKNOWN: IntervalUnion = { ranges: [{ lower: -Infinity, upper: Infinity }], continuous: false };
const SPLIT: IntervalValue = { status: 'split', reason: 'unknown' };
const OUTSIDE: IntervalValue = { status: 'outside-domain' };
function range(lower: number, upper: number): IntervalValue { return { status: 'range', interval: { lower, upper } }; }
function domain(input: MathInterval, lower: number, upper: number, open = false): 'inside' | 'outside' | 'split' {
  if (open ? input.upper <= lower || input.lower >= upper : input.upper < lower || input.lower > upper) return 'outside';
  return (open ? input.lower > lower && input.upper < upper : input.lower >= lower && input.upper <= upper) ? 'inside' : 'split';
}
function onDomain(input: MathInterval, lower: number, upper: number, output: IntervalValue, open = false): IntervalValue {
  const status = domain(input, lower, upper, open);
  return status === 'inside' ? output : status === 'outside' ? OUTSIDE : SPLIT;
}
/** Only the values where the square root is defined. A cell with a negative part is never continuous. */
function definedSqrt(input: MathInterval): IntervalUnion {
  if (input.upper < 0) return { ranges: [], continuous: false };
  const root = intervalSqrt({ lower: Math.max(0, input.lower), upper: input.upper });
  return root.status === 'range' ? { ranges: [root.interval], continuous: input.lower >= 0 } : UNKNOWN;
}

function unary(operation: Extract<Instruction, { kind: 'unary' }>['operation'], value: MathInterval, degree: boolean): IntervalValue {
  switch (operation) {
    case 'gamma': {
      const enclosure = gammaFunctionRanges(value).value;
      return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
    }
    case 'erf': case 'erfc': {
      const enclosure = errorFunctionRange(operation, value);
      return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
    }
    case 'negate': return range(-value.upper, -value.lower);
    case 'absolute': return intervalAbsolute(value);
    case 'square': return intervalSquare(value);
    case 'sqrt': return intervalSqrt(value);
    case 'sin': case 'cos': return trigonometricInterval(value, operation === 'cos', degree);
    case 'sinh': case 'cosh': case 'tanh': case 'arsinh': {
      const enclosure = hyperbolicRange(operation, value);
      return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
    }
    case 'exponential': {
      const enclosure=exponentialRange(value);
      return enclosure===null?SPLIT:range(enclosure.lower,enclosure.upper);
    }
    case 'natural-log': case 'log-two': case 'log-ten': return intervalLogDomain(value);
    case 'arctan': return range(degree ? -90 : -2, degree ? 90 : 2);
    case 'arcsin': return onDomain(value, -1, 1, range(degree ? -90 : -2, degree ? 90 : 2));
    case 'arccos': return onDomain(value, -1, 1, range(0, degree ? 180 : 4));
    case 'arcosh': case 'artanh': {
      const enclosure = hyperbolicRange(operation, value);
      return onDomain(value, operation === 'arcosh' ? 1 : -1, operation === 'arcosh' ? Infinity : 1,
        enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper), operation === 'artanh');
    }
    case 'floor': case 'ceiling': {
      const operationFn = operation === 'floor' ? Math.floor : Math.ceil;
      const low = operationFn(value.lower), high = operationFn(value.upper);
      return low === high ? range(low, high) : SPLIT;
    }
    case 'sign': return value.lower > 0 ? range(1, 1) : value.upper < 0 ? range(-1, -1)
      : value.lower === 0 && value.upper === 0 ? range(0, 0) : SPLIT;
    // These reciprocals are handled as unions, preserving both branches around a pole.
    case 'tan': case 'cot': case 'sec': case 'csc': return SPLIT;
  }
}

function unaryUnion(operation: Extract<Instruction, { kind: 'unary' }>['operation'], value: IntervalUnion,
  degree: boolean, defined: boolean): IntervalUnion {
  if (defined && operation === 'sqrt') return unionFlatMap(value, definedSqrt);
  if (operation === 'natural-log' || operation === 'log-two' || operation === 'log-ten') {
    return unionFlatMap(value, input => {
      if (input.upper <= 0) return { ranges: [], continuous: false };
      const range = logarithmicPositiveRange(input, operation === 'natural-log' ? 'e' : operation === 'log-two' ? 'two' : 'ten');
      return range === null ? UNKNOWN : { ranges: [range], continuous: input.lower > 0 };
    });
  }
  if (operation === 'tan' || operation === 'cot' || operation === 'sec' || operation === 'csc') {
    const sine = () => unionMap(value, input => trigonometricInterval(input, false, degree));
    const cosine = () => unionMap(value, input => trigonometricInterval(input, true, degree));
    if (operation === 'sec') return unionReciprocal(cosine());
    if (operation === 'csc') return unionReciprocal(sine());
    return operation === 'tan' ? unionDivide(sine(), cosine()) : unionDivide(cosine(), sine());
  }
  return unionMap(value, input => unary(operation, input, degree));
}

/** Integer power uses directed basic arithmetic, not an assumed error bound for Math.pow. */
function integerPower(input: MathInterval, exponent: number): IntervalValue {
  if (exponent === 0) return input.lower <= 0 && input.upper >= 0 ? SPLIT : range(1, 1);
  let base: IntervalValue = range(input.lower, input.upper), result: IntervalValue = range(1, 1), remaining = exponent;
  while (remaining > 0) {
    if (base.status !== 'range' || result.status !== 'range') return SPLIT;
    if (remaining % 2 === 1) result = intervalMultiply(result.interval, base.interval);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) base = intervalSquare(base.interval);
  }
  return result;
}
function rationalPower(value: IntervalUnion, instruction: Extract<Instruction, { kind: 'rational-power' }>, defined: boolean): IntervalUnion {
  const { numerator, denominator } = instruction.exact;
  const magnitude = numerator < 0n ? -numerator : numerator;
  let result: IntervalUnion;
  if (denominator === 1n && magnitude <= 1024n) result = unionMap(value, input => integerPower(input, Number(magnitude)));
  else if (magnitude === 1n && denominator === 2n) result = defined ? unionFlatMap(value, definedSqrt) : unionMap(value, intervalSqrt);
  else result = unionMap(value, input => {
    if (denominator % 2n === 0n) return onDomain(input, 0, Infinity, range(0, Infinity));
    return magnitude % 2n === 0n ? range(0, Infinity) : range(-Infinity, Infinity);
  });
  return numerator < 0n ? unionReciprocal(result) : result;
}

function binary(instruction: Extract<Instruction, { kind: 'binary' }>, left: IntervalUnion, right: IntervalUnion): IntervalUnion {
  if (instruction.operation === 'subtract') return unionSubtract(left, right);
  if (instruction.operation === 'divide') return unionDivide(left, right);
  return unionCombine(left, right, (a, b) => {
    if (instruction.operation === 'beta') {
      const enclosure = betaFunctionValueRange(a, b);
      return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
    }
    if (instruction.operation === 'log-base') {
      if (a.upper <= 0 || b.upper <= 0 || b.lower === 1 && b.upper === 1) return OUTSIDE;
      return a.lower > 0 && b.lower > 0 && !(b.lower <= 1 && b.upper >= 1) ? range(-Infinity, Infinity) : SPLIT;
    }
    // Dynamic powers/roots on negative bases require integer/parity evidence, not rounded samples.
    if (a.lower <= 0) return SPLIT;
    if (instruction.operation === 'root' && b.lower <= 0 && b.upper >= 0) return SPLIT;
    return range(0, Infinity);
  });
}

/** Three-valued comparison of two enclosures; null means both results can occur in the box. */
export function compareRanges(operation: ScalarComparison, a: MathInterval, b: MathInterval): boolean | null {
  const disjoint = a.upper < b.lower || b.upper < a.lower;
  const identicalPoints = a.lower === a.upper && b.lower === b.upper && a.lower === b.lower;
  if (operation === 'equal') return disjoint ? false : identicalPoints ? true : null;
  if (operation === 'not-equal') return disjoint ? true : identicalPoints ? false : null;
  if (operation === 'less') return a.upper < b.lower ? true : a.lower >= b.upper ? false : null;
  if (operation === 'less-equal') return a.upper <= b.lower ? true : a.lower > b.upper ? false : null;
  if (operation === 'greater') return a.lower > b.upper ? true : a.upper <= b.lower ? false : null;
  return a.lower >= b.upper ? true : a.upper < b.lower ? false : null;
}

export interface ScalarConditionInterval extends ScalarConditionValue {
  /** False means no point in this box can evaluate the condition. Unknown is not false. */
  readonly defined: boolean;
}

/** Three-valued interval conditions, reusable by condition-defined domains. */
export function createScalarConditionIntervalSampler(condition: ScalarCondition): (inputs: readonly MathInterval[]) => ScalarConditionInterval {
  if (condition.kind === 'boolean') return () => ({ truth: condition.value, boundary: false, defined: true });
  if (condition.kind === 'not') {
    const evaluate = createScalarConditionIntervalSampler(condition.operand);
    return inputs => { const result = evaluate(inputs); return { ...result, truth: result.truth === null ? null : !result.truth }; };
  }
  if (condition.kind === 'and' || condition.kind === 'or') {
    const operands = condition.operands.map(createScalarConditionIntervalSampler);
    return inputs => {
      let boundary = false, unknown = false;
      for (const evaluate of operands) {
        const result = evaluate(inputs); boundary ||= result.boundary;
        if (!result.defined) return { truth: null, boundary: true, defined: unknown };
        if (result.truth === null) unknown = true;
        else if (result.truth === (condition.kind === 'or')) {
          // Earlier unknown operands may themselves be undefined on part of the box.
          return { truth: unknown ? null : result.truth, boundary, defined: true };
        }
      }
      return { truth: unknown ? null : condition.kind === 'and', boundary, defined: true };
    };
  }
  const operands = condition.operands.map(createScalarIntervalSampler);
  return inputs => {
    const values = operands.map(evaluate => evaluate(inputs));
    if (values.some(value => value.ranges.length === 0)) return { truth: null, boundary: true, defined: false };
    if (values.some(value => !value.continuous)) return { truth: null, boundary: true, defined: true };
    let truth: boolean | null = true, boundary = false;
    for (let i = 1; i < values.length; i++) {
      for (let j = condition.operation === 'not-equal' ? 0 : i - 1; j < i; j++) {
        let yes = false, no = false;
        for (const a of values[j].ranges) for (const b of values[i].ranges) {
          const comparison = compareRanges(condition.operation, a, b);
          yes ||= comparison !== false; no ||= comparison !== true;
          boundary ||= condition.dynamic && a.lower <= b.upper && b.lower <= a.upper;
        }
        const comparison = yes && no ? null : yes;
        if (comparison === false) truth = false;
        else if (comparison === null && truth !== false) truth = null;
      }
    }
    return { truth, boundary, defined: true };
  };
}

function createPiecewiseIntervalSampler(instruction: Extract<Instruction, { kind: 'piecewise' }>,
  definedPart: ScalarDefinedPart | null): (inputs: readonly MathInterval[]) => IntervalUnion {
  const branches = instruction.branches.map(branch => ({ condition: createScalarConditionIntervalSampler(branch.condition), value: intervalSampler(branch.value, definedPart) }));
  return inputs => {
    const ranges: MathInterval[] = [];
    let uncertain = false;
    for (const branch of branches) {
      const condition = branch.condition(inputs);
      if (!condition.defined) break;
      if (instruction.interior && condition.boundary) {
        if (inputs.every(input => input.lower === input.upper)) break;
        uncertain = true;
      }
      if (condition.truth === false) continue;
      const value = branch.value(inputs);
      if (condition.truth === true && !uncertain) return value;
      ranges.push(...value.ranges);
      uncertain = true;
      if (condition.truth === true) break;
    }
    return unionFlatMap({ ranges, continuous: false }, input => intervalUnion(input.lower, input.upper));
  };
}

/** Empty ranges mean no real values; continuous=false always prevents joining across that parameter cell. */
export function createScalarIntervalEvaluation(tape: ScalarTape): {
  readonly evaluate: (inputs: readonly MathInterval[]) => IntervalUnion;
  readonly values: readonly IntervalUnion[];
} {
  return intervalEvaluation(tape, null);
}
/** Chooses instructions of a tape, or of its branch tapes, whose square root encloses only its defined part. */
export type ScalarDefinedPart = (tape: ScalarTape, index: number) => boolean;
function intervalEvaluation(tape: ScalarTape, definedPart: ScalarDefinedPart | null): ReturnType<typeof createScalarIntervalEvaluation> {
  const values: IntervalUnion[] = [];
  const piecewise = new Map(tape.instructions.flatMap((instruction, index) => instruction.kind === 'piecewise'
    ? [[index, createPiecewiseIntervalSampler(instruction, definedPart)] as const] : []));
  const evaluate = (inputs: readonly MathInterval[]): IntervalUnion => {
    if (inputs.length !== tape.inputs.length || inputs.some(value => !Number.isFinite(value.lower)
      || !Number.isFinite(value.upper) || value.lower > value.upper)) return UNKNOWN;
    for (let index = 0; index < tape.instructions.length; index++) {
      const instruction = tape.instructions[index];
      if (instruction.kind === 'piecewise') values[index] = piecewise.get(index)?.(inputs) ?? UNKNOWN;
      else if (instruction.kind === 'constant') values[index] = !Number.isFinite(instruction.value) ? { ranges: [], continuous: false }
        : instruction.enclosure === null ? UNKNOWN
        : intervalUnion(instruction.enclosure.lower, instruction.enclosure.upper);
      else if (instruction.kind === 'input') {
        const input = inputs[instruction.slot]; values[index] = input === undefined ? UNKNOWN : intervalUnion(input.lower, input.upper);
      } else if (instruction.kind === 'unary') values[index] = unaryUnion(instruction.operation,
        values[instruction.value] ?? UNKNOWN, tape.angleUnit === 'degree', definedPart?.(tape, index) === true);
      else if(instruction.kind==='zeta')values[index]=unionMap(values[instruction.value]??UNKNOWN,input=>{
        const enclosure=zetaDerivativeRanges(input,instruction.order)?.[instruction.order];
        return enclosure===undefined?SPLIT:range(enclosure.lower,enclosure.upper);
      });
      else if (instruction.kind === 'airy') values[index] = unionMap(values[instruction.value] ?? UNKNOWN, input => {
        const enclosure = airyRanges(instruction.family, instruction.prime, input).value;
        return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
      });
      else if (instruction.kind === 'lambertw') values[index] = unionMap(values[instruction.value] ?? UNKNOWN, input => {
        const enclosure = lambertWValueRange(instruction.branch, input);
        return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
      });
      else if (instruction.kind === 'bessel') values[index] = unionMap(values[instruction.value] ?? UNKNOWN, input => {
        const enclosure = besselValueRange(instruction.family, instruction.order, input);
        return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
      });
      else if (instruction.kind === 'polygamma') values[index] = unionMap(values[instruction.value] ?? UNKNOWN, input => {
        const enclosure = polygammaRange(instruction.order, input);
        return enclosure === null ? SPLIT : range(enclosure.lower, enclosure.upper);
      });
      else if (instruction.kind === 'elliptic') {
        const inputs=instruction.values.map(operand=>values[operand]??UNKNOWN);
        const args=inputs.map(input=>input.continuous&&input.ranges.length===1?input.ranges[0]:null);
        const enclosure=args.every(input=>input!==null)?ellipticPartialValue(instruction.family,args,instruction.orders,tape.angleUnit==='degree'):null;
        values[index]=enclosure===null?UNKNOWN:intervalUnion(enclosure.lower,enclosure.upper);
      }
      else if (instruction.kind === 'binary') values[index] = binary(instruction, values[instruction.left] ?? UNKNOWN, values[instruction.right] ?? UNKNOWN);
      else if (instruction.kind === 'rational-power') values[index] = rationalPower(values[instruction.base] ?? UNKNOWN, instruction,
        definedPart?.(tape, index) === true);
      else {
        let accumulated: IntervalUnion | null = null;
        for (const operand of instruction.values) {
          const value = values[operand] ?? UNKNOWN;
          if (accumulated === null) { accumulated = value; continue; }
          accumulated = instruction.operation === 'add' ? unionAdd(accumulated, value)
            : instruction.operation === 'multiply' ? unionMultiply(accumulated, value)
              : unionCombine(accumulated, value, (a, b) => instruction.operation === 'minimum'
                ? range(Math.min(a.lower, b.lower), Math.min(a.upper, b.upper)) : range(Math.max(a.lower, b.lower), Math.max(a.upper, b.upper)));
        }
        values[index] = accumulated ?? (instruction.operation === 'add' ? intervalUnion(0) : instruction.operation === 'multiply' ? intervalUnion(1) : UNKNOWN);
      }
    }
    const output = values[tape.output] ?? UNKNOWN;
    intervalTapes?.set(output, tape);
    for (const guard of tape.domainGuards ?? []) {
      const condition = values[guard];
      if (condition?.ranges.length === 0) return { ranges: [], continuous: false };
      if (condition?.continuous !== true) return { ...output, continuous: false };
    }
    return output;
  };
  return { evaluate, values };
}
export function createScalarIntervalSampler(tape: ScalarTape): (inputs: readonly MathInterval[]) => IntervalUnion {
  return intervalSampler(tape, null);
}
/** The same sampler, where the chosen square roots enclose only their defined part; such a cell is never continuous. */
export function createScalarDefinedIntervalSampler(tape: ScalarTape, definedPart: ScalarDefinedPart): (inputs: readonly MathInterval[]) => IntervalUnion {
  return intervalSampler(tape, definedPart);
}
function intervalSampler(tape: ScalarTape, definedPart: ScalarDefinedPart | null): (inputs: readonly MathInterval[]) => IntervalUnion {
  const evaluate = intervalEvaluation(tape, definedPart).evaluate;
  const boundaries = scalarParameterBoundaries(tape);
  if (boundaries.length === 0) return evaluate;
  return inputs => {
    // Keep the public value enclosure unchanged. The certificate is local to
    // this evaluation and never survives serialization or crosses Workers.
    const value = evaluate(inputs);
    const result = { ...value };
    parameterBoundaries.set(result, boundaries);
    intervalTapes?.set(result, tape);
    return result;
  };
}

export interface ScalarParameterBoundary {
  readonly axis: number; readonly value: number; readonly lower: number; readonly upper: number;
}
const parameterBoundaries = new WeakMap<IntervalUnion, readonly ScalarParameterBoundary[]>();
let intervalTapes: WeakMap<IntervalUnion, ScalarTape> | undefined;
/** Synchronous, scoped provenance collection; ordinary sampling allocates no entries. */
export function withScalarIntervalTapes<T>(evaluate: () => T): T {
  const previous = intervalTapes;
  intervalTapes = new WeakMap();
  try { return evaluate(); } finally { intervalTapes = previous; }
}
/** Calculation provenance for certifying the tiny strip removed at an open endpoint. */
export function scalarIntervalTape(value: IntervalUnion): ScalarTape | undefined { return intervalTapes?.get(value); }
/** Input/constant comparison cuts with directed constant enclosures. Other boundaries still require subdivision. */
export function scalarIntervalBoundaries(value: IntervalUnion): readonly ScalarParameterBoundary[] {
  return parameterBoundaries.get(value) ?? [];
}
function scalarParameterBoundaries(tape: ScalarTape): readonly ScalarParameterBoundary[] {
  const result: ScalarParameterBoundary[] = [];
  function condition(value: ScalarCondition): void {
    if (value.kind === 'not') condition(value.operand);
    else if (value.kind === 'and' || value.kind === 'or') value.operands.forEach(condition);
    else if (value.kind === 'comparison') {
      const operands = value.operands.map(operand => operand.instructions[operand.output]);
      for (let i = 0; i < operands.length; i++) for (let j = i + 1; j < operands.length; j++) {
        const a = operands[i], b = operands[j];
        const input = a.kind === 'input' ? a : b.kind === 'input' ? b : null;
        const constant = a.kind === 'constant' ? a : b.kind === 'constant' ? b : null;
        if (input !== null && constant?.enclosure !== null && constant?.enclosure !== undefined
            && Number.isFinite(constant.enclosure.lower) && Number.isFinite(constant.enclosure.upper)
            && constant.value >= constant.enclosure.lower && constant.value <= constant.enclosure.upper) {
          result.push({ axis: input.slot, value: constant.value, ...constant.enclosure });
        }
      }
      value.operands.forEach(visit);
    }
  }
  function visit(value: ScalarTape): void {
    for (const instruction of value.instructions) if (instruction.kind === 'piecewise') {
      for (const branch of instruction.branches) { condition(branch.condition); visit(branch.value); }
    }
  }
  visit(tape);
  return result;
}
