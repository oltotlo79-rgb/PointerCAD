import { describe, expect, it } from 'vitest';

import type { Dimension, DrawingSource, DrawingView } from '@pointercad/drawing';

import { createDrawingDocument } from './createDrawingDocument.js';
import {
  DUPLICATE_DRAWING_LAYER_NAME_MESSAGE,
  INVALID_DRAWING_LAYER_COLOR_MESSAGE,
  addDrawingLayer,
  removeDrawingLayer,
  reorderDrawingLayer,
  replaceDrawingLayer,
} from './layerEdit.js';

const source: DrawingSource = {
  sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad', path: './part.pcad',
  contentHash: 'abc', importedAt: '2026-09-08T00:00:00.000Z',
};

function view(layerId: string): DrawingView {
  return {
    id: 'view-1', name: '正面図', kind: 'front', position: [100, 100], scale: null,
    direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true,
    layerId,
  };
}

function dimension(layerId: string): Dimension {
  return {
    id: 'dim-1', kind: 'length', measurement: 'trueDistance', targets: [],
    placement: { commonNormalCoordinate: 10, textPosition: null }, reference: false,
    origin: 'manual', layerId,
  };
}

describe('図面レイヤーの編集', () => {
  it('新しいレイヤーをlayer-8で足す', () => {
    const result = addDrawingLayer(createDrawingDocument('図面', source), { name: '補助' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.layers.at(-1)).toMatchObject({ id: 'layer-8', name: '補助' });
    }
  });

  it('色が#RRGGBBでなければ理由を返す', () => {
    expect(addDrawingLayer(createDrawingDocument('図面', source), {
      name: '補助', color: 'red',
    })).toEqual({ ok: false, message: INVALID_DRAWING_LAYER_COLOR_MESSAGE });
  });

  it('同じ名前を断る', () => {
    expect(addDrawingLayer(createDrawingDocument('図面', source), {
      name: '外形線',
    })).toEqual({ ok: false, message: DUPLICATE_DRAWING_LAYER_NAME_MESSAGE });
  });

  it('レイヤーを不変に差し替える', () => {
    const document = createDrawingDocument('図面', source);
    const first = document.layers[0];
    if (first === undefined) {
      throw new Error('既定レイヤーがありません。');
    }
    const result = replaceDrawingLayer(document, first.id, { ...first, color: '#123456' });
    expect(result.ok).toBe(true);
    expect(document.layers[0]?.color).toBe('#000000');
    if (result.ok) {
      expect(result.document.layers[0]?.color).toBe('#123456');
    }
  });

  it('要素のあるレイヤーを消すと要素数を返して要素も消す', () => {
    const base = createDrawingDocument('図面', source);
    const document = { ...base, views: [view('layer-1')], dimensions: [dimension('layer-1')] };
    const result = removeDrawingLayer(document, 'layer-1');
    expect(result.removedElementCount).toBe(2);
    expect(result.document.views).toEqual([]);
    expect(result.document.dimensions).toEqual([]);
    expect(result.document.layers).toHaveLength(6);
  });

  it('知らないレイヤーの削除は元を返す', () => {
    const document = createDrawingDocument('図面', source);
    expect(removeDrawingLayer(document, 'missing')).toEqual({ document, removedElementCount: 0 });
  });

  it('レイヤーを先頭へ移しても元の並びを変えない', () => {
    const document = createDrawingDocument('図面', source);
    const next = reorderDrawingLayer(document, 'layer-7', 0);
    expect(next.layers[0]?.id).toBe('layer-7');
    expect(document.layers[0]?.id).toBe('layer-1');
  });

  it('範囲外の移動先を両端へ丸める', () => {
    const document = createDrawingDocument('図面', source);
    expect(reorderDrawingLayer(document, 'layer-1', 99).layers.at(-1)?.id).toBe('layer-1');
    expect(reorderDrawingLayer(document, 'layer-7', -4).layers[0]?.id).toBe('layer-7');
  });
});
