import { LINEAR_DEFINITIONS } from './exactLinearOperations.js';
/** Candidate pure-operation registry. Entries need independent acceptance before product enablement. */
import { STATISTICS_DEFINITIONS } from './statisticsOperations.js';
import type { MathOperationDefinition } from './mathInputContract.js';

const definitions: readonly [id: string, head: string, minimum: number, maximum: number, structural?: boolean][] = [
  ...LINEAR_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
  ...STATISTICS_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
  ['add', 'Add', 2, 256], ['subtract', 'Subtract', 2, 2], ['negate', 'Negate', 1, 1],
  ['multiply', 'Multiply', 2, 256], ['divide', 'Divide', 2, 2], ['power', 'Power', 2, 2],
  ['sqrt', 'Sqrt', 1, 1], ['root', 'Root', 2, 2], ['square', 'Square', 1, 1],
  ['absolute', 'Abs', 1, 1], ['sign', 'Sign', 1, 1], ['floor', 'Floor', 1, 1],
  ['ceiling', 'Ceil', 1, 1], ['round', 'Round', 1, 2], ['minimum', 'Min', 1, 256], ['maximum', 'Max', 1, 256],
  ['factorial', 'Factorial', 1, 1], ['double-factorial', 'Factorial2', 1, 1],
  ['binomial', 'Binomial', 2, 2], ['gcd', 'GCD', 2, 256], ['lcm', 'LCM', 2, 256], ['modulo', 'Mod', 2, 2],
  ['exponential', 'Exp', 1, 1], ['natural-log', 'Ln', 1, 1], ['log-base', 'Log', 2, 2],
  ['log-two', 'Lb', 1, 1], ['log-ten', 'Lg', 1, 1],
  ['sin', 'Sin', 1, 1], ['cos', 'Cos', 1, 1], ['tan', 'Tan', 1, 1],
  ['cot', 'Cot', 1, 1], ['sec', 'Sec', 1, 1], ['csc', 'Csc', 1, 1],
  ['arcsin', 'Arcsin', 1, 1], ['arccos', 'Arccos', 1, 1], ['arctan', 'Arctan', 1, 1],
  ['sinh', 'Sinh', 1, 1], ['cosh', 'Cosh', 1, 1], ['tanh', 'Tanh', 1, 1],
  ['arsinh', 'Arsinh', 1, 1], ['arcosh', 'Arcosh', 1, 1], ['artanh', 'Artanh', 1, 1],
  ['coth', 'Coth', 1, 1], ['sech', 'Sech', 1, 1], ['csch', 'Csch', 1, 1],
  ['arccot', 'Arccot', 1, 1], ['arcsec', 'Arcsec', 1, 1], ['arccsc', 'Arccsc', 1, 1],
  ['arcoth', 'Arcoth', 1, 1], ['arsech', 'Arsech', 1, 1], ['arcsch', 'Arcsch', 1, 1],
  ['arctan-two', 'Arctan2', 2, 2], ['cis', 'Cis', 1, 1],
  ['reciprocal', 'Reciprocal', 1, 1], ['clamp', 'Clamp', 3, 3],
  ['permutations', 'Permutations', 2, 2], ['component', 'Component', 2, 3],
  ['complex', 'Complex', 2, 2], ['real-part', 'Re', 1, 1], ['imaginary-part', 'Im', 1, 1],
  ['argument', 'Arg', 1, 1], ['conjugate', 'Conjugate', 1, 1],
  ['equal', 'Equal', 2, 256], ['not-equal', 'NotEqual', 2, 256], ['less', 'Less', 2, 256],
  ['less-equal', 'LessEqual', 2, 256], ['greater', 'Greater', 2, 256], ['greater-equal', 'GreaterEqual', 2, 256],
  ['and', 'And', 2, 256], ['or', 'Or', 2, 256], ['not', 'Not', 1, 1],
  ['implies', 'Implies', 2, 2], ['equivalent', 'Equivalent', 2, 256],
  ['which', 'Which', 2, 256], ['element', 'Element', 2, 2], ['set', 'Set', 0, 256],
  ['union', 'Union', 2, 256], ['intersection', 'Intersection', 2, 256], ['set-minus', 'SetMinus', 2, 2],
  ['interval', 'Interval', 2, 2], ['open-endpoint', 'Open', 1, 1, true],
  ['list', 'List', 0, 256], ['tuple', 'Tuple', 1, 256, true],
  ['matrix', 'Matrix', 1, 2], ['determinant', 'Determinant', 1, 1], ['inverse-matrix', 'Inverse', 1, 1],
  ['transpose', 'Transpose', 1, 1], ['conjugate-transpose', 'ConjugateTranspose', 1, 1],
  ['trace', 'Trace', 1, 1], ['rank', 'Rank', 1, 1], ['dot', 'Dot', 2, 2], ['cross', 'Cross', 2, 2],
  ['norm', 'Norm', 1, 2],
  ['sum', 'Sum', 2, 16], ['product', 'Product', 2, 16], ['integrate', 'Integrate', 2, 16],
  ['differentiate', 'D', 2, 16], ['limit', 'Limit', 2, 3],
  ['for-all', 'ForAll', 2, 2], ['exists', 'Exists', 2, 2], ['lambda', 'Function', 2, 16],
  ['delimiter', 'Delimiter', 1, 1, true], ['implicit-operation', 'InvisibleOperator', 2, 256, true],
  ['coefficient-reference', 'PcadCoefficient', 1, 1, true],
  ['dot-token', 'PcadDotToken', 2, 2, true], ['times-token', 'PcadTimesToken', 2, 2, true],
];

export const CANDIDATE_MATH_OPERATIONS: ReadonlyMap<string, MathOperationDefinition> = new Map(
  definitions.map(([id, engineHead, minimumArguments, maximumArguments, structural]) => [engineHead,
    { id, engineHead, minimumArguments, maximumArguments, structural, pure: true }]),
);

export const CANDIDATE_MATH_BY_ID: ReadonlyMap<string, MathOperationDefinition> = new Map(
  [...CANDIDATE_MATH_OPERATIONS.values()].map(operation => [operation.id,
    operation.id === 'matrix' ? { ...operation, maximumArguments: 1 } : operation]),
);
