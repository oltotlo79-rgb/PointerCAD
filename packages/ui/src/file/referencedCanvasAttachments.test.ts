import { createEmptyPartDocument, DEFAULT_TOOL_DEFAULTS } from '@pointercad/model';
import { encodeSaveDocument, readPcadFile, writePcadFile } from '@pointercad/io';
import { describe, expect, it } from 'vitest';
import { newSketchCanvas } from './canvasFile.js';
import { referencedCanvasAttachments } from './referencedCanvasAttachments.js';
import { createMemoryTemplateStorage, saveTemplate } from './templateFile.js';

describe('保存スナップショットが参照する下絵だけを選ぶ', () => {
  const kept = newSketchCanvas([], 'xy', 'keep.png', { width: 1, height: 1 }, 'canvas-1');
  const hidden = { ...kept, id: 'canvas-2', imageId: 'hidden', visible: false };
  const bytes = Uint8Array.of(1, 2, 3);
  const images = new Map([['canvas-1', bytes], ['hidden', Uint8Array.of(4)], ['deleted', Uint8Array.of(5)]]);

  it('非表示も保存し、消した画像だけ除き、元の表と画像のバイト列を保持する', () => {
    const document = { ...createEmptyPartDocument(), canvases: [kept, hidden] };
    const selected = referencedCanvasAttachments(document, images);
    expect([...selected.keys()]).toEqual(['canvas-1', 'hidden']);
    expect(selected.get('canvas-1')).toBe(bytes);
    expect(images.size).toBe(3);
    const attachments = { shapes: new Map([['unknown-shape', bytes]]), meshes: new Map(), canvases: selected };
    const zip = writePcadFile(document, { attachments });
    expect(Buffer.from(zip).includes(Buffer.from('canvases/deleted.png'))).toBe(false);
    const parsed = readPcadFile(zip);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Round trip failed');
    expect(parsed.attachments.canvases).toEqual(selected);
    expect(parsed.attachments.shapes).toEqual(attachments.shapes);
  });

  it('同じ画像を参照する複数の下絵は1資産になり、参照が無ければ空になる', () => {
    const document = { ...createEmptyPartDocument(), canvases: [kept, { ...kept, id: 'canvas-3' }] };
    expect(referencedCanvasAttachments(document, images).size).toBe(1);
    expect(referencedCanvasAttachments({ ...document, canvases: [] }, images).size).toBe(0);
  });

  it('画像が足りない場合は捏造せず、既存の実読み手が拒否する', () => {
    const document = { ...createEmptyPartDocument(), canvases: [kept] };
    const selected = referencedCanvasAttachments(document, new Map());
    expect(selected.size).toBe(0);
    expect(readPcadFile(writePcadFile(document, { attachments: {
      shapes: new Map(), meshes: new Map(), canvases: selected,
    } })).ok).toBe(false);
  });

  it('ひな形の実保存は下絵を引き継がず画像も保存しない', async () => {
    const storage = createMemoryTemplateStorage();
    const outcome = await saveTemplate({ storage, encodeSave: encodeSaveDocument, gateway: {
      openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => false, saveFileAs: () => Promise.resolve(true),
    } }, { document: { ...createEmptyPartDocument(), canvases: [kept, hidden] },
      name: 'canvas-template', lengthUnit: 'mm', toolDefaults: DEFAULT_TOOL_DEFAULTS });
    expect(outcome.ok).toBe(true);
    const saved = await storage.get('canvas-template');
    if (saved === null) throw new Error('Missing template');
    const parsed = readPcadFile(saved.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Template could not be read');
    expect(parsed.document.canvases).toEqual([]); expect(parsed.attachments.canvases.size).toBe(0);
  });
});
