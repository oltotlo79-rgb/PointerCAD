import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, KERNEL_CONTENT_SECURITY_POLICY, MANUAL_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { fetchVerifiedOfflineAsset } from './offlineTransfer.js';
import { OFFLINE_PREPARATION_HEADER } from './offlineNetwork.js';

const base = new URL('https://pointercad.test/');
const bytes = new TextEncoder().encode('hello');
// Independent known SHA-256 for the UTF-8 bytes of "hello"; no server-only API in browser tests.
const asset = { url: 'assets/code.js', byteLength: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' };
function network(body: BodyInit | null, input: {
  url?: string; type?: ResponseType; status?: number; redirected?: boolean; headers?: HeadersInit;
} = {}): Response {
  const response = new Response(body, { status: input.status ?? 200,
    headers: input.headers ?? { 'Content-Type': 'text/javascript' } });
  // Synthetic metadata is only for isolated cases. Browser tests must verify actual response identity.
  Object.defineProperties(response, {
    url: { value: input.url ?? new URL(asset.url, base).href },
    type: { value: input.type ?? 'basic' }, redirected: { value: input.redirected ?? false },
  });
  return response;
}
function start(response: Response, controller = new AbortController(), fetchedBytes: (bytes: number) => void = () => undefined) {
  const fetchResponse = vi.fn<typeof fetch>(() => Promise.resolve(response));
  return { fetchResponse, operation: fetchVerifiedOfflineAsset(base, asset, {
    signal: controller.signal, fetchedBytes, fetchResponse,
  }) };
}
afterEach(() => { vi.useRealTimers(); });

describe('通信なし用の取得では実際の内容と応答条件を確認する', () => {
  it('分割して届く全内容を照合し、URL・応答条件と本文を持つ元の応答を返す', async () => {
    const response = network(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 2)); controller.enqueue(bytes.slice(2)); controller.close();
    } }), { headers: { 'Content-Type': 'text/javascript', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin' } });
    const progress: number[] = [];
    const run = start(response, new AbortController(), value => { progress.push(value); });
    const result = await run.operation;
    expect(result).toBe(response);
    expect(result.url).toBe('https://pointercad.test/assets/code.js');
    expect(result.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await result.text()).toBe('hello');
    expect(progress).toEqual([2, 5]);
    const requestOptions = run.fetchResponse.mock.calls[0]?.[1];
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(run.fetchResponse).toHaveBeenCalledExactlyOnceWith(new URL(asset.url, base), {
      signal: requestOptions?.signal, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error',
      headers: { [OFFLINE_PREPARATION_HEADER]: '1' },
    });
  });
  it.each(['hell', 'hello!', 'HELLO'])('取得した内容が%sなら長さまたは内容の違いを拒否する', async body => {
    await expect(start(network(body)).operation).rejects.toMatchObject({ reason: body === 'HELLO' ? 'hash' : 'size' });
  });
  it('申告された長さが正しくても、実際に届く内容が超過したら読み続けない', async () => {
    const response = network(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('hello!'));
      // The connection deliberately stays open. The size check must not wait for EOF.
    } }), { headers: { 'Content-Type': 'text/javascript', 'Content-Length': '5' } });
    const run = start(response);
    await expect(run.operation).rejects.toMatchObject({ reason: 'size' });
    expect(run.fetchResponse.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each([
    { type: 'opaque' as const }, { type: 'cors' as const }, { status: 206 }, { status: 404 },
    { redirected: true }, { url: 'https://pointercad.test/assets/other.js' },
    { headers: { 'Content-Type': 'text/html' } },
  ])('取得先・状態・種類が違う応答を保存候補へ渡さない: %j', async input => {
    await expect(start(network(bytes, input)).operation).rejects.toMatchObject({ reason: 'response' });
  });
  it('本文が存在しない応答を空の成功にしない', async () => {
    await expect(start(network(null)).operation).rejects.toMatchObject({ reason: 'size' });
  });
  it('開始前の取消では通信自体を始めない', async () => {
    const controller = new AbortController(); controller.abort();
    const run = start(network(bytes), controller);
    await expect(run.operation).rejects.toMatchObject({ reason: 'cancelled' });
    expect(run.fetchResponse).not.toHaveBeenCalled();
  });
  it('次の内容が届かない最中でも取消を返し、取得の信号も止める', async () => {
    const controller = new AbortController();
    const response = network(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(bytes.slice(0, 2)); } }));
    const run = start(response, controller, () => { controller.abort(); });
    await expect(run.operation).rejects.toMatchObject({ reason: 'cancelled' });
    expect(run.fetchResponse.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('最後の内容を受け取る時点で取り消しても、照合済みの成功にしない', async () => {
    const controller = new AbortController();
    await expect(start(network(bytes), controller, () => { controller.abort(); }).operation)
      .rejects.toMatchObject({ reason: 'cancelled' });
  });
  it('180秒たっても応答がない通信を無期限に待たない', async () => {
    vi.useFakeTimers();
    const fetchResponse = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }));
    const operation = fetchVerifiedOfflineAsset(base, asset, {
      signal: new AbortController().signal, fetchedBytes: () => undefined, fetchResponse,
    });
    const rejection = expect(operation).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(180_000);
    await rejection;
    expect(fetchResponse.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each(['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Content-Security-Policy'])(
    'HTMLに%sが欠けたら、内容が同じでも準備完了へ進めない', async missing => {
      const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
        'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY });
      headers.delete(missing);
      await expect(fetchVerifiedOfflineAsset(base, { ...asset, url: 'index.html' }, {
        signal: new AbortController().signal, fetchedBytes: () => undefined,
        fetchResponse: () => Promise.resolve(network(bytes, { url: base.href, headers })),
      })).rejects.toMatchObject({ reason: 'response' });
    });
  it('公開先のHTML省略URLを直接取得し、別の場所への転送は許可しない', async () => {
    const response = network(bytes, { url: base.href, headers: { 'Content-Type': 'text/html',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY } });
    const fetchResponse = vi.fn<typeof fetch>(() => Promise.resolve(response));
    const result = await fetchVerifiedOfflineAsset(base, { ...asset, url: 'index.html' }, {
      signal: new AbortController().signal, fetchedBytes: () => undefined, fetchResponse,
    });
    expect(fetchResponse.mock.calls[0]?.[0]).toEqual(new URL('https://pointercad.test/'));
    expect(fetchResponse.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(result).toBe(response);
    expect(await result.text()).toBe('hello');
  });
  it.each(['/', '/app/'])('配置先%sでも計算部専用の応答条件を保持し、通常画面用の条件との混同を拒否する', async path => {
    const applicationBase = new URL(path, base);
    const url = 'assets/kernel.worker-ab12_CD.js';
    const run = (policy: string) => fetchVerifiedOfflineAsset(applicationBase, { ...asset, url }, {
      signal: new AbortController().signal, fetchedBytes: () => undefined,
      fetchResponse: () => Promise.resolve(network(bytes, { url: new URL(url, applicationBase).href,
        headers: { 'Content-Type': 'text/javascript', 'Content-Security-Policy': policy } })),
    });
    await expect(run(APP_CONTENT_SECURITY_POLICY)).rejects.toMatchObject({ reason: 'response' });
    const valid = await run(KERNEL_CONTENT_SECURITY_POLICY);
    expect(valid.headers.get('Content-Security-Policy')).toBe(KERNEL_CONTENT_SECURITY_POLICY);
    expect(await valid.text()).toBe('hello');
  });
  it('下位フォルダーへ置いた説明書も専用の書体と通信制限を照合する', async () => {
    const applicationBase = new URL('/app/', base), url = 'manual/overview.html';
    const run = (policy: string) => fetchVerifiedOfflineAsset(applicationBase, { ...asset, url }, {
      signal: new AbortController().signal, fetchedBytes: () => undefined,
      fetchResponse: () => Promise.resolve(network(bytes, { url: new URL('manual/overview', applicationBase).href,
        headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': policy,
          'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } })),
    });
    await expect(run(APP_CONTENT_SECURITY_POLICY)).rejects.toMatchObject({ reason: 'response' });
    const valid = await run(MANUAL_CONTENT_SECURITY_POLICY);
    expect(valid.headers.get('Content-Security-Policy')).toBe(MANUAL_CONTENT_SECURITY_POLICY);
    expect(await valid.text()).toBe('hello');
  });
});
