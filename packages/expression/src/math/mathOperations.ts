import { SET_BOUND_DEFINITIONS } from './setBounds.js';
import { EQUATION_DEFINITIONS } from './equationSolutions.js';
import { INTEGRAL_TRANSFORM_DEFINITIONS } from './integralTransforms.js';
import { DISCRETE_FOURIER_DEFINITIONS } from './discreteFourierTransforms.js';
import { TAYLOR_DEFINITIONS } from './taylorExpansion.js';
import { SEQUENCE_DEFINITIONS } from './sequenceCalculations.js';
import { LINEAR_DEFINITIONS, STATISTICS_DEFINITIONS, TENSOR_DEFINITIONS, INTEGER_DEFINITIONS } from './mathOperationMetadata.js';
import { VECTOR_CALCULUS_DEFINITIONS } from './vectorCalculusOperations.js';
import { VECTOR_CALCULUS_AT_DEFINITIONS } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_DEFINITIONS } from './lineIntegrals.js';
import { REGION_INTEGRAL_DEFINITIONS } from './regionIntegrals.js';
import { GENERAL_PROBABILITY_DEFINITIONS, DISTRIBUTION_DEFINITIONS } from './generalProbability.js';
/** Candidate pure-operation registry. Entries need independent acceptance before product enablement. */
import type { MathOperationDefinition } from './mathInputContract.js';

const definitions: readonly [id: string, head: string, minimum: number, maximum: number, structural?: boolean][] = [
  ...SET_BOUND_DEFINITIONS.map<[string, string, number, number]>(([id, head]) => [id, head, 1, 1]),
  ...EQUATION_DEFINITIONS.map<[string, string, number, number]>(([id, head]) => [id, head, 2, 2]),
  ['solution-value', 'Solution', 2, 2],
  ['solve-ode', 'ODESolve', 2, 2], ['ode-value', 'ODEAt', 4, 4], ['partial-equations', 'PDE', 2, 2],
  ['solve-system', 'SolveSystem', 2, 2], ['system-solution', 'SystemSolution', 3, 3],
  ['numerical-roots', 'NumericRoots', 4, 4], ['root-interval', 'RootInterval', 2, 2],
  ...INTEGRAL_TRANSFORM_DEFINITIONS.map<[string, string, number, number]>(([id, head]) => [id, head, 1, 1]),
  ['transform-value', 'TransformAt', 2, 2],
  ['fourier-series', 'FourierSeries', 4, 4],
  ['fourier-value', 'FourierAt', 2, 2], ['fourier-cosine', 'FourierCos', 2, 2], ['fourier-sine', 'FourierSin', 2, 2],
  ...DISCRETE_FOURIER_DEFINITIONS.map<[string, string, number, number]>(([id, head]) => [id, head, 1, 1]),
  ['zeta', 'Zeta', 1, 1],
  ['zetaderivative', 'ZetaDerivative', 2, 2],
  ['elliptick', 'EllipticK', 1, 1], ['elliptice', 'EllipticE', 1, 1], ['ellipticf', 'EllipticF', 2, 2],
  ['ellipticeinc', 'EllipticEinc', 2, 2], ['ellipticpi', 'EllipticPi', 2, 2], ['ellipticpiinc', 'EllipticPiinc', 3, 3],
  ['airyai', 'AiryAi', 1, 1], ['airybi', 'AiryBi', 1, 1], ['airyaiprime', 'AiryAiPrime', 1, 1], ['airybiprime', 'AiryBiPrime', 1, 1],
  ['lambertw', 'LambertW', 2, 2],
  ['besselj', 'BesselJ', 2, 2], ['bessely', 'BesselY', 2, 2], ['besseli', 'BesselI', 2, 2], ['besselk', 'BesselK', 2, 2],
  ['beta', 'Beta', 2, 2], ['gamma', 'Gamma', 1, 1], ['polygamma', 'Polygamma', 2, 2],
  ['erf', 'Erf', 1, 1], ['erfc', 'Erfc', 1, 1],
  ['legendre', 'Legendre', 2, 2],
  ['series-coefficient', 'SeriesCoefficient', 2, 2],
  ...TAYLOR_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
  ...SEQUENCE_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
  ...GENERAL_PROBABILITY_DEFINITIONS.map<[string,string,number,number]>(([id, head]) => [id, head, 2, 2]),
  ...DISTRIBUTION_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
  ...REGION_INTEGRAL_DEFINITIONS.map<[string,string,number,number]>(([id, head]) => [id, head, 4, 4]),
  ...LINE_INTEGRAL_DEFINITIONS.map<[string,string,number,number]>(([id, head]) => [id, head, 4, 4]),
  ...VECTOR_CALCULUS_AT_DEFINITIONS.map<[string,string,number,number]>(([id, head]) => [id, head, 2, 2]),
  ...VECTOR_CALCULUS_DEFINITIONS.map<[string,string,number,number]>(([id, head]) => [id, head, 2, 2]),
  ...INTEGER_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
  ...TENSOR_DEFINITIONS.map<[string,string,number,number]>(([id, head, count]) => [id, head, count, count]),
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
  ['differentiate', 'D', 2, 16], ['differentiate-at', 'DerivativeAt', 3, 3], ['limit', 'Limit', 2, 3],
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
