/** Principal complex values. DLMF 4.2, 4.23(iv), 4.37(iv).
 * The negative real axis uses arg=+pi; no signed-zero branch is stored.
 * Guard digits belong to this call and never change the application's Decimal.
 */
import Decimal from 'decimal.js';
import { MathInputProblem } from './mathInputContract.js';
import type { EngineMathJson } from './encodeMathJson.js';
import { jsonDecimal, numberJson as N } from './nativeMathNumber.js';

type Pair = readonly [EngineMathJson, EngineMathJson];
type Complex = readonly [Decimal, Decimal];
const HEADS = new Set(['Sqrt', 'Ln', 'Log', 'Power', 'Arcsin', 'Arccos', 'Arctan', 'Arsinh', 'Arcosh', 'Artanh']);
const op = (head: string, ...args: EngineMathJson[]): EngineMathJson => [head, ...args];

/** Entire functions are expanded before rounding, retaining e^(i*pi) exactly. */
export function entireComplexOperation(head: string, [a, b]: Pair): EngineMathJson | null {
  switch (head) {
    case 'Exp': return op('Complex', op('Multiply', op('Exp', a), op('Cos', b)), op('Multiply', op('Exp', a), op('Sin', b)));
    case 'Sin': return op('Complex', op('Multiply', op('Sin', a), op('Cosh', b)), op('Multiply', op('Cos', a), op('Sinh', b)));
    case 'Cos': return op('Complex', op('Multiply', op('Cos', a), op('Cosh', b)), op('Negate', op('Multiply', op('Sin', a), op('Sinh', b))));
    case 'Sinh': return op('Complex', op('Multiply', op('Sinh', a), op('Cos', b)), op('Multiply', op('Cosh', a), op('Sin', b)));
    case 'Cosh': return op('Complex', op('Multiply', op('Cosh', a), op('Cos', b)), op('Multiply', op('Sinh', a), op('Sin', b)));
    case 'Tan': case 'Cot': return op('Divide', op(head === 'Tan' ? 'Sin' : 'Cos', op('Complex', a, b)), op(head === 'Tan' ? 'Cos' : 'Sin', op('Complex', a, b)));
    case 'Sec': case 'Csc': return op('Divide', N(1), op(head === 'Sec' ? 'Cos' : 'Sin', op('Complex', a, b)));
    case 'Tanh': return op('Divide', op('Sinh', op('Complex', a, b)), op('Cosh', op('Complex', a, b)));
    default: return null;
  }
}

export function principalComplexOperation(head: string, pair: Pair, other?: Pair): EngineMathJson | null {
  if (!HEADS.has(head)) return null;
  const values = [...pair, ...(other ?? [])].map(jsonDecimal);
  if (values.some(value => value === null)) return null;
  const known = values.filter((value): value is Decimal => value !== null);
  if (known.some(value => !value.isFinite())) throw new MathInputProblem('domain', '複素数の成分は有限の数で指定してください。');
  // Retain tiny off-axis components and distances to branch points instead of
  // rounding them onto a cut. Work remains bounded even for adversarial input.
  const precision = Math.max(80, ...known.map(value => 60 + 2 * Math.max(value.precision(), Math.abs(value.e))));
  if (precision > 512) throw new MathInputProblem('budget', '複素関数の成分の桁差が計算範囲を超えています。');
  const D = Decimal.clone({ precision, rounding: Decimal.ROUND_HALF_EVEN });
  const zero = new D(0), one = new D(1), pi = D.acos(-1);
  const z: Complex = [new D(known[0]), new D(known[1])];
  const w: Complex | undefined = other === undefined ? undefined : [new D(known[2]), new D(known[3])];
  const add = ([a, b]: Complex, [c, d]: Complex): Complex => [a.add(c), b.add(d)];
  const neg = ([a, b]: Complex): Complex => [a.neg(), b.neg()];
  const mul = ([a, b]: Complex, [c, d]: Complex): Complex => [a.mul(c).sub(b.mul(d)), a.mul(d).add(b.mul(c))];
  const scale = ([a, b]: Complex, factor: Decimal): Complex => [a.mul(factor), b.mul(factor)];
  const divide = ([a, b]: Complex, [c, d]: Complex): Complex => {
    const denominator = c.mul(c).add(d.mul(d));
    if (denominator.isZero()) throw new MathInputProblem('domain', '複素数でも0で割ることはできません。');
    return [a.mul(c).add(b.mul(d)).div(denominator), b.mul(c).sub(a.mul(d)).div(denominator)];
  };
  const sqrt = ([a, b]: Complex): Complex => {
    if (b.isZero()) return a.isNegative() ? [zero, a.neg().sqrt()] : [a.sqrt(), zero];
    const radius = a.mul(a).add(b.mul(b)).sqrt();
    if (a.gte(0)) {
      const real = radius.add(a).div(2).sqrt();
      return [real, b.div(real.mul(2))];
    }
    const imaginary = radius.sub(a).div(2).sqrt().mul(b.isNegative() ? -1 : 1);
    return [b.div(imaginary.mul(2)), imaginary];
  };
  const log = ([a, b]: Complex): Complex => {
    if (a.isZero() && b.isZero()) throw new MathInputProblem('domain', '0の複素対数は有限になりません。');
    return [a.mul(a).add(b.mul(b)).ln().div(2), b.isZero() && a.isNegative() ? pi : D.atan2(b, a)];
  };
  const exp = ([a, b]: Complex): Complex => [a.exp().mul(b.cos()), a.exp().mul(b.sin())];
  const unit: Complex = [one, zero], imaginary: Complex = [zero, one];
  const asin = (value: Complex): Complex => {
    // Odd reflection avoids a subtractive logarithm on the negative half-plane.
    if (value[0].lt(0) || value[0].isZero() && value[1].lt(0)) return neg(asin(neg(value)));
    return mul(neg(imaginary), log(add(mul(imaginary, value), sqrt(add(unit, neg(mul(value, value)))))));
  };
  const asinh = (value: Complex): Complex => {
    if (value[0].lt(0) || value[0].isZero() && value[1].lt(0)) return neg(asinh(neg(value)));
    return log(add(value, sqrt(add(mul(value, value), unit))));
  };
  let result: Complex;
  switch (head) {
    case 'Sqrt': result = sqrt(z); break;
    case 'Ln': result = log(z); break;
    case 'Log': if (w === undefined) return null; result = divide(log(z), log(w)); break;
    case 'Power': {
      if (w === undefined) return null;
      if (z.every(value => value.isZero())) {
        if (!w[1].isZero() || w[0].lte(0)) throw new MathInputProblem('domain', '0の累乗は正の実数の指数で指定してください。');
        result = [zero, zero];
      } else result = exp(mul(w, log(z)));
      break;
    }
    case 'Arcsin': result = asin(z); break;
    case 'Arccos': result = add([pi.div(2), zero], neg(asin(z))); break;
    case 'Arctan': result = scale(mul(imaginary, add(log(add(unit, neg(mul(imaginary, z)))), neg(log(add(unit, mul(imaginary, z)))))), new D('0.5')); break;
    case 'Arsinh': result = asinh(z); break;
    case 'Arcosh': result = log(add(z, mul(sqrt(add(z, neg(unit))), sqrt(add(z, unit))))); break;
    case 'Artanh': result = scale(add(log(add(unit, z)), neg(log(add(unit, neg(z))))), new D('0.5')); break;
    default: return null;
  }
  if (result.some(value => !value.isFinite())) throw new MathInputProblem('domain', '有限の複素数の結果を求められません。');
  return op('Complex', ...result.map(value => N(value.toSignificantDigits(40).toString())));
}
