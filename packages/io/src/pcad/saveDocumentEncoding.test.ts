import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createDrawingTemplate, createEmptyPartDocument,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { encodeSaveDocument, type SaveDocumentInput } from './saveDocumentEncoding.js';
import { readDocumentBundle, readPcadFile, writeDocumentBundle, writePcadFile } from './pcadFile.js';
import { readDrawingBundle, writeDrawingBundle } from './drawingBundle.js';
import { readDrawingTemplateFile, writeDrawingTemplateFile } from './drawingTemplateFile.js';
import { PCAD_TEMPLATE_KIND } from './schema.js';

const savedAt = '2026-10-04T00:00:00.000Z';

function viewDigest(view: ArrayBufferView): string {
  return `${String(view.byteLength)}:${createHash('sha256')
    .update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex')}`;
}

/** 借用meshの3viewとshape/canvas/thumbnailが同じbufferを共有する有効な大きい部品。 */
function sharedMeshPart(): Extract<SaveDocumentInput, { kind: 'part' }> {
  const triangles = 25_000, vertices = triangles * 3, floatBytes = vertices * 3 * 4;
  const buffer = new ArrayBuffer(floatBytes * 2 + vertices * 4);
  const positions = new Float32Array(buffer, 0, vertices * 3);
  const normals = new Float32Array(buffer, floatBytes, vertices * 3);
  const indices = new Uint32Array(buffer, floatBytes * 2, vertices);
  for (let index = 0; index < positions.length; index += 1) positions[index] = (index % 977) * 0.25;
  for (let index = 0; index < vertices; index += 1) { normals[index * 3 + 2] = 1; indices[index] = index; }
  const document = { ...createEmptyPartDocument(), solids: [{ kind: 'importedMesh' as const, id: 'mesh-feature',
    name: 'shared original', suppressed: true, meshRef: 'big', triangleCount: triangles,
    source: { format: 'stl' as const, fileName: 'big.stl', unit: 'mm' as const, byteLength: 84 * triangles } }] };
  return { kind: 'part', document, options: { savedAt, thumbnailPng: new Uint8Array(buffer, 32, 16),
    attachments: { shapes: new Map([['original', new Uint8Array(buffer, 0, 16)]]),
      canvases: new Map([['image', new Uint8Array(buffer, 16, 16)]]),
      meshes: new Map([['big', { positions, normals, indices }]]) } } };
}

describe('part保存の新規mesh scratch所有権', () => {
  it('大きいpartの新規entryだけを切り離し、共有借用入力を2回使えて従来ZIP・実mesh読戻しが一致する', async () => {
    const input = sharedMeshPart(), attachments = input.options.attachments;
    const mesh = attachments?.meshes.get('big');
    if (attachments === undefined || mesh === undefined || input.options.thumbnailPng === undefined) throw new Error('Missing fixture');
    const views = [mesh.positions, mesh.normals, mesh.indices, ...attachments.shapes.values(),
      ...attachments.canvases.values(), input.options.thumbnailPng];
    const before = views.map(viewDigest), expected = writePcadFile(input.document, input.options);
    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer');
    const native: unknown = Reflect.get(ArrayBuffer.prototype, 'transfer');
    if (typeof native !== 'function') throw new Error('This ownership test requires native transfer');
    const released: ArrayBuffer[] = [];
    Object.defineProperty(ArrayBuffer.prototype, 'transfer', { configurable: true, writable: true,
      value(this: ArrayBuffer, length: number): unknown {
        released.push(this); const transferred: unknown = Reflect.apply(native, this, [length]); return transferred;
      } });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events: string[] = [];
        const result = await encodeSaveDocument(input, { onProgress: stage => events.push(stage), onEntriesBuilt: () => events.push('entries') });
        expect(events).toEqual(['preparing', 'entries', 'compressing']);
        expect(viewDigest(result)).toBe(viewDigest(expected));
        expect(views.map(viewDigest)).toEqual(before);
        const read = readPcadFile(result);
        if (!read.ok) throw new Error(read.error.message);
        const restored = read.attachments.meshes.get('big');
        if (restored === undefined) throw new Error('Missing restored mesh');
        expect([restored.positions, restored.normals, restored.indices].map(viewDigest)).toEqual(before.slice(0, 3));
      }
      expect(released).toHaveLength(2);
      expect(released.every(buffer => buffer.byteLength === 0 && buffer !== mesh.positions.buffer)).toBe(true);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(ArrayBuffer.prototype, 'transfer');
      else Object.defineProperty(ArrayBuffer.prototype, 'transfer', descriptor);
    }
  });

  it.each([false, true])('小さいpart/mesh無しは従来fast pathを保持する (mesh=%s)', async withMesh => {
    const document = createEmptyPartDocument();
    const attachments = { ...emptyEmbeddedPartAttachments(), meshes: new Map(withMesh ? [['small', {
      positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 0, 1]), indices: new Uint32Array([0, 0, 0]),
    }]] : []) };
    const options = { savedAt, attachments }, events: string[] = [];
    const expected = writePcadFile(document, options);
    const result = await encodeSaveDocument({ kind: 'part', document, options }, {
      onProgress: stage => events.push(stage), onEntriesBuilt: () => events.push('entries') });
    expect(result).toEqual(expected);
    expect(events).toEqual(['preparing', 'entries', 'compressing']);
    if (withMesh) expect(attachments.meshes.get('small')?.positions.byteLength).toBe(12);
  });

  it('大きいpartの取消は借用共有入力を保ち、新しい保存試行で再生成して読戻せる', async () => {
    const input = sharedMeshPart(), mesh = input.options.attachments?.meshes.get('big');
    if (mesh === undefined) throw new Error('Missing fixture');
    const before = [mesh.positions, mesh.normals, mesh.indices].map(viewDigest), controller = new AbortController();
    const running = encodeSaveDocument(input, { signal: controller.signal,
      onProgress: stage => { if (stage === 'compressing') controller.abort(); } });
    await expect(running.then(() => 'unexpected ZIP success')).rejects.toMatchObject({ name: 'AbortError' });
    expect([mesh.positions, mesh.normals, mesh.indices].map(viewDigest)).toEqual(before);
    const result = await encodeSaveDocument(input);
    expect(readPcadFile(result)).toMatchObject({ ok: true });
    expect([mesh.positions, mesh.normals, mesh.indices].map(viewDigest)).toEqual(before);
  });
});

