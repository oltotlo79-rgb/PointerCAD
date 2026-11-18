import { describe, expect, it, vi } from 'vitest';

import { createDesktopSixDofAccess } from './desktopSixDofAccess.js';

/* preload の 3D マウスの口(B-09 3-5)。欠けていれば口を作らず、本体の答えは true の時だけ真。 */
function scope(api: unknown): object {
  return { pointercadDesktop: api };
}

describe('3D マウスの口の組み立て', () => {
  it('preload が無い・口が 1 つでも欠けている時は作らない', () => {
    expect(createDesktopSixDofAccess({})).toBeNull();
    expect(createDesktopSixDofAccess(scope(null))).toBeNull();
    expect(createDesktopSixDofAccess(scope({ enableSixDof: vi.fn(), disableSixDof: vi.fn() }))).toBeNull();
    expect(createDesktopSixDofAccess(scope({ enableSixDof: vi.fn(), disableSixDof: vi.fn(), sixDofEnabled: 'yes' }))).toBeNull();
  });

  it('本体の答えは true の時だけ真で、引数を渡さずに呼ぶ', async () => {
    const api = {
      enableSixDof: vi.fn(() => Promise.resolve('true')),
      disableSixDof: vi.fn(() => Promise.resolve(true)),
      sixDofEnabled: vi.fn(() => Promise.resolve(1)),
    };
    const access = createDesktopSixDofAccess(scope(api));
    if (access === null) throw new Error('口がありません');
    expect(await access.enable()).toBe(false);
    expect(await access.disable()).toBe(true);
    expect(await access.enabled()).toBe(false);
    for (const method of Object.values(api)) expect(method).toHaveBeenCalledWith();
  });
});
