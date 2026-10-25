import { emptyPcadAttachments, readPcadFile, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { newSketchCanvas } from './canvasFile.js';
import { partAssetReferences, referencedPartAttachments } from './referencedPartAttachments.js';

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
