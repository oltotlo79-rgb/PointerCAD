import { describe, expect, it, vi } from 'vitest';
import { desktopCamGateway } from './desktopCamGateway.js';
vi.mock('@pointercad/ui', () => ({ t: (key: string) => key }));
function api(result: unknown) {
  return { saveExport: vi.fn(() => Promise.resolve(result)), openExport: vi.fn(() => Promise.resolve(true)), openCamTool: vi.fn(() => Promise.resolve(true)) };
}
describe('Desktopの加工受渡しを任意能力として接続する', () => {
  it('古いpreloadでも部品の口を壊さない', () => { expect(desktopCamGateway({})).toEqual({}); });
  it.each([true, undefined, {}, { token: 1 }, { token: '' }])('成功の形が不正なら保存済みと扱わない: %s', async (value) => {
    await expect(desktopCamGateway(api(value)).saveExport?.('part.stl', 'stl', Uint8Array.of(1))).rejects.toThrow('file.saveFailed');
  });
  it('取消と保存済み・札失効を区別する', async () => {
    expect(await desktopCamGateway(api(null)).saveExport?.('part.stl', 'stl', Uint8Array.of(1))).toBeNull();
    expect(await desktopCamGateway(api({ token: null })).saveExport?.('part.stl', 'stl', Uint8Array.of(1))).toEqual({ token: null });
  });
  it('パスなどの余分な返答を画面へ広げず、開く口へ札だけ渡す', async () => {
    const native = api({ token: 'opaque', path: '/private/part.stl' }), gateway = desktopCamGateway(native);
    expect(await gateway.saveExport?.('part.stl', 'stl', Uint8Array.of(1))).toEqual({ token: 'opaque' });
    expect(await gateway.openExport?.('opaque')).toBe(true);
    expect(native.openExport).toHaveBeenCalledExactlyOnceWith('opaque');
    expect(await gateway.openCamTool?.('kiri')).toBe(true);
    expect(native.openCamTool).toHaveBeenCalledExactlyOnceWith('kiri');
  });
});
