import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserOfflineGateway, type BrowserOfflineOptions } from './browserOfflineGateway.js';
import { fetchOfflineInventory } from './offlineInventory.js';
import { prepareOfflineEdition, OfflinePreparationError } from './offlinePreparation.js';
import { inspectPreparedOfflineEdition } from './offlineReady.js';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';

vi.mock('./offlineInventory.js', () => ({ fetchOfflineInventory: vi.fn() }));
vi.mock('./offlinePreparation.js', async importOriginal => ({
  ...await importOriginal<typeof import('./offlinePreparation.js')>(), prepareOfflineEdition: vi.fn(),
}));
vi.mock('./offlineReady.js', () => ({ inspectPreparedOfflineEdition: vi.fn() }));

const manifest = createOfflineAssetManifest([{ path: 'index.html', bytes: new TextEncoder().encode('hello') }], ['index.html']);
const prepared = { cacheName: 'pointercad-offline-edition-v1-fixture', manifest };
function fixture() {
  const active = vi.fn(() => Promise.resolve(true)), ensure = vi.fn(() => Promise.resolve());
  const keys = vi.fn(() => Promise.resolve<string[]>([]));
  const options: BrowserOfflineOptions = {
    baseUrl: new URL('https://pointercad.test/app/'), registration: { active, ensure },
    locks: { request: vi.fn() }, storage: { keys,
      has: () => Promise.resolve(false), open: () => Promise.reject(new Error('Unexpected direct cache write')),
      match: () => Promise.resolve(undefined), delete: () => Promise.reject(new Error('Unexpected direct deletion')) },
  };
  return { gateway: createBrowserOfflineGateway(options), options, active, ensure, keys };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Not initialized'); };
  const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchOfflineInventory).mockResolvedValue(manifest);
  vi.mocked(prepareOfflineEdition).mockResolvedValue(prepared);
  vi.mocked(inspectPreparedOfflineEdition).mockResolvedValue(prepared);
});
describe('通信なしの準備を画面の寿命から分離し、登録と全取得の成功後にだけ完了表示する', () => {
  it('登録失敗では取得も保存も開始せず、理由を表示する', async () => {
    const f = fixture(); f.ensure.mockRejectedValue(new Error('Registration failed'));
    await f.gateway.prepare();
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'registration' });
    expect(fetchOfflineInventory).not.toHaveBeenCalled(); expect(prepareOfflineEdition).not.toHaveBeenCalled();
  });
  it('設定を閉じても続行し、再表示と二重開始で取得を増やさない', async () => {
    const f = fixture(), entered = deferred<void>(), finish = deferred<typeof prepared>();
    const listener = vi.fn(), remove = f.gateway.subscribe(listener);
    vi.mocked(prepareOfflineEdition).mockImplementation(options => {
      options.progress({ phase: 'verifying', receivedBytes: 5, totalBytes: 5, storedFiles: 1, totalFiles: 1 });
      entered.resolve(); return finish.promise;
    });
    const operation = f.gateway.prepare(); await entered.promise;
    expect(f.gateway.getSnapshot().phase).toBe('preparing'); remove(); const calls = listener.mock.calls.length;
    await f.gateway.refresh(); await f.gateway.prepare(); expect(prepareOfflineEdition).toHaveBeenCalledTimes(1);
    finish.resolve(prepared); await operation;
    expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'ready', totalFiles: 1, receivedBytes: 5 });
    expect(listener).toHaveBeenCalledTimes(calls);
  });
  it('準備の取消を保存側へ渡し、遅い取消が完了後に届いても成功した版を取り消さない', async () => {
    const f = fixture(), entered = deferred<AbortSignal>(), finish = deferred<typeof prepared>();
    vi.mocked(prepareOfflineEdition).mockImplementation(options => { entered.resolve(options.signal); return finish.promise; });
    const operation = f.gateway.prepare(), signal = await entered.promise;
    f.gateway.cancel(); expect(signal.aborted).toBe(true);
    finish.resolve(prepared); await operation; expect(f.gateway.getSnapshot().phase).toBe('ready');
  });
  it('取消の失敗結果は完了とせず、準備中の片付け失敗も明示する', async () => {
    const f = fixture();
    vi.mocked(prepareOfflineEdition).mockRejectedValue(new OfflinePreparationError('cancelled', false));
    await f.gateway.prepare(); expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'cancelled' });
    vi.mocked(prepareOfflineEdition).mockRejectedValue(new OfflinePreparationError('cancelled', true));
    await f.gateway.prepare(); expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'storage' });
  });
  it('完了印があっても全ファイルが読めなければ準備済みと表示しない', async () => {
    const f = fixture(); f.keys.mockResolvedValue([prepared.cacheName]);
    vi.mocked(inspectPreparedOfflineEdition).mockRejectedValue(new Error('Asset missing'));
    await f.gateway.refresh(); expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'missing' });
    expect(prepareOfflineEdition).not.toHaveBeenCalled();
  });
  it('全ファイルがあっても起動する処理が有効でなければ準備済みと表示しない', async () => {
    const f = fixture(); f.keys.mockResolvedValue([prepared.cacheName]); f.active.mockResolvedValue(false);
    await f.gateway.refresh(); expect(f.gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'registration' });
  });
  it('保存機能が使えない環境では未対応と返し、登録も取得もしない', async () => {
    const f = fixture(), gateway = createBrowserOfflineGateway({ ...f.options, storage: undefined });
    await gateway.refresh(); await gateway.prepare();
    expect(gateway.getSnapshot()).toMatchObject({ phase: 'error', reason: 'unsupported' });
    expect(f.ensure).not.toHaveBeenCalled(); expect(fetchOfflineInventory).not.toHaveBeenCalled();
  });
  it('空き容量が取得できなくても実際の保存結果で判定し、目安0だけでは打ち切らない', async () => {
    const f = fixture(), estimate = vi.fn(() => Promise.reject(new Error('No estimate')));
    const gateway = createBrowserOfflineGateway({ ...f.options, estimate });
    await gateway.prepare(); expect(gateway.getSnapshot().phase).toBe('ready');
    const withZero = createBrowserOfflineGateway({ ...f.options, estimate: () => Promise.resolve({ quota: 1, usage: 1 }) });
    await withZero.prepare(); expect(withZero.getSnapshot().phase).toBe('ready');
  });
});
