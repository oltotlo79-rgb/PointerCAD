import { describe, expect, it, vi } from 'vitest';
import { readBrowserFile } from './readBrowserFile.js';

describe('確保前にサイズを断る共通読み手', () => {
  it.each([300 * 1024 * 1024, Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('不正/超過%sで本文を取得しない', async (size) => {
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    await expect(readBrowserFile({ size, arrayBuffer })).rejects.toThrow();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it('空と予算ちょうどを受理し、1バイト超過を取得前に断る', async () => {
    const maximum = 16;
    for (const size of [0, maximum]) {
      const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(size)));
      expect(await readBrowserFile({ size, arrayBuffer }, maximum)).toHaveLength(size);
      expect(arrayBuffer).toHaveBeenCalledTimes(1);
    }
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    await expect(readBrowserFile({ size: maximum + 1, arrayBuffer }, maximum)).rejects.toThrow();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it('返された実本文のサイズが宣言と違えば文書として渡さない', async () => {
    for (const size of [0, 3]) {
      await expect(readBrowserFile({ size, arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)) }, 4)).rejects.toThrow();
    }
  });
});
