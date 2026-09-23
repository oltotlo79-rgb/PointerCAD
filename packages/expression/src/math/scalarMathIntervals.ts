import { besselValueRange } from './besselScalar.js';
import { airyRanges } from './airyIntervals.js';
import { zetaDerivativeRanges } from './zetaIntervals.js';
import { lambertWValueRange } from './lambertWIntervals.js';
import { ellipticPartialValue } from './ellipticPartials.js';
/** Conservative domain/range evaluation for the same VM used to sample geometry. */
import type { ScalarTape } from './scalarMathTape.js';
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
  degree: boolean): IntervalUnion {
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
function rationalPower(value: IntervalUnion, instruction: Extract<Instruction, { kind: 'rational-power' }>): IntervalUnion {
  const { numerator, denominator } = instruction.exact;
  const magnitude = numerator < 0n ? -numerator : numerator;
  let result: IntervalUnion;
  if (denominator === 1n && magnitude <= 1024n) result = unionMap(value, input => integerPower(input, Number(magnitude)));
  else if (magnitude === 1n && denominator === 2n) result = unionMap(value, intervalSqrt);
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

/** Empty ranges mean no real values; continuous=false always prevents joining across that parameter cell. */
export function createScalarIntervalEvaluation(tape: ScalarTape): {
  readonly evaluate: (inputs: readonly MathInterval[]) => IntervalUnion;
  readonly values: readonly IntervalUnion[];
} {
  const values: IntervalUnion[] = [];
  const evaluate = (inputs: readonly MathInterval[]): IntervalUnion => {
    if (inputs.length !== tape.inputs.length || inputs.some(value => !Number.isFinite(value.lower)
      || !Number.isFinite(value.upper) || value.lower > value.upper)) return UNKNOWN;
    for (let index = 0; index < tape.instructions.length; index++) {
      const instruction = tape.instructions[index];
      if (instruction.kind === 'constant') values[index] = instruction.enclosure === null ? UNKNOWN
        : intervalUnion(instruction.enclosure.lower, instruction.enclosure.upper);
      else if (instruction.kind === 'input') {
        const input = inputs[instruction.slot]; values[index] = input === undefined ? UNKNOWN : intervalUnion(input.lower, input.upper);
      } else if (instruction.kind === 'unary') values[index] = unaryUnion(instruction.operation,
        values[instruction.value] ?? UNKNOWN, tape.angleUnit === 'degree');
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
      else if (instruction.kind === 'rational-power') values[index] = rationalPower(values[instruction.base] ?? UNKNOWN, instruction);
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
  return createScalarIntervalEvaluation(tape).evaluate;
}
