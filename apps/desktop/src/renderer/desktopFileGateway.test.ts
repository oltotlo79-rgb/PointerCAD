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

describe('図面の読み書きを本体プロセスへ届ける（P8-64）', () => {
  it.each(['pcadscript', 'step', 'stl', 'pcadt'] satisfies Array<'pcadscript' | 'step' | 'stl' | 'pcadt'>)('%sの読込に通常文書の保存先tokenを要求しない', async kind => {
    const bytes = Uint8Array.of(1, 2, 3);
    const api = {
      openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), savePcad: () => Promise.resolve('model.pcad'), hasSaveTarget: () => Promise.resolve(true),
      openFile: vi.fn(() => Promise.resolve({ name: `sample.${kind}`, kind, bytes })), saveFileAs: () => Promise.resolve(true),
    };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.openFile === undefined) throw new Error('typed gateway required');
    await Promise.resolve();
    expect(await gateway.openFile([kind])).toEqual({ fileName: `sample.${kind}`, kind, bytes });
    expect(api.openFile).toHaveBeenCalledWith([kind]);
    expect(gateway.hasSaveTarget()).toBe(true);
  });
  it('図面のバイト列・形式と保存先の確定を往復し、パスを画面へ出さない', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const api = {
      openPcad: vi.fn(() => Promise.resolve({ name: '組図.pcadd', bytes, saveTargetToken: 'opaque-drawing' })),
      confirmSaveTarget: vi.fn(() => Promise.resolve(true)), clearSaveTarget: () => Promise.resolve(undefined),
      savePcad: vi.fn(() => Promise.resolve('組図.pcadd')), hasSaveTarget: () => Promise.resolve(false),
    };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    const opened = await gateway.openPcad('drawing');
    expect(api.openPcad).toHaveBeenCalledWith('drawing');
    expect(opened).toEqual({ name: '組図.pcadd', bytes, saveTargetToken: 'opaque-drawing' });
    expect(gateway.hasSaveTarget()).toBe(false);
    await gateway.confirmSaveTarget?.('opaque-drawing'); expect(gateway.hasSaveTarget()).toBe(true);
    expect(await gateway.savePcad('組図.pcadd', bytes, false, 'drawing')).toBe('組図.pcadd');
    expect(api.savePcad).toHaveBeenCalledWith('組図.pcadd', bytes, false, 'drawing');
  });
});
