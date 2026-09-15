import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { contentSecurityPolicyFor } from '@pointercad/ui/security-policy';
import { offlineAssetRequestUrl } from './offlineNetwork.js';
import { OFFLINE_CACHE_PREFIX, OFFLINE_READY_FORMAT } from './offlinePreparation.js';
import { loadPreparedOfflineResponder } from './offlineServing.js';

function fixture(base = new URL('https://pointercad.test/app/'), edition = 'old') {
  const files = [{ path: 'index.html', text: edition }, { path: 'worker.js', text: edition + '-worker' },
    { path: 'manual/overview.html', text: edition + '-manual' }];
  const manifest = createOfflineAssetManifest(files.map(file => ({ path: file.path,
    bytes: new TextEncoder().encode(file.text) })), files.map(file => file.path));
  const cacheName = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
  function response(file: { path: string; text: string }) {
    const response = new Response(file.text, { headers: {
      'Content-Type': file.path.endsWith('.html') ? 'text/html' : 'text/javascript',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': contentSecurityPolicyFor('/' + file.path),
      'X-Edition': edition,
    } });
    // Unit metadata is synthetic; browser-cache response identity is covered in real routing checks.
    Object.defineProperties(response, { type: { value: 'basic' }, url: { value: offlineAssetRequestUrl(base, file.path).href } });
    return response;
  }
  const values = new Map(files.map(file => [new URL(file.path, base).href, () => response(file)]));
  values.set(new URL('offline-assets.json', base).href, () => new Response(JSON.stringify({
    format: OFFLINE_READY_FORMAT, cacheName, manifest,
  }), { headers: { 'Content-Type': 'application/json' } }));
  const calls: string[] = [];
  const storage = { match: (url: string, options: { readonly cacheName: string }) => {
    calls.push(options.cacheName); return Promise.resolve(options.cacheName === cacheName ? values.get(url)?.() : undefined);
  } };
  const signal = () => new AbortController().signal;
  return { base, files, values, cacheName, response, calls, signal,
    load: () => loadPreparedOfflineResponder(base, cacheName, storage, signal()) };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('起動後も同じ版の検証済みファイルだけを画面と計算部へ返す', () => {
  it.each(['https://pointercad.test/', 'https://pointercad.test/app/'])(
    '%sで公開用の短いURLとHTML名を同じ保存内容へ対応させる', async address => {
      const f = fixture(new URL(address)), reader = await f.load();
      for (const path of ['', 'index.html', 'manual/overview', 'manual/overview.html']) {
        const result = await reader.respond(new URL(path, f.base), f.signal());
        expect(await result.text()).toBe(path.startsWith('manual/') ? 'old-manual' : 'old');
        expect(result.headers.get('X-Edition')).toBe('old');
        expect(result.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
        expect(result.url).toBe(new URL(path.startsWith('manual/') ? 'manual/overview' : '', f.base).href);
      }
    });

  it('新旧の画面を別々の版へ保ち、ファイル取得の順序では切り替わらない', async () => {
    const old = fixture(), next = fixture(undefined, 'next');
    const first = await old.load(), second = await next.load();
    expect(await (await first.respond(new URL('worker.js', old.base), old.signal())).text()).toBe('old-worker');
    expect(await (await second.respond(new URL('worker.js', next.base), next.signal())).text()).toBe('next-worker');
    expect(await (await first.respond(old.base, old.signal())).text()).toBe('old');
    expect(new Set(old.calls)).toEqual(new Set([old.cacheName]));
    expect(new Set(next.calls)).toEqual(new Set([next.cacheName]));
  });

  it.each(['missing', 'bytes', 'headers'])(
    '起動後の%sの欠落・変更を拒否し、新版を通信で代用しない', async change => {
      const f = fixture(), reader = await f.load(), network = vi.spyOn(globalThis, 'fetch');
      const path = new URL('index.html', f.base).href;
      if (change === 'missing') f.values.delete(path);
      else f.values.set(path, () => {
        const result = f.response({ path: 'index.html', text: change === 'bytes' ? 'NEW' : 'old' });
        if (change === 'headers') result.headers.delete('Cross-Origin-Embedder-Policy');
        return result;
      });
      await expect(reader.respond(f.base, f.signal())).rejects.toMatchObject({ reason: change === 'missing' ? 'missing' : 'changed' });
      expect(network).not.toHaveBeenCalled();
      expect(await (await reader.respond(new URL('worker.js', f.base), f.signal())).text()).toBe('old-worker');
    });

  it.each(['https://other.test/app/', 'https://pointercad.test/', 'https://pointercad.test/app/unknown',
    'https://pointercad.test/app/?edition=new', 'https://pointercad.test/app/#fragment'])(
    '一覧にない場所%sを既存の画面へ返さない', async address => {
      const f = fixture(), reader = await f.load(), previous = f.calls.length;
      await expect(reader.respond(new URL(address), f.signal())).rejects.toMatchObject({ reason: 'route' });
      expect(f.calls.length).toBe(previous);
    });

  it('読取り前の取消では保存内容へアクセスしない', async () => {
    const f = fixture(), reader = await f.load(), previous = f.calls.length, controller = new AbortController();
    controller.abort();
    await expect(reader.respond(f.base, controller.signal)).rejects.toThrow();
    expect(f.calls.length).toBe(previous);
  });
});
