import { describe, expect, it } from 'vitest';

import { DEFAULT_DRAWING_LAYERS } from './style/layers.js';
import type { DrawingDocument } from './types.js';

const sample = {
  id: 'drawing-1',
  name: '見本',
  schemaVersion: 9,
  source: {
    sourceRef: 'source-1',
    sourceKind: 'part',
    fileName: 'sample.pcad',
    path: './sample.pcad',
    contentHash: 'abc',
    importedAt: '2026-09-08T00:00:00.000Z',
  },
  sheet: {
    paperSizeId: 'A3-landscape',
    orientation: 'landscape',
    scale: 1,
    projectionMethod: 'third',
    frame: { visible: true },
    titleBlock: {
      title: '', drawingNumber: '', revision: '', author: '', date: '', material: '',
    },
  },
  views: [],
  dimensions: [],
  annotations: [],
  tables: [],
  balloons: [],
  datums: [],
  gdtFrames: [],
  weldSymbols: [],
  layers: DEFAULT_DRAWING_LAYERS,
  parameters: [],
} satisfies DrawingDocument;

describe('図面文書の型', () => {
  it('見本が DrawingDocument の型に合う', () => {
    expect(sample.name).toBe('見本');
  });

  it('id を除く内容に製作指示3配列を含む14欄を持つ', () => {
    expect(Object.keys(sample).filter((key) => key !== 'id')).toHaveLength(14);
  });

  it('投影の線や寸法値を保存する欄を持たない', () => {
    expect(sample).not.toHaveProperty('projectedLines');
    expect(sample.dimensions).toEqual([]);
  });

  it('参照元は文書の種類と内容ハッシュを持つ', () => {
    expect(sample.source).toMatchObject({ sourceKind: 'part', contentHash: 'abc' });
  });

  it('用紙座標の既定は第三角法である', () => {
    expect(sample.sheet.projectionMethod).toBe('third');
  });
});
