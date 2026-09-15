import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { APP_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { inspectPreparedOfflineEdition } from './offlineReady.js';
import { OFFLINE_CACHE_PREFIX, OFFLINE_READY_FORMAT } from './offlinePreparation.js';

const base = new URL('https://pointercad.test/');
const files = [{ path: 'index.html', text: 'hello' }, { path: 'worker.js', text: 'worker' }];
const manifest = createOfflineAssetManifest(files.map(file => ({ path: file.path,
  bytes: new TextEncoder().encode(file.text) })), files.map(file => file.path));
const cacheName = `${OFFLINE_CACHE_PREFIX}${manifest.buildId}-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const markerUrl = new URL('offline-assets.json', base).href;

function response(file: { path: string; text: string }): Response {
  const result = new Response(file.text, { headers: {
    'Content-Type': file.path.endsWith('.html') ? 'text/html' : 'text/javascript',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY,
  } });
  // Synthetic metadata only. The real browser cache also needs its own integration coverage.
  Object.defineProperties(result, { type: { value: 'basic' }, url: {
    value: file.path === 'index.html' ? base.href : new URL(file.path, base).href,
  } });
  return result;
}
function fixture() {
  const values = new Map<string, () => Response>();
  const marker = { format: OFFLINE_READY_FORMAT, cacheName, manifest };
  values.set(markerUrl, () => new Response(JSON.stringify(marker), { headers: { 'Content-Type': 'application/json' } }));
  for (const file of files) values.set(new URL(file.path, base).href, () => response(file));
  const matches: string[] = [];
  const controller = new AbortController();
  const storage = { match: (url: string, options: { readonly cacheName: string }) => {
    expect(options.cacheName).toBe(cacheName);
    matches.push(url);
    return Promise.resolve(values.get(url)?.());
  } };
  return { values, marker, storage, matches, controller,
    inspect: () => inspectPreparedOfflineEdition(base, cacheName, storage, controller.signal) };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('準備済みの印だけで起動せず、保存された全内容を再確認する', () => {
  it('全資産と完了印が残る同じ版を、通信や書込みをせず起動候補へ返す', async () => {
    const f = fixture(), network = vi.spyOn(globalThis, 'fetch');
    const before = [...f.values.keys()];
    await expect(f.inspect()).resolves.toEqual({ cacheName, manifest });
    expect(network).not.toHaveBeenCalled();
    expect([...f.values.keys()]).toEqual(before);
  });
  it.each(['offline-assets.json', 'worker.js'])('印または必要ファイル%sが消えた版を利用可能にしない', async path => {
    const f = fixture();
    f.values.delete(new URL(path, base).href);
    await expect(f.inspect()).rejects.toMatchObject({ reason: path === 'offline-assets.json' ? 'missing' : 'asset' });
    expect(f.values.has(new URL('index.html', base).href)).toBe(true);
  });
  it('同じ長さでも内容が変わった資産を拒否し、残る内容を消さない', async () => {
    const f = fixture();
    f.values.set(new URL('worker.js', base).href, () => response({ path: 'worker.js', text: 'WORKER' }));
    const before = [...f.values.keys()];
    await expect(f.inspect()).rejects.toMatchObject({ reason: 'asset' });
    expect([...f.values.keys()]).toEqual(before);
  });
  it('元のファイルが同じでも、安全な起動に必要な応答条件の欠落を拒否する', async () => {
    const f = fixture();
    f.values.set(base.href + 'index.html', () => {
      const value = response(files[0]); value.headers.delete('Cross-Origin-Embedder-Policy'); return value;
    });
    await expect(f.inspect()).rejects.toMatchObject({ reason: 'asset' });
  });
  it.each(['bad-json', 'different-name', 'different-manifest'])('破損した完了印%sを起動候補へ使わない', async kind => {
    const f = fixture();
    const body = kind === 'bad-json' ? '{' : JSON.stringify(kind === 'different-name'
      ? { ...f.marker, cacheName: 'other-cache' } : { ...f.marker, manifest: { ...manifest, buildId: '0'.repeat(64) } });
    f.values.set(markerUrl, () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    await expect(f.inspect()).rejects.toMatchObject({ reason: 'marker' });
    expect(f.matches.some(url => url.endsWith('worker.js'))).toBe(false);
  });
  it('確認途中に完了印が消えた版を、そのまま成功にしない', async () => {
    const f = fixture();
    f.values.set(base.href + 'worker.js', () => { f.values.delete(markerUrl); return response(files[1]); });
    await expect(f.inspect()).rejects.toMatchObject({ reason: 'missing' });
  });
  it('開始前と読取り中の取消で、未確認の版を返さない', async () => {
    const before = fixture(); before.controller.abort();
    await expect(before.inspect()).rejects.toMatchObject({ reason: 'cancelled' });
    expect(before.matches).toEqual([]);
    const during = fixture();
    during.values.set(base.href + 'worker.js', () => { during.controller.abort(); return response(files[1]); });
    await expect(during.inspect()).rejects.toMatchObject({ reason: 'cancelled' });
    expect(during.values.has(markerUrl)).toBe(true);
  });
});
