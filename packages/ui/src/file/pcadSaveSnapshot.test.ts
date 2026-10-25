import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createDrawingTemplate, createEmptyPartDocument,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { encodeSaveDocument, readDrawingTemplateFile, type SaveDocumentInput } from '@pointercad/io';
import { captureSaveSnapshot, copySaveSnapshot } from './pcadSaveSnapshot.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('保存専用コピーの所有権', () => {
  it('図面ひな形は設定だけを捕捉し、原本や添付をコピー・転送しない', async () => {
    const source = { sourceRef: 'source-1', sourceKind: 'part' as const, path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' };
    const drawing = createDrawingDocument('drawing', source), created = createDrawingTemplate(drawing, 'template');
    if (!created.ok) throw new Error(created.reason);
    const original = Uint8Array.of(1, 2, 3, 4);
    const input = { kind: 'drawingTemplate' as const, savedAt: '2026-10-04T00:00:00.000Z',
      template: { ...created.template, source, original }, document: drawing,
      attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['original', original]]) } };
    const captured = captureSaveSnapshot(input), copied = await copySaveSnapshot(captured);
    expect(Object.keys(captured).sort()).toEqual(['kind', 'savedAt', 'template']);
    if (copied.input.kind !== 'drawingTemplate') throw new Error('template missing');
    expect(Object.keys(copied.input.template).sort()).toEqual(['layers', 'name', 'sheet']);
    expect(copied.transfer).toEqual([]); expect(copied.copiedBytes).toBe(0);
    const moved: SaveDocumentInput = structuredClone(copied.input, { transfer: copied.transfer });
    expect(readDrawingTemplateFile(await encodeSaveDocument(moved))).toEqual({ ok: true, template: created.template, savedAt: input.savedAt });
    expect(original.byteLength).toBe(4); expect(original).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(input.document).toBe(drawing); expect(input.template.sheet).toBe(created.template.sheet);
  });
  it('組立と図面の抱き込んだ部品の原本も専用コピーへ移し、元の表を保持する', async () => {
    const original = Uint8Array.of(1, 2, 3, 4), attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape', original]]) };
    const embedded = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'part.pcad', '', { attachments });
    const bundle = createAssemblyDocumentBundle(createAssemblyDocument('組立'), embedded.library);
    const source = { sourceKind: 'assembly' as const, document: bundle.document, library: embedded.library };
    const drawingSource = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'assembly.pcada', '');
    const inputs: SaveDocumentInput[] = [{ kind: 'assembly', bundle, options: {} }, {
      kind: 'drawing', document: createDrawingDocument('図面', drawingSource.source), options: { source },
    }];
    for (const input of inputs) {
      const copied = await copySaveSnapshot(captureSaveSnapshot(input));
      expect(copied.copiedBytes).toBe(4);
      const moved: SaveDocumentInput = structuredClone(copied.input, { transfer: copied.transfer });
      const actual = moved.kind === 'assembly' ? moved.bundle.embeddedDocuments.get(embedded.partRef)?.attachments.shapes.get('shape')
        : moved.kind === 'drawing' && moved.options.source.sourceKind === 'assembly'
          ? moved.options.source.library?.attachments.get(embedded.partRef)?.shapes.get('shape') : undefined;
      expect(actual).toEqual(original); expect(original.byteLength).toBe(4); expect(actual?.buffer).not.toBe(original.buffer);
      expect(original).toEqual(Uint8Array.of(1, 2, 3, 4));
    }
  });
  it('表の変更を固定し、部分viewとmeshを転送しても現在文書・Undoの原本全バイトを保持する', async () => {
    const original = Uint8Array.from({ length: 64 }, (_, i) => i);
    const undo = original.subarray(4, 52);
    const positions = new Float32Array([1, 2, 3]);
    const meshes = new Map([['mesh', { positions, normals: new Float32Array([0, 0, 1]), indices: new Uint32Array([0]) }]]);
    const shapes = new Map([['shape', undo]]);
    const snapshot = captureSaveSnapshot({ kind: 'part', document: createEmptyPartDocument(),
      options: { attachments: { ...emptyEmbeddedPartAttachments(), shapes, meshes } } });
    shapes.clear(); meshes.clear();
    const before = digest(original), meshBefore = digest(new Uint8Array(positions.buffer));
    const copied = await copySaveSnapshot(snapshot);
    expect(copied.copiedBytes).toBe(48 + 12 + 12 + 4);
    const moved: SaveDocumentInput = structuredClone(copied.input, { transfer: copied.transfer });
    expect(copied.transfer.every(buffer => buffer.byteLength === 0)).toBe(true);
    if (moved.kind !== 'part') throw new Error('part expected');
    expect(moved.options.attachments?.shapes.get('shape')).toEqual(undo);
    expect(original.byteLength).toBe(64); expect(undo.byteLength).toBe(48);
    expect(positions.byteLength).toBe(12);
    expect(digest(original)).toBe(before); expect(digest(new Uint8Array(positions.buffer))).toBe(meshBefore);
  });

  it.each([32, 128])('%iMiBを3回コピーし所有容量・yieldと全バイトを記録する（入力応答は画面検査で別測定）', async mib => {
    const original = new Uint8Array(mib * 1024 * 1024);
    for (let offset = 0; offset < original.length; offset++) original[offset] = (offset * 31) % 251;
    const before = digest(original);
    const input: SaveDocumentInput = { kind: 'part', document: createEmptyPartDocument(),
      options: { attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['large', original]]) } } };
    for (let repeat = 0; repeat < 3; repeat++) {
      const copied = await copySaveSnapshot(input);
      expect(copied.copiedBytes).toBe(original.byteLength);
      expect(copied.yields).toBeGreaterThan(0);
      expect(copied.transfer).not.toContain(original.buffer);
      const moved: SaveDocumentInput = structuredClone(copied.input, { transfer: copied.transfer });
      if (moved.kind !== 'part') throw new Error('part expected');
      const bytes = moved.options.attachments?.shapes.get('large');
      if (bytes === undefined) throw new Error('large bytes missing');
      expect(digest(bytes)).toBe(before); expect(digest(original)).toBe(before);
      expect(original.byteLength).toBe(mib * 1024 * 1024);
      const measurement = { mib, repeat, copiedBytes: copied.copiedBytes, maxSliceMs: copied.maxSliceMs,
        yields: copied.yields, transferredSenderBytes: copied.transfer.reduce((sum, b) => sum + b.byteLength, 0),
        sourceBytes: original.byteLength, sha256: digest(original) };
      const auditDirectory = process.env.PCAD_SAVE_AUDIT_DIR;
      if (auditDirectory !== undefined) await appendFile(join(auditDirectory, 'copy-metrics.jsonl'), JSON.stringify(measurement) + '\n');
    }
  });

  it('コピー開始前の取消で転送せず原本を保つ', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(copySaveSnapshot({ kind: 'part', document: createEmptyPartDocument(), options: {} }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
