/** Preserve a discrete step when the default sigma/product formatter omits it. */
import type { ParsedMathJson as MathJsonExpression } from './mathLatexTokens.js';
import { MathInputProblem } from './mathInputContract.js';

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
