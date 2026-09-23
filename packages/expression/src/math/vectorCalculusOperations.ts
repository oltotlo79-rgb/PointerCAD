/** Explicit ordered Cartesian coordinates; no inferred metric or coordinate system. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { ScalarInput } from './scalarMathTape.js';

export const VECTOR_CALCULUS_DEFINITIONS = [
  ['gradient', 'Gradient'], ['divergence', 'Divergence'], ['curl', 'Curl'],
  ['laplacian', 'Laplacian'], ['jacobian', 'Jacobian'], ['hessian', 'Hessian'],
] as const;
const ids = new Set<string>(VECTOR_CALCULUS_DEFINITIONS.map(([id]) => id));

export function expandFunctionVectorCalculus(source: MathNode, inputs: readonly ScalarInput[]):
  { readonly expression: MathNode; readonly changed: boolean } {
  let work = 0, changed = false;
  const spend = (depth = 0): void => {
    if (++work > 4096 || depth > 64) throw new MathInputProblem('budget', 'ベクトル解析の式が複雑すぎます。式を分けてください。');
  };
  const op = (operation: string, ...operands: MathNode[]): MathNode => {
    spend(); return { kind: 'operation', operation, operands };
  };
  const diff = (body: MathNode, ...variables: MathNode[]): MathNode => op('differentiate', body, ...variables);
  const list = (values: readonly MathNode[]): MathNode => op('list', ...values);
  const sum = (values: readonly MathNode[]): MathNode => values.length === 1 ? values[0] : op('add', ...values);
  const scalar = (value: MathNode): MathNode => {
    if (value.kind === 'operation' && ['list', 'matrix', 'set', 'interval'].includes(value.operation)) {
      throw new MathInputProblem('domain', 'このベクトル解析の式には数値になる成分を指定してください。');
    }
    return value;
  };
  function visit(node: MathNode, depth: number): MathNode {
    spend(depth);
    if (node.kind !== 'operation') return node;
    const operands = node.operands.map(value => visit(value, depth + 1));
    if (!ids.has(node.operation)) return { ...node, operands };
    changed = true;
    const [body, coordinateList] = operands;
    if (operands.length !== 2 || coordinateList.kind !== 'operation' || coordinateList.operation !== 'list'
        || coordinateList.operands.length < 1 || coordinateList.operands.length > 3) {
      throw new MathInputProblem('domain', '直交座標の変数を [X,Y,Z] のように1〜3個、順序を指定して並べてください。');
    }
    const variables = coordinateList.operands, names = variables.map(variable => {
      if (variable.kind !== 'symbol' || !['axis', 'parameter'].includes(variable.reference.role)) {
        throw new MathInputProblem('domain', '微分する変数には作図の独立変数を指定してください。');
      }
      const ref = variable.reference;
      if ((ref.role !== 'axis' && ref.role !== 'parameter') || !inputs.includes(ref.name)) {
        throw new MathInputProblem('domain', 'この作図で使う独立変数を指定してください。');
      }
      return ref.name;
    });
    if (new Set(names).size !== names.length) throw new MathInputProblem('domain', '直交座標の変数を重複させないでください。');
    if (node.operation === 'gradient') return list(variables.map(variable => diff(scalar(body), variable)));
    if (node.operation === 'laplacian') return sum(variables.map(variable => diff(scalar(body), variable, variable)));
    if (node.operation === 'hessian') return list(variables.map(row => list(variables.map(column => diff(scalar(body), row, column)))));
    if (body.kind !== 'operation' || body.operation !== 'list' || body.operands.length < 1 || body.operands.length > 16) {
      throw new MathInputProblem('domain', 'ベクトルの成分を空でない一覧で指定してください。成分は16個までです。');
    }
    const components = body.operands.map(scalar);
    if (node.operation === 'jacobian') return list(components.map(component => list(variables.map(variable => diff(component, variable)))));
    if (components.length !== variables.length || node.operation === 'curl' && variables.length !== 3) {
      throw new MathInputProblem('domain', '発散は成分と変数を同じ数に、回転はどちらも3個にしてください。');
    }
    if (node.operation === 'divergence') return sum(components.map((component, i) => diff(component, variables[i])));
    return list([0, 1, 2].map(i => {
      const j = (i + 1) % 3, k = (i + 2) % 3;
      return op('subtract', diff(components[k], variables[j]), diff(components[j], variables[k]));
    }));
  }
  return { expression: visit(source, 0), changed };
}
