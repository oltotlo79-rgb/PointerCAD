import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createDrawingTemplate, createEmptyPartDocument,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { encodeSaveDocument, type SaveDocumentInput } from './saveDocumentEncoding.js';
import { readDocumentBundle, writeDocumentBundle, writePcadFile } from './pcadFile.js';
import { readDrawingBundle, writeDrawingBundle } from './drawingBundle.js';
import { readDrawingTemplateFile, writeDrawingTemplateFile } from './drawingTemplateFile.js';
import { PCAD_TEMPLATE_KIND } from './schema.js';

const savedAt = '2026-10-04T00:00:00.000Z';

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
