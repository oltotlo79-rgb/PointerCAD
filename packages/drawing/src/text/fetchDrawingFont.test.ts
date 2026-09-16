import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDrawingFont } from './fetchDrawingFont.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('字体の一時的な取得失敗から回復し、待機を有限にする', () => {
  it('通信失敗と本文取得失敗の後も同じ字体を取得し、成功後は再取得しない', async () => {
    vi.useFakeTimers();
    const bytes = new Uint8Array([12, 34, 56]);
    const interrupted = new Response(bytes);
    vi.spyOn(interrupted, 'arrayBuffer').mockRejectedValue(new TypeError('body interrupted'));
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('net::ERR_NO_BUFFER_SPACE'))
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const result = fetchDrawingFont('/fonts/test.otf');
    await vi.runAllTimersAsync();
    expect(new Uint8Array(await result)).toEqual(bytes);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(Array(3).fill('/fonts/test.otf'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('見つからない字体は再取得せず、HTTPの失敗を残す', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchDrawingFont('/missing.otf')).rejects.toThrow('Font HTTP 404');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('返信しない取得を3回の有限時間で中止し、タイマーを残さない', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (signal == null) throw new Error('中止信号なし');
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const outcome = fetchDrawingFont('/slow.otf').then(() => 'unexpected', (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(DOMException);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
