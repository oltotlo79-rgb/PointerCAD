import { numericalRootFunction } from './numericalRootResult.js';
import { equationSystemFunction } from './equationSystems.js';
import { differentialEquationProblem } from './differentialEquations.js';
import { EQUATION_DEFINITIONS, EQUATION_IDS, equationFunction } from './equationSolutions.js';
import { FOURIER_SERIES_ID, fourierSeriesFunction } from './fourierSeries.js';
import { INTEGRAL_TRANSFORM_IDS, transformFunction } from './integralTransforms.js';
import { TAYLOR_IDS, taylorFunction } from './taylorExpansion.js';
/** Explicit text preserves operation identity. The caller reparses it before replacing a user's input. */
import { SEQUENCE_IDS, sequenceFunction } from './sequenceCalculations.js';
import { MATH_INPUT_LIMITS, MathInputProblem, validateMathSource, type MathNode, type MathOperationDefinition } from './mathInputContract.js';
import { VECTOR_CALCULUS_AT_IDS, vectorCalculusAtBounds } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_IDS, validateLineIntegral } from './lineIntegrals.js';
import { REGION_INTEGRAL_IDS, validateRegionIntegral } from './regionIntegrals.js';
import { GENERAL_PROBABILITY_IDS, probabilityFunction } from './generalProbability.js';

const CONSTANTS: Readonly<Record<Extract<MathNode, { kind: 'constant' }>['name'], string>> = {
  pi: 'pi', e: 'e', 'imaginary-unit': 'i', infinity: '∞', true: 'true', false: 'false',
  'real-numbers': 'ℝ', 'complex-numbers': 'ℂ', integers: 'ℤ', naturals: 'ℕ', rationals: 'ℚ', 'empty-set': '∅',
};

