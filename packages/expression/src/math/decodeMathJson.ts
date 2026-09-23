import { numericalRootFunction } from './numericalRootResult.js';
import { equationSystemFunction } from './equationSystems.js';
import { differentialEquationProblem } from './differentialEquations.js';
import { EQUATION_IDS, equationFunction } from './equationSolutions.js';
import { FOURIER_SERIES_ID, fourierSeriesFunction } from './fourierSeries.js';
import { INTEGRAL_TRANSFORM_IDS, transformFunction } from './integralTransforms.js';
import { TAYLOR_IDS, taylorFunction } from './taylorExpansion.js';
/** Convert validated, noncanonical parser output into the application's own immutable math nodes. */
import { SEQUENCE_IDS, sequenceFunction } from './sequenceCalculations.js';
import { MathInputProblem, validateRawMath, type MathBinding, type MathNode,
  type MathOperationDefinition } from './mathInputContract.js';
import { MathSymbolScope, type MathNameContext } from './mathSymbolScope.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { VECTOR_CALCULUS_AT_IDS, vectorCalculusAtBounds } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_IDS, validateLineIntegral } from './lineIntegrals.js';
import { REGION_INTEGRAL_IDS, validateRegionIntegral } from './regionIntegrals.js';
import { GENERAL_PROBABILITY_IDS, probabilityFunction } from './generalProbability.js';

