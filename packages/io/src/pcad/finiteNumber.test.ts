import { expect, it, vi } from 'vitest';
import { isFiniteNumber, readNumber, readOptionalNumber } from './guards.js';

it('preserves finite primitive values including signed zero and the binary range endpoints', () => {
  for (const value of [-Number.MAX_VALUE, -1, -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE, 1, Number.MAX_VALUE]) {
    expect(isFiniteNumber(value)).toBe(true);
    const required = readNumber({ radius: value }, 'radius', 'shape');
    const optional = readOptionalNumber({ radius: value }, 'radius', 'shape');
    expect(required).toStrictEqual({ ok: true, value });
    expect(optional).toStrictEqual({ ok: true, value });
    if (!required.ok || !optional.ok) throw new Error('Finite scalar rejected');
    expect(Object.is(required.value, value)).toBe(true);
    expect(Object.is(optional.value, value)).toBe(true);
  }
});

it('rejects nonnumbers before Number.isFinite without reading or coercing objects', () => {
  const inaccessible = new Proxy({}, { get: () => { throw new Error('Unexpected property read'); } });
  const finite = vi.spyOn(Number, 'isFinite');
  try {
    for (const value of [undefined, null, true, false, '', '1', 1n, Symbol('number'), [], inaccessible])
      expect(isFiniteNumber(value)).toBe(false);
    expect(finite).not.toHaveBeenCalled();
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(finite).toHaveBeenCalledExactlyOnceWith(Number.NaN);
  } finally { finite.mockRestore(); }
});

it('keeps missing/type paths distinct and only the optional reader accepts null', () => {
  expect(readNumber({}, 'radius', 'shape')).toStrictEqual({ ok: false, problem: { path: 'shape.radius', reason: 'missing' } });
  expect(readOptionalNumber({}, 'radius', 'shape')).toStrictEqual({ ok: false, problem: { path: 'shape.radius', reason: 'missing' } });
  for (const value of [undefined, '0', Number.NaN, Infinity, -Infinity]) {
    expect(readNumber({ radius: value }, 'radius', 'shape')).toStrictEqual({ ok: false, problem: { path: 'shape.radius', reason: 'type' } });
    expect(readOptionalNumber({ radius: value }, 'radius', 'shape')).toStrictEqual({ ok: false, problem: { path: 'shape.radius', reason: 'type' } });
  }
  expect(readNumber({ radius: null }, 'radius', '')).toStrictEqual({ ok: false, problem: { path: 'radius', reason: 'type' } });
  expect(readOptionalNumber({ radius: null }, 'radius', '')).toStrictEqual({ ok: true, value: null });
});

it('retains has-before-get, reads the source once, and does not touch a missing field', () => {
  for (const read of [readNumber, readOptionalNumber]) {
    const trace: string[] = [];
    const target: Record<string, unknown> = { radius: -0 };
    const source = new Proxy(target, {
      has: (object, key) => { trace.push(`has:${String(key)}`); return Reflect.has(object, key); },
      get: (object, key, receiver): unknown => { trace.push(`get:${String(key)}`); return Reflect.get(object, key, receiver); },
    });
    expect(read(source, 'radius', 'shape')).toStrictEqual({ ok: true, value: -0 });
    expect(trace).toEqual(['has:radius', 'get:radius']);
    trace.length = 0;
    expect(read(source, 'missing', 'shape')).toStrictEqual({ ok: false, problem: { path: 'shape.missing', reason: 'missing' } });
    expect(trace).toEqual(['has:missing']);
  }
});

it('preserves a source getter exception by identity', () => {
  const sentinel = new Error('source accessor');
  const source = { get radius(): number { throw sentinel; } };
  for (const read of [readNumber, readOptionalNumber]) {
    let caught: unknown;
    try { read(source, 'radius', 'shape'); } catch (error: unknown) { caught = error; }
    expect(caught).toBe(sentinel);
  }
});
