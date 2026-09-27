/** App-owned symbol declarations. Formula text cannot assign values or execute declarations. */
import { MATH_INPUT_LIMITS, MathInputProblem, hasMathControlCharacters, validateMathSource, type MathNode } from './mathInputContract.js';
import { MathSymbolScope } from './mathSymbolScope.js';

export const MATH_DECLARATION_LIMITS = Object.freeze({ count: 128, meaningLength: 512, totalMeaningLength: 16_384 });
export type MathDeclaredType = 'real' | 'complex' | 'integer' | 'natural' | 'rational'
  | 'boolean' | 'set' | 'vector' | 'matrix' | 'function' | 'symbolic';
export interface MathDeclaration {
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
  readonly type: MathDeclaredType;
  /** A pure, closed text expression, evaluated with the enclosing formula's angle unit. */
  readonly valueSource?: string;
}
const TYPES: readonly MathDeclaredType[] = ['real', 'complex', 'integer', 'natural', 'rational',
  'boolean', 'set', 'vector', 'matrix', 'function', 'symbolic'];

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || hasMathControlCharacters(value)) {
    throw new MathInputProblem('syntax', '記号の名前・意味・識別子を確認してください。');
  }
  return value;
}

/** Decode a detached, immutable snapshot; duplicate names and IDs never use last-write-wins. */
export function decodeMathDeclarations(value: unknown): readonly MathDeclaration[] {
  if (!Array.isArray(value) || value.length > MATH_DECLARATION_LIMITS.count) {
    throw new MathInputProblem('budget', '定義する記号が多すぎます。');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).length !== value.length
    || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) {
    throw new MathInputProblem('syntax', '記号の一覧に空欄や読み取り時の処理を含めることはできません。');
  }
  let remaining = MATH_DECLARATION_LIMITS.totalMeaningLength, remainingValues = MATH_INPUT_LIMITS.sourceCodeUnits;
  const declarations = value.map((entry: unknown): MathDeclaration => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MathInputProblem('syntax', '記号の定義を読み取れません。');
    }
    const prototype: unknown = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    const hasValue = Object.hasOwn(entry, 'valueSource');
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== (hasValue ? 5 : 4)
      || keys.some(key => typeof key !== 'string' || !['id', 'label', 'meaning', 'type', 'valueSource'].includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(entry, key) ?? {}, 'value'))) {
      throw new MathInputProblem('syntax', '記号の定義項目が不正です。');
    }
    const raw = entry as Record<string, unknown>;
    const id = text(raw.id, 128), label = text(raw.label, 128);
    // One explicit identifier. Whitespace, operators and program fragments are never names.
    if (!/^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(label)) {
      throw new MathInputProblem('syntax', '記号名は文字で始め、文字・数字・下線で指定してください。');
    }
    const meaning = text(raw.meaning, MATH_DECLARATION_LIMITS.meaningLength);
    remaining -= meaning.length;
    if (remaining < 0) throw new MathInputProblem('budget', '記号の説明の合計が長すぎます。');
    const type = TYPES.find(type => type === raw.type);
    if (type === undefined) throw new MathInputProblem('syntax', '記号の種類を指定してください。');
    const valueSource = hasValue ? text(raw.valueSource, MATH_INPUT_LIMITS.sourceCodeUnits) : undefined;
    if (valueSource !== undefined) {
      validateMathSource(valueSource);
      remainingValues -= valueSource.length;
      if (remainingValues < 0) throw new MathInputProblem('budget', '記号の値の式の合計が長すぎます。');
    }
    return Object.freeze({ id, label, meaning, type, ...(valueSource === undefined ? {} : { valueSource }) });
  });
  // Use the same reserved names and duplicate rules as the actual parser.
  new MathSymbolScope({ axes: new Set(), parameters: new Set(), coefficients: [],
    declared: declarations.map(value => ({ role: 'declared', id: value.id, label: value.label })) });
  return Object.freeze(declarations);
}

export function scalarMathDeclarationIds(declarations: readonly MathDeclaration[]): ReadonlySet<string> {
  return new Set(declarations.filter(value => ['real', 'complex', 'integer', 'natural', 'rational'].includes(value.type))
    .map(value => value.id));
}

/** A declaration certifies identity and type, never a numeric value or a removable domain obligation. */
export function referencedMathDeclarations(expression: MathNode, declarations: readonly MathDeclaration[]): readonly MathDeclaration[] {
  const byId = new Map(declarations.map(value => [value.id, value])), used = new Map<string, MathDeclaration>();
  const pending = [expression]; let remaining = MATH_INPUT_LIMITS.nodes;
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '記号を確認する数式が大きすぎます。');
    if (node.kind === 'symbol' && node.reference.role === 'declared') {
      const declaration = byId.get(node.reference.id);
      if (declaration === undefined || declaration.label !== node.reference.label) {
        throw new MathInputProblem('syntax', '記号の参照先と定義の名前が一致しません。');
      }
      used.set(declaration.id, declaration);
    } else if (node.kind === 'operation') pending.push(...node.operands);
    else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return [...used.values()];
}

export function sameMathDeclarations(left: readonly MathDeclaration[] | undefined,
  right: readonly MathDeclaration[] | undefined): boolean {
  const a = left ?? [], b = right ?? [];
  if (a.length !== b.length) return false;
  const byId = new Map(b.map(value => [value.id, value]));
  return a.every(value => {
    const other = byId.get(value.id);
    return other !== undefined && value.label === other.label && value.meaning === other.meaning && value.type === other.type
      && value.valueSource === other.valueSource;
  });
}
