import { describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { encodeSaveDocument, readPcadFile, writeThreeMf,
  type SaveDocumentInput, type ThreeMfMeshInput } from '@pointercad/io';
import { createPcadSaveEncoder, createPcadSavePointClient, createThreeMfExportEncoder,
  type PcadSaveWorkerPort } from './pcadSaveWorker.js';
import type { NamedSavePoint } from '../history/namedSavePoints.js';
import type { PcadSaveRequest, PcadThreeMfRequest, PcadWorkerRequest } from './pcadSaveProtocol.js';

function fixture() {
  let request: PcadSaveRequest | null = null;
  let started: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const terminate = vi.fn();
  const port: PcadSaveWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: (value, transfer) => {
      if ('input' in value) { request = structuredClone(value, { transfer }); started(); }
    }, terminate };
  const captured = () => { if (request === null) throw new Error('request missing'); return request; };
  const reply = (data: unknown) => port.onmessage?.(new MessageEvent('message', { data }));
  return { port, terminate, ready, captured, reply, encode: createPcadSaveEncoder(() => port) };
}
const input: SaveDocumentInput = { kind: 'part', document: { ...createEmptyPartDocument(), name: '実IO' },
  options: { savedAt: '2026-10-04T00:00:00.000Z' } };

const pointId = 'point:00000000-0000-4000-8000-000000000001';
const point: NamedSavePoint = { version: 1, id: pointId, originId: pointId, name: 'A',
  createdAt: '2026-10-04T00:00:00.000Z', kind: 'part', sourceSha256: 'a'.repeat(64), sourceByteLength: 1,
  entries: [{ name: 'document.json', sha256: 'b'.repeat(64), byteLength: 1, level: 6 }] };

function pointFixture() {
  const messages: PcadWorkerRequest[] = [], terminate = vi.fn();
  let started = (): void => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const port: PcadSaveWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: (value, transfer) => { messages.push(structuredClone(value, { transfer })); started(); }, terminate };
  return { port, ready, messages, terminate,
    reply: (data: unknown) => port.onmessage?.(new MessageEvent('message', { data })),
    client: createPcadSavePointClient(() => port) };
}

const threeMfMesh: ThreeMfMeshInput = { name: 'two faces', color: [1, 0, 0],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  faceColors: new Map([[1, [0, 0, 1] as const]]),
  faceRanges: [{ triangleOffset: 0, triangleCount: 1 }, { triangleOffset: 1, triangleCount: 1 }] };

function threeMfFixture() {
  let request: PcadThreeMfRequest | null = null;
  let started = (): void => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const terminate = vi.fn();
  const port: PcadSaveWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: (value, transfer) => {
      if ('kind' in value && value.kind === 'export3mf') {
        request = structuredClone(value, { transfer }); started();
      }
    }, terminate };
  return { port, terminate, ready,
    captured: () => { if (request === null) throw new Error('3MF request missing'); return request; },
    reply: (data: unknown) => port.onmessage?.(new MessageEvent('message', { data })),
    encode: createThreeMfExportEncoder(() => port) };
}

