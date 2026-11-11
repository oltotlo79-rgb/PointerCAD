import { emptyPcadAttachments } from '@pointercad/io';
import { createEmptyPartDocument, importedShapeOf, type PartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { loadedPartAttachments } from './loadedPartAttachments.js';

function documentWith(ref: string): PartDocument {
  return { ...createEmptyPartDocument(), solids: [
    { kind: 'importedSolid', id: 'solid-1', name: 'shape', shapeRef: ref, suppressed: true, bodyKind: 'solid',
      source: { format: 'step', fileName: 'shape.step', unit: 'mm', byteLength: 2 } },
    { kind: 'importedMesh', id: 'mesh-1', name: 'mesh', meshRef: ref, suppressed: false, triangleCount: 1,
      source: { format: 'stl', fileName: 'mesh.stl', unit: 'mm', byteLength: 84 } },
  ] };
}
const mesh = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
  normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) };

describe('部品の添付を所有者と同時に正規化する', () => {
  it('非衝突refは据え置き、文書・原本・元Mapを変えない', () => {
    const document = documentWith('new'), bytes = Uint8Array.of(1, 2);
    const attachments = { ...emptyPcadAttachments(), shapes: new Map([['new', bytes]]), meshes: new Map([['new', mesh]]) };
    const result = loadedPartAttachments(document, attachments, emptyPcadAttachments(), () => { throw new Error('No collision'); });
    expect(result.document).toBe(document); expect(result.attachments.shapes).toBe(attachments.shapes);
    expect(result.attachments.meshes).toBe(attachments.meshes);
    expect(result.attachments.shapeDigests?.get('new')).toBe(importedShapeOf(bytes).shapeDigest);
  });

  it('shape/meshは独立に衝突を移し、digestキーも変えるがfeature.id・source・配置は保つ', () => {
    const document = documentWith('shared'), oldBytes = Uint8Array.of(1, 2), bytes = Uint8Array.of(3, 4);
    const incoming = { ...emptyPcadAttachments(), shapes: new Map([['shared', bytes]]), meshes: new Map([['shared', mesh]]),
      shapeDigests: new Map([['shared', importedShapeOf(bytes).shapeDigest]]) };
    const retained = { ...emptyPcadAttachments(), shapes: new Map([['shared', oldBytes]]), meshes: new Map([['shared', mesh]]) };
    const result = loadedPartAttachments(document, incoming, retained, kind => `${kind}-new`);
    expect(result.document.solids).toEqual(document.solids.map(feature => feature.kind === 'importedSolid'
      ? { ...feature, shapeRef: 'shape-new' } : feature.kind === 'importedMesh' ? { ...feature, meshRef: 'mesh-new' } : feature));
    expect(result.attachments.shapes.get('shared')).toBe(oldBytes); expect(result.attachments.shapes.get('shape-new')).toBe(bytes);
    expect(result.attachments.meshes.get('shared')).toBe(mesh); expect(result.attachments.meshes.get('mesh-new')).toBe(mesh);
    expect(result.attachments.shapeDigests).toEqual(new Map([['shared', importedShapeOf(oldBytes).shapeDigest],
      ['shape-new', importedShapeOf(bytes).shapeDigest]]));
    expect(incoming.shapes.size).toBe(1); expect(incoming.shapeDigests.size).toBe(1); expect(retained.shapes.size).toBe(1);
    expect(document.solids).toEqual(documentWith('shared').solids);
    expect(bytes).toEqual(Uint8Array.of(3, 4)); expect(mesh.indices).toEqual(Uint32Array.of(0, 1, 2));
  });

  it('新規取込では同refを持つ既存featureを変えず、新規の複数featureだけを移す', () => {
    const before = documentWith('shared'), existing = before.solids[0];
    const first = { ...existing, id: 'new-1' }, second = { ...existing, id: 'new-2' };
    const document = { ...before, solids: [...before.solids, first, second] };
    const old = Uint8Array.of(1), incoming = Uint8Array.of(2);
    const result = loadedPartAttachments(document,
      { ...emptyPcadAttachments(), shapes: new Map([['shared', incoming]]) },
      { ...emptyPcadAttachments(), shapes: new Map([['shared', old]]) }, () => 'fresh', new Set(['new-1', 'new-2']));
    expect(result.document.solids[0]).toBe(existing); expect(result.document.solids[1]).toBe(before.solids[1]);
    expect(result.document.solids.slice(2)).toEqual([{ ...first, shapeRef: 'fresh' }, { ...second, shapeRef: 'fresh' }]);
    expect(result.attachments.shapes.get('shared')).toBe(old); expect(result.attachments.shapes.get('fresh')).toBe(incoming);
  });
});