describe('保存専用エンコーダーと従来のIOの一致', () => {
  it('部品・ひな形・組立・図面を同じ時刻で全エントリ・全バイト照合し従来の読み手で再開する', async () => {
    const document = { ...createEmptyPartDocument(), name: '保存試験' };
    const attachments = { ...emptyEmbeddedPartAttachments(),
      shapes: new Map([['original', Uint8Array.of(1, 3, 5, 7)]]),
      canvases: new Map([['unknown-image', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 11)]]),
      meshes: new Map([['mesh', { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }]]) };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, document, 'part.pcad', '', { attachments, importedAt: savedAt });
    const assembly = createAssemblyDocumentBundle(createAssemblyDocument('組立'), embedded.library);
    const source = { sourceKind: 'assembly' as const, document: assembly.document, library: embedded.library };
    const drawingSource = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'assembly.pcada', '', { importedAt: savedAt });
    const drawing = createDrawingDocument('図面', drawingSource.source);
    const created = createDrawingTemplate(drawing, '図面ひな形');
    if (!created.ok) throw new Error(created.reason);
    const cases: readonly { input: SaveDocumentInput; old: () => Uint8Array | Promise<Uint8Array> }[] = [
      { input: { kind: 'part', document, options: { savedAt, attachments } }, old: () => writePcadFile(document, { savedAt, attachments }) },
      { input: { kind: 'part', document, options: { savedAt, attachments, kind: PCAD_TEMPLATE_KIND } },
        old: () => writePcadFile(document, { savedAt, attachments, kind: PCAD_TEMPLATE_KIND }) },
      { input: { kind: 'assembly', bundle: assembly, options: { savedAt } }, old: () => writeDocumentBundle(assembly, { savedAt }) },
      { input: { kind: 'drawing', document: drawing, options: { savedAt, source } }, old: () => writeDrawingBundle(drawing, { savedAt, source }) },
      { input: { kind: 'drawingTemplate', template: created.template, savedAt }, old: () => writeDrawingTemplateFile(created.template, savedAt) },
    ];
    for (const item of cases) {
      const stages: string[] = [];
      const bytes = await encodeSaveDocument(item.input, { onProgress: stage => stages.push(stage) });
      const previous = await item.old();
      const actualEntries = unzipSync(bytes), oldEntries = unzipSync(previous);
      expect(Object.keys(actualEntries)).toEqual(Object.keys(oldEntries));
      for (const key of Object.keys(oldEntries)) expect(actualEntries[key]).toEqual(oldEntries[key]);
      expect(bytes).toEqual(previous);
      const auditDirectory = process.env.PCAD_SAVE_AUDIT_DIR;
      if (auditDirectory !== undefined) {
        const name = item.input.kind === 'part' && item.input.options.kind === PCAD_TEMPLATE_KIND ? 'template' : item.input.kind;
        await writeFile(join(auditDirectory, `${name}-worker.pcad`), bytes);
        await writeFile(join(auditDirectory, `${name}-legacy.pcad`), previous);
      }
      expect(stages).toEqual(['preparing', 'compressing']);
      if (item.input.kind === 'drawing') expect(await readDrawingBundle(bytes)).toMatchObject({ ok: true, document: drawing, source });
      else if (item.input.kind === 'drawingTemplate') {
        expect(Object.keys(actualEntries)).toEqual(['document.json']);
        expect(readDrawingTemplateFile(bytes)).toEqual({ ok: true, template: created.template, savedAt });
      }
      else expect(await readDocumentBundle(bytes, item.input.kind)).toMatchObject({ ok: true });
    }
    expect(attachments.shapes.get('original')).toEqual(Uint8Array.of(1, 3, 5, 7));
    expect(attachments.meshes.get('mesh')?.positions.byteLength).toBe(36);
  });

  it('項目ができた後・圧縮の前に onEntriesBuilt を1回だけ呼び、そこで入力の三角形を手放しても全バイトが同じ', async () => {
    const mesh = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });
    const owned = mesh(), shapes = new Map([['shape', Uint8Array.of(9, 8, 7)]]);
    const document = { ...createEmptyPartDocument(), name: '項目の後' };
    const expected = writePcadFile(document, { savedAt, attachments: { ...emptyEmbeddedPartAttachments(), shapes, meshes: new Map([['mesh', mesh()]]) } });
    const events: string[] = [];
    const bytes = await encodeSaveDocument({ kind: 'part', document,
      options: { savedAt, attachments: { ...emptyEmbeddedPartAttachments(), shapes, meshes: new Map([['mesh', owned]]) } } },
    { onProgress: stage => events.push(stage), onEntriesBuilt: () => {
      events.push('entries');
      // The caller owns this copy: detach it as the save Worker does; the entry already holds its own encoded bytes.
      for (const array of [owned.positions, owned.normals, owned.indices]) structuredClone(array.buffer, { transfer: [array.buffer] });
    } });
    expect(events).toEqual(['preparing', 'entries', 'compressing']);
    expect(owned.positions.byteLength + owned.normals.byteLength + owned.indices.byteLength).toBe(0);
    expect(bytes).toEqual(expected);
    expect(shapes.get('shape')).toEqual(Uint8Array.of(9, 8, 7));
  });

  it('準備中に取消されたら onEntriesBuilt も圧縮も呼ばない', async () => {
    const controller = new AbortController(), events: string[] = [];
    await expect(encodeSaveDocument({ kind: 'part', document: createEmptyPartDocument(), options: { savedAt } },
      { signal: controller.signal, onProgress: stage => { events.push(stage); controller.abort(); },
        onEntriesBuilt: () => events.push('entries') })).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['preparing']);
  });

  it('取消済みの依頼では圧縮を始めない', async () => {
    const controller = new AbortController();
    controller.abort();
    const stages: string[] = [];
    await expect(encodeSaveDocument({ kind: 'part', document: createEmptyPartDocument(), options: { savedAt } },
      { signal: controller.signal, onProgress: stage => stages.push(stage) })).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages).toEqual([]);
  });

  it('図面ひな形の準備後の取消では圧縮へ進まず、原設定を保つ', async () => {
    const drawing = createDrawingDocument('drawing', { sourceRef: 'part-1', sourceKind: 'part',
      path: '', fileName: 'part.pcad', contentHash: '', importedAt: savedAt });
    const created = createDrawingTemplate(drawing, 'template');
    if (!created.ok) throw new Error(created.reason);
    const before = structuredClone(created.template), controller = new AbortController(), stages: string[] = [];
    await expect(encodeSaveDocument({ kind: 'drawingTemplate', template: created.template, savedAt },
      { signal: controller.signal, onProgress: stage => { stages.push(stage); controller.abort(); } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(stages).toEqual(['preparing']); expect(created.template).toEqual(before);
  });
});
