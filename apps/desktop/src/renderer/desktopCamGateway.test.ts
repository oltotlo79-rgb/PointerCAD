import { describe, expect, it, vi } from 'vitest';
import { desktopCamGateway } from './desktopCamGateway.js';
vi.mock('@pointercad/ui', () => ({ t: (key: string) => key }));
function api(result: unknown) {
  return { saveExport: vi.fn(() => Promise.resolve(result)), openExport: vi.fn(() => Promise.resolve(true)), openCamTool: vi.fn(() => Promise.resolve(true)) };
}
describe('Desktopの加工受渡しを任意能力として接続する', () => {
  it('picker中取消は同じrequest IDを通知し旧tokenを採らない', async () => {
    let answer: (value: unknown) => void = () => { throw new Error('未初期化'); };
    const pending = new Promise<unknown>((resolve) => { answer = resolve; });
    const native = { ...api(null), saveExport: vi.fn<(
      name: string, format: string, bytes: Uint8Array, requestId?: string,
    ) => Promise<unknown>>(() => pending),
      cancelExportSave: vi.fn(() => Promise.resolve(true)) };
    const gateway = desktopCamGateway(native);
    const controller = new AbortController();
    const saving = gateway.saveExport?.('part.stl', 'stl', Uint8Array.of(1),
      { signal: controller.signal, isCurrent: () => !controller.signal.aborted });
    const requestId: unknown = native.saveExport.mock.calls[0]?.[3];
    expect(requestId).toMatch(/^[\da-f-]{36}$/i);
    controller.abort();
    expect(native.cancelExportSave).toHaveBeenCalledExactlyOnceWith(requestId);
    answer({ token: 'old' });
    expect(await saving).toBeNull();
  });
  it('取消口がない旧preloadにはcontrol付きexportを開始しない', async () => {
    const native = api({ token: 'old' });
    const controller = new AbortController();
    expect(await desktopCamGateway(native).saveExport?.('part.stl', 'stl', Uint8Array.of(1),
      { signal: controller.signal, isCurrent: () => true })).toBeNull();
    expect(native.saveExport).not.toHaveBeenCalled();
  });
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
