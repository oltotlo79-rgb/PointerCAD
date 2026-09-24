/** Fail-closed decoder for persisted math. It reconstructs trusted objects; it never casts JSON to an AST. */
import { MATH_INPUT_FORMAT, MATH_INPUT_LIMITS, MathInputProblem, validateMathDecimal, validateMathSource, hasMathControlCharacters,
  type MathBinding, type MathNode, type MathOperationDefinition, type MathSymbolReference,
  type StoredMathExpression } from './mathInputContract.js';
import { decodeMathDeclarations, referencedMathDeclarations } from './mathDeclarations.js';

export interface StoredMathContext {
  readonly operationsById: ReadonlyMap<string, MathOperationDefinition>;
  readonly coefficientIds: ReadonlySet<string>;
  readonly declaredIds: ReadonlySet<string>;
  /** File decoding preserves unresolved IDs; the evaluation boundary must always supply a closed scope. */
  readonly allowUnresolvedCoefficients?: true;
  /** File loading preserves complete local declarations; live requests must supply the same closed scope. */
  readonly allowStoredDeclarations?: true;
  /** Parse the visible source under the same name/type choices, without canonicalizing or evaluating it. */
  readonly parseSource: (source: string, notation: 'text' | 'latex') => MathNode;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new MathInputProblem('syntax', '数式の保存データを読み取れません。');
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new MathInputProblem('syntax', '数式の保存データに未対応の項目があります。');
  }
}
function text(value: unknown, maximumLength = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength || hasMathControlCharacters(value)) {
    throw new MathInputProblem('syntax', '数式の名前を読み取れません。');
  }
  return value;
}
function constant(value: unknown): Extract<MathNode, { kind: 'constant' }>['name'] {
  switch (value) {
    case 'pi': case 'e': case 'imaginary-unit': case 'infinity': case 'true': case 'false':
    case 'real-numbers': case 'complex-numbers': case 'integers': case 'naturals': case 'rationals': case 'empty-set': return value;
    default: throw new MathInputProblem('syntax', '定数の種類を読み取れません。');
  }
}

export function decodeStoredMath(value: unknown, context: StoredMathContext): StoredMathExpression {
  const stored = decodeStoredMathStructure(value, context);
  const parsed = context.parseSource(stored.source, stored.inputNotation);
  if (JSON.stringify(parsed) !== JSON.stringify(stored.expression)) throw new MathInputProblem('syntax', '表示される数式と保存された定義が一致しません。');
  return stored;
}

/** Decode a detached transport snapshot; source equivalence must still be checked inside the Worker. */
export function decodeStoredMathStructure(value: unknown, context: Pick<StoredMathContext,
  'operationsById' | 'coefficientIds' | 'declaredIds' | 'allowUnresolvedCoefficients' | 'allowStoredDeclarations'>): StoredMathExpression {
  const stored = object(value);
  const hasDeclarations = Object.hasOwn(stored, 'declarations');
  keys(stored, ['format', 'source', 'inputNotation', 'angleUnit', 'expression', ...(hasDeclarations ? ['declarations'] : [])]);
  if (stored.format !== MATH_INPUT_FORMAT || typeof stored.source !== 'string'
    || (stored.inputNotation !== 'text' && stored.inputNotation !== 'latex')
    || (stored.angleUnit !== 'degree' && stored.angleUnit !== 'radian')) {
    throw new MathInputProblem('syntax', '数式の版または入力設定に対応していません。');
  }
  validateMathSource(stored.source);
  const declarations = hasDeclarations ? decodeMathDeclarations(stored.declarations) : undefined;
  if (context.allowStoredDeclarations !== true && declarations?.some(value => !context.declaredIds.has(value.id))) {
    throw new MathInputProblem('syntax', '現在の入力にない記号が保存データへ追加されています。');
  }
  const expression = decodeStoredMathNode(stored.expression, declarations === undefined ? context
    : { ...context, declaredIds: new Set(declarations.map(value => value.id)) });
  if (declarations !== undefined) referencedMathDeclarations(expression, declarations);
  return { format: MATH_INPUT_FORMAT, source: stored.source, inputNotation: stored.inputNotation, angleUnit: stored.angleUnit, expression,
    ...(declarations === undefined ? {} : { declarations }) };
}

