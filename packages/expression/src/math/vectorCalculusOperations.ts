/** Explicit ordered coordinates and physical components in their orthonormal basis. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import type { ScalarInput } from './scalarMathTape.js';

export const VECTOR_CALCULUS_DEFINITIONS = [
  ['gradient', 'Gradient'], ['divergence', 'Divergence'], ['curl', 'Curl'],
  ['laplacian', 'Laplacian'], ['jacobian', 'Jacobian'], ['hessian', 'Hessian'],
] as const;
const ids = new Set<string>(VECTOR_CALCULUS_DEFINITIONS.map(([id]) => id));
/** Operations whose third operand selects the coordinate system (MC-29). */
export const COORDINATE_SELECTABLE: ReadonlySet<string> = new Set(['gradient', 'divergence', 'curl', 'laplacian']);
/**
 * Keywords for the selectors 0, 1 and 2, read in the selector position and shown for a literal selector
 * (MC-19c). The digits stay readable, so saved sources and existing inputs keep their meaning.
 */
export const VECTOR_COORDINATE_SYSTEMS = ['cartesian', 'cylindrical', 'spherical'] as const;
export type VectorCoordinateSystemName = (typeof VECTOR_COORDINATE_SYSTEMS)[number];

/** Numeric selectors use the existing text/LaTeX grammar: 0 Cartesian, 1 cylindrical, 2 spherical. */
export function vectorCoordinateSystem(selector?: MathNode): 0 | 1 | 2 {
  if (selector === undefined) return 0;
  const value = selector.kind === 'number' ? rationalOfExpression(selector) : null;
  if (value?.denominator === 1n) {
    if (value.numerator === 0n) return 0;
    if (value.numerator === 1n) return 1;
    if (value.numerator === 2n) return 2;
  }
  throw new MathInputProblem('domain', '座標系は cartesian（直交）・cylindrical（円柱 r,θ,z）・spherical（球 r,θ,φ・θは極角）のいずれか、'
    + 'または番号 0・1・2 で指定してください。');
}
/** The keyword that displays a literal selector 0, 1 or 2; any other node keeps its own display. */
export function coordinateSystemKeyword(selector: MathNode | undefined): VectorCoordinateSystemName | null {
  if (selector?.kind !== 'number') return null;
  const value = rationalOfExpression(selector);
  if (value?.denominator !== 1n) return null;
  return value.numerator === 0n ? 'cartesian' : value.numerator === 1n ? 'cylindrical' : value.numerator === 2n ? 'spherical' : null;
}

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
    const [body, coordinateList, selector] = operands;
    const selectable = COORDINATE_SELECTABLE.has(node.operation);
    if ((operands.length !== 2 && !(selectable && operands.length === 3))
        || coordinateList?.kind !== 'operation' || coordinateList.operation !== 'list'
        || coordinateList.operands.length < 1 || coordinateList.operands.length > 3) {
      throw new MathInputProblem('domain', '直交座標の変数を [X,Y,Z] のように1〜3個、順序を指定して並べてください。');
    }
    const system = vectorCoordinateSystem(selector);
    if (system !== 0 && coordinateList.operands.length !== 3) {
      throw new MathInputProblem('domain', '円柱座標は [r,θ,z]、球座標は [r,θ,φ] の順序で3個の変数を指定してください。');
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
    if (system !== 0) return curvilinear(node.operation, body, variables, system);
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
  function curvilinear(operation: string, body: MathNode, variables: readonly MathNode[], system: 1 | 2): MathNode {
    const one: MathNode = { kind: 'number', decimal: '1' }, zero: MathNode = { kind: 'number', decimal: '0' };
    const [radius, theta] = variables;
    const mul = (...values: MathNode[]): MathNode => op('multiply', ...values);
    const div = (a: MathNode, b: MathNode): MathNode => op('divide', a, b);
    // acos(-1) is a half turn in the saved angle convention. This supplies the
    // radians-per-angle factor without changing the caller's angle semantics.
    const halfTurn = op('arccos', { kind: 'number', decimal: '-1' });
    const angle = div({ kind: 'constant', name: 'pi' }, halfTurn);
    const scales = [one, mul(radius, angle), system === 1 ? one : mul(radius, angle, op('sin', theta))];
    const area = (i: number): MathNode => mul(scales[(i + 1) % 3], scales[(i + 2) % 3]);
    const volume = mul(...scales);
    const gradient = (value: MathNode): MathNode[] => variables.map((variable, i) => div(diff(value, variable), scales[i]));
    const divergence = (values: readonly MathNode[]): MathNode => div(sum(values.map((value, i) =>
      diff(mul(area(i), value), variables[i]))), volume);
    // Derivative guards are collected before zero/component simplification.
    // log imposes the open chart even for a constant or a selected zero result.
    // Differentiate each guard with respect to an independent coordinate: its
    // value is zero, avoiding an artificial 1/r overflow near a regular point.
    const chart = [diff(op('natural-log', radius), theta)];
    if (system === 2) chart.push(diff(op('natural-log', mul(theta, op('subtract', halfTurn, theta))), radius));
    const protect = (value: MathNode): MathNode => sum([value, ...chart.map(guard => mul(zero, guard))]);
    if (operation === 'gradient') return list(gradient(scalar(body)).map(protect));
    if (operation === 'laplacian') return protect(divergence(gradient(scalar(body))));
    if (body.kind !== 'operation' || body.operation !== 'list' || body.operands.length !== 3) {
      throw new MathInputProblem('domain', '円柱・球座標のベクトルは各単位ベクトル方向の数値の成分を3個指定してください。');
    }
    const components = body.operands.map(scalar);
    if (operation === 'divergence') return protect(divergence(components));
    return list([0, 1, 2].map(i => {
      const j = (i + 1) % 3, k = (i + 2) % 3;
      return protect(div(op('subtract', diff(mul(scales[k], components[k]), variables[j]),
        diff(mul(scales[j], components[j]), variables[k])), area(i)));
    }));
  }
  return { expression: visit(source, 0), changed };
}
