import { afterEach, describe, expect, it, vi } from 'vitest';
import { yieldToMessages } from './yieldToMessages.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CADの段間のメッセージと取消timer', () => {
  it('先に予約した取消timerを、次の段へ進む前に届ける', async () => {
    for (let index = 0; index < 12; index += 1) {
      let cancelled = false;
      setTimeout(() => { cancelled = true; }, 0);
      await yieldToMessages();
      expect(cancelled).toBe(true);
    }
  });

  it('別のMessagePortから来る取消も受け取れる', async () => {
    const input = new MessageChannel();
    try {
      let cancelled = false;
      input.port1.onmessage = () => { cancelled = true; };
      input.port2.postMessage('cancel');
      await yieldToMessages();
      expect(cancelled).toBe(true);
    } finally { input.port1.close(); input.port2.close(); }
  });

  it('MessageChannelがない環境でも実timerを待つ', async () => {
    vi.stubGlobal('MessageChannel', undefined);
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 0);
    await yieldToMessages();
    expect(cancelled).toBe(true);
  });

  it('毎回の両portを閉じ、待機の通信路を残さない', async () => {
    const Channel = MessageChannel, closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.stubGlobal('MessageChannel', function () {
      const channel = new Channel();
      closes.push(vi.spyOn(channel.port1, 'close'), vi.spyOn(channel.port2, 'close'));
      return channel;
    });
    await yieldToMessages();
    expect(closes).toHaveLength(2);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });

  it('送信失敗もErrorとして伝え、両portを解放する', async () => {
    const channel = new MessageChannel();
    const closes = [vi.spyOn(channel.port1, 'close'), vi.spyOn(channel.port2, 'close')];
    const failure = new Error('transport failed');
    vi.spyOn(channel.port2, 'postMessage').mockImplementation(() => { throw failure; });
    vi.stubGlobal('MessageChannel', function () { return channel; });
    await expect(yieldToMessages()).rejects.toBe(failure);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });
});
