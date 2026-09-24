/** Shared numerical-input contract. Isolated implementation pending integration and canonical tests. */
export const MATH_INPUT_FORMAT = 'pointercad-math/1' as const;
export const MATH_INPUT_LIMITS = Object.freeze({
  sourceCodeUnits: 16_384,
  nodes: 4_096,
  depth: 64,
  arguments: 256,
  literalDigits: 2_048,
  decimalExponent: 10_000,
  matrixEntries: 4_096,
});

export type MathAxis = 'X' | 'Y' | 'Z';
export type MathParameter = 'T' | 'U' | 'V';
export type MathSymbolReference =
  | { readonly role: 'axis'; readonly name: MathAxis }
  | { readonly role: 'parameter'; readonly name: MathParameter }
  | { readonly role: 'coefficient'; readonly id: string; readonly label: string }
  | { readonly role: 'bound'; readonly id: string; readonly label: string }
  | { readonly role: 'declared'; readonly id: string; readonly label: string };

export type MathValueKind =
  | 'real' | 'complex' | 'boolean' | 'vector' | 'matrix' | 'tensor'
  | 'infinite-bound' | 'set' | 'interval' | 'function' | 'distribution' | 'symbolic' | 'series' | 'transform' | 'fourier-series' | 'equation-system' | 'root-intervals' | 'ode-solutions';

export interface MathOperationDefinition {
  readonly id: string;
  readonly engineHead: string;
  readonly minimumArguments: number;
  readonly maximumArguments: number;
  /** Structural nodes are accepted only while transforming a validated enclosing operation. */
  readonly structural?: boolean;
  readonly pure: true;
}

export type MathNode =
  | { readonly kind: 'number'; readonly decimal: string }
  | { readonly kind: 'constant'; readonly name: 'pi' | 'e' | 'imaginary-unit' | 'infinity' | 'true' | 'false'
      | 'real-numbers' | 'complex-numbers' | 'integers' | 'naturals' | 'rationals' | 'empty-set' }
  | { readonly kind: 'symbol'; readonly reference: MathSymbolReference }
  | { readonly kind: 'operation'; readonly operation: string; readonly operands: readonly MathNode[] }
  | { readonly kind: 'binder'; readonly operation: string; readonly bindings: readonly MathBinding[];
      readonly body: MathNode };

/** Each domain is resolved before its own variable is bound; earlier bindings are visible. */
export interface MathBinding {
  readonly variable: Extract<MathSymbolReference, { readonly role: 'bound' }>;
  readonly domain:
    | { readonly kind: 'range'; readonly lower: MathNode; readonly upper: MathNode; readonly step: MathNode | null }
    | { readonly kind: 'set'; readonly value: MathNode }
    | { readonly kind: 'unrestricted' };
}

export interface StoredMathExpression {
  readonly format: typeof MATH_INPUT_FORMAT;
  readonly source: string;
  readonly inputNotation: 'text' | 'latex';
  readonly angleUnit: 'degree' | 'radian';
  readonly expression: MathNode;
  /** Local definitions travel with the original formula, including their stable IDs and meanings. */
  readonly declarations?: readonly import('./mathDeclarations.js').MathDeclaration[];
}

