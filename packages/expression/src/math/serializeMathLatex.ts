/** Lossless display of our finite positive expression grammar. No algebraic rewriting. */
import { MathInputProblem, MATH_INPUT_LIMITS, validateMathSource, validateMathDecimal } from './mathInputContract.js';
import type { DisplayMathJson } from './mathNotationConversion.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { mathLatexLabel } from './mathLatexLabel.js';

const CONSTANTS: Readonly<Record<string, string>> = {
  Pi: '\\pi', ExponentialE: '\\exponentialE', ImaginaryUnit: '\\imaginaryI', PositiveInfinity: '\\infty',
  RealNumbers: '\\mathbb{R}', ComplexNumbers: '\\mathbb{C}', Integers: '\\mathbb{Z}',
  NonNegativeIntegers: '\\mathbb{N}', RationalNumbers: '\\mathbb{Q}', EmptySet: '\\emptyset',
  True: '\\top', False: '\\bot',
};
const BINARY: Readonly<Record<string, string>> = {
  Add: '+', Subtract: '-', Multiply: '\\times ', PcadTimesToken: '\\times ', PcadDotToken: '\\cdot ',
  TensorProduct: '\\otimes ', HadamardProduct: '\\odot ', Equal: '=', NotEqual: '\\ne ', Less: '<',
  LessEqual: '\\le ', Greater: '>', GreaterEqual: '\\ge ', Element: '\\in ', Union: '\\cup ',
  Intersection: '\\cap ', SetMinus: '\\setminus ', And: '\\land ', Or: '\\lor ',
  Implies: '\\implies ', Equivalent: '\\iff ',
};
const wrap = (value: string): string => '\\left(' + value + '\\right)';
export function serializeMathLatex(expression: DisplayMathJson): string {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function visit(value: DisplayMathJson, depth: number): string {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '表示する数式が複雑すぎます。');
    if (typeof value === 'string') {
      if (CONSTANTS[value]) return CONSTANTS[value];
      const name = mathLatexLabel(value);
      return /^[A-Za-z]$/u.test(name) ? name : '\\mathit{' + name + '}';
    }
    if ('num' in value) { validateMathDecimal(value.num); return value.num; }
    if ('str' in value) return '\\text{' + mathLatexLabel(value.str) + '}';
    const head = value[0], operands = value.slice(1), args = operands.map(child => visit(child, depth + 1));
    const a = args[0], b = args[1];
    if (head === 'List') return '\\left[' + args.join(',') + '\\right]';
    if (head === 'Tuple') return wrap(args.join(','));
    if (head === 'Set') return '\\left\\{' + args.join(',') + '\\right\\}';
    if (head === 'Delimiter' && args.length === 1) return wrap(a);
    if (BINARY[head] && args.length === 2) return wrap(a) + BINARY[head] + wrap(b);
    if (head === 'Divide' && args.length === 2) return '\\frac{' + a + '}{' + b + '}';
    if (head === 'Power' && args.length === 2) return '{' + wrap(a) + '}^{' + b + '}';
    if (head === 'Negate' && args.length === 1) return '-' + wrap(a);
    if (head === 'Sqrt' && args.length === 1) return '\\sqrt{' + a + '}';
    if (head === 'Root' && args.length === 2) return '\\sqrt[' + b + ']{' + a + '}';
    if (head === 'Abs' && args.length === 1) return '\\left|' + a + '\\right|';
    if ((head === 'Factorial' || head === 'Factorial2') && args.length === 1) return '{' + wrap(a) + '}' + (head === 'Factorial' ? '!' : '!!');
    if (head === 'Log' && args.length === 2) return '\\log_{' + b + '}' + wrap(a);
    if (head === 'Lb' || head === 'Lg') return '\\log_{' + (head === 'Lb' ? '2' : '10') + '}' + wrap(a);
    if (head === 'Limit' && (operands.length === 2 || operands.length === 3)) {
      const fn = operands[0], direction = operands[2];
      if (typeof fn !== 'string' && !('num' in fn) && !('str' in fn) && fn[0] === 'Function' && fn.length === 3) {
        const sign = direction !== undefined && typeof direction !== 'string' && 'num' in direction ? direction.num : '0';
        if (!['-1', '0', '1'].includes(sign)) throw new MathInputProblem('syntax', '極限の方向を確認してください。');
        return '\\lim_{' + visit(fn[2], depth + 1) + '\\to ' + b + (sign === '0' ? '' : sign === '1' ? '^{+}' : '^{-}')
          + '}{' + visit(fn[1], depth + 1) + '}';
      }
    }
    if (['Sum', 'Product', 'Integrate'].includes(head) && operands.length === 2) {
      const domain = operands[1];
      if (typeof domain !== 'string' && !('num' in domain) && !('str' in domain)
        && domain[0] === 'Tuple' && domain.length === 4) {
        const [, variable, lower, upper] = domain;
        const label = visit(variable, depth + 1), lo = visit(lower, depth + 1), hi = visit(upper, depth + 1);
        if (head === 'Integrate') return '\\int_{' + lo + '}^{' + hi + '}{' + a + '}\\,\\mathrm{d}' + label;
        return (head === 'Sum' ? '\\sum_{' : '\\prod_{') + label + '=' + lo + '}^{' + hi + '}{' + a + '}';
      }
    }
    if (!CANDIDATE_MATH_OPERATIONS.has(head)) throw new MathInputProblem('unsupported', '表示する演算の定義を確認できません。');
    const name = head === 'PcadCoefficient' ? 'coef' : head === 'D' ? 'diff'
      : head === 'Sum' ? 'sumstep' : head === 'Product' ? 'productstep' : head.toLowerCase();
    return '\\operatorname{' + name + '}' + wrap(args.join(','));
  }
  const source = visit(expression, 0);
  validateMathSource(source);
  return source;
}
