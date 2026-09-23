import { describe, expect, it, vi } from 'vitest';
import { startBrowserApplication } from './startupRecovery.js';

function fixture() {
  const data = new Map([['saved-user-setting', 'keep']]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  return { data, storage, options: { load: vi.fn<() => Promise<unknown>>(), storage: () => storage,
    address: 'https://example.test/cad/?edition=1#part', reload: vi.fn(), ready: vi.fn(), failed: vi.fn() } };
}

describe('起動前の取得失敗だけ一度再試行し、保存内容を保持する', () => {
  it.each([
    new TypeError('Failed to fetch dynamically imported module: /assets/main.js'),
    new TypeError('error loading dynamically imported module: /assets/main.js'),
    new TypeError('Importing a module script failed.'),
    new Error('Unable to preload CSS for /assets/main.css'),
  ])('%sでも二度目に止まり、成功した次の起動だけ記録を解除する', async error => {
    const f = fixture(); f.options.load.mockRejectedValue(error);
    expect(await startBrowserApplication(f.options)).toBe('reloading');
    expect(f.options.failed).not.toHaveBeenCalled();
    expect(await startBrowserApplication(f.options)).toBe('failed');
    expect(f.options.reload).toHaveBeenCalledTimes(1);
    expect(f.options.failed).toHaveBeenCalledWith(error);
    expect(f.options.ready).not.toHaveBeenCalled();
    f.options.load.mockResolvedValue(undefined);
    expect(await startBrowserApplication(f.options)).toBe('ready');
    expect([...f.data]).toEqual([['saved-user-setting', 'keep']]);
    f.options.load.mockRejectedValue(error);
    expect(await startBrowserApplication(f.options)).toBe('reloading');
    expect(f.options.reload).toHaveBeenCalledTimes(2);
  });

  it.each(['getter', 'get', 'set', 'silent'] as const)('保存先の%s失敗で無限に再読み込みしない', async kind => {
    const f = fixture(); f.options.load.mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'));
    const denied = (): never => { throw new Error('denied'); };
    if (kind === 'getter') f.options.storage = denied;
    if (kind === 'get') f.storage.getItem = denied;
    if (kind === 'set') f.storage.setItem = denied;
    if (kind === 'silent') f.storage.setItem = () => {};
    expect(await startBrowserApplication(f.options)).toBe('failed');
    expect(f.options.reload).not.toHaveBeenCalled();
    expect([...f.data]).toEqual([['saved-user-setting', 'keep']]);
  });

  it.each([new TypeError('Cannot read properties of undefined'), new SyntaxError('Unexpected token'), 'offline'])(
    '読み込み失敗以外の例外%sは隠さず案内へ渡す', async error => {
      const f = fixture(); f.options.load.mockRejectedValue(error);
      expect(await startBrowserApplication(f.options)).toBe('failed');
      expect(f.options.failed).toHaveBeenCalledWith(error);
      expect(f.options.reload).not.toHaveBeenCalled();
      expect([...f.data]).toEqual([['saved-user-setting', 'keep']]);
    },
  );

  it('再読み込み自体が拒否されても元の失敗と手動案内を残す', async () => {
    const f = fixture(), error = new TypeError('Failed to fetch dynamically imported module');
    f.options.load.mockRejectedValue(error); f.options.reload.mockImplementation(() => { throw new Error('denied'); });
    expect(await startBrowserApplication(f.options)).toBe('failed');
    expect(f.options.failed).toHaveBeenCalledWith(error);
  });

  it('記録を消せなくても、読み込みに成功した画面を妨げない', async () => {
    const f = fixture(); f.options.load.mockRejectedValue(new TypeError('error loading dynamically imported module'));
    await startBrowserApplication(f.options);
    f.options.load.mockResolvedValue(undefined);
    f.storage.removeItem = () => { throw new Error('denied'); };
    expect(await startBrowserApplication(f.options)).toBe('ready');
    expect(f.options.ready).toHaveBeenCalledTimes(1);
    expect(f.data.get('saved-user-setting')).toBe('keep');
  });
});
