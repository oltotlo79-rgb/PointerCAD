import { describe, expect, it, vi } from 'vitest';
import { createDesktopFileGateway } from './desktopFileGateway.js';

vi.mock('@pointercad/ui', () => ({ t: (key: string) => key }));

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('未初期化'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('デスクトップ画面の保存先キャッシュ（レビュー R02）', () => {
  it('解除後に古い保存が返っても上書き先ありに戻さない', async () => {
    const saved = deferred<string>();
    const gateway = createDesktopFileGateway({ pointercadDesktop: {
      openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true), clearSaveTarget: () => Promise.resolve(undefined),
      savePcad: () => saved.promise, hasSaveTarget: () => Promise.resolve(false),
    } });
    if (gateway === null) throw new Error('gateway が必要');
    const pending = gateway.savePcad('A.pcad', Uint8Array.of(1), true);
    gateway.clearSaveTarget?.(); saved.resolve('A.pcad');
    expect(await pending).toBeNull(); expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('古い確定依頼の返答が新しい確定を取り消さない', async () => {
    const old = deferred<boolean>();
    const gateway = createDesktopFileGateway({ pointercadDesktop: {
      openPcad: () => Promise.resolve(null), confirmSaveTarget: (token: string) => token === 'old' ? old.promise : Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), savePcad: () => Promise.resolve('A.pcad'), hasSaveTarget: () => Promise.resolve(false),
    } });
    if (gateway === null) throw new Error('gateway が必要');
    const pending = gateway.confirmSaveTarget?.('old');
    gateway.clearSaveTarget?.(); await gateway.confirmSaveTarget?.('new');
    old.resolve(false); await pending;
    expect(gateway.hasSaveTarget()).toBe(true);
  });
});