function recordOf(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isSequence(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function sequenceOf(value: unknown): readonly unknown[] | null {
  if (isSequence(value)) return value;
  return recordOf(value) && isSequence(value.fn) ? value.fn : null;
}
function symbolOf(value: unknown): string | null {
  if (typeof value === 'string' && !value.startsWith("'")) return value;
  return recordOf(value) && typeof value.sym === 'string' ? value.sym : null;
}
function stringOf(value: unknown): string | null {
  if (typeof value === 'string' && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return recordOf(value) && typeof value.str === 'string' ? value.str : null;
}
function unwrapDelimiter(value: unknown): unknown {
  const sequence = sequenceOf(value);
  return sequence?.[0] === 'Delimiter' && sequence.length === 2 ? sequence[1] : value;
}

export interface DecodeMathOptions {
  readonly names: MathNameContext;
  readonly operations: ReadonlyMap<string, MathOperationDefinition>;
  /** Only true for products already visible as distinct atoms in the structural editor. */
  readonly allowRenderedProducts: boolean;
  /** Text aliases are resolved after local bindings, so sum(...,i,...) does not overwrite imaginary i. */
  readonly symbolNotation?:'text'|'engine';
  /** Only coefficients whose declarations guarantee a scalar value; absent IDs remain ambiguous. */
  readonly scalarCoefficientIds?: ReadonlySet<string>;
  /** Resolve from explicit types or an actual user choice; never guess between vector operations. */
  readonly resolveProduct?: (site: { readonly path: string; readonly token: 'dot' | 'times'; readonly operands: readonly MathNode[] })
    => 'multiply' | 'dot' | 'cross' | null;
}

export function decodeMathJson(input: unknown, options: DecodeMathOptions): MathNode {
  validateRawMath(input, options.operations);
  const rootScope = new MathSymbolScope(options.names);
  const scalarBoundIds = new Set<string>();

  function parse(value: unknown, scope: MathSymbolScope, path: string, scalarFunction = false): MathNode {
    if (typeof value === 'number') return { kind: 'number', decimal: String(value) };
    if (recordOf(value) && typeof value.num === 'string') return { kind: 'number', decimal: value.num };
    const symbol = symbolOf(value);
    if (symbol !== null) return scope.resolve(symbol,options.symbolNotation);
    const items = sequenceOf(value);
    if (!items) throw new MathInputProblem('syntax', 'この位置には数式を入力してください。');
    const head = items[0];
    if (typeof head !== 'string') throw new MathInputProblem('syntax', '演算名を確認できません。');
    const operation = options.operations.get(head);
    if (!operation) throw new MathInputProblem('unsupported', `演算「${head}」の定義を確認してください。`);
    if (operation.id === 'matrix') {
      // Parentheses/brackets are rendering metadata, not another mathematical operand.
      // Determinant/norm notation must arrive with its own operator, never be dropped as a style.
      const style = items.length === 3 ? stringOf(items[2]) : null;
      if (items.length === 3 && style !== '[]' && style !== '()' && style !== '..') {
        throw new MathInputProblem('syntax', '行列の囲みと行列式・ノルムを区別して指定してください。');
      }
      const contents = parse(items[1], scope, `${path}.0`);
      if (contents.kind !== 'operation' || contents.operation !== 'list' || contents.operands.length === 0) {
        throw new MathInputProblem('syntax', '行列の行と列を指定してください。');
      }
      let columns = -1, entries = 0;
      for (const row of contents.operands) {
        if (row.kind !== 'operation' || row.operation !== 'list' || row.operands.length === 0
          || columns >= 0 && columns !== row.operands.length) throw new MathInputProblem('syntax', '行列の各行の成分数を揃えてください。');
        columns = row.operands.length; entries += columns;
        if (entries > 4096) throw new MathInputProblem('budget', '行列の成分が多すぎます。');
      }
      return { kind: 'operation', operation: 'matrix', operands: [contents] };
    }
    if (head === 'Delimiter') return parse(items[1], scope, `${path}.1`);
    if (head === 'PcadCoefficient') {
      const label = stringOf(unwrapDelimiter(items[1]));
      if (label === null) throw new MathInputProblem('syntax', '係数一覧から名前を選んでください。');
      return scope.coefficient(label);
    }
    if (head === 'PcadDotToken' || head === 'PcadTimesToken') {
      const operands = items.slice(1).map((operand, index) => parse(operand, scope, `${path}.${index + 1}`));
      const token = head === 'PcadDotToken' ? 'dot' : 'times';
      const selected = options.resolveProduct === undefined ? resolveTypedMathProduct(token, operands, reference =>
        reference.role === 'axis' || reference.role === 'parameter'
        || (reference.role === 'coefficient' && options.scalarCoefficientIds?.has(reference.id) === true)
        || (reference.role === 'bound' && scalarBoundIds.has(reference.id)))
        : options.resolveProduct({ path, token, operands });
      if (!selected || (token === 'dot' && selected === 'cross') || (token === 'times' && selected === 'dot')) {
        throw new MathInputProblem('unsupported', token === 'dot' ? '「·」の掛け算／内積を指定してください。' : '「×」の掛け算／外積を指定してください。');
      }
      return { kind: 'operation', operation: selected, operands };
    }
    if (head === 'InvisibleOperator') {
      if (items.length === 3 && symbolOf(items[1]) === 'coef') {
        const label = stringOf(unwrapDelimiter(items[2]));
        if (label === null) throw new MathInputProblem('syntax', '係数は係数一覧から名前を選んで挿入してください。');
        return scope.coefficient(label);
      }
      if (!options.allowRenderedProducts) {
        throw new MathInputProblem('syntax', '掛け算は * または × で区切ってください。');
      }
      return { kind: 'operation', operation: 'multiply',
        operands: items.slice(1).map((operand, index) => parse(operand, scope, `${path}.${index + 1}`)) };
    }
    if (head === 'Sum' || head === 'Product' || head === 'Integrate') {
      return indexedBinding(items, operation.id, scope, path);
    }
    if (head === 'ForAll' || head === 'Exists') {
      const declaration = sequenceOf(items[1]);
      if (declaration?.[0] !== 'Element' || declaration.length !== 3) {
        throw new MathInputProblem('syntax', '量化する変数と集合を指定してください。');
      }
      const name = symbolOf(declaration[1]);
      if (!name) throw new MathInputProblem('syntax', '量化する変数名を指定してください。');
      const domain = parse(declaration[2], scope, `${path}.1.2`);
      const bound = scope.bind(name, `${path}.1.1`);
      return { kind: 'binder', operation: operation.id,
        bindings: [{ variable: bound.variable, domain: { kind: 'set', value: domain } }],
        body: parse(items[2], bound.scope, `${path}.2`) };
    }
    if (head === 'Function') {
      const bindings: MathBinding[] = [];
      const seen = new Set<string>();
      let nested = scope;
      for (let index = 2; index < items.length; index += 1) {
        const name = symbolOf(items[index]);
        if (!name || seen.has(name)) throw new MathInputProblem('syntax', '関数の引数名を重複なく指定してください。');
        seen.add(name);
        const bound = nested.bind(name, `${path}.${index}`);
        bindings.push({ variable: bound.variable, domain: { kind: 'unrestricted' } });
        // Calculus and explicit real probability laws declare scalar variables. A generic lambda
        // still permits vector arguments, so its products remain type-checked.
        if (scalarFunction) scalarBoundIds.add(bound.variable.id);
        nested = bound.scope;
      }
      return { kind: 'binder', operation: operation.id, bindings, body: parse(items[1], nested, `${path}.1`) };
    }
    if (head === 'Which' && (items.length - 1) % 2 !== 0) {
      throw new MathInputProblem('syntax', '場合分けの条件と値を対で指定してください。');
    }
    if (head === 'D') {
      const body = parse(items[1], scope, `${path}.1`);
      const variables = items.slice(2).map((value, index) => parse(value, scope, `${path}.${index + 2}`));
      if (variables.some(variable => variable.kind !== 'symbol')) {
        throw new MathInputProblem('syntax', '微分する変数を記号で指定してください。');
      }
      return { kind: 'operation', operation: operation.id, operands: [body, ...variables] };
    }
    if (LINE_INTEGRAL_IDS.has(operation.id) || REGION_INTEGRAL_IDS.has(operation.id)) {
      const value: Extract<MathNode, { kind: 'operation' }> = { kind: 'operation', operation: operation.id,
        operands: items.slice(1).map((item, index) => parse(item, scope, `${path}.${index + 1}`, index < 2)) };
      if (REGION_INTEGRAL_IDS.has(operation.id)) validateRegionIntegral(value);
      else validateLineIntegral(value);
      return value;
    }
    if (operation.id === 'solve-system') {
      const value: MathNode = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true), parse(items[2], scope, `${path}.2`)] };
      equationSystemFunction(value);
      return value;
    }
    if (EQUATION_IDS.has(operation.id)) {
      const value: MathNode = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true), parse(items[2], scope, `${path}.2`)] };
      equationFunction(value);
      return value;
    }
    if (operation.id === 'numerical-roots') {
      const value: MathNode = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true), ...items.slice(2).map((item, index) => parse(item, scope, `${path}.${String(index + 2)}`))] };
      numericalRootFunction(value);
      return value;
    }
    if (operation.id === 'solve-ode' || operation.id === 'partial-equations') {
      const value: MathNode = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, path + '.1', true), parse(items[2], scope, path + '.2')] };
      differentialEquationProblem(value);
      return value;
    }
    if (operation.id === FOURIER_SERIES_ID) {
      const value: MathNode = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true), ...items.slice(2).map((item, index) => parse(item, scope, `${path}.${String(index + 2)}`))] };
      fourierSeriesFunction(value);
      return value;
    }
    if (INTEGRAL_TRANSFORM_IDS.has(operation.id)) {
      const value: Extract<MathNode, { kind: 'operation' }> = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true)] };
      transformFunction(value);
      return value;
    }
    if (TAYLOR_IDS.has(operation.id)) {
      const value: Extract<MathNode, { kind: 'operation' }> = { kind: 'operation', operation: operation.id,
        operands: items.slice(1).map((item, index) => parse(item, scope, `${path}.${index + 1}`, index === 0)) };
      taylorFunction(value);
      return value;
    }
    if (SEQUENCE_IDS.has(operation.id)) {
      const value: Extract<MathNode, { kind: 'operation' }> = { kind: 'operation', operation: operation.id,
        operands: items.slice(1).map((item, index) => parse(item, scope, `${path}.${index + 1}`, index === 0)) };
      sequenceFunction(value);
      return value;
    }
    if (GENERAL_PROBABILITY_IDS.has(operation.id)) {
      const value: Extract<MathNode, { kind: 'operation' }> = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true), parse(items[2], scope, `${path}.2`)] };
      probabilityFunction(value);
      return value;
    }
    if (VECTOR_CALCULUS_AT_IDS.has(operation.id)) {
      const value: Extract<MathNode, { kind: 'operation' }> = { kind: 'operation', operation: operation.id,
        operands: [parse(items[1], scope, `${path}.1`, true), parse(items[2], scope, `${path}.2`)] };
      vectorCalculusAtBounds(value);
      return value;
    }
    if (head === 'Limit' || head === 'DerivativeAt') {
      const body = parse(items[1], scope, `${path}.1`, head === 'DerivativeAt');
      if (body.kind !== 'binder' || body.operation !== 'lambda' || body.bindings.length !== 1) {
        throw new MathInputProblem('syntax', '計算する式の変数を1つと、値を調べる位置を指定してください。');
      }
      return { kind: 'operation', operation: operation.id,
        operands: [body, ...items.slice(2).map((value, index) => parse(value, scope, `${path}.${index + 2}`))] };
    }
    if (operation.structural && head !== 'Open') {
      throw new MathInputProblem('syntax', `「${head}」をこの位置の値として使用できません。`);
    }
    return { kind: 'operation', operation: operation.id,
      operands: items.slice(1).map((operand, index) => parse(operand, scope, `${path}.${index + 1}`)) };
  }

  function indexedBinding(items: readonly unknown[], operation: string, scope: MathSymbolScope, path: string): MathNode {
    let nested = scope;
    const bindings: MathBinding[] = [];
    const seen = new Set<string>();
    for (let index = 2; index < items.length; index += 1) {
      const item = items[index];
      const range = sequenceOf(item);
      const name = symbolOf(range?.[0] === 'Tuple' ? range[1] : item);
      if (!name || seen.has(name)) throw new MathInputProblem('syntax', '積分や総和の変数名を重複なく指定してください。');
      seen.add(name);
      let domain: MathBinding['domain'];
      if (range?.[0] === 'Tuple' && (range.length === 4 || range.length === 5)) {
        if (operation === 'integrate' && range.length === 5) throw new MathInputProblem('syntax', '積分の範囲に刻み幅は指定できません。');
        domain = { kind: 'range', lower: parse(range[2], nested, `${path}.${index}.2`),
          upper: parse(range[3], nested, `${path}.${index}.3`),
          step: range.length === 5 ? parse(range[4], nested, `${path}.${index}.4`) : null };
      } else if (symbolOf(item) !== null && operation === 'integrate') {
        domain = { kind: 'unrestricted' };
      } else {
        throw new MathInputProblem('syntax', '積分や総和の下限と上限を指定してください。');
      }
      const bound = nested.bind(name, `${path}.${index}.1`);
      scalarBoundIds.add(bound.variable.id);
      bindings.push({ variable: bound.variable, domain });
      nested = bound.scope;
    }
    return { kind: 'binder', operation, bindings, body: parse(items[1], nested, `${path}.1`) };
  }

  return parse(input, rootScope, '0');
}
