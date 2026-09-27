/** Keep the legacy parameter alphabet and mathematical labels consistent without allowing LaTeX commands. */
import { isIdentifierPart } from '../tokenize.js';
import { MathInputProblem } from './mathInputContract.js';

export function mathLatexLabel(value: string): string {
  if (value.length < 1 || value.length > 128 || !Array.from(value).every(character =>
    isIdentifierPart(character) || /^[_\p{L}\p{M}\p{N}]$/u.test(character))) {
    throw new MathInputProblem('syntax', '数式の記号名に使えない文字があります。');
  }
  return value.replaceAll('_', String.raw`\_`);
}
