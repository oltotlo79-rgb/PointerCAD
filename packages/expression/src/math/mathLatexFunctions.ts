import { differentialEquationNotation } from './differentialEquationNotation.js';
import { EQUATION_DEFINITIONS } from './equationSolutions.js';
import { INTEGRAL_TRANSFORM_DEFINITIONS } from './integralTransforms.js';
/** Explicit application function names; no evaluation, macro expansion or external dictionary. */
import { TAYLOR_DEFINITIONS } from './taylorExpansion.js';
import { SEQUENCE_DEFINITIONS } from './sequenceCalculations.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { LINE_INTEGRAL_DEFINITIONS } from './lineIntegrals.js';
import { REGION_INTEGRAL_DEFINITIONS } from './regionIntegrals.js';
import { VECTOR_CALCULUS_AT_DEFINITIONS } from './vectorCalculusAt.js';
import { GENERAL_PROBABILITY_DEFINITIONS } from './generalProbability.js';
import { MathInputProblem } from './mathInputContract.js';
import { parseSteppedRanges } from './mathDiscreteRangeNotation.js';
import type { ParsedMathJson } from './mathLatexTokens.js';

export const LATEX_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ...[...CANDIDATE_MATH_OPERATIONS.values()].map(operation => [operation.engineHead.toLowerCase(), operation.engineHead] as const),
  ['coef', 'PcadCoefficient'], ['diff', 'D'], ['det', 'Determinant'], ['arcsinh', 'Arsinh'],
  ['arccosh', 'Arcosh'], ['arctanh', 'Artanh'], ['sumstep', 'PcadSteppedSum'], ['productstep', 'PcadSteppedProduct'],
]);
const REGION = new Set<string>(REGION_INTEGRAL_DEFINITIONS.map(([, head]) => head));
const LINE = new Set<string>(LINE_INTEGRAL_DEFINITIONS.map(([, head]) => head));
const VECTOR = new Set<string>(VECTOR_CALCULUS_AT_DEFINITIONS.map(([, head]) => head));
export function latexFunction(head: string, args: readonly ParsedMathJson[]): ParsedMathJson {
  if (head === 'ODESolve' || head === 'PDE') {
    const dependent = args[2], independent = head === 'ODESolve' ? ['List', args[1]] : args[1];
    if (args.length !== 4 || !Array.isArray(dependent) || dependent[0] !== 'List'
      || !Array.isArray(independent) || independent[0] !== 'List') {
      throw new MathInputProblem('syntax', '微分方程式、独立変数、求める関数と条件を指定してください。');
    }
    const inputs: readonly ParsedMathJson[] = independent, outputs: readonly ParsedMathJson[] = dependent;
    if ([...inputs.slice(1), ...outputs.slice(1)].some(value => typeof value !== 'string')) {
      throw new MathInputProblem('syntax', '変数と求める関数を名前で指定してください。');
    }
    return [head, ['Function', differentialEquationNotation(['List', args[0], args[3]], inputs.slice(1), outputs.slice(1)), ...inputs.slice(1), ...outputs.slice(1)],
      { num: String(inputs.length - 1) }];
  }
  if (head === 'SolveSystem') {
    const variables = args[1];
    if (args.length !== 3 || !Array.isArray(variables) || variables[0] !== 'List' || variables.length < 2 || variables.length > 9) {
      throw new MathInputProblem('syntax', '方程式の一覧、未知数の一覧、実数または複素数の範囲を指定してください。');
    }
    const names: readonly ParsedMathJson[] = variables;
    if (names.slice(1).some(value => typeof value !== 'string')) {
      throw new MathInputProblem('syntax', '未知数は名前の一覧で指定してください。');
    }
    return [head, ['Function', args[0], ...names.slice(1)], args[2]];
  }
  if (EQUATION_DEFINITIONS.some(([, name]) => name === head)) {
    if (args.length !== 3 || typeof args[1] !== 'string') throw new MathInputProblem('syntax', '式、未知数と解を求める範囲を指定してください。');
    return [head, ['Function', args[0], args[1]], args[2]];
  }
  if (head === 'Mapping') {
    if (args.length !== 4 || typeof args[1] !== 'string') throw new MathInputProblem('syntax', '写像の式、変数、定義域と出力先の集合を指定してください。');
    return [head, ['Function', args[0], args[1]], ...args.slice(2)];
  }
  if (head === 'NumericRoots') {
    if (args.length !== 5 || typeof args[1] !== 'string') throw new MathInputProblem('syntax', '式、未知数、探索範囲の両端と精度を指定してください。');
    return [head, ['Function', args[0], args[1]], ...args.slice(2)];
  }
  if (head === 'FourierSeries') {
    if (args.length !== 5 || typeof args[1] !== 'string') throw new MathInputProblem('syntax', '級数の式、変数、区間の両端と最高次数を指定してください。');
    return [head, ['Function', args[0], args[1]], ...args.slice(2)];
  }
  const transform = INTEGRAL_TRANSFORM_DEFINITIONS.find(([, name]) => name === head);
  if (transform !== undefined) {
    if (args.length !== 3 || typeof args[1] !== 'string' || typeof args[2] !== 'string') {
      throw new MathInputProblem('syntax', '変換する式、変換前と変換後の変数を指定してください。');
    }
    return [head, ['Function', args[0], args[1], args[2]]];
  }
  const expansion = TAYLOR_DEFINITIONS.find(([, name]) => name === head);
  if (expansion !== undefined) {
    if (args.length !== expansion[2] + 1 || typeof args[1] !== 'string') {
      throw new MathInputProblem('syntax', '展開する式、変数、中心と打切り次数を指定してください。');
    }
    return [head, ['Function', args[0], args[1]], ...args.slice(2)];
  }
  const sequence = SEQUENCE_DEFINITIONS.find(([, name]) => name === head);
  if (sequence !== undefined) {
    const recurrence = sequence[0] === 'recurrence-value', variable = args[1];
    let names: readonly ParsedMathJson[] = [variable];
    if (recurrence) {
      if (!Array.isArray(variable) || variable[0] !== 'List') {
        throw new MathInputProblem('syntax', '漸化式の変数は添字から始まる一覧で指定してください。');
      }
      const list: readonly ParsedMathJson[] = variable;
      names = list.slice(1);
    }
    if (args.length !== sequence[2] + 1 || names.some(value => typeof value !== 'string')
      || (!recurrence && typeof variable !== 'string')) {
      throw new MathInputProblem('syntax', '数列の式、添字と評価条件をすべて指定してください。');
    }
    return [head, ['Function', args[0], ...names], ...args.slice(2)];
  }
  const probability = GENERAL_PROBABILITY_DEFINITIONS.find(([, name]) => name === head);
  if (probability !== undefined) {
    const count = probability[2], variables = args[count];
    if (args.length !== count + 2 || !Array.isArray(variables) || variables[0] !== 'List'
      || variables.length < 2 || variables.length > 9) {
      throw new MathInputProblem('syntax', '計算する式、変数一覧、分布を指定してください。');
    }
    const names: readonly ParsedMathJson[] = variables;
    if (names.slice(1).some(value => typeof value !== 'string')) throw new MathInputProblem('syntax', '局所変数の名前を指定してください。');
    return [head, ['Function', ['List', ...args.slice(0, count)], ...names.slice(1)], args[count + 1]];
  }
  if (head === 'PcadSteppedSum' || head === 'PcadSteppedProduct') {
    return parseSteppedRanges(head === 'PcadSteppedSum' ? 'Sum' : 'Product', args);
  }
  if (REGION.has(head)) {
    const coordinates = args[1], parameters = args[3];
    if (args.length !== 6 || !Array.isArray(coordinates) || coordinates[0] !== 'List'
      || !Array.isArray(parameters) || parameters[0] !== 'List') {
      throw new MathInputProblem('syntax', '量または場、座標変数、座標式、媒介変数、下限と上限を一覧で指定してください。');
    }
    const names: readonly ParsedMathJson[] = coordinates, bindings: readonly ParsedMathJson[] = parameters;
    return [head, ['Function', args[0], ...names.slice(1)], ['Function', args[2], ...bindings.slice(1)], args[4], args[5]];
  }
  if (LINE.has(head) || VECTOR.has(head)) {
    const variables = args[1];
    if (args.length !== (LINE.has(head) ? 6 : 3) || !Array.isArray(variables)
      || variables[0] !== 'List' || variables.length < 2 || variables.length > 4) {
      throw new MathInputProblem('syntax', '式、変数一覧と評価する範囲を指定してください。');
    }
    const names: readonly ParsedMathJson[] = variables;
    return LINE.has(head)
      ? [head, ['Function', args[0], ...names.slice(1)], ['Function', args[2], args[3]], args[4], args[5]]
      : [head, ['Function', args[0], ...names.slice(1)], args[2]];
  }
  if (head === 'LimSup' || head === 'LimInf') {
    if (args.length < 3 || args.length > 5 || typeof args[1] !== 'string') {
      throw new MathInputProblem('syntax', '上極限・下極限の式、変数、近づける値と必要な方向・範囲を指定してください。');
    }
    return [head, ['Function', args[0], args[1]], ...args.slice(2)];
  }
  if (head === 'DerivativeAt') {
    if (args.length !== 3 && args.length !== 4) throw new MathInputProblem('syntax', '微分する式、変数、位置、回数を指定してください。');
    return [head, ['Function', args[0], args[1]], args[2], args[3] ?? 1];
  }
  if (head === 'ForAll' || head === 'Exists') {
    // Mirror mathTextSyntax.ts's forall/exists: bind the variable and its finite set with
    // Element before decodeMathJson.ts sees it, instead of a flat 3-argument call.
    // A presentation round trip re-parses this function's own \in serialization of the
    // stored Element pair, so an already-bound first argument passes through unchanged.
    if (args.length === 2 && Array.isArray(args[0]) && args[0].length === 3 && args[0][0] === 'Element') {
      return [head, args[0], args[1]];
    }
    if (args.length !== 3 || typeof args[0] !== 'string') {
      throw new MathInputProblem('syntax', '量化する変数、集合、条件を指定してください。');
    }
    return [head, ['Element', args[0], args[1]], args[2]];
  }
  return [head, ...args];
}
