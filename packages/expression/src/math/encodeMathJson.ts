/** Pure boundary back to the computation engine; only the application's validated AST enters here. */
import { MathInputProblem, type MathBinding, type MathNode, type MathOperationDefinition } from './mathInputContract.js';
import { engineSymbolOf } from './mathSymbolScope.js';

export type EngineMathJson = string | { num: string } | [string, ...EngineMathJson[]];
type ConstantName = Extract<MathNode, { readonly kind: 'constant' }>['name'];
const CONSTANTS: Readonly<Record<ConstantName, string>> = {
  pi: 'Pi', e: 'ExponentialE', 'imaginary-unit': 'ImaginaryUnit', infinity: 'PositiveInfinity',
  true: 'True', false: 'False', 'real-numbers': 'RealNumbers', 'complex-numbers': 'ComplexNumbers',
  integers: 'Integers', naturals: 'NonNegativeIntegers', rationals: 'RationalNumbers', 'empty-set': 'EmptySet',
};

/** bindings have already been lexicalized; no free variable can capture a sum/integral dummy. */
export function encodeMathJson(node: MathNode, byId: ReadonlyMap<string, MathOperationDefinition>): EngineMathJson {
  switch (node.kind) {
    case 'number': return { num: node.decimal };
    case 'constant': return CONSTANTS[node.name];
    case 'symbol': return engineSymbolOf(node.reference);
    case 'operation': {
      const operation = byId.get(node.operation);
      if (!operation || !operation.pure) throw new MathInputProblem('unsupported', '演算の定義を確認できません。');
      if (node.operation === 'rank') {
        // The pinned engine's Rank reports tensor depth (2 for a dependent 2x2 matrix).
        // Matrix rank must pass our row-reduction boundary before engine evaluation.
        throw new MathInputProblem('unsupported', '行列の階数は行基本変形で求めてください。');
      }
      if (node.operation === 'root' && node.operands.length === 2 && node.operands[0] && node.operands[1]) {
        const value=encodeMathJson(node.operands[0],byId),degree=encodeMathJson(node.operands[1],byId);
        const zero:EngineMathJson={num:'0'},one:EngineMathJson={num:'1'},two:EngineMathJson={num:'2'};
        // Retain the existing real-root convention: positive radicands allow a
        // nonzero real degree; negative radicands need an odd integer degree.
        // The engine's Root(-8,1.5) returns -4, which is invalid under that convention.
        const undefinedValue:EngineMathJson=['Divide',zero,zero],reciprocal:EngineMathJson=['Divide',one,degree];
        return ['Which',['Equal',degree,zero],undefinedValue,
          ['GreaterEqual',value,zero],['Power',value,reciprocal],
          ['And',['Element',degree,'Integers'],['NotEqual',['Mod',degree,two],zero]],
          ['Negate',['Power',['Negate',value],reciprocal]],'True',undefinedValue];
      }
      if (node.operation === 'double-factorial' && node.operands.length === 1 && node.operands[0]) {
        const operand = encodeMathJson(node.operands[0], byId);
        // Preserve (-1)!! = 1, including inside a bounded sum. Domain validation
        // still rejects values below -1 and nonintegers before simplification.
        return ['Which', ['Equal', operand, { num: '-1' }], { num: '1' }, 'True', ['Factorial2', operand]];
      }
      return [operation.engineHead, ...node.operands.map(operand => encodeMathJson(operand, byId))];
    }
    case 'binder': {
      const operation = byId.get(node.operation);
      if (!operation || node.bindings.length === 0) throw new MathInputProblem('syntax', '局所変数の指定を確認できません。');
      const body = encodeMathJson(node.body, byId);
      if (node.operation === 'for-all' || node.operation === 'exists') {
        const binding = node.bindings[0];
        if (node.bindings.length !== 1 || !binding || binding.domain.kind !== 'set') {
          throw new MathInputProblem('syntax', '量化する変数と集合を指定してください。');
        }
        return [operation.engineHead,
          ['Element', engineSymbolOf(binding.variable), encodeMathJson(binding.domain.value, byId)], body];
      }
      if (node.operation === 'lambda') {
        if (node.bindings.some(binding => binding.domain.kind !== 'unrestricted')) {
          throw new MathInputProblem('syntax', '関数の引数の指定を確認してください。');
        }
        return [operation.engineHead, body, ...node.bindings.map(binding => engineSymbolOf(binding.variable))];
      }
      return [operation.engineHead, body, ...node.bindings.map(binding => encodeIndex(binding, byId))];
    }
  }
}

function encodeIndex(binding: MathBinding, byId: ReadonlyMap<string, MathOperationDefinition>): EngineMathJson {
  const symbol = engineSymbolOf(binding.variable);
  switch (binding.domain.kind) {
    case 'unrestricted': return symbol;
    case 'set': return ['Tuple', symbol, encodeMathJson(binding.domain.value, byId)];
    case 'range': {
      const result: [string, ...EngineMathJson[]] = ['Tuple', symbol,
        encodeMathJson(binding.domain.lower, byId), encodeMathJson(binding.domain.upper, byId)];
      if (binding.domain.step !== null) result.push(encodeMathJson(binding.domain.step, byId));
      return result;
    }
  }
}
