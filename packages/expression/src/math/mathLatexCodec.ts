/** Mathematical display/input is owned by the application and never evaluates source. */
import { parseMathLatex } from './parseMathLatex.js';
import { serializeMathLatex } from './serializeMathLatex.js';
import type { DisplayMathJson } from './mathNotationConversion.js';

export function createMathLatexCodec(): {
  readonly parse: (source: string) => unknown;
  readonly serialize: (expression: DisplayMathJson) => string;
} {
  return { parse: parseMathLatex, serialize: serializeMathLatex };
}
