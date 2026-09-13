/** Convert a validated legacy AST structurally, retaining coefficient identity and the old inch/rad conventions. */
import type { Node } from '../ast.js';
import { lengthUnitFactor } from '../lengthUnits.js';
import { MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';

export interface LegacyMathNames {
  readonly resolveVariable: (name: string) => {
    readonly reference: Extract<MathSymbolReference, { role: 'coefficient' | 'declared' }>;
    readonly kind: 'length' | 'angle' | 'scalar';
  } | null;
}
export interface ConvertedLegacyMath { readonly expression: MathNode; readonly hasExplicitLengthUnit: boolean }
function number(decimal: string): MathNode { return { kind: 'number', decimal }; }
function operation(operation: string, ...operands: MathNode[]): MathNode { return { kind: 'operation', operation, operands }; }

export function legacyMathToDefinition(input: Node, names: LegacyMathNames): ConvertedLegacyMath {
  let remaining = 4096;
  function convert(node: Node, scale: string | null, depth: number): ConvertedLegacyMath {
    remaining -= 1;
    if (remaining < 0 || depth > 64) throw new MathInputProblem('budget', '旧形式の式が複雑すぎます。');
    if (node.kind === 'number') return { expression: number(node.text), hasExplicitLengthUnit: false };
    if (node.kind === 'constant') return { expression: { kind: 'constant', name: node.name }, hasExplicitLengthUnit: false };
    if (node.kind === 'variable') {
      const variable = names.resolveVariable(node.name);
      if (!variable) throw new MathInputProblem('syntax', `係数「${node.name}」が見つかりません。`);
      const symbol: MathNode = { kind: 'symbol', reference: variable.reference };
      return { expression: scale !== null && variable.kind === 'length' ? operation('divide', symbol, number(scale)) : symbol,
        hasExplicitLengthUnit: false };
    }
    if (node.kind === 'unit') {
      if (scale !== null) throw new MathInputProblem('syntax', '長さの単位を入れ子にできません。');
      const factor = lengthUnitFactor(node.unit), inner = convert(node.operand, factor, depth + 1);
      return { expression: operation('multiply', inner.expression, number(factor)), hasExplicitLengthUnit: true };
    }
    if (node.kind === 'unary') {
      const inner = convert(node.operand, scale, depth + 1);
      return { expression: node.operator === '-' ? operation('negate', inner.expression) : inner.expression,
        hasExplicitLengthUnit: inner.hasExplicitLengthUnit };
    }
    if (node.kind === 'binary') {
      const left = convert(node.left, scale, depth + 1), right = convert(node.right, scale, depth + 1);
      const a = left.hasExplicitLengthUnit, b = right.hasExplicitLengthUnit;
      if (((node.operator === '+' || node.operator === '-') && a !== b) || (node.operator === '*' && a && b)
        || (node.operator === '/' && b) || (node.operator === '^' && (a || b))) {
        throw new MathInputProblem('syntax', '旧形式の式の長さの単位が一致しません。');
      }
      const id = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '^': 'power' }[node.operator];
      return { expression: operation(id, left.expression, right.expression), hasExplicitLengthUnit: a || b };
    }
    const args = node.args.map(argument => convert(argument, scale, depth + 1));
    if (args.some(argument => argument.hasExplicitLengthUnit)) throw new MathInputProblem('syntax', '長さの単位は関数の外側に指定してください。');
    const first = args[0]?.expression, second = args[1]?.expression;
    let expression: MathNode;
    if (node.name === 'root' && first && second && args.length === 2) expression = operation('root', first, second);
    else if (!first || args.length !== 1) throw new MathInputProblem('syntax', '旧形式の関数の引数が不正です。');
    else if (node.name === 'sqrt') expression = operation('sqrt', first);
    else if (node.name === 'cbrt') expression = operation('root', first, number('3'));
    else if (node.name === 'abs') expression = operation('absolute', first);
    else if (node.name === 'rad') expression = operation('divide', operation('multiply', first, number('180')), { kind: 'constant', name: 'pi' });
    else throw new MathInputProblem('unsupported', `旧形式の関数「${node.name}」に対応していません。`);
    return { expression, hasExplicitLengthUnit: false };
  }
  return convert(input, null, 0);
}
