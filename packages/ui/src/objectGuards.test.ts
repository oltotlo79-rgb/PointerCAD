import { expect, it } from 'vitest';
import { isObject, isRecord } from './valueGuards.js';

it('keeps the array-permitting object contract distinct from records', () => {
  for (const value of [{}, new Date(0), new Map(), new Set()]) {
    expect(isObject(value)).toBe(true);
    expect(isRecord(value)).toBe(true);
  }
  expect(isObject([])).toBe(true);
  expect(isRecord([])).toBe(false);
  for (const value of [null, undefined, '', 0, 1n, false, Symbol('object'), () => undefined]) {
    expect(isObject(value)).toBe(false);
    expect(isRecord(value)).toBe(false);
  }
});

it('does not inspect object or array properties, descriptors or prototypes', () => {
  const sentinel = new Error('Unexpected shape inspection');
  const traps: ProxyHandler<object> = {
    get: () => { throw sentinel; }, getPrototypeOf: () => { throw sentinel; },
    ownKeys: () => { throw sentinel; }, getOwnPropertyDescriptor: () => { throw sentinel; },
  };
  const object = new Proxy({}, traps), array = new Proxy([], traps);
  expect(isObject(object)).toBe(true);
  expect(isObject(array)).toBe(true);
  expect(isRecord(object)).toBe(true);
  expect(isRecord(array)).toBe(false);
});
