import { besselSlope } from './besselScalar.js';
import { airySlope } from './airyIntervals.js';
import { zetaSample } from './zetaIntervals.js';
import { lambertWSlope } from './lambertWIntervals.js';
import { ellipticMidpoint } from './ellipticIntervals.js';
import { ellipticPartialRanges } from './ellipticPartials.js';
/** Forward differentiation of the safe scalar tape. Nonsmooth and domain-boundary points have no invented normal. */
import { createScalarConditionSampler, createScalarTapeEvaluation, type ScalarTape } from './scalarMathTape.js';
import { polygammaSample } from './polygammaIntervals.js';
import { betaFunctionRanges } from './betaFunctionIntervals.js';
export interface ScalarDifferential {
  readonly value: number;
  readonly gradient: readonly number[] | null;
  readonly reason: 'domain' | 'nonsmooth' | 'derivative-overflow' | null;
}

export function createScalarDifferential(tape: ScalarTape): (inputs: readonly number[]) => ScalarDifferential {
  const count = tape.instructions.length, dimensions = tape.inputs.length;
  const scalar = createScalarTapeEvaluation(tape), values = scalar.values;
  const gradient = new Float64Array(count * dimensions);
  const valid = new Uint8Array(count);
  const toRadians = tape.angleUnit === 'degree' ? Math.PI / 180 : 1;
  const branches = new Map(tape.instructions.flatMap((item, index) => item.kind === 'piecewise'
    ? [[index, item.branches.map(branch => ({ condition: createScalarConditionSampler(branch.condition),
      differential: createScalarDifferential(branch.value) }))] as const] : []));
  const branchDifferential = (index: number, inputs: readonly number[]): ScalarDifferential['reason'] => {
    valid[index] = 0;
    for (const branch of branches.get(index) ?? []) {
      const condition = branch.condition(inputs);
      if (condition.truth === null || condition.boundary) return 'nonsmooth';
      if (!condition.truth) continue;
      const selected = branch.differential(inputs);
      if (selected.gradient === null) return selected.reason;
      gradient.set(selected.gradient, index * dimensions); valid[index] = 1;
      return null;
    }
    return 'domain';
  };
  return inputs => {
    const value = scalar.evaluate(inputs);
    if (!Number.isFinite(value)) return { value, gradient: null, reason: 'domain' };
    gradient.fill(0); valid.fill(1);
    let reason: ScalarDifferential['reason'] = null;
    for (let index = 0; index < count; index += 1) {
      const item = tape.instructions[index];
      function combine(terms: readonly (readonly [number, number])[]): void {
        for (const [operand, factor] of terms) {
          if (tape.instructions[operand].kind === 'constant') continue;
          if (!valid[operand] || !Number.isFinite(factor)) { valid[index] = 0; reason ??= 'nonsmooth'; return; }
          for (let axis = 0; axis < dimensions; axis += 1) {
            const offset = index * dimensions + axis;
            gradient[offset] += factor * gradient[operand * dimensions + axis];
            if (!Number.isFinite(gradient[offset])) { valid[index] = 0; reason = 'derivative-overflow'; return; }
          }
        }
      }
      if (item.kind === 'constant') continue;
      if (item.kind === 'input') { gradient[index * dimensions + item.slot] = 1; continue; }
      if (item.kind === 'unary') {
        const x = values[item.value], r = values[index];
        let derivative: number;
        switch (item.operation) {
          case 'negate': derivative = -1; break;
          case 'square': derivative = 2 * x; break;
          case 'sqrt': derivative = x > 0 ? 0.5 / r : NaN; break;
          case 'absolute': derivative = x === 0 ? NaN : Math.sign(x); break;
          case 'sign': derivative = x === 0 ? NaN : 0; break;
          case 'floor': case 'ceiling': derivative = Number.isInteger(x) ? NaN : 0; break;
          case 'exponential': derivative = r; break;
          case 'gamma': derivative = r*polygammaSample(0, x); break;
          case 'erf': case 'erfc': derivative = (item.operation === 'erf' ? 1 : -1) * 2/Math.sqrt(Math.PI)*Math.exp(-x*x); break;
          case 'natural-log': derivative = 1 / x; break;
          case 'log-two': derivative = 1 / (x * Math.LN2); break;
          case 'log-ten': derivative = 1 / (x * Math.LN10); break;
          case 'sin': derivative = Math.cos(x * toRadians) * toRadians; break;
          case 'cos': derivative = -Math.sin(x * toRadians) * toRadians; break;
          case 'tan': derivative = (1 + r * r) * toRadians; break;
          case 'cot': derivative = -(1 + r * r) * toRadians; break;
          case 'sec': derivative = r * Math.tan(x * toRadians) * toRadians; break;
          case 'csc': derivative = -r / Math.tan(x * toRadians) * toRadians; break;
          case 'arcsin': derivative = 1 / (Math.sqrt(1 - x*x) * toRadians); break;
          case 'arccos': derivative = -1 / (Math.sqrt(1 - x*x) * toRadians); break;
          case 'arctan': derivative = Math.abs(x) > 1 ? ((1/x) / x) / ((1 + (1/x)**2) * toRadians) : 1 / ((1 + x*x) * toRadians); break;
          case 'sinh': derivative = Math.cosh(x); break;
          case 'cosh': derivative = Math.sinh(x); break;
          case 'tanh': derivative = 1 - r*r; break;
          case 'arsinh': derivative = 1 / Math.hypot(x, 1); break;
          case 'arcosh': derivative = 1 / (Math.sqrt(x - 1) * Math.sqrt(x + 1)); break;
          case 'artanh': derivative = 1 / (1 - x*x); break;
        }
        combine([[item.value, derivative]]);
      } else if(item.kind==='zeta') {
        combine([[item.value,zetaSample(item.order+1,values[item.value])]]);
      } else if (item.kind === 'airy') {
        combine([[item.value, airySlope(item.family, item.prime, values[item.value])]]);
      } else if (item.kind === 'lambertw') {
        combine([[item.value, lambertWSlope(item.branch, values[item.value])]]);
      } else if (item.kind === 'elliptic') {
        const ranges=ellipticPartialRanges(item.family,item.values.map(operand=>({lower:values[operand],upper:values[operand]})),item.orders,tape.angleUnit==='degree');
        combine(item.values.map((operand,index)=>[operand,ellipticMidpoint(ranges.first[index])]));
      } else if (item.kind === 'bessel') {
        combine([[item.value, besselSlope(item.family, item.order, values[item.value])]]);
      } else if (item.kind === 'polygamma') {
        combine([[item.value, polygammaSample(item.order+1, values[item.value])]]);
      } else if (item.kind === 'binary') {
        const a = values[item.left], b = values[item.right], r = values[index];
        let left: number, right: number;
        switch (item.operation) {
          case 'beta': {
            const ranges = betaFunctionRanges({ lower: a, upper: a }, { lower: b, upper: b });
            left = ranges.da === null ? NaN : ranges.da.lower/2+ranges.da.upper/2;
            right = ranges.db === null ? NaN : ranges.db.lower/2+ranges.db.upper/2;
            break;
          }
          case 'subtract': left = 1; right = -1; break;
          case 'divide': left = 1 / b; right = -r / b; break;
          case 'log-base': left = 1 / (a * Math.log(b)); right = -Math.log(a) / (b * Math.log(b)**2); break;
          case 'power': left = a > 0 ? b * r / a : NaN; right = a > 0 ? r * Math.log(a) : NaN; break;
          case 'root': left = a !== 0 && (a > 0 || Number.isSafeInteger(b) && b % 2 !== 0) ? (r/a) / b : NaN;
            right = a > 0 ? -r * Math.log(a) / (b*b) : NaN; break;
        }
        combine([[item.left, left], [item.right, right]]);
      } else if (item.kind === 'rational-power') {
        const base = values[item.base], exponent = item.exponent;
        const factor = base === 0 ? !item.oddDenominator ? NaN : exponent > 1 ? 0 : exponent === 1 ? 1 : NaN
          : exponent * values[index] / base;
        combine([[item.base, factor]]);
      } else if (item.operation === 'add') {
        combine(item.values.map(index => [index, 1]));
      } else if (item.operation === 'multiply') {
        // Prefix/suffix products handle zero factors without dividing by a zero result.
        const before = new Float64Array(item.values.length), after = new Float64Array(item.values.length);
        let product = 1;
        for (let i = 0; i < item.values.length; i += 1) { before[i] = product; product *= values[item.values[i]]; }
        product = 1;
        for (let i = item.values.length - 1; i >= 0; i -= 1) { after[i] = product; product *= values[item.values[i]]; }
        combine(item.values.map((operand, i) => [operand, before[i] * after[i]]));
      } else if (item.kind === 'piecewise') {
        const failure = branchDifferential(index, inputs); reason ??= failure;
      } else {
        const selected = item.values.filter(operand => values[operand] === values[index]);
        if (selected.length !== 1) { valid[index] = 0; reason ??= 'nonsmooth'; }
        else combine([[selected[0], 1]]);
      }
    }
    return valid[tape.output] ? { value, gradient: Array.from(gradient.subarray(tape.output * dimensions, (tape.output + 1) * dimensions)), reason: null }
      : { value, gradient: null, reason: reason ?? 'nonsmooth' };
  };
}
