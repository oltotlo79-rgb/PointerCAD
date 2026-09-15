/** A single exact quadratic extension Q(sqrt(d)); zero tests never use a tolerance. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { decimalRational, rational, rationalOfExpression, type ExactRational } from './exactRational.js';
import { exactLinearNode } from './exactLinearData.js';

export interface QuadraticValue { readonly a: ExactRational; readonly b: ExactRational }
const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
const number = (value: ExactRational): QuadraticValue => ({ a: value, b: ZERO });

export class ExactQuadraticField {
  private radicand: ExactRational | null = null;
  private remaining = 250_000;
  readonly zero = number(ZERO);
  readonly one = number(ONE);

  private value(numerator: bigint, denominator = 1n): ExactRational {
    if (--this.remaining < 0) throw new MathInputProblem('budget', '固有空間の演算回数が上限を超えました。');
    const result = rational(numerator, denominator);
    if (result === null) throw new MathInputProblem('budget', '固有空間の厳密な桁数が上限を超えました。');
    return result;
  }

  private sum(a: ExactRational, b: ExactRational): ExactRational {
    return this.value(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
  }

  private product(a: ExactRational, b: ExactRational): ExactRational {
    return this.value(a.numerator * b.numerator, a.denominator * b.denominator);
  }

  scalar(value: ExactRational): QuadraticValue { return number(this.value(value.numerator, value.denominator)); }
  isZero(value: QuadraticValue): boolean { return value.a.numerator === 0n && value.b.numerator === 0n; }

  add(left: QuadraticValue, right: QuadraticValue): QuadraticValue {
    return { a: this.sum(left.a, right.a), b: this.sum(left.b, right.b) };
  }

  negate(value: QuadraticValue): QuadraticValue {
    return { a: this.value(-value.a.numerator, value.a.denominator), b: this.value(-value.b.numerator, value.b.denominator) };
  }

  subtract(left: QuadraticValue, right: QuadraticValue): QuadraticValue { return this.add(left, this.negate(right)); }

  multiply(left: QuadraticValue, right: QuadraticValue): QuadraticValue {
    const d = this.radicand ?? ZERO;
    return { a: this.sum(this.product(left.a, right.a), this.product(this.product(left.b, right.b), d)),
      b: this.sum(this.product(left.a, right.b), this.product(left.b, right.a)) };
  }

  divide(left: QuadraticValue, right: QuadraticValue): QuadraticValue {
    if (this.isZero(right)) throw new MathInputProblem('domain', '固有値の式で0による除算が発生しました。');
    const conjugate = { a: right.a, b: this.value(-right.b.numerator, right.b.denominator) };
    const denominator = this.multiply(right, conjugate).a;
    if (denominator.numerator === 0n) throw new MathInputProblem('domain', '固有値の分母を0以外と確定できません。');
    const numerator = this.multiply(left, conjugate);
    return { a: this.value(numerator.a.numerator * denominator.denominator, numerator.a.denominator * denominator.numerator),
      b: this.value(numerator.b.numerator * denominator.denominator, numerator.b.denominator * denominator.numerator) };
  }

  private squareRoot(d: ExactRational): QuadraticValue {
    const root = (value: ExactRational): ExactRational | null => rationalOfExpression({
      kind: 'operation', operation: 'sqrt', operands: [exactLinearNode(value)],
    });
    const perfect = root(d);
    if (perfect !== null) return this.scalar(perfect);
    if (this.radicand === null) { this.radicand = d; return { a: ZERO, b: ONE }; }
    // Principal roots with the same sign share a field iff their ratio is a rational square.
    const ratio = this.value(d.numerator * this.radicand.denominator, d.denominator * this.radicand.numerator);
    const factor = root(ratio);
    if (factor === null) throw new MathInputProblem('unsupported', 'この固有値は複数の独立な平方根を含みます。二次代数数の範囲では確定しません。');
    return { a: ZERO, b: factor };
  }

  read(source: MathNode): QuadraticValue {
    let nodes = 4096;
    const visit = (node: MathNode, depth: number): QuadraticValue => {
      if (--nodes < 0 || depth > 64) throw new MathInputProblem('budget', '固有値の式が複雑すぎます。');
      if (node.kind === 'number') {
        const value = decimalRational(node.decimal);
        if (value === null) throw new MathInputProblem('budget', '固有値の桁数が上限を超えました。');
        return this.scalar(value);
      }
      if (node.kind === 'constant' && node.name === 'imaginary-unit') return this.squareRoot({ numerator: -1n, denominator: 1n });
      if (node.kind !== 'operation') throw new MathInputProblem('unsupported', '固有値には有理数または一つの平方根で表せる二次代数数を指定してください。');
      if (node.operation === 'sqrt' && node.operands.length === 1) {
        const d = rationalOfExpression(node.operands[0]);
        if (d === null) throw new MathInputProblem('unsupported', '固有値の平方根の中は有理数で指定してください。');
        return this.squareRoot(d);
      }
      const values = node.operands.map(operand => visit(operand, depth + 1));
      if (node.operation === 'negate' && values.length === 1) return this.negate(values[0]);
      if (node.operation === 'square' && values.length === 1) return this.multiply(values[0], values[0]);
      if (node.operation === 'subtract' && values.length === 2) return this.subtract(values[0], values[1]);
      if (node.operation === 'divide' && values.length === 2) return this.divide(values[0], values[1]);
      if (node.operation === 'add') return values.reduce((sum, value) => this.add(sum, value), this.zero);
      if (node.operation === 'multiply') return values.reduce((product, value) => this.multiply(product, value), this.one);
      if (node.operation === 'power' && values.length === 2 && values[1].b.numerator === 0n
          && values[1].a.denominator === 1n) {
        let power = values[1].a.numerator;
        if (power < -256n || power > 256n) throw new MathInputProblem('budget', '固有値の整数冪は絶対値256以内で指定してください。');
        if (power === 0n && this.isZero(values[0])) throw new MathInputProblem('domain', '固有値の0の0乗は定義していません。');
        let base = power < 0n ? this.divide(this.one, values[0]) : values[0], result = this.one;
        if (power < 0n) power = -power;
        while (power > 0n) {
          if (power % 2n === 1n) result = this.multiply(result, base);
          power /= 2n;
          if (power > 0n) base = this.multiply(base, base);
        }
        return result;
      }
      throw new MathInputProblem('unsupported', 'この固有値の演算は有理数と二次代数数の厳密な計算に対応していません。');
    };
    return visit(source, 0);
  }

  node(value: QuadraticValue): MathNode {
    if (value.b.numerator === 0n) return exactLinearNode(value.a);
    if (this.radicand === null) throw new Error('Missing quadratic field');
    const root: MathNode = { kind: 'operation', operation: 'sqrt', operands: [exactLinearNode(this.radicand)] };
    const radical: MathNode = value.b.numerator === value.b.denominator ? root
      : { kind: 'operation', operation: 'multiply', operands: [exactLinearNode(value.b), root] };
    return value.a.numerator === 0n ? radical : { kind: 'operation', operation: 'add', operands: [exactLinearNode(value.a), radical] };
  }
}
