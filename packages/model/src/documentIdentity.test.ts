import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentElementId } from './documentIdentity.js';

afterEach(() => { vi.unstubAllGlobals(); });
describe('new saved document element identity assembly', () => {
  it.each(['shape-asset-', 'mesh-asset-', 'canvas-asset-', 'point:', 'canvas-image-', 'part-uuid:'])('retains exact prefix %s with one supplied entropy call', prefix => {
    const entropy = vi.fn(() => '00000000-0000-4000-8000-000000000001');
    expect(createDocumentElementId(prefix, entropy)).toBe(`${prefix}00000000-0000-4000-8000-000000000001`);
    expect(entropy).toHaveBeenCalledExactlyOnceWith();
  });
  it('returns the unprefixed entropy result directly', () => {
    const entropy = vi.fn(() => '00:verbatim-token');
    expect(createDocumentElementId('', entropy)).toBe('00:verbatim-token');
    expect(entropy).toHaveBeenCalledExactlyOnceWith();
  });
  it('uses the current crypto.randomUUID once by default', () => {
    const randomUUID = vi.fn(() => 'default-entropy');
    vi.stubGlobal('crypto', { randomUUID });
    expect(createDocumentElementId()).toBe('default-entropy');
    expect(randomUUID).toHaveBeenCalledExactlyOnceWith();
  });
  it('retains the original entropy exception identity', () => {
    const failure = new Error('secure entropy unavailable');
    const entropy = vi.fn(() => { throw failure; });
    let caught: unknown;
    try { createDocumentElementId('part-uuid:', entropy); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(entropy).toHaveBeenCalledExactlyOnceWith();
  });
});
