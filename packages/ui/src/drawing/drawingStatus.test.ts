import { describe, expect, it } from 'vitest';
import { createDrawingDocument, type DrawingRefreshResult } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import { drawingScaleRatio, drawingStatusGeometry } from './drawingStatus.js';

function fixture(): DrawingDocument {
  const document = createDrawingDocument('縮尺の図面', {
    sourceRef: 'source', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
  });
  return { ...document, sheet: { ...document.sheet, scale: 0.5 },
    views: [{ id: 'enlarged', name: '拡大した図', kind: 'front', direction: [0, 1, 0], xDir: [1, 0, 0],
      position: [100, 100], scale: 2, showHidden: true, showCenterLines: true, layerId: document.layers[0].id }] };
}

describe('図面の縮尺・用紙・未解決件数(P8-69)', () => {
  it.each([[1, '1:1'], [0.5, '1:2'], [0.125, '1:8'], [2, '2:1'], [0.3, '0.3:1']] as const)('縮尺%sを%sと示す', (value, label) => {
    expect(drawingScaleRatio(value)).toBe(label);
  });
  it.each([0, -1, NaN, Infinity, -Infinity])('不正な縮尺%sを等倍と表示しない', (value) => {
    expect(drawingScaleRatio(value)).toBeNull();
  });
  it('選択なしは用紙の縮尺を示し、内部の用紙IDを表示しない', () => {
    const result = drawingStatusGeometry(fixture(), null, []);
    expect(result.scaleRatio).toBe('1:2'); expect(result.viewName).toBeNull();
    expect(result.paperLabel).toContain('A3'); expect(result.paperLabel).not.toContain('landscape');
  });
  it('1つの図を選ぶとその図の個別縮尺と名前を示す', () => {
    expect(drawingStatusGeometry(fixture(), null, ['enlarged'])).toMatchObject({ scaleRatio: '2:1', viewName: '拡大した図' });
  });
  it('個別縮尺を持たない図は用紙の縮尺を継ぐ', () => {
    const document = fixture();
    const drawing = { ...document, views: [{ ...document.views[0], scale: null }] };
    expect(drawingStatusGeometry(drawing, null, ['enlarged'])).toMatchObject({ scaleRatio: '1:2', viewName: '拡大した図' });
  });
  it('複数図を選んだ場合は、最初の図の縮尺を全体の値と誤表示しない', () => {
    const document = fixture();
    const drawing = { ...document, views: [...document.views, { ...document.views[0], id: 'another', scale: 5 }] };
    expect(drawingStatusGeometry(drawing, null, ['another', 'enlarged'])).toMatchObject({ scaleRatio: '1:2', viewName: null });
  });
  it('以前の再評価結果と失敗を未解決0件と表示しない', () => {
    const document = fixture();
    const resolution: DrawingRefreshResult = { ok: true, document, dimensions: [], unresolvedCount: 2,
      sourceChangedExternally: false, projection: { ok: true, views: [], failures: [], cancelled: false } };
    expect(drawingStatusGeometry(document, resolution, []).unresolvedCount).toBe(2);
    expect(drawingStatusGeometry({ ...document }, resolution, []).unresolvedCount).toBeNull();
    expect(drawingStatusGeometry(document, { ok: false, message: '計算失敗' }, []).unresolvedCount).toBeNull();
  });
  it('図面を閉じると前の図名・用紙・縮尺を残さない', () => {
    expect(drawingStatusGeometry(null, null, ['enlarged'])).toEqual({ scaleRatio: null, viewName: null, paperLabel: null, unresolvedCount: null });
  });
});