export function decodeStoredMathNode(value: unknown, context: Pick<StoredMathContext,
  'operationsById' | 'coefficientIds' | 'declaredIds' | 'allowUnresolvedCoefficients'>): MathNode {
  let nodeCount = 0;
  const allBoundIds = new Set<string>();
  function spend(depth: number): void {
    nodeCount += 1;
    if (depth > MATH_INPUT_LIMITS.depth || nodeCount > MATH_INPUT_LIMITS.nodes) throw new MathInputProblem('budget', '保存された数式が複雑すぎます。');
  }
  function reference(raw: unknown, bound: ReadonlyMap<string, string>): MathSymbolReference {
    const item = object(raw);
    if (item.role === 'axis') {
      keys(item, ['role', 'name']);
      if (item.name !== 'X' && item.name !== 'Y' && item.name !== 'Z') throw new MathInputProblem('syntax', '座標軸が不正です。');
      return { role: 'axis', name: item.name };
    }
    if (item.role === 'parameter') {
      keys(item, ['role', 'name']);
      if (item.name !== 'T' && item.name !== 'U' && item.name !== 'V') throw new MathInputProblem('syntax', '作図変数が不正です。');
      return { role: 'parameter', name: item.name };
    }
    keys(item, ['role', 'id', 'label']);
    const id = text(item.id, item.role === 'bound' ? 512 : 128), label = text(item.label);
    if (item.role === 'coefficient' && (context.coefficientIds.has(id) || context.allowUnresolvedCoefficients === true)) return { role: 'coefficient', id, label };
    if (item.role === 'declared' && context.declaredIds.has(id)) return { role: 'declared', id, label };
    if (item.role === 'bound' && bound.get(id) === label) return { role: 'bound', id, label };
    throw new MathInputProblem('syntax', '存在しない係数または有効範囲外の変数が参照されています。');
  }
  function node(raw: unknown, depth: number, bound: ReadonlyMap<string, string>): MathNode {
    spend(depth);
    const item = object(raw);
    if (item.kind === 'number') {
      keys(item, ['kind', 'decimal']);
      if (typeof item.decimal !== 'string') throw new MathInputProblem('syntax', '数値の保存形式が不正です。');
      validateMathDecimal(item.decimal);
      return { kind: 'number', decimal: item.decimal };
    }
    if (item.kind === 'constant') { keys(item, ['kind', 'name']); return { kind: 'constant', name: constant(item.name) }; }
    if (item.kind === 'symbol') { keys(item, ['kind', 'reference']); return { kind: 'symbol', reference: reference(item.reference, bound) }; }
    const operation = typeof item.operation === 'string' ? context.operationsById.get(item.operation) : undefined;
    if (!operation) throw new MathInputProblem('unsupported', '保存された演算に対応していません。');
    if (item.kind === 'operation') {
      keys(item, ['kind', 'operation', 'operands']);
      if (operation.structural && operation.id !== 'open-endpoint') throw new MathInputProblem('syntax', '数式の構造が不正です。');
      if (['sum', 'product', 'integrate', 'for-all', 'exists', 'lambda'].includes(operation.id)) {
        throw new MathInputProblem('syntax', '変数を伴う演算の保存形式が不正です。');
      }
      if (!Array.isArray(item.operands) || item.operands.length < operation.minimumArguments
        || item.operands.length > operation.maximumArguments) throw new MathInputProblem('syntax', '演算の引数の数が不正です。');
      if (operation.id === 'which' && item.operands.length % 2 !== 0) throw new MathInputProblem('syntax', '場合分けの条件と値が対応していません。');
      return { kind: 'operation', operation: operation.id, operands: item.operands.map(value => node(value, depth + 1, bound)) };
    }
    if (item.kind !== 'binder' || !['sum', 'product', 'integrate', 'for-all', 'exists', 'lambda'].includes(operation.id)) {
      throw new MathInputProblem('syntax', '数式の節の種類が不正です。');
    }
    keys(item, ['kind', 'operation', 'bindings', 'body']);
    if (!Array.isArray(item.bindings) || item.bindings.length < 1 || item.bindings.length > 15
      || (['for-all', 'exists'].includes(operation.id) && item.bindings.length !== 1)) {
      throw new MathInputProblem('syntax', '変数の個数が不正です。');
    }
    const nested = new Map(bound), names = new Set<string>();
    const bindings: MathBinding[] = [];
    for (const rawBinding of item.bindings) {
      spend(depth + 1);
      const binding = object(rawBinding); keys(binding, ['variable', 'domain']);
      const variable = object(binding.variable); keys(variable, ['role', 'id', 'label']);
      const id = text(variable.id, 512), label = text(variable.label);
      if (variable.role !== 'bound' || allBoundIds.has(id) || names.has(label)) throw new MathInputProblem('syntax', '変数の識別子が重複または不正です。');
      const rawDomain = object(binding.domain);
      let domain: MathBinding['domain'];
      if (rawDomain.kind === 'unrestricted' && (operation.id === 'lambda' || operation.id === 'integrate')) {
        keys(rawDomain, ['kind']); domain = { kind: 'unrestricted' };
      } else if (rawDomain.kind === 'set' && (operation.id === 'for-all' || operation.id === 'exists')) {
        keys(rawDomain, ['kind', 'value']); domain = { kind: 'set', value: node(rawDomain.value, depth + 1, nested) };
      } else if (rawDomain.kind === 'range' && ['sum', 'product', 'integrate'].includes(operation.id)) {
        keys(rawDomain, ['kind', 'lower', 'upper', 'step']);
        if (operation.id === 'integrate' && rawDomain.step !== null) throw new MathInputProblem('syntax', '積分の範囲に刻み幅は指定できません。');
        domain = { kind: 'range', lower: node(rawDomain.lower, depth + 1, nested), upper: node(rawDomain.upper, depth + 1, nested),
          step: rawDomain.step === null ? null : node(rawDomain.step, depth + 1, nested) };
      } else throw new MathInputProblem('syntax', '変数の範囲が演算に対応していません。');
      allBoundIds.add(id); names.add(label); nested.set(id, label);
      bindings.push({ variable: { role: 'bound', id, label }, domain });
    }
    return { kind: 'binder', operation: operation.id, bindings, body: node(item.body, depth + 1, nested) };
  }
  return node(value, 0, new Map());
}
