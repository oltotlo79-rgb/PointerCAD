import { emptyPcadAttachments, encodeSaveDocument, readPcadFile, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument, DEFAULT_TOOL_DEFAULTS, type PartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { newSketchCanvas } from './canvasFile.js';
import { partAssetReferences, referencedPartAttachments } from './referencedPartAttachments.js';
import { createMemoryTemplateStorage, saveTemplate } from './templateFile.js';

describe('保存対象の部品添付', () => {
  it('抑制・複数配置・非表示を参照として選び、過去poolを混入させない', () => {
    const document: PartDocument = { ...createEmptyPartDocument(), solids: [
      { kind: 'importedSolid', id: 'solid-1', name: 'shape', shapeRef: 'shared', suppressed: true, bodyKind: 'solid',
        source: { format: 'step', fileName: 'shape.step', unit: 'mm', byteLength: 1 } },
      { kind: 'importedMesh', id: 'mesh-1', name: 'mesh', meshRef: 'shared', suppressed: true, triangleCount: 1,
        source: { format: 'stl', fileName: 'mesh.stl', unit: 'mm', byteLength: 84 } },
    ], canvases: [{ ...newSketchCanvas([], 'xy', 'image', { width: 1, height: 1 }, 'shared'), visible: false }] };
    const duplicate = { ...document, solids: [...document.solids, { ...document.solids[0], id: 'copy' }] };
    const bytes = Uint8Array.of(1), mesh = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) };
    const assets = { shapes: new Map([['shared', bytes], ['past', bytes]]),
      meshes: new Map([['shared', mesh], ['past', mesh]]), canvases: new Map([['shared', bytes], ['past', bytes]]) };
    const selected = referencedPartAttachments(duplicate, assets);
    expect([...selected.shapes.keys()]).toEqual(['shared']); expect([...selected.meshes.keys()]).toEqual(['shared']);
    expect([...selected.canvases.keys()]).toEqual(['shared']); expect(selected.shapes.get('shared')).toBe(bytes);
    expect(selected.meshes.get('shared')).toBe(mesh); expect(assets.shapes.size).toBe(2);
    expect(partAssetReferences([document, duplicate]).shapes.size).toBe(1);
    const saved = readPcadFile(writePcadFile(duplicate, { attachments: selected }));
    expect(saved.ok).toBe(true); if (!saved.ok) throw new Error('Referenced part must roundtrip');
    expect(saved.attachments.shapes.size).toBe(1); expect(saved.attachments.meshes.get('shared')).toEqual(mesh);
    expect(saved.attachments.canvases.get('shared')).toEqual(bytes);
  });

  it('汎用codecの未知添付保持を変えず、文書に無いUI資産だけを選別する', () => {
    const document = createEmptyPartDocument(), bytes = Uint8Array.of(1, 2);
    const assets = { ...emptyPcadAttachments(), shapes: new Map([['unknown', bytes]]) };
    expect(referencedPartAttachments(document, assets).shapes.size).toBe(0);
    const direct = readPcadFile(writePcadFile(document, { attachments: assets }));
    expect(direct.ok).toBe(true); if (!direct.ok) throw new Error('Generic codec must preserve extras');
    expect(direct.attachments.shapes.get('unknown')).toEqual(bytes); expect(assets.shapes.get('unknown')).toBe(bytes);
  });
});

describe('保存スナップショットが参照する下絵だけを選ぶ', () => {
  const kept = newSketchCanvas([], 'xy', 'keep.png', { width: 1, height: 1 }, 'canvas-1');
  const hidden = { ...kept, id: 'canvas-2', imageId: 'hidden', visible: false };
  const bytes = Uint8Array.of(1, 2, 3);
  const images = new Map([['canvas-1', bytes], ['hidden', Uint8Array.of(4)], ['deleted', Uint8Array.of(5)]]);

  it('非表示も保存し、消した画像だけ除き、元の表と画像のバイト列を保持する', () => {
    const document = { ...createEmptyPartDocument(), canvases: [kept, hidden] };
    const attachments = referencedPartAttachments(document, { ...emptyPcadAttachments(), canvases: images });
    const selected = attachments.canvases;
    expect([...selected.keys()]).toEqual(['canvas-1', 'hidden']);
    expect(selected.get('canvas-1')).toBe(bytes);
    expect(images.size).toBe(3);
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
    expect(referencedPartAttachments(document, { ...emptyPcadAttachments(), canvases: images }).canvases.size).toBe(1);
    expect(referencedPartAttachments({ ...document, canvases: [] }, { ...emptyPcadAttachments(), canvases: images }).canvases.size).toBe(0);
  });

  it('画像が足りない場合は捏造せず、既存の実読み手が拒否する', () => {
    const document = { ...createEmptyPartDocument(), canvases: [kept] };
    const attachments = referencedPartAttachments(document, emptyPcadAttachments());
    expect(attachments.canvases.size).toBe(0);
    expect(readPcadFile(writePcadFile(document, { attachments })).ok).toBe(false);
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
