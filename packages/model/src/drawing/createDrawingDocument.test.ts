import { describe, expect, it } from 'vitest';

import type { DrawingSource, DrawingView } from '@pointercad/drawing';

import {
  DRAWING_SCHEMA_VERSION,
  appendDrawingView,
  createDrawingDocument,
  nextDrawingAnnotationId,
  nextDrawingBalloonId,
  nextDrawingDimensionId,
  nextDrawingLayerId,
  nextDrawingTableId,
  nextDrawingViewId,
} from './createDrawingDocument.js';

const source: DrawingSource = {
  sourceRef: 'source-1',
  sourceKind: 'part',
  fileName: 'part.pcad',
  path: './part.pcad',
  contentHash: 'abc',
  importedAt: '2026-09-08T00:00:00.000Z',
};

function view(id: string): DrawingView {
  return {
    id,
    name: id,
    kind: 'front',
    position: [100, 100],
    scale: null,
    direction: [0, 1, 0],
    xDir: [1, 0, 0],
    showHidden: true,
    showCenterLines: true,
    layerId: 'layer-1',
    style: null,
  };
}

describe('図面文書の生成と採番', () => {
  const document = createDrawingDocument('部品図', source);

  it('空の図面は投影図を持たない', () => {
    expect(document.views).toEqual([]);
  });

  it('既定はA3横・第三角法・等倍である', () => {
    expect(document.sheet).toMatchObject({
      paperSizeId: 'A3-landscape', orientation: 'landscape', projectionMethod: 'third', scale: 1,
    });
  });

  it('既定レイヤーを7枚持つ', () => {
    expect(document.layers).toHaveLength(7);
    expect(new Set(document.layers.map((layer) => layer.name)).size).toBe(7);
  });

  it('表題欄へ文書名を入れる', () => {
    expect(document.sheet.titleBlock.title).toBe('部品図');
  });

  it('参照元をそのまま保つ', () => {
    expect(document.source).toBe(source);
  });

  it('保存形式の版を共有する', () => {
    expect(document.schemaVersion).toBe(DRAWING_SCHEMA_VERSION);
  });

  it.each([
    ['view', nextDrawingViewId, 'view-1'],
    ['dimension', nextDrawingDimensionId, 'dim-1'],
    ['annotation', nextDrawingAnnotationId, 'note-1'],
    ['table', nextDrawingTableId, 'table-1'],
    ['balloon', nextDrawingBalloonId, 'balloon-1'],
    ['layer', nextDrawingLayerId, 'layer-8'],
  ] as const)('空の%sの次のidは%s', (_name, nextId, expected) => {
    expect(nextId(document)).toBe(expected);
  });

  it('途中の図を消しても次の最大連番を使う', () => {
    const withThree = { ...document, views: [view('view-1'), view('view-2'), view('view-3')] };
    const withoutSecond = { ...withThree, views: withThree.views.filter((entry) => entry.id !== 'view-2') };
    expect(nextDrawingViewId(withoutSecond)).toBe('view-4');
  });

  it('図を足しても元の配列を変えない', () => {
    const next = appendDrawingView(document, view('view-1'));
    expect(document.views).toHaveLength(0);
    expect(next.views).toHaveLength(1);
    expect(next.views).not.toBe(document.views);
  });
});
