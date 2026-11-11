import { describe, expect, it, vi } from 'vitest';
import { createDesktopFileGateway } from './desktopFileGateway.js';

vi.mock('@pointercad/ui', () => ({ t: (key: string) => key }));

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('未初期化'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('デスクトップ画面の保存先キャッシュ（レビュー R02）', () => {
  it('通常saveAsにもcontrolを渡しpicker中取消の旧成功を採らない', async () => {
    const pending = deferred<boolean>();
    const api = {
      openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => Promise.resolve(false),
      openFile: () => Promise.resolve(null), saveFileAs: vi.fn<(
        name: string, kind: string, bytes: Uint8Array, requestId?: string,
      ) => Promise<boolean>>(() => pending.promise),
      cancelExportSave: vi.fn(() => Promise.resolve(true)),
    };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.saveFileAs === undefined) throw new Error('saveAs口なし');
    const controller = new AbortController();
    const saving = gateway.saveFileAs('part.3mf', '3mf', Uint8Array.of(1),
      { signal: controller.signal, isCurrent: () => !controller.signal.aborted });
    const requestId: unknown = api.saveFileAs.mock.calls[0]?.[3];
    expect(requestId).toMatch(/^[\da-f-]{36}$/i);
    controller.abort();
    expect(api.cancelExportSave).toHaveBeenCalledExactlyOnceWith(requestId);
    pending.resolve(true);
    expect(await saving).toBe(false);
    expect(gateway.hasSaveTarget()).toBe(false);
  });
  it('旧preloadに取消口がないときcontrol付き通常saveAsは開始しない', async () => {
    const api = { openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => Promise.resolve(false), openFile: () => Promise.resolve(null),
      saveFileAs: vi.fn(() => Promise.resolve(true)) };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    const controller = new AbortController();
    expect(await gateway?.saveFileAs?.('part.stl', 'stl', Uint8Array.of(1),
      { signal: controller.signal, isCurrent: () => true })).toBe(false);
    expect(api.saveFileAs).not.toHaveBeenCalled();
  });
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

describe('「開く」の大きさ関連の失敗をWeb版と同じ鍵で画面へ出す（P12-26 続き）', () => {
  // 本体プロセス(pcadDialogs.ts)の印。文字列は同じ値を書き写している(実装ファイルの注記参照)。
  const TOO_LARGE_MARKER = 'PCAD_READ_TOO_LARGE:';
  const SIZE_CHANGED_MARKER = 'PCAD_READ_SIZE_CHANGED:';
  // Electron の ipcRenderer.invoke が実際に拒否する文面の形を模す(saveFailure.test.ts と同じ流儀)。
  const asIpcRejection = (channel: string, marker: string, text: string) =>
    new Error(`Error invoking remote method '${channel}': Error: ${marker} ${text}`);

  function apiWith(overrides: { openPcad?: () => Promise<unknown>; openFile?: () => Promise<unknown> }) {
    return {
      openPcad: overrides.openPcad ?? (() => Promise.resolve(null)),
      confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined),
      savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => Promise.resolve(false),
      openFile: overrides.openFile ?? (() => Promise.resolve(null)),
      saveFileAs: () => Promise.resolve(false),
    };
  }

  it('部品を開く(openPcad)で大きすぎるとき、Web版と同じfile.error.tooLargeを投げる', async () => {
    const api = apiWith({ openPcad: () => Promise.reject(
      asIpcRejection('pcad:open', TOO_LARGE_MARKER, 'ファイルが大きすぎます。種類ごとの読込上限を超えています。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    await expect(gateway.openPcad('part')).rejects.toThrow('file.error.tooLarge');
  });

  it('部品を開く(openPcad)で読込中に大きさが変わったとき、Web版と同じfile.error.corruptedを投げる', async () => {
    const api = apiWith({ openPcad: () => Promise.reject(
      asIpcRejection('pcad:open', SIZE_CHANGED_MARKER, '読込中にファイルの大きさが変わりました。もう一度開いてください。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    await expect(gateway.openPcad('part')).rejects.toThrow('file.error.corrupted');
  });

  it('種類つき読込(openFile)で大きすぎるとき、Web版と同じfile.error.tooLargeを投げる', async () => {
    const api = apiWith({ openFile: () => Promise.reject(
      asIpcRejection('pcad:openAny', TOO_LARGE_MARKER, 'ファイルが大きすぎます。種類ごとの読込上限を超えています。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.openFile === undefined) throw new Error('typed gateway required');
    await expect(gateway.openFile(['step'])).rejects.toThrow('file.error.tooLarge');
  });

  it('種類つき読込(openFile)で読込中に大きさが変わったとき、Web版と同じfile.error.corruptedを投げる', async () => {
    const api = apiWith({ openFile: () => Promise.reject(
      asIpcRejection('pcad:openAny', SIZE_CHANGED_MARKER, '読込中にファイルの大きさが変わりました。もう一度開いてください。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.openFile === undefined) throw new Error('typed gateway required');
    await expect(gateway.openFile(['step'])).rejects.toThrow('file.error.corrupted');
  });

  it('心当たりのない失敗(印なし)は文面を変えずにそのまま伝える', async () => {
    const api = apiWith({ openPcad: () => Promise.reject(new Error('permission denied')) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    await expect(gateway.openPcad('part')).rejects.toThrow('permission denied');
  });
});

describe('パラメータCSVの画面側口', () => {
  const base = (openFile: () => Promise<unknown>) => ({
    openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true),
    clearSaveTarget: () => Promise.resolve(undefined), savePcad: () => Promise.resolve(null),
    hasSaveTarget: () => Promise.resolve(true), openFile, saveFileAs: () => Promise.resolve(false),
  });

  it('CSV専用の依頼を送り、取消と異種応答を分け、保存先を変えない', async () => {
    const openFile = vi.fn(() => Promise.resolve<unknown>({ name: '係数.csv', kind: 'csv', bytes: Uint8Array.of(1) }));
    const gateway = createDesktopFileGateway({ pointercadDesktop: base(openFile) });
    if (gateway?.openParameterCsv === undefined) throw new Error('CSV口が必要');
    expect(await gateway.openParameterCsv()).toEqual({ fileName: '係数.csv', bytes: Uint8Array.of(1) });
    expect(openFile).toHaveBeenCalledWith(['csv']);
    expect(gateway.hasSaveTarget()).toBe(true);
    const cancelled = createDesktopFileGateway({ pointercadDesktop: base(() => Promise.resolve(null)) });
    expect(await cancelled?.openParameterCsv?.()).toBeNull();
    const wrong = createDesktopFileGateway({ pointercadDesktop: base(() => Promise.resolve({
      name: '係数.csv', kind: 'step', bytes: Uint8Array.of(1),
    })) });
    await expect(wrong?.openParameterCsv?.()).rejects.toThrow('file.openFailed');
  });

  it('IPC後の1MiB超過を拒否する', async () => {
    const gateway = createDesktopFileGateway({ pointercadDesktop: base(() => Promise.resolve({
      name: '係数.csv', kind: 'csv', bytes: new Uint8Array(1024 * 1024 + 1),
    })) });
    await expect(gateway?.openParameterCsv?.()).rejects.toThrow('file.error.tooLarge');
  });
});