export type MathEvaluation =
  | { readonly status: 'value'; readonly kind: 'real'; readonly exact: MathNode | null;
      /** Decimal text at the configured precision; rationals such as "16/3" are never stored here. */
      readonly decimal: string; readonly coordinate: number;
      readonly approximation: { readonly absoluteError: number | null;
        /** A quadrature estimate is not a proved bound and cannot authorize a CAD coordinate. */
        readonly estimatedAbsoluteError?: number } | null }
  | { readonly status: 'value'; readonly kind: Exclude<MathValueKind, 'real' | 'series' | 'transform' | 'fourier-series' | 'equation-system' | 'root-intervals' | 'ode-solutions'>; readonly expression: MathNode }
  | { readonly status: 'value'; readonly kind: 'ode-solutions'; readonly expression: MathNode;
      readonly solutions: import('./differentialEquations.js').OdeSolutions }
  | { readonly status: 'value'; readonly kind: 'root-intervals'; readonly expression: MathNode;
      readonly intervals: import('./numericalRootResult.js').NumericalRootIntervals }
  | { readonly status: 'value'; readonly kind: 'equation-system'; readonly expression: MathNode;
      readonly solutions: import('./equationSystems.js').EquationSystemSolutions }
  | { readonly status: 'value'; readonly kind: 'fourier-series'; readonly expression: MathNode;
      readonly series: import('./fourierSeries.js').FourierSeries }
  | { readonly status: 'value'; readonly kind: 'transform'; readonly expression: MathNode;
      readonly transform: import('./integralTransforms.js').IntegralTransform }
  | { readonly status: 'value'; readonly kind: 'series'; readonly expression: MathNode;
      readonly expansion: import('./taylorExpansion.js').TaylorExpansion }
  | { readonly status: 'unresolved'; readonly reason: 'unknown-symbol' | 'missing-condition' | 'unevaluated'; readonly names: readonly string[] }
  | { readonly status: 'invalid'; readonly reason: 'syntax' | 'domain' | 'non-finite' | 'dimension' | 'unit' | 'unsupported' | 'divergent' | 'no-limit' | 'empty-set' | 'no-extremum'; readonly detail: string }
  | { readonly status: 'multiple'; readonly candidates: readonly MathNode[]; readonly exhaustive: boolean }
  | { readonly status: 'stopped'; readonly reason: 'cancelled' | 'deadline' | 'budget' };

export class MathInputProblem extends Error {
  readonly code: 'syntax' | 'domain' | 'budget' | 'forbidden' | 'unsupported';
  constructor(code: MathInputProblem['code'], message: string) {
    super(message);
    this.name = 'MathInputProblem';
    this.code = code;
  }
}

/** Names forbid all C0 characters; expression bodies may contain tabs and line breaks. */
export function hasMathControlCharacters(value: string, allowLineBreaks = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 || code === 127) && !(allowLineBreaks && (code === 9 || code === 10 || code === 13))) return true;
  }
  return false;
}

/** Validate before calling any parser. This does not reinterpret LaTeX grouping as a complete grammar. */
export function validateMathSource(source: string): void {
  if (source.length === 0) throw new MathInputProblem('syntax', '式を入力してください。');
  if (source.length > MATH_INPUT_LIMITS.sourceCodeUnits) {
    throw new MathInputProblem('budget', '式が長すぎます。定義を分けてください。');
  }
  if (hasMathControlCharacters(source, true)) {
    throw new MathInputProblem('syntax', '数式に使えない制御文字が含まれています。');
  }
  let depth = 0;
  let digits = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    // The only purpose is to cap raw syntactic nesting before the third-party parser.
    // Escaped LaTeX braces still consume the conservative resource budget.
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      if (depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '括弧の入れ子が深すぎます。');
    } else if (character === ')' || character === ']' || character === '}') {
      depth = Math.max(0, depth - 1);
    }
    digits = character !== undefined && /[0-9０-９]/u.test(character) ? digits + 1 : 0;
    if (digits > MATH_INPUT_LIMITS.literalDigits) throw new MathInputProblem('budget', '数値の桁数が多すぎます。');
  }
}

