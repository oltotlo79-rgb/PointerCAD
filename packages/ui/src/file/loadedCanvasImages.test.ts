import { emptyPcadAttachments } from '@pointercad/io';
import { createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { newSketchCanvas } from './canvasFile.js';
import { loadedCanvasImages } from './loadedCanvasImages.js';

describe('読み込んだ部品の画像ID所有', () => {
  it.each(['canvas-1', 'canvas-image-550e8400-e29b-41d4-a716-446655440000'])('非衝突の %s は文書もIDも変更しない', id => {
    const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, id);
    const document = { ...createEmptyPartDocument(), canvases: [canvas] }, bytes = Uint8Array.of(1, 2);
    const attachments = { ...emptyPcadAttachments(), canvases: new Map([[id, bytes]]) };
    const unused = () => { throw new Error('Unexpected ID allocation'); };
    expect(loadedCanvasImages(document, attachments, new Map(), unused)).toEqual({ document, attachments });
    const oldBytes = Uint8Array.of(3, 4), retained = new Map([['past-only', oldBytes]]);
    const result = loadedCanvasImages(document, attachments, retained, unused);
    expect(result.document).toBe(document); expect(result.document.canvases[0]).toBe(canvas);
    expect(result.attachments.canvases.get(id)).toBe(bytes);
    expect(result.attachments.canvases.get('past-only')).toBe(oldBytes);
    expect(retained.size).toBe(1); expect(attachments.canvases.size).toBe(1);
  });

  it('衝突だけを再IDし、同じ画像の複数配置・未参照添付・元の全Map/bytesを保つ', () => {
    const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'canvas-1');
    const duplicate = { ...canvas, id: 'canvas-2', name: 'also-A.png', visible: false };
    const unconflicted = { ...canvas, id: 'canvas-3', imageId: 'incoming-only' };
    const document = { ...createEmptyPartDocument(), canvases: [canvas, duplicate, unconflicted] };
    const old = Uint8Array.of(1, 2), next = Uint8Array.of(3, 4), extra = Uint8Array.of(5, 6);
    const retained = new Map([['canvas-1', old], ['future-only', old]]);
    const attachments = { ...emptyPcadAttachments(),
      canvases: new Map([['canvas-1', next], ['incoming-only', extra], ['unused-in-file', extra]]) };
    const candidates = ['canvas-1', 'future-only', 'incoming-only', 'unused-in-file', 'fresh'];
    const result = loadedCanvasImages(document, attachments, retained, () => {
      const id = candidates.shift(); if (id === undefined) throw new Error('ID candidates exhausted'); return id;
    });
    expect(result.document.canvases).toEqual([{ ...canvas, imageId: 'fresh' }, { ...duplicate, imageId: 'fresh' }, unconflicted]);
    expect(result.document.canvases[2]).toBe(unconflicted);
    expect(result.attachments.canvases.get('canvas-1')).toBe(old);
    expect(result.attachments.canvases.get('fresh')).toBe(next);
    expect(result.attachments.canvases.get('future-only')).toBe(old);
    expect(result.attachments.canvases.get('unused-in-file')).toBe(extra);
    expect(result.attachments.shapes).toBe(attachments.shapes); expect(result.attachments.meshes).toBe(attachments.meshes);
    expect(document.canvases).toEqual([canvas, duplicate, unconflicted]);
    expect(retained).toEqual(new Map([['canvas-1', old], ['future-only', old]]));
    expect(attachments.canvases.get('canvas-1')).toBe(next); expect(attachments.canvases.size).toBe(3);
    expect(old).toEqual(Uint8Array.of(1, 2)); expect(next).toEqual(Uint8Array.of(3, 4));
  });
});
