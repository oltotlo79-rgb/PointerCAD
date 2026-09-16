import { describe, expect, it, vi } from 'vitest';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { OFFLINE_MAX_MANIFEST_BYTES } from '../../../../scripts/vite/offlineProtocol.mjs';
import { fetchOfflineInventory } from './offlineInventory.js';

const base = new URL('https://pointercad.test/');
const manifestUrl = new URL('offline-assets.json', base).href;
const manifest = createOfflineAssetManifest([{ path: 'index.html', bytes: new TextEncoder().encode('hello') }], ['index.html']);
function network(body: BodyInit | null, headers: HeadersInit = { 'Content-Type': 'application/json' }) {
  const response = new Response(body, { headers });
  // Unit-only metadata; actual same-origin routing is verified in the browser separately.
  Object.defineProperties(response, { url: { value: manifestUrl }, type: { value: 'basic' } });
  return response;
}
function start(response: Response, controller = new AbortController(), fetchedBytes: (bytes: number) => void = () => undefined) {
  const fetchResponse = vi.fn<typeof fetch>(() => Promise.resolve(response));
  return { fetchResponse, operation: fetchOfflineInventory(base, { signal: controller.signal, fetchedBytes, fetchResponse }) };
}

describe('通信なし用の一覧は読込み量と内容を確認してから採用する', () => {
  it('申告された取得量に依存せず、全内容と必須項目を確認した一覧を返す', async () => {
    const body = JSON.stringify(manifest), progress: number[] = [];
    const run = start(network(body, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': '1' }),
      new AbortController(), value => { progress.push(value); });
    const result = await run.operation;
    expect(result).toEqual(manifest);
    expect(Object.isFrozen(result)).toBe(true);
    expect(progress.at(-1)).toBe(new TextEncoder().encode(body).byteLength);
    expect(run.fetchResponse).toHaveBeenCalledTimes(1);
    expect(run.fetchResponse.mock.calls[0]?.[0]).toEqual(new URL(manifestUrl));
  });
  it.each(['{"format":', '{}', JSON.stringify({ ...manifest, buildId: '0'.repeat(64) }),
    JSON.stringify({ ...manifest, required: [] })])('不完全・破損した一覧から資産の取得へ進めない: %s', async body => {
    const run = start(network(body));
    await expect(run.operation).rejects.toMatchObject({ reason: 'inventory' });
    expect(run.fetchResponse).toHaveBeenCalledTimes(1);
  });
  it('文字として解釈できない取得物を勝手に置換して一覧にしない', async () => {
    await expect(start(network(new Uint8Array([0xff, 0xfe, 0xff]))).operation).rejects.toMatchObject({ reason: 'inventory' });
  });
  it('一覧の8MiB上限を超える取得は、相手が閉じる前に止める', async () => {
    const response = network(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(OFFLINE_MAX_MANIFEST_BYTES + 1));
      // Deliberately no EOF: reaching the bound must independently stop this response.
    } }), { 'Content-Type': 'application/json', 'Content-Length': '1' });
    const run = start(response);
    await expect(run.operation).rejects.toMatchObject({ reason: 'size' });
    expect(run.fetchResponse.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('取得先が返したHTMLをJSONの一覧として扱わない', async () => {
    await expect(start(network(JSON.stringify(manifest), { 'Content-Type': 'text/html' })).operation)
      .rejects.toMatchObject({ reason: 'response' });
  });
  it('一覧の取得途中に取り消した場合は解析や資産取得へ進まない', async () => {
    const controller = new AbortController();
    const response = network(new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{"format":'));
    } }));
    const run = start(response, controller, () => { controller.abort(); });
    await expect(run.operation).rejects.toMatchObject({ reason: 'cancelled' });
    expect(run.fetchResponse).toHaveBeenCalledTimes(1);
  });
  it('壊れた基準URLでは通信を始めない', async () => {
    const fetchResponse = vi.fn<typeof fetch>(() => Promise.resolve(network(JSON.stringify(manifest))));
    await expect(fetchOfflineInventory(new URL('https://user:password@pointercad.test/?query=1'), {
      signal: new AbortController().signal, fetchedBytes: () => undefined, fetchResponse,
    })).rejects.toMatchObject({ reason: 'response' });
    expect(fetchResponse).not.toHaveBeenCalled();
  });
});
