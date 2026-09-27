import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend, warmMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import * as preparation from './prepareMathCalculation.js';

afterEach(() => { vi.restoreAllMocks(); });

const identity = { documentId: 'warmup-test', documentVersion: 1, editorId: 'input', inputRevision: 1 };
/** The same two requests as the warm-up: a formula with a coefficient converted for the structured input, and back. */
function representative(backend: MathExecutionBackend): number {
  const text: MathWorkRequest = { identity, source: 'sqrt(2)*sin(30)+coef("a")/3', notation: 'text', angleUnit: 'degree',
    coefficients: [{ id: 'a', label: 'a', decimal: '1.5', exactExpression: { kind: 'operation', operation: 'divide',
      operands: [{ kind: 'number', decimal: '3' }, { kind: 'number', decimal: '2' }] } }], presentationNotation: 'latex' };
  const started = performance.now();
  const first = executeMathWorkRequest(createMathWorkEnvelope(1, text), backend);
  const saved = first.presentation;
  if (saved === null || saved === undefined) throw new Error(JSON.stringify(first.evaluation));
  const second = executeMathWorkRequest(createMathWorkEnvelope(2, { ...text, source: saved.source, notation: 'latex',
    definition: saved, presentationNotation: 'text' }), backend);
  const elapsed = performance.now() - started;
  for (const reply of [first, second]) expect(reply.evaluation).toMatchObject({ status: 'value', kind: 'real' });
  return elapsed;
}

describe('計算の Worker の準備で小さな代表の計算を1回空回しする', () => {
  // Keep this first in the file: the warm-up is the first calculation of this module instance (the cold state).
  it('(d) 空回しの後の最初の依頼は、冷えた状態の同じ計算（空回し）より速い', () => {
    const backend = createMathBackend();
    const cold = warmMathBackend(backend);
    const first = representative(backend);
    console.log('[実測] 空回しと最初の依頼', JSON.stringify({ coldMs: cold, firstRequestMs: first }));
    expect(Number.isFinite(cold)).toBe(true);
    expect(first).toBeLessThan(cold);
  });

  it('空回しは構造入力への変換と読み戻し、準備と評価まで通り、結果は返さない', () => {
    const backend = createMathBackend();
    const parse = vi.spyOn(backend, 'parseLatex'), serialize = vi.spyOn(backend, 'serializeLatex'), box = vi.spyOn(backend, 'box');
    const elapsed = warmMathBackend(backend);
    expect(typeof elapsed).toBe('number');
    expect(parse).toHaveBeenCalled();
    expect(serialize).toHaveBeenCalled();
    expect(box).toHaveBeenCalled();
  });

  it('空回しの後も通常の式の200msの期限を持ち越さない', () => {
    const backend = createMathBackend();
    warmMathBackend(backend);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const prepare = preparation.prepareMathCalculation;
    vi.spyOn(preparation, 'prepareMathCalculation').mockImplementation((...args) => { now += 201; return prepare(...args); });
    const reply = executeMathWorkRequest(createMathWorkEnvelope(3, { identity, source: '1+2', notation: 'text',
      angleUnit: 'radian', coefficients: [] }), backend);
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
  });

  it('計算部が壊れていても空回しは例外を出さず、準備の所要時間を返す', () => {
    const broken: MathExecutionBackend = { ...createMathBackend(), withinDeadline: () => { throw new Error('broken backend'); } };
    expect(Number.isFinite(warmMathBackend(broken))).toBe(true);
  });
});
