import { expect, it } from 'vitest';
import { isRecord } from './mathRecord.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { decodeNumericalRootIntervals } from './numericalRootResult.js';
import { decodeTaylorExpansion } from './taylorExpansion.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

const scalar: MathNode = { kind: 'number', decimal: '0' };
const source: MathNode = { kind: 'operation', operation: 'numerical-roots', operands: [
  { kind: 'binder', operation: 'lambda', bindings: [
    { variable: { role: 'bound', id: 'record-x', label: 'x' }, domain: { kind: 'unrestricted' } },
  ], body: scalar }, scalar, scalar, scalar,
] };
const root = (value: unknown) => decodeNumericalRootIntervals(value, source);
const taylor = (value: unknown) => decodeTaylorExpansion(value, () => scalar);
const exact = (value: unknown) => decodeExactMathResult(value, scalar, {
  operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
});
const readers = [
  { read: root, message: '解を探す式・範囲・精度と計算した区間を確認してください。' },
  { read: taylor, message: '級数の展開結果の形式が不正です。' },
  { read: exact, message: '数式の厳密な計算結果の形式が不正です。' },
];

function thrownBy(read: (value: unknown) => unknown, value: unknown): unknown {
  try { read(value); } catch (error: unknown) { return error; }
  throw new Error('Expected rejection');
}

it('the common record predicate performs no prototype, key or property inspection', () => {
  const sentinel = new Error('Unexpected trap');
  const proxy = new Proxy({}, {
    getPrototypeOf: () => { throw sentinel; }, ownKeys: () => { throw sentinel; },
    getOwnPropertyDescriptor: () => { throw sentinel; }, get: () => { throw sentinel; },
  });
  expect(isRecord(proxy)).toBe(true);
  expect(isRecord(new Date(0))).toBe(true);
  for (const value of [null, undefined, false, 1, 1n, '', Symbol('record'), [], () => undefined])
    expect(isRecord(value)).toBe(false);
});

it('all three readers retain their own error class, code and exact message', () => {
  for (const { read, message } of readers) for (const value of [null, undefined, 0, '', []]) {
    const error = thrownBy(read, value);
    expect(error).toBeInstanceOf(MathInputProblem);
    if (!(error instanceof MathInputProblem)) throw new Error('Wrong error class');
    expect(error.code).toBe('syntax');
    expect(error.message).toBe(message);
  }
});

it('root keeps prototype-before-descriptors while Taylor keeps descriptors-before-prototype', () => {
  for (const [read, expected] of [
    [root, ['prototype', 'keys', 'descriptor:marker', 'keys']],
    [taylor, ['keys', 'descriptor:marker', 'prototype', 'keys']],
  ] satisfies readonly (readonly [(value: unknown) => unknown, readonly string[]])[]) {
    const trace: string[] = [];
    const proxy = new Proxy({ marker: 1 }, {
      getPrototypeOf: target => { trace.push('prototype'); return Reflect.getPrototypeOf(target); },
      ownKeys: target => { trace.push('keys'); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: (target, key) => { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      get: () => { throw new Error('A malformed record must not read a value'); },
    });
    expect(thrownBy(read, proxy)).toBeInstanceOf(MathInputProblem);
    expect(trace).toEqual(expected);
  }
});

it('does not translate a prototype or descriptor trap exception', () => {
  const sentinel = new Error('Native proxy trap');
  expect(thrownBy(root, new Proxy({}, { getPrototypeOf: () => { throw sentinel; } }))).toBe(sentinel);
  expect(thrownBy(taylor, new Proxy({}, { ownKeys: () => { throw sentinel; } }))).toBe(sentinel);
  expect(thrownBy(exact, new Proxy({}, { getPrototypeOf: () => { throw sentinel; } }))).toBe(sentinel);
});
