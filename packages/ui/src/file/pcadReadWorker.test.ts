import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createEmptyPartDocument,
  createPartDocumentBundle, embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary,
  emptyEmbeddedPartAttachments, prepareDocumentMathIdentity, synchronizeConfigurations } from '@pointercad/model';
import { IO_LIMITS, readDocumentBundle, readDrawingBundle, readPcadFile, serializeDocument,
  writeDocumentBundle, writeDrawingBundle, writePcadFile } from '@pointercad/io';
import { createPcadFileReader, type PcadReadWorkerPort } from './pcadReadWorker.js';
import type { PcadReadRequest } from './pcadReadProtocol.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const savedAt = '2026-10-25T00:00:00.000Z';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  let request: PcadReadRequest | null = null;
  let started = (): void => undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const terminate = vi.fn();
  const port: PcadReadWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: (value, transfer) => { request = structuredClone(value, { transfer }); started(); }, terminate };
  return { port, ready, terminate, read: createPcadFileReader(() => port),
    captured: () => { if (request === null) throw new Error('Read request missing'); return request; },
    reply: (data: unknown) => port.onmessage?.(new MessageEvent('message', { data })) };
}

/** Loads the real browser entry, replacing only its transport. IO dispatch is not mocked. */
async function workerEntry() {
  let resolveReply: (reply: unknown) => void = () => { throw new Error('No pending reply'); };
  const returned: ArrayBuffer[][] = [];
  const scope: { onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage: (reply: unknown, options?: StructuredSerializeOptions) => void } = {
    onmessage: null,
    postMessage(reply, options) {
      const transfer = options?.transfer ?? [];
      const buffers = transfer.filter((entry): entry is ArrayBuffer => entry instanceof ArrayBuffer);
      const received: unknown = structuredClone(reply, { transfer });
      returned.push(buffers);
      resolveReply(received);
    },
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('./pcadRead.worker.js');
  return { returned, send(request: PcadReadRequest): Promise<unknown> {
    return new Promise(resolve => { resolveReply = resolve; scope.onmessage?.(new MessageEvent('message', { data: request })); });
  } };
}

/** Independent ZIP headers, CRC and raw DEFLATE, matching the original E04 probe rather than the product writer. */
function independentZip(entries: readonly { name: string; bytes: Uint8Array; declared?: number; corruptCrc?: boolean }[]): Uint8Array {
  const table = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    let checksum = 0xffffffff;
    for (const byte of entry.bytes) checksum = table[(checksum ^ byte) & 255] ^ (checksum >>> 8);
    checksum = ((checksum ^ 0xffffffff) + (entry.corruptCrc === true ? 1 : 0)) >>> 0;
    const name = Buffer.from(entry.name), compressed = deflateRawSync(entry.bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.declared ?? entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(entry.declared ?? entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

describe('actual read Worker entry and strict IO parity', () => {
  it('preserves all part/assembly/drawing data, attachments, typed meshes and formula input through real transfer', async () => {
    const entry = await workerEntry();
    const part = synchronizeConfigurations(prepareDocumentMathIdentity({ ...createEmptyPartDocument(),
      name: 'formula source', parameters: [
        { name: 'A', mathId: 'coefficient:1', unit: 'mm', description: '', value: { source: '3', value: 3, display: '3' } },
        { name: 'B', mathId: 'coefficient:2', unit: 'mm', description: '', value: {
          source: 'coef("A")^2', value: 9, display: '9', mathDefinition: {
            format: 'pointercad-math/1', source: 'coef("A")^2', inputNotation: 'text', angleUnit: 'degree',
            expression: { kind: 'operation', operation: 'power', operands: [
              { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient:1', label: 'A' } },
              { kind: 'number', decimal: '2' },
            ] },
          },
        } },
      ] }));
    const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', Uint8Array.of(1, 2, 3)]]),
      canvases: new Map([['orphan', Uint8Array.of(8, 7, 6)]]), meshes: new Map([['mesh', {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      }]]) };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'source.pcad', '', { attachments });
    const bundle = createAssemblyDocumentBundle(createAssemblyDocument('assembly'), embedded.library);
    for (const kind of ['part', 'assembly'] as const) {
      const bytes = await writeDocumentBundle(kind === 'part' ? createPartDocumentBundle(part, attachments) : bundle, { savedAt });
      const expected = kind === 'part' ? readPcadFile(bytes) : await readDocumentBundle(bytes, 'assembly');
      expect(expected.ok, JSON.stringify({ kind, expected })).toBe(true);
      expect(await entry.send({ id: kind, kind, bytes })).toEqual({ id: kind, kind, result: expected });
      expect(entry.returned.at(-1)?.length).toBe(5);
      expect(entry.returned.at(-1)?.every(buffer => buffer.byteLength === 0)).toBe(true);
    }
    for (const source of [{ sourceKind: 'part' as const, document: part, attachments },
      { sourceKind: 'assembly' as const, document: bundle.document, library: embedded.library }]) {
      const embeddedSource = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'source', '');
      const drawing = createDrawingDocument('drawing', embeddedSource.source);
      const bytes = await writeDrawingBundle(drawing, { source, savedAt });
      const expected = await readDrawingBundle(bytes);
      expect(expected.ok).toBe(true);
      expect(await entry.send({ id: 'drawing', kind: 'drawing', bytes })).toEqual({ id: 'drawing', kind: 'drawing', result: expected });
      expect(entry.returned.at(-1)?.every(buffer => buffer.byteLength === 0)).toBe(true);
    }
  });

  it('keeps independent ZIP CRC, actual expanded length and resource budget failures as IO results', async () => {
    const entry = await workerEntry(), document = Buffer.from(serializeDocument(createEmptyPartDocument(), { savedAt }));
    for (const bytes of [Uint8Array.of(1, 2, 3), independentZip([{ name: 'document.json', bytes: document, corruptCrc: true }]),
      independentZip([{ name: 'document.json', bytes: document, declared: document.length + 1 }]),
      independentZip([{ name: 'document.json', bytes: document, declared: IO_LIMITS.archiveEntryExpandedBytes + 1 }]),
      independentZip(Array.from({ length: IO_LIMITS.archiveEntryCount + 1 }, (_, index) => ({ name: `unknown-${index}`, bytes: Uint8Array.of(0) })))]) {
      for (const kind of ['part', 'assembly', 'drawing'] as const) {
        const expected = kind === 'part' ? readPcadFile(bytes) : kind === 'assembly'
          ? await readDocumentBundle(bytes, 'assembly') : await readDrawingBundle(bytes);
        expect(expected.ok).toBe(false);
        expect(await entry.send({ id: kind, kind, bytes })).toEqual({ id: kind, kind, result: expected });
        expect(entry.returned.at(-1)).toEqual([]);
      }
    }
  });

  it.each([32, 128])('reuses the E04 %s MiB independent orphan canvas case with unchanged source SHA and attachment bytes', async mib => {
    const entry = await workerEntry(), payload = new Uint8Array(mib * 1024 * 1024).fill(65);
    const bytes = independentZip([{ name: 'document.json', bytes: Buffer.from(serializeDocument(createEmptyPartDocument(), { savedAt })) },
      { name: 'canvases/orphan.png', bytes: payload }]);
    const before = hash(bytes), worker = fixture(), pending = worker.read('part', bytes);
    await worker.ready;
    const reply = await entry.send(worker.captured());
    worker.reply(reply);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('E04 fixture refused');
    expect(result.attachments.canvases.get('orphan')?.byteLength).toBe(payload.byteLength);
    expect(hash(result.attachments.canvases.get('orphan') ?? new Uint8Array())).toBe(hash(payload));
    expect(hash(bytes)).toBe(before); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns an actual Worker reader exception as transport failure, with no output buffers', async () => {
    vi.doMock('@pointercad/io', async importOriginal => ({
      ...await importOriginal<typeof import('@pointercad/io')>(),
      readPcadFile: () => { throw new Error('reader exception'); },
    }));
    try {
      const entry = await workerEntry(), bytes = Uint8Array.of(1, 2, 3), before = hash(bytes);
      expect(await entry.send({ id: 'exception', kind: 'part', bytes })).toEqual({
        id: 'exception', kind: 'failure', message: 'reader exception',
      });
      expect(entry.returned).toEqual([[]]); expect(hash(bytes)).toBe(before);
    } finally { vi.doUnmock('@pointercad/io'); }
  });
});

describe('read host lifetime', () => {
  it('transfers only an owned copy, ignores wrong IDs and late replies, and terminates once', async () => {
    const bytes = writePcadFile(createEmptyPartDocument()), original = hash(bytes), length = bytes.length;
    const worker = fixture(), pending = worker.read('part', bytes);
    await worker.ready;
    const request = worker.captured(), late = worker.port.onmessage;
    expect(request.bytes.buffer).not.toBe(bytes.buffer);
    worker.reply({ id: 'other', kind: 'drawing', result: null });
    expect(worker.terminate).not.toHaveBeenCalled();
    const result = readPcadFile(request.bytes);
    worker.reply({ id: request.id, kind: 'part', result });
    await expect(pending).resolves.toEqual(result);
    late?.(new MessageEvent('message', { data: { id: request.id, kind: 'failure', message: 'late' } }));
    expect(hash(bytes)).toBe(original); expect(bytes.length).toBe(length);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.port.onmessage).toBeNull(); expect(worker.port.onerror).toBeNull(); expect(worker.port.onmessageerror).toBeNull();
  });

  it.each(['abort', 'stale', 'error', 'messageerror', 'invalid', 'wrongKind', 'failure', 'post'])('%s releases the Worker and never accepts a late success', async failure => {
    const worker = fixture(), controller = new AbortController();
    let current = true;
    if (failure === 'post') worker.port.postMessage = () => { throw new Error('post failed'); };
    const bytes = writePcadFile(createEmptyPartDocument()), before = hash(bytes);
    const pending = worker.read('part', bytes, { signal: controller.signal, isCurrent: () => current });
    const rejected = expect(pending).rejects.toThrow();
    if (failure !== 'post') {
      await worker.ready;
      const request = worker.captured(), late = worker.port.onmessage;
      if (failure === 'abort') controller.abort();
      else if (failure === 'stale') current = false;
      else if (failure === 'error') worker.port.onerror?.(Object.assign(new Event('error'),
        { message: 'crashed', colno: 0, error: null, filename: '', lineno: 0 }));
      else if (failure === 'messageerror') worker.port.onmessageerror?.(new MessageEvent('messageerror'));
      else worker.reply(failure === 'failure' ? { id: request.id, kind: 'failure', message: 'failed' }
        : { id: request.id, kind: failure === 'wrongKind' ? 'drawing' : 'part', result: null });
      await rejected;
      late?.(new MessageEvent('message', { data: { id: request.id, kind: 'part', result: readPcadFile(bytes) } }));
    } else await rejected;
    expect(hash(bytes)).toBe(before); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels during copying before Worker creation and rejects unavailable production Worker without fallback', async () => {
    const factory = vi.fn(() => fixture().port), controller = new AbortController();
    const pending = createPcadFileReader(factory)('part', new Uint8Array(2 * 1024 * 1024), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected; expect(factory).not.toHaveBeenCalled();
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    await expect(createPcadFileReader(factory)('part', shared)).rejects.toMatchObject({ reason: 'rejected' });
    expect(shared.byteLength).toBe(8); expect(factory).not.toHaveBeenCalled();
    vi.stubGlobal('Worker', undefined);
    await expect(createPcadFileReader()('part', Uint8Array.of(1))).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it.each(['success', 'cancel', 'error'])('settles %s as rejection even when termination throws, without retrying cleanup', async outcome => {
    const worker = fixture(), controller = new AbortController(), returned = new Error('termination failed');
    worker.terminate.mockImplementation(() => { throw returned; });
    const bytes = writePcadFile(createEmptyPartDocument()), pending = worker.read('part', bytes, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(returned);
    await worker.ready;
    const late = worker.port.onmessage, request = worker.captured();
    if (outcome === 'cancel') controller.abort();
    else if (outcome === 'error') worker.port.onmessageerror?.(new MessageEvent('messageerror'));
    else worker.reply({ id: request.id, kind: 'part', result: readPcadFile(bytes) });
    await rejected;
    late?.(new MessageEvent('message', { data: { id: request.id, kind: 'part', result: readPcadFile(bytes) } }));
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.port.onmessage).toBeNull(); expect(worker.port.onerror).toBeNull(); expect(worker.port.onmessageerror).toBeNull();
  });

  it('keeps synchronous readers exclusively in the Worker entry, outside the host', () => {
    const host = readFileSync(new URL('./pcadReadWorker.ts', import.meta.url), 'utf8');
    expect(host).not.toMatch(/\b(?:readPcadFile|readDocumentBundle|readDrawingBundle)\s*\(/);
    expect(host).not.toContain("from '@pointercad/io'");
    const entry = readFileSync(new URL('./pcadRead.worker.ts', import.meta.url), 'utf8');
    for (const reader of ['readPcadFile', 'readDocumentBundle', 'readDrawingBundle']) expect(entry).toContain(`${reader}(request.bytes`);
  });
});
