/** Pure rewrites give input aliases one explicit mathematical meaning before engine simplification. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { nativeMathProvenUndefined } from './nativeMathBackend.js';

/** 50ms shared across every sibling of one selection; a slow candidate is skipped, not treated as bad. */
function boundedCheck(): () => void {
  const deadline = performance.now() + 50;
  return () => { if (performance.now() > deadline) throw new MathInputProblem('budget', '成分の確認が計算時間を超えました。'); };
}

const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
const op = (operation: string, ...operands: MathNode[]): MathNode => ({ kind: 'operation', operation, operands });
const reciprocal = (value: MathNode): MathNode => op('divide', number('1'), value);

export function normalizeElementaryOperation(node: Extract<MathNode, { kind: 'operation' }>, angleUnit: 'degree' | 'radian'): MathNode {
  const [a, b, c] = node.operands;
  if (node.operation === 'double-factorial' && rationalOfExpression(a)?.numerator === -1n
    && rationalOfExpression(a)?.denominator === 1n) return number('1');
  switch (node.operation) {
    case 'reciprocal': return reciprocal(a);
    case 'coth': return reciprocal(op('tanh', a));
    case 'sech': return reciprocal(op('cosh', a));
    case 'csch': return reciprocal(op('sinh', a));
    case 'arccot': return op('subtract', angleUnit === 'degree' ? number('90')
      : op('divide', { kind: 'constant', name: 'pi' }, number('2')), op('arctan', a));
    case 'arcsec': return op('arccos', reciprocal(a));
    case 'arccsc': return op('arcsin', reciprocal(a));
    case 'arcoth': return op('artanh', reciprocal(a));
    case 'arsech': return op('arcosh', reciprocal(a));
    case 'arcsch': return op('arsinh', reciprocal(a));
    case 'cis': return op('add', op('cos', a), op('multiply', { kind: 'constant', name: 'imaginary-unit' }, op('sin', a)));
    case 'arctan-two': return op('argument', op('complex', b, a));
    case 'permutations': {
      const n = rationalOfExpression(a), k = rationalOfExpression(b);
      if (n !== null && k !== null && n.numerator < k.numerator) throw new MathInputProblem('domain', '順列は0以上の整数で、選ぶ個数を全体の個数以下にしてください。');
      return op('divide', op('factorial', a), op('factorial', op('subtract', a, b)));
    }
    case 'clamp': {
      const lower = rationalOfExpression(b), upper = rationalOfExpression(c);
      if (lower !== null && upper !== null && lower.numerator * upper.denominator > upper.numerator * lower.denominator) {
        throw new MathInputProblem('domain', 'clampの下限は上限以下で指定してください。');
      }
      return op('minimum', op('maximum', a, b), c);
    }
    case 'component': {
      let value = a;
      for (const index of node.operands.slice(1)) {
        const position = rationalOfExpression(index);
        if (position === null || position.denominator !== 1n || position.numerator < 1n || position.numerator > 256n) {
          throw new MathInputProblem('domain', '成分の番号は1から始まる整数で指定してください。');
        }
        if (value.kind === 'operation' && value.operation === 'matrix') value = value.operands[0];
        if (value.kind !== 'operation' || value.operation !== 'list') throw new MathInputProblem('domain', '成分を取り出すベクトルまたは行列を指定してください。');
        const selectedIndex = Number(position.numerator) - 1, selected = value.operands[selectedIndex];
        if (selected === undefined) throw new MathInputProblem('domain', '指定した成分番号が要素数を超えています。');
        // Evaluate every listed component, not only the selected one: like an outer 0, a selection
        // must not silently discard a sibling that numeric evaluation proves undefined.
        const check = boundedCheck();
        value.operands.forEach((sibling, at) => {
          if (at === selectedIndex) return;
          const reason = nativeMathProvenUndefined(sibling, angleUnit, check);
          if (reason !== null) throw new MathInputProblem('domain', reason);
        });
        value = selected;
      }
      return value;
    }
    default: return node;
  }
}
