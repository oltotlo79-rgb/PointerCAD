/** A saved problem is deliberately separate from every numeric coordinate and parameter. */
import { decodeMathExpressionStorage, type StoredMathExpression } from '@pointercad/expression';
import { differentialEquationProblem } from '@pointercad/expression/math/contracts';
import type { PartDocument } from './types.js';

export interface UnresolvedMathProblem {
  readonly id: string;
  readonly name: string;
  readonly status: 'unresolved';
  readonly definition: StoredMathExpression;
}
export const UNRESOLVED_MATH_PROBLEM_LIMIT = 128;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('保存した式を読み取れません。');
  const prototype: unknown = Object.getPrototypeOf(value), fields = Object.getOwnPropertyDescriptors(value);
  const names = ['id', 'name', 'status', 'definition'];
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== names.length
    || names.some(name => !Object.hasOwn(fields, name) || !Object.hasOwn(fields[name], 'value'))) {
    throw new Error('保存した式に不明な項目があります。');
  }
  return value as Record<string, unknown>;
}
export function readUnresolvedMathProblems(value: unknown): readonly UnresolvedMathProblem[] {
  if (!Array.isArray(value) || value.length > UNRESOLVED_MATH_PROBLEM_LIMIT
    || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) {
    throw new Error('未解決の式の一覧を確認してください。');
  }
  const seen = new Set<string>();
  return value.map<UnresolvedMathProblem>((item: unknown) => {
    const source = record(item);
    if (typeof source.id !== 'string' || !/^math-problem:[A-Za-z0-9_-]{1,100}$/u.test(source.id) || seen.has(source.id)) {
      throw new Error('保存した式の識別番号が重複、または不正です。');
    }
    if (typeof source.name !== 'string' || source.name.trim().length === 0 || source.name.length > 128
      || Array.from(source.name).some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }) || source.status !== 'unresolved') {
      throw new Error('式の名前と未解決の状態を確認してください。');
    }
    if (source.definition === null || typeof source.definition !== 'object') throw new Error('元の式が保存されていません。');
    const storedSource = Object.getOwnPropertyDescriptor(source.definition, 'source');
    if (storedSource === undefined || !Object.hasOwn(storedSource, 'value') || typeof storedSource.value !== 'string') {
      throw new Error('元の式が保存されていません。');
    }
    const definition = decodeMathExpressionStorage(source.definition, storedSource.value);
    if (definition.expression.kind !== 'operation' || definition.expression.operation !== 'partial-equations') {
      throw new Error('ここには解けていない偏微分方程式の式と条件を保存してください。');
    }
    differentialEquationProblem(definition.expression);
    seen.add(source.id);
    return { id: source.id, name: source.name, status: 'unresolved', definition };
  });
}

export function setUnresolvedMathProblem(document: PartDocument, problem: UnresolvedMathProblem): PartDocument {
  const current = document.unresolvedMathProblems ?? [];
  const values = current.some(value => value.id === problem.id)
    ? current.map(value => value.id === problem.id ? problem : value) : [...current, problem];
  return { ...document, unresolvedMathProblems: readUnresolvedMathProblems(values) };
}
export function removeUnresolvedMathProblem(document: PartDocument, id: string): PartDocument {
  const current = document.unresolvedMathProblems ?? [];
  if (!current.some(value => value.id === id)) return document;
  return { ...document, unresolvedMathProblems: current.filter(value => value.id !== id) };
}
