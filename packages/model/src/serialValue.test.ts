import { describe, expect, it } from 'vitest';
import { integerSerial, nextSerialValue } from './serialValue.js';
import { nameSerial, nextSerialId, nextSerialName } from './sketch/createSketchDocument.js';

describe('serial allocation preserves each saved identifier syntax', () => {
  it('keeps strict names and IDs decimal-only', () => {
    const values = ['item-2', 'item-05', 'item-2e2', 'item-0x20', 'item- 70 ', 'item-9.0', 'item-Infinity'];
    expect(nextSerialId(values, 'item-')).toBe('item-6');
    expect(nextSerialName(values, 'item-')).toBe('item-6');
  });

  it('keeps the historical integer suffixes used by appearance, sets and canvases', () => {
    const values = ['item-2', 'item-05', 'item-2e2', 'item-0x20', 'item- 70 ', 'item-9.0', 'item-Infinity'];
    expect(nextSerialValue(values, 'item-', integerSerial)).toBe('item-201');
  });

  it('ignores other prefixes, negative numbers, fractions and non-finite suffixes', () => {
    const values = ['other-500', 'item--8', 'item-4.2', 'item-NaN', 'item-Infinity', 'item-1e999'];
    expect(nextSerialValue(values, 'item-', integerSerial)).toBe('item-1');
    expect(nextSerialValue(values, 'item-', nameSerial)).toBe('item-1');
  });

  it('takes the maximum without reusing a gap and consumes a one-shot iterable once', () => {
    function* values() { yield 'item-8'; yield 'item-1'; yield 'item-8'; yield 'item-3'; }
    expect(nextSerialValue(values(), 'item-', integerSerial)).toBe('item-9');
    expect(nextSerialValue([], 'item-', nameSerial)).toBe('item-1');
  });

  it('preserves rounded integer increment behavior at the existing numeric boundary', () => {
    const values = ['item-9007199254740992'];
    expect(nextSerialId(values, 'item-')).toBe('item-9007199254740992');
    expect(nextSerialValue(values, 'item-', integerSerial)).toBe('item-9007199254740992');
  });
});
