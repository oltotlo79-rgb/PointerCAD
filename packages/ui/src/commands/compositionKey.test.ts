import { describe, expect, it } from 'vitest';
import { isCompositionKey } from './compositionKey.js';

describe('isCompositionKey', () => {
  it.each(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'z'])('recognizes each independent IME signal for %s', key => {
    expect(isCompositionKey({ key, keyCode: 0, isComposing: true })).toBe(true);
    expect(isCompositionKey({ key, keyCode: 229, isComposing: false })).toBe(true);
    expect(isCompositionKey({ key, keyCode: 0, isComposing: false })).toBe(false);
  });
  it('recognizes Process without another signal', () => {
    expect(isCompositionKey({ key: 'Process', keyCode: 0, isComposing: false })).toBe(true);
  });
});
