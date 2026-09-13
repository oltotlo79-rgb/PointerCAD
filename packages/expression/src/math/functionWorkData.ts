/** Strict, immutable data shared by function-curve and function-surface Workers. */
import { MathInputProblem, type StoredMathExpression } from './mathInputContract.js';
import { decodeStoredMathStructure } from './decodeStoredMath.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { validFunctionWorldBounds, type FunctionPoint } from './functionGeometryBounds.js';
import type { SurfaceParameter } from './surfaceParameterGrid.js';

function record(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function functionWorkRecord(value: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) {
    throw new MathInputProblem('syntax','関数の計算データの項目を確認できません。');
  }
  return value;
}
export function functionWorkNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MathInputProblem('syntax','関数の値とXYZ範囲には有限の実数が必要です。');
  return value;
}
export function functionWorkCounter(value: unknown, maximum: number, minimum = 0): number {
  const number = functionWorkNumber(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new MathInputProblem('budget','関数の計算数が上限と一致しません。');
  return number;
}
export function functionWorkArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new MathInputProblem('budget','関数の計算データが上限を超えています。');
  return value;
}
export function functionWorkPoint(value: unknown): FunctionPoint {
  const array = functionWorkArray(value,3);
  if (array.length !== 3) throw new MathInputProblem('syntax','X・Y・Zの各座標を指定してください。');
  return Object.freeze([functionWorkNumber(array[0]),functionWorkNumber(array[1]),functionWorkNumber(array[2])]);
}
export function functionWorkPair(value: unknown): SurfaceParameter {
  const array = functionWorkArray(value,2);
  if (array.length !== 2) throw new MathInputProblem('syntax','曲面の2つの変数の範囲を指定してください。');
  return Object.freeze([functionWorkNumber(array[0]),functionWorkNumber(array[1])]);
}
export function functionWorkBounds(low: unknown, high: unknown): { readonly minimum: FunctionPoint; readonly maximum: FunctionPoint } {
  const minimum = functionWorkPoint(low), maximum = functionWorkPoint(high);
  if (!validFunctionWorldBounds(minimum,maximum)) throw new MathInputProblem('domain','XYZの描画範囲は各軸とも有限の最小値 < 最大値にしてください。');
  return {minimum,maximum};
}
export function frozenFunctionDefinition(value: unknown, coefficientIds: ReadonlySet<string>): StoredMathExpression {
  const definition = decodeStoredMathStructure(value,{operationsById:CANDIDATE_MATH_BY_ID,coefficientIds,declaredIds:new Set()});
  const pending: object[] = [definition];
  while (pending.length > 0) {
    const item = pending.pop(); if (item === undefined) break;
    const children: readonly unknown[] = Object.values(item);
    for (const child of children) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(item);
  }
  return definition;
}
