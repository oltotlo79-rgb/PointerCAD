import { expect, test } from '@playwright/test';
import { captureNetworkState, collectFailedRequests, linuxNetworkState, recordRequestFailures, windowsNetworkState,
  type NetworkState } from './networkFailureEvidence.js';

// 読込の失敗の記録(networkFailureEvidence.ts)の契約。実アプリを開かず、合成の要求と OS の出力の写しで確かめる。
// 2026-11-13 の外部検査で「Failed to load resource: net::ERR_NO_BUFFER_SPACE」だけが残り、どの資源か決められなかった。

test('失敗した要求の url・種類・誤りの文・時刻を集め、上限を超えた分は数だけ数える', async ({ page }) => {
  await page.route('http://failed-request.invalid/**', route => route.abort('failed'));
  const all = collectFailedRequests(page), limited = collectFailedRequests(page, 1);
  const before = performance.now();
  await page.setContent('<img src="http://failed-request.invalid/a.png"><img src="http://failed-request.invalid/b.png">');
  await expect.poll(() => all.requests.length).toBe(2);
  const urls = all.requests.map(request => request.url).sort();
  expect(urls).toEqual(['http://failed-request.invalid/a.png', 'http://failed-request.invalid/b.png']);
  for (const request of all.requests) {
    expect(request.resourceType).toBe('image');
    expect(request.errorText).toMatch(/ERR_FAILED|NS_ERROR/u);
    expect(request.atMs).toBeGreaterThanOrEqual(before);
  }
  expect(all.dropped).toBe(0);
  expect(limited.requests).toHaveLength(1);
  expect(limited.dropped).toBe(1);
});

test('console の誤りが無ければ、通信の状態を取りに行かず、添付もログも出さない', async ({ page }, info) => {
  const failed = collectFailedRequests(page);
  let captured = 0;
  const attachments = info.attachments.length;
  const record = await recordRequestFailures(info, { label: '誤りなし', errors: [], failed,
    capture: () => { captured += 1; return Promise.resolve({ status: 'unavailable', reason: 'not expected' }); } });
  expect(record).toBeNull();
  expect(captured).toBe(0);
  expect(info.attachments).toHaveLength(attachments);
});

test('console の誤りがあれば、通信の状態を 1 回取り、1 行の JSON をログへ出して同じ記録を添付する', async ({ page }, info) => {
  const failed = collectFailedRequests(page);
  failed.requests.push({ url: 'http://127.0.0.1:4173/assets/a.js', resourceType: 'script', errorText: 'net::ERR_NO_BUFFER_SPACE', atMs: 12.5 });
  const network: NetworkState = { status: 'linux', sockstat: { TCP: { inuse: 3, tw: 1 } } };
  let captured = 0;
  const lines: unknown[][] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args); };
  let record: Awaited<ReturnType<typeof recordRequestFailures>>;
  try {
    record = await recordRequestFailures(info, { label: '誤りあり', errors: ['Failed to load resource: net::ERR_NO_BUFFER_SPACE'], failed,
      capture: () => { captured += 1; return Promise.resolve(network); } });
  } finally { console.log = original; }
  expect(captured).toBe(1);
  expect(record).toEqual({ label: '誤りあり', errors: ['Failed to load resource: net::ERR_NO_BUFFER_SPACE'],
    failedRequests: failed.requests, droppedRequests: 0, network });
  const logged = lines.filter(line => line[0] === '[通信の失敗]');
  expect(logged).toHaveLength(1);
  expect(JSON.parse(String(logged[0]?.[1]))).toEqual(record);
  const attached = info.attachments.filter(item => item.name === 'request-failures');
  expect(attached).toHaveLength(1);
  expect(JSON.parse(String(attached[0]?.body))).toEqual(record);
});

test('通信の状態を取る補助が失敗しても投げず、取れなかった旨を記録する', async ({ page }, info) => {
  const failed = collectFailedRequests(page);
  const record = await recordRequestFailures(info, { label: '取得の失敗', errors: ['x'], failed,
    capture: () => Promise.reject(new Error('powershell missing')) });
  expect(record?.network.status).toBe('unavailable');
  expect(record?.network.status === 'unavailable' ? record.network.reason : '').toContain('powershell missing');
});

test('Windows の PowerShell の出力を、状態ごとの数・preview の口への接続の数・一時ポートの範囲に整え、形の違う出力は断る', () => {
  expect(windowsNetworkState({ states: [{ state: 'Established', count: 40 }, { state: 'TimeWait', count: 900 }],
    preview: 12, start: 49152, count: 16384 }, 4173)).toEqual({ status: 'windows', tcpStates: { Established: 40, TimeWait: 900 },
    previewPort: 4173, previewConnections: 12, dynamicPortStart: 49152, dynamicPortCount: 16384 });
  expect(windowsNetworkState({ states: [{ state: 'Listen', count: 3 }], preview: 0, start: null, count: null }, 4173))
    .toMatchObject({ status: 'windows', dynamicPortStart: null, dynamicPortCount: null });
  for (const malformed of [null, 'text', { states: 'Established', preview: 1, start: 1, count: 1 },
    { states: [{ state: 'Listen', count: '3' }], preview: 0, start: null, count: null },
    { states: [], preview: -1, start: null, count: null }]) {
    expect(windowsNetworkState(malformed, 4173).status).toBe('unavailable');
  }
});

test('Linux の /proc/net/sockstat を種類ごとの値に整え、TCP の行が無い本文は断る', () => {
  const text = ['sockets: used 213', 'TCP: inuse 5 orphan 0 tw 7 alloc 9 mem 1', 'UDP: inuse 2 mem 3', ''].join('\n');
  expect(linuxNetworkState(text)).toEqual({ status: 'linux', sockstat: {
    sockets: { used: 213 }, TCP: { inuse: 5, orphan: 0, tw: 7, alloc: 9, mem: 1 }, UDP: { inuse: 2, mem: 3 } } });
  expect(linuxNetworkState('sockets: used 2\nUDP: inuse 1').status).toBe('unavailable');
});

test('この機械の通信の状態を、投げずに実際に取れる(Windows は PowerShell、Linux は /proc)', async () => {
  const state = await captureNetworkState(4173);
  const expected = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unavailable';
  expect(state.status, JSON.stringify(state)).toBe(expected);
});
