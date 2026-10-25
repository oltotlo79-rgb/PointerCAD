import { createEmptyPartDocument, createUndoStack } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { newSketchCanvas } from '../file/canvasFile.js';
import { createInitialDocumentState } from './initialDocumentState.js';
import { canvasAssetRetention, retainCanvasAssets } from './canvasAssetRetention.js';

function documentFor(imageId: string) {
  return { ...createEmptyPartDocument(), canvases: [newSketchCanvas([], 'xy', `${imageId}.png`, { width: 2, height: 1 }, imageId)] };
}

describe('下絵資産の保持集合', () => {
  it('nextとpast/present/futureを別々に保持し、重複・非表示を落とさない', () => {
    const next = documentFor('next'), past = documentFor('past'), present = documentFor('present');
    const future = documentFor('future');
    const hidden = { ...future, canvases: future.canvases.map(canvas => ({ ...canvas, visible: false })) };
    const stack = { ...createUndoStack(present), past: [past, past], future: [hidden] };
    const images = new Map(['next', 'past', 'present', 'future', 'unused'].map((id, i) => [id, Uint8Array.of(i)]));
    const retained = retainCanvasAssets(images, next, stack);
    expect([...retained.keys()]).toEqual(['next', 'past', 'present', 'future']);
    expect(images.size).toBe(5);
    for (const id of retained.keys()) expect(retained.get(id)).toBe(images.get(id));
  });

  it('空Mapでは文書集合を読まず、回収対象がなければ同じMapを返す', () => {
    const document = documentFor('kept'), empty = new Map<string, Uint8Array>();
    const stack = { ...createUndoStack(document), get past(): readonly typeof document[] { throw new Error('Should not walk an empty pool'); } };
    expect(retainCanvasAssets(empty, document, stack)).toBe(empty);
    const images = new Map([['kept', Uint8Array.of(1)]]);
    expect(retainCanvasAssets(images, document, createUndoStack(document))).toBe(images);
  });

  it('足りない画像を捏造せず、不要な画像は元Mapを変えず全て回収する', () => {
    const document = documentFor('missing'), bytes = Uint8Array.of(1, 2);
    const images = new Map([['unused', bytes]]);
    expect(retainCanvasAssets(images, document, createUndoStack(document)).size).toBe(0);
    expect(images.get('unused')).toBe(bytes); expect(bytes).toEqual(Uint8Array.of(1, 2));
  });

  it('資産を回収するとバイト列を持つ状態と画素・再試行の控えも同じ更新で手放す', () => {
    const initial = createInitialDocumentState(), document = documentFor('kept');
    const bytes = Uint8Array.of(1), request = {};
    const load = { documentId: 'owner', bytes, request, status: 'failed' as const };
    const state = { ...initial, canvases: new Map([['kept', bytes], ['unused', bytes]]),
      canvasScale: { canvasId: 'removed', documentId: 'owner', imageId: 'unused', bytes, points: [] },
      canvasRectification: { canvasId: 'removed', documentId: 'owner', imageId: 'unused',
        bytes, request, size: { width: 1, height: 1 }, points: [] },
      canvasImageLoads: new Map([['kept', load], ['unused', load]]),
      canvasPixelSizes: new Map([['unused', { width: 1, height: 1 }]]), canvasImageRetries: new Map([['unused', 2]]) };
    const result = canvasAssetRetention(state, document, createUndoStack(document), false);
    expect([...result.canvases.keys()]).toEqual(['kept']);
    expect([...result.canvasImageLoads.keys()]).toEqual(['kept']);
    expect(result.canvasImageLoads.get('kept')).toBe(load);
    expect(result.canvasPixelSizes.size).toBe(0); expect(result.canvasImageRetries.size).toBe(0);
    expect(result.canvasScale).toBeNull(); expect(state.canvasScale.bytes).toBe(bytes);
    expect(result.canvasRectification).toBeNull(); expect(state.canvasRectification.bytes).toBe(bytes);
    expect(state.canvasImageLoads.size).toBe(2); expect(state.canvasPixelSizes.size).toBe(1);
  });

  it('同じ画像byteが残る文書差替えでも一時的な四隅だけ取り下げる', () => {
    const initial = createInitialDocumentState(), document = documentFor('kept');
    const bytes = Uint8Array.of(1), request = {};
    const state = { ...initial, canvases: new Map([['kept', bytes]]),
      canvasRectification: { canvasId: 'canvas-1', documentId: 'old', imageId: 'kept',
        bytes, request, size: { width: 2, height: 1 }, points: [] } };
    const result = canvasAssetRetention(state, document, createUndoStack(document), true);
    expect(result.canvases).toBe(state.canvases);
    expect(result.canvasRectification).toBeNull();
    expect(state.canvasRectification.bytes).toBe(bytes);
  });
});