const DECIMAL = /^[+-]?([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?$/u;

export function validateMathDecimal(value: string): void {
  if (value.length > MATH_INPUT_LIMITS.literalDigits + 16) {
    throw new MathInputProblem('budget', '数値の桁数が多すぎます。');
  }
  const match = DECIMAL.exec(value);
  if (!match) throw new MathInputProblem('syntax', '数値の表記が正しくありません。');
  if ((match[1]?.replace('.', '').length ?? Infinity) > MATH_INPUT_LIMITS.literalDigits) {
    throw new MathInputProblem('budget', '数値の桁数が多すぎます。');
  }
  const exponent = Number(match[2] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MATH_INPUT_LIMITS.decimalExponent) {
    throw new MathInputProblem('budget', '指数が大きすぎます。');
  }
}

// Public math inputs are expressions. The application owns definitions and coefficient assignment.
const FORBIDDEN_HEADS = new Set([
  'Assign', 'AssignDelayed', 'Declare', 'Assume', 'Forget', 'Block', 'Module',
  'Loop', 'While', 'For', 'Do', 'Break', 'Continue', 'Return', 'Exit',
  'Evaluate', 'EvaluateExpression', 'Parse', 'Compile', 'Apply', 'Call',
  'Random', 'RandomExpression', 'RandomInteger', 'RandomReal', 'SeedRandom',
  'Time', 'Date', 'Now', 'Read', 'Write', 'Print', 'Import', 'Export',
]);

export interface RawMathValidation {
  readonly nodes: number;
  readonly heads: ReadonlySet<string>;
  readonly symbols: ReadonlySet<string>;
}

/**
 * Validate noncanonical MathJSON before canonicalizing or evaluating it.
 * A positive registry is required; adding an engine function does not grant input permission.
 * Container nodes (tuple/list) still need their semantic type checked by the AST conversion.
 */
export function validateRawMath(
  input: unknown,
  operations: ReadonlyMap<string, MathOperationDefinition>,
): RawMathValidation {
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  const heads = new Set<string>();
  const symbols = new Set<string>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    nodes += 1;
    if (nodes > MATH_INPUT_LIMITS.nodes || item.depth > MATH_INPUT_LIMITS.depth) {
      throw new MathInputProblem('budget', '数式の構造が複雑すぎます。');
    }
    const value = item.value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new MathInputProblem('syntax', '有限でない数値は定数として明示してください。');
      continue;
    }
    if (typeof value === 'string') {
      if (value.length === 0 || value.length > MATH_INPUT_LIMITS.sourceCodeUnits) {
        throw new MathInputProblem('budget', '記号名の長さが上限を超えています。');
      }
      symbols.add(value);
      continue;
    }
    if (Array.isArray(value)) {
      const head: unknown = value[0];
      if (typeof head !== 'string') throw new MathInputProblem('syntax', '演算名を確認できません。');
      if (FORBIDDEN_HEADS.has(head)) throw new MathInputProblem('forbidden', 'この欄には値を求める数式を入力してください。');
      const operation = operations.get(head);
      if (!operation || operation.pure !== true) throw new MathInputProblem('unsupported', `演算「${head}」の定義を確認してください。`);
      const count = value.length - 1;
      if (count > MATH_INPUT_LIMITS.arguments || count < operation.minimumArguments || count > operation.maximumArguments) {
        throw new MathInputProblem('syntax', `演算「${head}」の引数の数を確認してください。`);
      }
      heads.add(head);
      for (let index = value.length - 1; index >= 1; index -= 1) {
        pending.push({ value: value[index], depth: item.depth + 1 });
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      const prototype: unknown = Object.getPrototypeOf(value);
      const keys = Object.keys(value);
      if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 1) {
        throw new MathInputProblem('syntax', '数式データの形式が正しくありません。');
      }
      const data = value as Record<string, unknown>;
      if (typeof data.num === 'string') validateMathDecimal(data.num);
      else if (typeof data.sym === 'string' || typeof data.str === 'string') {
        pending.push({ value: data.sym ?? data.str, depth: item.depth + 1 });
      } else if (Array.isArray(data.fn)) pending.push({ value: data.fn, depth: item.depth + 1 });
      else throw new MathInputProblem('syntax', '数式データの種類を確認できません。');
      continue;
    }
    throw new MathInputProblem('syntax', '数式データに無効な値が含まれています。');
  }
  return { nodes, heads, symbols };
}

/** The last, explicit boundary. It must never convert the first component or drop an imaginary part. */
export function coordinateFromMath(result: MathEvaluation): number {
  if (result.status !== 'value' || result.kind !== 'real' || !Number.isFinite(result.coordinate)) {
    throw new MathInputProblem('syntax', 'この座標には有限の実数になる式を指定してください。');
  }
  return result.coordinate;
}