export function formatMathText(expression: MathNode, operations: ReadonlyMap<string, MathOperationDefinition>): string {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function format(node: MathNode, depth: number): string {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '表示する数式が複雑すぎます。');
    if (node.kind === 'number') return node.decimal;
    if (node.kind === 'constant') return CONSTANTS[node.name];
    if (node.kind === 'symbol') {
      const reference = node.reference;
      if (reference.role === 'coefficient') return `coef(${JSON.stringify(reference.label)})`;
      return reference.role === 'axis' || reference.role === 'parameter' ? reference.name : reference.label;
    }
    const operation = operations.get(node.operation);
    if (!operation || operation.structural) throw new MathInputProblem('unsupported', 'この演算のテキスト表記を確認できません。');
    if (node.kind === 'operation') {
      if (node.operation === 'interval') {
        if (node.operands.length !== 2) throw new MathInputProblem('syntax', '区間には二つの端点が必要です。');
        const ends = node.operands.map(endpoint => {
          if (endpoint.kind !== 'operation' || endpoint.operation !== 'open-endpoint') return format(endpoint, depth + 1);
          if (endpoint.operands.length !== 1) throw new MathInputProblem('syntax', '開いた端点の値を一つ指定してください。');
          // Open is structural only here; it must not become a standalone scalar.
          return `open(${format(endpoint.operands[0], depth + 2)})`;
        });
        return `interval(${ends.join(',')})`;
      }
      if (node.operation === 'solve-ode' || node.operation === 'partial-equations') {
        const problem = differentialEquationProblem(node), names = problem.fn.bindings.map(binding => binding.variable.label);
        const independent = problem.independentCount === 1 ? names[0] : '[' + names.slice(0, problem.independentCount).join(',') + ']';
        return operation.engineHead.toLowerCase() + '(' + [
          format(problem.equations, depth + 1), independent,
          '[' + names.slice(problem.independentCount).join(',') + ']', format(problem.conditions, depth + 1),
        ].join(',') + ')';
      }
      if (node.operation === 'solve-system') {
        const fn = equationSystemFunction(node);
        return `solvesystem(${format(fn.body, depth + 1)},[${fn.bindings.map(binding => binding.variable.label).join(',')}],${format(node.operands[1], depth + 1)})`;
      }
      if (EQUATION_IDS.has(node.operation)) {
        const fn = equationFunction(node), head = EQUATION_DEFINITIONS.find(([id]) => id === node.operation)?.[1];
        if (head === undefined) throw new MathInputProblem('syntax', '方程式の演算名を確認してください。');
        return `${head.toLowerCase()}(${format(fn.body, depth + 1)},${fn.bindings[0].variable.label},${format(node.operands[1], depth + 1)})`;
      }
      if (node.operation === 'numerical-roots') {
        const fn = numericalRootFunction(node);
        return `numericroots(${[format(fn.body, depth + 1), fn.bindings[0].variable.label, ...node.operands.slice(1).map(item => format(item, depth + 1))].join(',')})`;
      }
      if (node.operation === FOURIER_SERIES_ID) {
        const fn = fourierSeriesFunction(node);
        return `fourierseries(${[format(fn.body, depth + 1), fn.bindings[0].variable.label, ...node.operands.slice(1).map(item => format(item, depth + 1))].join(',')})`;
      }
      if (INTEGRAL_TRANSFORM_IDS.has(node.operation)) {
        const fn = transformFunction(node);
        return `${operation.engineHead.toLowerCase()}(${[format(fn.body, depth + 1), ...fn.bindings.map(binding => binding.variable.label)].join(',')})`;
      }
      if (TAYLOR_IDS.has(node.operation)) {
        const fn = taylorFunction(node);
        return `${operation.engineHead.toLowerCase()}(${[format(fn.body, depth + 1), fn.bindings[0].variable.label,
          ...node.operands.slice(1).map(child => format(child, depth + 1))].join(',')})`;
      }
      if (SEQUENCE_IDS.has(node.operation)) {
        const fn = sequenceFunction(node), names = fn.bindings.map(binding => binding.variable.label);
        const variables = node.operation === 'recurrence-value' ? `[${names.join(',')}]` : names[0];
        return `${operation.engineHead.toLowerCase()}(${[format(fn.body, depth + 1), variables,
          ...node.operands.slice(1).map(child => format(child, depth + 1))].join(',')})`;
      }
      if (GENERAL_PROBABILITY_IDS.has(node.operation)) {
        const fn = probabilityFunction(node);
        if (fn.body.kind !== 'operation') throw new MathInputProblem('syntax', '確率の式一覧を指定してください。');
        const args = [...fn.body.operands.map(child => format(child, depth + 1)),
          `[${fn.bindings.map(binding => binding.variable.label).join(',')}]`, format(node.operands[1], depth + 1)];
        return `${operation.engineHead.toLowerCase()}(${args.join(',')})`;
      }
      if (REGION_INTEGRAL_IDS.has(node.operation)) {
        validateRegionIntegral(node);
        const [field, mapping, lower, upper] = node.operands;
        if (field.kind !== 'binder' || mapping.kind !== 'binder') throw new MathInputProblem('syntax', '場と座標式を指定してください。');
        const args = [format(field.body, depth + 1), `[${field.bindings.map(binding => binding.variable.label).join(',')}]`,
          format(mapping.body, depth + 1), `[${mapping.bindings.map(binding => binding.variable.label).join(',')}]`,
          format(lower, depth + 1), format(upper, depth + 1)];
        return `${operation.engineHead.toLowerCase()}(${args.join(',')})`;
      }
      if (LINE_INTEGRAL_IDS.has(node.operation)) {
        validateLineIntegral(node);
        const [field, path, lower, upper] = node.operands;
        if (field.kind !== 'binder' || path.kind !== 'binder') throw new MathInputProblem('syntax', '場と曲線を指定してください。');
        const args = [format(field.body, depth + 1), `[${field.bindings.map(binding => binding.variable.label).join(',')}]`,
          format(path.body, depth + 1), path.bindings[0].variable.label, format(lower, depth + 1), format(upper, depth + 1)];
        return `${operation.engineHead.toLowerCase()}(${args.join(',')})`;
      }
      if (VECTOR_CALCULUS_AT_IDS.has(node.operation)) {
        vectorCalculusAtBounds(node);
        const [fn, target] = node.operands;
        if (fn.kind !== 'binder') throw new MathInputProblem('syntax', '微分する変数を指定してください。');
        return `${operation.engineHead.toLowerCase()}(${format(fn.body, depth + 1)},[${fn.bindings.map(binding => binding.variable.label).join(',')}],${format(target, depth + 1)})`;
      }
      if (node.operation === 'differentiate-at') {
        const [fn, target, order] = node.operands;
        if (node.operands.length !== 3 || fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1) {
          throw new MathInputProblem('syntax', '微分する変数、位置、回数を確認してください。');
        }
        return `derivativeat(${format(fn.body, depth + 1)},${fn.bindings[0].variable.label},${format(target, depth + 1)},${format(order, depth + 1)})`;
      }
      if (node.operation === 'limit') {
        const [fn, target] = node.operands;
        if ((node.operands.length !== 2 && node.operands.length !== 3) || fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1) {
          throw new MathInputProblem('unsupported', '片側極限の入力設定を保持できないため元の表記を残しました。');
        }
        const direction = node.operands.length === 3 ? `,${format(node.operands[2], depth + 1)}` : '';
        return `limit(${format(fn.body, depth + 1)},${fn.bindings[0].variable.label},${format(target, depth + 1)}${direction})`;
      }
      return `${operation.engineHead}(${node.operands.map(child => format(child, depth + 1)).join(',')})`;
    }
    if (node.operation === 'lambda') {
      if (node.bindings.some(binding => binding.domain.kind !== 'unrestricted')) throw new MathInputProblem('syntax', '関数の変数設定が不正です。');
      return `Function(${format(node.body, depth + 1)},${node.bindings.map(binding => binding.variable.label).join(',')})`;
    }
    if (node.bindings.length !== 1) throw new MathInputProblem('unsupported', '複数変数の範囲を保持するため元の表記を残しました。');
    const binding = node.bindings[0], domain = binding.domain, body = format(node.body, depth + 1);
    if (domain.kind === 'set' && (node.operation === 'for-all' || node.operation === 'exists')) {
      return `${node.operation === 'for-all' ? 'forall' : 'exists'}(${binding.variable.label},${format(domain.value, depth + 1)},${body})`;
    }
    if (domain.kind === 'unrestricted' && node.operation === 'integrate') return `integrate(${body},${binding.variable.label})`;
    if (domain.kind !== 'range') throw new MathInputProblem('unsupported', 'この変数の範囲をテキスト表記へ変換できません。');
    return `${node.operation}(${body},${binding.variable.label},${format(domain.lower, depth + 1)},${format(domain.upper, depth + 1)}${domain.step === null ? '' : ',' + format(domain.step, depth + 1)})`;
  }
  const source = format(expression, 0);
  validateMathSource(source);
  return source;
}
