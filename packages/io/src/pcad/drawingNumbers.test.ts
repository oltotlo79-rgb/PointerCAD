import { describe, expect, it } from 'vitest';
import { createDrawingDocument, type DrawingDocument, type DrawingView } from '@pointercad/model';
import { parseDrawing, serializeDrawing } from './drawingJson.js';

function document(viewChange: Partial<DrawingView> = {}): DrawingDocument {
  const base = createDrawingDocument('入力検査', { sourceRef: 'source', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' });
  return { ...base, views: [{ id: 'front', name: '正面図', kind: 'front', position: [0, 0], scale: null,
    direction: [0, -1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: base.layers[0].id, ...viewChange }] };
}

describe('図面JSONの意味制約（R09）', () => {
  it.each([0, -0.1])('詳細図の縮尺%sをparse入口で拒否し、欄を示す', (scale) => {
    const result = parseDrawing(serializeDrawing(document({ detail: { center: [0, 0], radius: 10, scale } })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('detail.scale');
  });
  it.each([0, -1])('詳細図の半径%sを拒否する', (radius) => {
    const result = parseDrawing(serializeDrawing(document({ detail: { center: [0, 0], radius, scale: 2 } })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('detail.radius');
  });
  it('ゼロ方向・平行な方向を拒否し、正規化可能な方向は保持する', () => {
    expect(parseDrawing(serializeDrawing(document({ direction: [0, 0, 0] }))).ok).toBe(false);
    expect(parseDrawing(serializeDrawing(document({ xDir: [0, 3, 0] }))).ok).toBe(false);
    const valid = document({ direction: [0, -3, 0], xDir: [2, 1, 0], detail: { center: [0, 0], radius: 1, scale: 2 } });
    expect(parseDrawing(serializeDrawing(valid))).toMatchObject({ ok: true, document: valid });
  });
  it('ヘアライン0を保ち、負の要素線幅を拒否する', () => {
    expect(parseDrawing(serializeDrawing(document({ style: { lineWidth: 0 } }))).ok).toBe(true);
    const result = parseDrawing(serializeDrawing(document({ style: { lineWidth: -0.1 } })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('style.lineWidth');
  });
  it('注記の高さ0と負値を拒否し、位置の0や負値を保存する', () => {
    const base = document();
    for (const height of [0, -1]) {
      const value: DrawingDocument = { ...base, annotations: [{ id: 'note', kind: 'note', text: '注記', position: [0, -1], height, layerId: base.layers[0].id }] };
      const result = parseDrawing(serializeDrawing(value));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('height');
    }
  });
  it('raw JSONの大きな指数と未知欄内の非有限値を受理しない', () => {
    const text = serializeDrawing(document());
    const scalar = text.replace(/"scale":\s*1/u, '"scale": 1e309');
    expect(scalar).not.toBe(text);
    expect(parseDrawing(scalar).ok).toBe(false);
    const unknown = text.replace(/"document":\s*\{/u, '"document": {"future": {"value": 1e309},');
    expect(unknown).not.toBe(text);
    expect(parseDrawing(unknown).ok).toBe(false);
  });
});
