/** The same scalar tapes provide point values, domain enclosures and surface interpolation bounds. */
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler, type ScalarInput } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { intervalAdd, intervalSubtract, intervalMultiply, type MathInterval, type IntervalValue } from './mathInterval.js';
import type { PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { FunctionSurfaceEvaluator } from './adaptiveFunctionSurface.js';

function unpack(value: IntervalValue): MathInterval | null { return value.status === 'range' ? value.interval : null; }
function product(a: MathInterval | null, b: MathInterval | null): MathInterval | null {
  return a === null || b === null ? null : unpack(intervalMultiply(a,b));
}
/** Any triangle within the parameter rectangle: variance(U)<=du²/4, |cov(U,V)|<=du*dv/4. */
function triangleBound(hessians: readonly (readonly (MathInterval | null)[])[], lower: readonly number[], upper: readonly number[]): number | null {
  const widths = lower.map((value, axis) => unpack(intervalSubtract({ lower: upper[axis], upper: upper[axis] }, { lower: value, upper: value })));
  let bound: MathInterval = { lower: 0, upper: 0 };
  for (const [uu, vv, diagonal] of hessians) {
    if (uu === null || vv === null || diagonal === null) return null;
    if ([uu,vv,diagonal].every(value=>value.lower===0 && value.upper===0)) continue;
    // Keep signs until subtraction: 2Huv = H(u+v,u+v)-Huu-Hvv.
    // Taking absolute values first invents a large mixed derivative even for U²+V².
    const difference = unpack(intervalSubtract(diagonal,uu));
    const cross = difference === null ? null : unpack(intervalSubtract(difference,vv));
    const absolute = (value: MathInterval | null): MathInterval | null => value === null ? null
      : { lower:0,upper:Math.max(Math.abs(value.lower),Math.abs(value.upper)) };
    const terms = [product(absolute(uu), product(widths[0], widths[0])),
      product(absolute(vv), product(widths[1], widths[1])), product(absolute(cross), product(widths[0], widths[1]))];
    for (const term of terms) {
      if (term === null) return null;
      const next = unpack(intervalAdd(bound, term)); if (next === null) return null; bound = next;
    }
  }
  if (bound.upper === 0) return 0;
  const result = product(bound, { lower: 0.125, upper: 0.125 });
  return result !== null && Number.isFinite(result.upper) ? Math.max(0,result.upper) : null;
}

export function createFunctionSurfaceEvaluator(outputs: readonly [unknown, unknown, unknown],
  independent: readonly [ScalarInput, ScalarInput], coefficients: unknown,
  context: Omit<PreparedScalarMathContext, 'angleUnit'>): FunctionSurfaceEvaluator {
  const tapes = context.backend.withinDeadline(() => outputs.map(output => compileFunctionScalar(output, independent, coefficients, context)));
  const points = tapes.map(createScalarSampler), intervals = tapes.map(createScalarIntervalSampler);
  const curvature = tapes.map(tape => [[1,0],[0,1],[1,1]].map(direction => createScalarDirectionalJet(tape, direction)));
  return {
    point: parameters => {
      const x = points[0](parameters), y = points[1](parameters), z = points[2](parameters);
      return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x,y,z] : null;
    },
    enclosure: (lower, upper) => {
      const box = lower.map((value, axis) => ({ lower: value, upper: upper[axis] }));
      return [intervals[0](box), intervals[1](box), intervals[2](box)];
    },
    interpolationErrorBound: (lower, upper) => {
      const box = lower.map((value, axis) => ({ lower: value, upper: upper[axis] }));
      return triangleBound(curvature.map(directions => directions.map(direction => direction(box).second)), lower, upper);
    },
  };
}
