import { describe, expect, it, vi } from 'vitest';
import { awaitThumbnailCapture } from './thumbnail.js';

describe('a save awaits its already-started thumbnail without retaining a cancelled queue', () => {
  it('returns the same completed PNG bytes and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    expect(await awaitThumbnailCapture(Promise.resolve(png), controller.signal)).toBe(png);
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('settles cancellation before the provider completes (already cancelled: %s)', async already => {
    const controller = new AbortController();
    let fail: (error: Error) => void = () => { throw new Error('uninitialized'); };
    const provider = new Promise<Uint8Array | null>((_resolve, reject) => { fail = reject; });
    if (already) controller.abort();
    const pending = awaitThumbnailCapture(provider, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    fail(new Error('late provider failure after cancellation'));
    await Promise.resolve();
  });
  it('keeps a refused image optional without turning it into success bytes', async () => {
    const controller = new AbortController();
    expect(await awaitThumbnailCapture(Promise.resolve(null), controller.signal)).toBeNull();
    expect(await awaitThumbnailCapture(Promise.reject(new Error('provider failure')), controller.signal)).toBeNull();
  });
});
