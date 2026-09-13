/** The explicit editor entry converts old identifiers and units structurally; opening alone never alters a document. */
import { parse } from '../parse.js';
import { legacyMathToDefinition, type LegacyMathNames } from './legacyMathBridge.js';
import { formatMathText } from './formatMathText.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

export function prepareLegacyMathInput(source: string, names: LegacyMathNames): string {
  return formatMathText(legacyMathToDefinition(parse(source), names).expression, CANDIDATE_MATH_BY_ID);
}
