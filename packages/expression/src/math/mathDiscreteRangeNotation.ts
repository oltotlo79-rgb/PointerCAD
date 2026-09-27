/** Preserve a discrete step when the default sigma/product formatter omits it. */
import type { ParsedMathJson as MathJsonExpression } from './mathLatexTokens.js';
import { MathInputProblem, MATH_INPUT_LIMITS } from './mathInputContract.js';
import type { DisplayMathJson } from './mathNotationConversion.js';

export function displaySteppedRanges(expression: DisplayMathJson): DisplayMathJson {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function visit(value: DisplayMathJson, depth: number): DisplayMathJson {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) {
      throw new MathInputProblem('budget', '表示する数式が複雑すぎます。');
    }
    if (typeof value === 'string' || 'num' in value || 'str' in value) return value;
    const head = value[0], operands = value.slice(1).map(child => visit(child, depth + 1));
    const stepped = (head === 'Sum' || head === 'Product')
      && operands.slice(1).some(range => Array.isArray(range) && range[0] === 'Tuple' && range.length === 5);
    return [stepped ? head === 'Sum' ? 'PcadSteppedSum' : 'PcadSteppedProduct' : head, ...operands];
  }
  return visit(expression, 0);
}

export function parseSteppedRanges(operation: 'Sum' | 'Product', args: readonly MathJsonExpression[] | null): MathJsonExpression {
  if (args === null || args.length < 2 || args.length > 16) {
    throw new MathInputProblem('syntax', '和・積の式と範囲を指定してください。');
  }
  const ranges = args.slice(1).map((value): MathJsonExpression => {
    // The display parser represents a parenthesized tuple as Delimiter/Sequence.
    // Only this explicit range notation accepts that shape as a binding domain.
    const parts: readonly MathJsonExpression[] | null = Array.isArray(value) ? value : null;
    const tuple = parts !== null && parts[0] === 'Delimiter'
      && (parts.length === 2 || parts.length === 3) ? parts[1] : value;
    if (!Array.isArray(tuple) || !['Tuple', 'Sequence'].includes(String(tuple[0]))
      || (tuple.length !== 4 && tuple.length !== 5)) {
      throw new MathInputProblem('syntax', '範囲は添字・下端・上端・刻み幅の順で指定してください。');
    }
    const values: readonly MathJsonExpression[] = tuple;
    return ['Tuple', ...values.slice(1)];
  });
  return [operation, args[0], ...ranges];
}