describe('3MF 短命Workerと原meshの所有', () => {
  it('1MiB以下の原配列をdetachせず、面色ZIPはwriterと同bytes、旧札/後着を捨て次も正常', async () => {
    const worker = threeMfFixture();
    const pending = worker.encode([threeMfMesh], { remainingMs: 5000 });
    await worker.ready;
    const request = worker.captured(), late = worker.port.onmessage;
    expect(threeMfMesh.positions).toHaveLength(12);
    expect(threeMfMesh.indices).toHaveLength(6);
    expect(request.meshes[0].positions).not.toBe(threeMfMesh.positions);
    worker.reply({ id: 'old', kind: 'export3mfSuccess', bytes: Uint8Array.of(0) });
    const bytes = writeThreeMf(request.meshes);
    worker.reply({ id: request.id, kind: 'export3mfSuccess', bytes });
    expect(await pending).toEqual(writeThreeMf([threeMfMesh]));
    late?.(new MessageEvent('message', { data: { id: request.id, kind: 'export3mfFailure', message: 'late' } }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.port.onmessage).toBeNull();
    const next = threeMfFixture(), nextPending = next.encode([threeMfMesh], { remainingMs: 5000 });
    await next.ready;
    expect(next.captured().id).not.toBe(request.id);
    next.reply({ id: next.captured().id, kind: 'export3mfSuccess', bytes });
    await expect(nextPending).resolves.toEqual(bytes);
  });

  it('事前容量拒否と失効はWorker生成前、処理中取消はterminateし旧返信を採用しない', async () => {
    const factory = vi.fn(() => threeMfFixture().port);
    const tooLong: ThreeMfMeshInput = { ...threeMfMesh,
      indices: new Proxy<number[]>([], { get(_target, key) {
        return key === 'length' ? Number.MAX_SAFE_INTEGER + 1 : 0;
      } }) };
    await expect(createThreeMfExportEncoder(factory)([tooLong], { remainingMs: 5000 })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    const staleFactory = vi.fn(() => threeMfFixture().port);
    await expect(createThreeMfExportEncoder(staleFactory)([threeMfMesh],
      { remainingMs: 5000, isCurrent: () => false })).rejects.toMatchObject({ name: 'AbortError' });
    expect(staleFactory).not.toHaveBeenCalled();
    const worker = threeMfFixture(), controller = new AbortController();
    const pending = worker.encode([threeMfMesh], { remainingMs: 5000, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await worker.ready;
    const late = worker.port.onmessage;
    controller.abort(); await rejected;
    late?.(new MessageEvent('message', { data: { id: worker.captured().id,
      kind: 'export3mfSuccess', bytes: Uint8Array.of(1) } }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('post後に現行性だけを失っても無応答Workerを解放し、次の依頼は成功する', async () => {
    const worker = threeMfFixture();
    let current = true;
    const pending = worker.encode([threeMfMesh], { remainingMs: 5000, isCurrent: () => current });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.race([worker.ready, pending.then(
      () => { throw new Error('3MF finished before stale Worker post'); },
      error => { throw new Error(`3MF failed before stale Worker post: ${String(error)}`); },
    )]);
    const late = worker.port.onmessage;
    current = false;
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    late?.(new MessageEvent('message', { data: { id: worker.captured().id,
      kind: 'export3mfSuccess', bytes: Uint8Array.of(8) } }));
    const next = threeMfFixture(), nextPending = next.encode([threeMfMesh], { remainingMs: 5000 });
    await Promise.race([next.ready, nextPending.then(
      () => { throw new Error('3MF finished before next Worker post'); },
      error => { throw new Error(`3MF failed before next Worker post: ${String(error)}`); },
    )]);
    next.reply({ id: next.captured().id, kind: 'export3mfSuccess', bytes: Uint8Array.of(9) });
    await expect(nextPending).resolves.toEqual(Uint8Array.of(9));
    expect(next.terminate).toHaveBeenCalledTimes(1);
  });

  it('無応答期限と crash / invalid reply / post throw の全出口でWorkerを解放する', async () => {
    const timeout = threeMfFixture(), pending = timeout.encode([threeMfMesh], { remainingMs: 2000 });
    const rejected = expect(pending).rejects.toThrow();
    await Promise.race([timeout.ready, pending.then(
      () => { throw new Error('3MF finished before no-response Worker post'); },
      error => { throw new Error(`3MF failed before no-response Worker post: ${String(error)}`); },
    )]);
    await rejected;
    expect(timeout.terminate).toHaveBeenCalledTimes(1);
    for (const failure of ['crash', 'invalid', 'post'] as const) {
      const worker = threeMfFixture();
      if (failure === 'post') worker.port.postMessage = () => { throw new Error('post failed'); };
      const attempt = worker.encode([threeMfMesh], { remainingMs: 5000 });
      const failed = expect(attempt).rejects.toThrow();
      if (failure !== 'post') await worker.ready;
      if (failure === 'crash') worker.port.onerror?.(Object.assign(new Event('error'),
        { message: 'worker crashed', colno: 0, error: null, filename: '', lineno: 0 }));
      if (failure === 'invalid') worker.reply({ id: worker.captured().id,
        kind: 'export3mfSuccess', bytes: 'invalid' });
      await failed;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.port.onmessage).toBeNull();
    }
  });
});

describe('保存Workerの寿命と応答の採用', () => {
  it('実IOを明示注入した相手へ専用コピーを転送し、誤札・重複・終了後の返信を採用しない', async () => {
    const original = Uint8Array.of(3, 4, 5), stages: string[] = [], worker = fixture();
    const pending = worker.encode({ ...input, options: { ...input.options,
      attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', original]]) } } }, { onProgress: stage => stages.push(stage) });
    await worker.ready;
    const request = worker.captured(), late = worker.port.onmessage;
    worker.reply({ id: 'different', kind: 'success', bytes: Uint8Array.of(0) });
    worker.reply({ id: 'different', kind: 'success', bytes: 'bad stale bytes' });
    const bytes = await encodeSaveDocument(request.input, { onProgress: stage => worker.reply({ id: request.id, kind: 'progress', stage }) });
    worker.reply({ id: request.id, kind: 'success', bytes });
    expect(readPcadFile(await pending)).toMatchObject({ ok: true, document: { name: '実IO' } });
    const accepted = [...stages];
    late?.(new MessageEvent('message', { data: { id: request.id, kind: 'progress', stage: 'compressing' } }));
    late?.(new MessageEvent('message', { data: { id: request.id, kind: 'failure', message: 'late' } }));
    expect(stages).toEqual(accepted); expect(original).toEqual(Uint8Array.of(3, 4, 5));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.port.onmessage).toBeNull(); expect(worker.port.onerror).toBeNull(); expect(worker.port.onmessageerror).toBeNull();
    const next = fixture(), nextSave = next.encode(input); await next.ready;
    expect(next.captured().id).not.toBe(request.id);
    next.reply({ id: next.captured().id, kind: 'success', bytes }); await nextSave;
  });

  it('圧縮中の取消はWorkerを実際に終了し、遅い成功を捨てる', async () => {
    const worker = fixture(), controller = new AbortController(), pending = worker.encode(input, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await worker.ready;
    const request = worker.captured(), late = worker.port.onmessage;
    worker.reply({ id: request.id, kind: 'progress', stage: 'compressing' });
    controller.abort(); await rejected;
    late?.(new MessageEvent('message', { data: { id: request.id, kind: 'success', bytes: await encodeSaveDocument(input) } }));
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.port.onmessage).toBeNull();
  });

  it.each(['failure', 'invalid', 'crash', 'messageerror'])('%sでも元文書を保ち、資源を解放する', async kind => {
    const worker = fixture(), pending = worker.encode(input), rejected = expect(pending).rejects.toMatchObject({ name: 'PcadSaveWorkerError' });
    await worker.ready;
    if (kind === 'failure') worker.reply({ id: worker.captured().id, kind, message: 'compression rejected' });
    else if (kind === 'invalid') worker.reply({ id: worker.captured().id, kind: 'success', bytes: 'broken' });
    else if (kind === 'crash') worker.port.onerror?.(Object.assign(new Event('error'),
      { message: 'worker crashed', colno: 0, error: null, filename: '', lineno: 0 }));
    else worker.port.onmessageerror?.(new MessageEvent('messageerror'));
    await rejected; expect(worker.terminate).toHaveBeenCalledTimes(1); expect(input.document.name).toBe('実IO');
  });

  it('生成拒否時に同期保存へ戻らず、原因を返す', async () => {
    const error = new Error('blocked by policy');
    await expect(createPcadSaveEncoder(() => { throw error; })(input)).rejects.toBe(error);
  });

  it('製品のWorker APIが利用できなければ理由付きで失敗し、同期処理を使わない', async () => {
    vi.stubGlobal('Worker', undefined);
    try { await expect(createPcadSaveEncoder()(input)).rejects.toMatchObject({ name: 'PcadSaveWorkerError', reason: 'unavailable' }); }
    finally { vi.unstubAllGlobals(); }
  });

  it('準備中の取消はWorkerを生成する前に終了する', async () => {
    const worker = fixture(), factory = vi.fn(() => worker.port), controller = new AbortController();
    const pending = createPcadSaveEncoder(factory)(input, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected; expect(factory).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('送信失敗でも1回だけ終了する', async () => {
    const worker = fixture(); worker.port.postMessage = () => { throw new Error('clone failed'); };
    await expect(worker.encode(input)).rejects.toMatchObject({ reason: 'rejected', message: 'clone failed' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('保存点Workerの取消と返信所有', () => {
  it.each([true, false])('複製成功と一覧結果ok=%sは1要求で返し、終端の資源を1回解放する', async ok => {
    vi.useFakeTimers();
    try {
      const worker = pointFixture(), factory = vi.fn(() => worker.port);
      const client = createPcadSavePointClient(factory), controller = new AbortController();
      const pending = client.cloneAndList(point.id, 'alias', controller.signal);
      const request = worker.messages[0], late = worker.port.onmessage;
      if (request === undefined) throw new Error('Batch request missing');
      expect(request).toEqual({ id: request.id, kind: 'savePoint', operation: 'cloneAndList', pointId: point.id, name: 'alias' });
      const result = { point, listing: ok ? { ok: true, points: [point] }
        : { ok: false, reason: 'corrupt', message: 'refresh failed' } };
      worker.reply({ id: request.id, kind: 'savePointResult', operation: 'cloneAndList', ...result });
      await expect(pending).resolves.toEqual(result);
      controller.abort();
      late?.(new MessageEvent('message', { data: { id: request.id, kind: 'savePointCancelled' } }));
      expect(factory).toHaveBeenCalledTimes(1); expect(worker.messages).toHaveLength(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.port.onmessage).toBeNull(); expect(worker.port.onerror).toBeNull();
      expect(worker.port.onmessageerror).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('組の途中取消はIDBの応答まで待ち、遅い成功でも削除や次の一覧要求を送らない', async () => {
    const worker = pointFixture(), controller = new AbortController();
    const pending = worker.client.cloneAndList(point.id, 'alias', controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const request = worker.messages[0];
    if (request === undefined) throw new Error('Batch request missing');
    controller.abort();
    expect(worker.messages[1]).toEqual({ id: request.id, kind: 'savePointCancel' });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ id: request.id, kind: 'savePointResult', operation: 'cloneAndList', point,
      listing: { ok: true, points: [point] } });
    await rejected;
    expect(worker.messages).toHaveLength(2); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('組全体も25秒で終了し、一覧を待つための通常期限延長をしない', async () => {
    vi.useFakeTimers();
    try {
      const worker = pointFixture(), pending = worker.client.cloneAndList(point.id, 'alias');
      const rejected = expect(pending).rejects.toMatchObject({ reason: 'aborted' });
      await vi.advanceTimersByTimeAsync(24_999); expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await rejected;
      expect(worker.messages).toHaveLength(1); expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['failure', 'invalid', 'wrong'])('組の%s返信は成功扱いせず終了する', async failure => {
    const worker = pointFixture(), pending = worker.client.cloneAndList(point.id, 'alias');
    const rejected = expect(pending).rejects.toThrow(), request = worker.messages[0];
    if (request === undefined) throw new Error('Batch request missing');
    worker.reply(failure === 'failure' ? { id: request.id, kind: 'savePointFailure', reason: 'quota', message: 'full' }
      : failure === 'wrong' ? { id: request.id, kind: 'savePointResult', operation: 'clone', point }
        : { id: request.id, kind: 'savePointResult', operation: 'cloneAndList', point,
          listing: { ok: true, points: [{ ...point, entries: [] }] } });
    await rejected; expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('通常要求が25秒無応答なら不確定として終了し、listenerとtimerを残さない', async () => {
    vi.useFakeTimers();
    try {
      const worker = pointFixture(), pending = worker.client.list();
      const rejected = expect(pending).rejects.toMatchObject({ reason: 'aborted' });
      await worker.ready;
      await vi.advanceTimersByTimeAsync(24_999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.port.onmessage).toBeNull();
      expect(worker.port.onerror).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('通常成功は25秒timerを消し、後からWorkerを再終了しない', async () => {
    vi.useFakeTimers();
    try {
      const worker = pointFixture(), pending = worker.client.list();
      await worker.ready;
      const request = worker.messages[0];
      if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Save point request missing');
      worker.reply({ id: request.id, kind: 'savePointResult', operation: 'list', points: [point] });
      expect(await pending).toEqual([point]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(25_001);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('取消で通常timerを外し、IDB結果待ちの25秒timerだけへ交換する', async () => {
    vi.useFakeTimers();
    try {
      const worker = pointFixture(), controller = new AbortController();
      const pending = worker.client.clone(point.id, 'alias', controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ reason: 'aborted' });
      await worker.ready;
      await vi.advanceTimersByTimeAsync(24_999);
      controller.abort();
      const request = worker.messages[0];
      if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Save point request missing');
      expect(worker.messages[1]).toEqual({ id: request.id, kind: 'savePointCancel' });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24_999);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('一覧は検証済みmetadataだけを受け取り、誤札を採用せずWorkerを終了する', async () => {
    const worker = pointFixture(), pending = worker.client.list();
    await worker.ready;
    const request = worker.messages[0];
    if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Save point request missing');
    worker.reply({ id: 'different', kind: 'savePointResult', operation: 'list', points: [point] });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ id: request.id, kind: 'savePointResult', operation: 'list', points: [point] });
    expect(await pending).toEqual([point]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.port.onmessage).toBeNull();
  });

  it('壊れた保存点metadataの返信は一覧へ渡さずWorkerを終了する', async () => {
    const worker = pointFixture(), pending = worker.client.list();
    await worker.ready;
    const request = worker.messages[0];
    if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Save point request missing');
    worker.reply({ id: request.id, kind: 'savePointResult', operation: 'list', points: [{ ...point, entries: [] }] });
    await expect(pending).rejects.toMatchObject({ reason: 'rejected' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('commit前の取消は同ID cancelを送り、abort応答までWorkerを終了しない', async () => {
    const worker = pointFixture(), controller = new AbortController(), source = Uint8Array.of(1, 2, 3);
    const pending = worker.client.create('A', source, 'part', controller.signal);
    await worker.ready;
    const request = worker.messages[0];
    if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Create request missing');
    expect(request.operation).toBe('create');
    controller.abort();
    expect(worker.messages[1]).toEqual({ id: request.id, kind: 'savePointCancel' });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply({ id: request.id, kind: 'savePointCancelled' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('oncomplete後の成功は確定点として返し、後追いcancelで削除要求を送らない', async () => {
    const worker = pointFixture(), controller = new AbortController();
    const pending = worker.client.clone(point.id, 'alias', controller.signal);
    await worker.ready;
    const request = worker.messages[0];
    if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Clone request missing');
    const alias = { ...point, id: 'point:00000000-0000-4000-8000-000000000002', name: 'alias' };
    worker.reply({ id: request.id, kind: 'savePointResult', operation: 'clone', point: alias });
    expect(await pending).toEqual(alias);
    controller.abort();
    expect(worker.messages).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('取消とcommit完了が競走しても旧成功返信を捨て、確定点のrollbackを要求しない', async () => {
    const worker = pointFixture(), controller = new AbortController();
    const pending = worker.client.clone(point.id, 'alias', controller.signal);
    await worker.ready;
    const request = worker.messages[0];
    if (request === undefined || !('kind' in request) || request.kind !== 'savePoint') throw new Error('Clone request missing');
    controller.abort();
    worker.reply({ id: request.id, kind: 'savePointResult', operation: 'clone', point });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages.map(message => 'kind' in message ? message.kind : 'normal')).toEqual(['savePoint', 'savePointCancel']);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});


it('createAndList transfers owned input once and terminates after the validated combined reply', async () => {
  const worker = pointFixture(), bytes = Uint8Array.of(1, 2, 3);
  const pending = worker.client.createAndList('A', bytes, 'part');
  await worker.ready;
  expect(bytes.byteLength).toBe(0);
  const request = worker.messages[0];
  if (!('kind' in request) || request.kind !== 'savePoint' || request.operation !== 'createAndList')
    throw new Error('Combined create request missing');
  expect(request.bytes).toEqual(Uint8Array.of(1, 2, 3));
  worker.reply({ id: request.id, kind: 'savePointResult', operation: 'createAndList', point, points: [point] });
  await expect(pending).resolves.toEqual({ point, points: [point] });
  expect(worker.messages).toHaveLength(1); expect(worker.terminate).toHaveBeenCalledTimes(1);
});
