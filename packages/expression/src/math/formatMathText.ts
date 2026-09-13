/** Explicit text preserves operation identity. The caller reparses it before replacing a user's input. */
import { MATH_INPUT_LIMITS, MathInputProblem, validateMathSource, type MathNode, type MathOperationDefinition } from './mathInputContract.js';

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
      if (node.operation === 'limit') {
        const [fn, target] = node.operands;
        if (node.operands.length !== 2 || fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1) {
          throw new MathInputProblem('unsupported', '片側極限の入力設定を保持できないため元の表記を残しました。');
        }
        return `limit(${format(fn.body, depth + 1)},${fn.bindings[0].variable.label},${format(target, depth + 1)})`;
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
