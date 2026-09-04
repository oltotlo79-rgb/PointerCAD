import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  DEFAULT_FACE_COLOR,
  type PartDocument,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { findSketchFeatureAt, sketchLookupOrder } from './sketchRefs.js';

/**
 * 面・線分・点を同じ id で持つスケッチを作る。要素 id はスケッチ 1 本の中でだけ
 * 一意なので、2 本のスケッチが同じ `face-1` を持つのはふつうの状態(P4 仕上げ (g))。
 */
function sketchWithSameIds(id: string, name: string): SketchDocument {
  const empty: SketchDocument = { id, name, features: [] };
  const withFace = appendFeature(empty, {
    id: 'face-1',
    name: '面1',
    planeId: 'xy',
    kind: 'face',
    boundary: [],
    color: DEFAULT_FACE_COLOR,
  });
  const withLine = appendFeature(withFace, {
    id: 'line-1',
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(10, 0, 0),
    construction: false,
  });
  return appendFeature(withLine, {
    id: 'pointArray-1',
    name: '点列1',
    planeId: 'xy',
    kind: 'pointArray',
    layout: {
      kind: 'linear',
      base: absoluteCoordinate(0, 0, 0),
      azimuth: expressionValueFromNumber(0),
      spacing: expressionValueFromNumber(10),
      count: expressionValueFromNumber(3),
    },
  });
}

function documentWithTwoSketches(activeSketchId: string): PartDocument {
  return {
    ...createEmptyPartDocument(),
    sketches: [sketchWithSameIds('sketch-1', 'スケッチ1'), sketchWithSameIds('sketch-2', 'スケッチ2')],
    activeSketchId,
  };
}

describe('スケッチを探す順(P4 仕上げ (g))', () => {
  it('編集中のスケッチが先頭で、残りは文書の並び順', () => {
    expect(sketchLookupOrder(documentWithTwoSketches('sketch-2'))).toEqual([
      'sketch-2',
      'sketch-1',
    ]);
    expect(sketchLookupOrder(documentWithTwoSketches('sketch-1'))).toEqual([
      'sketch-1',
      'sketch-2',
    ]);
  });

  it('編集中の id が実在しないときは文書の並び順のまま', () => {
    expect(sketchLookupOrder(documentWithTwoSketches('sketch-9'))).toEqual([
      'sketch-1',
      'sketch-2',
    ]);
  });
});

describe('要素 id からスケッチのフィーチャーを探す(P4 仕上げ (g))', () => {
  it('同じ id が両方のスケッチにあるときは編集中のものを返す', () => {
    const found = findSketchFeatureAt(documentWithTwoSketches('sketch-2'), 'face-1');
    expect(found?.sketchId).toBe('sketch-2');
    expect(found?.featureId).toBe('face-1');
    expect(found?.feature.kind).toBe('face');
  });

  it('点列の 1 点(`pointArray-1#2`)からもフィーチャーの id へ戻す', () => {
    const found = findSketchFeatureAt(documentWithTwoSketches('sketch-2'), 'pointArray-1#2');
    expect(found?.sketchId).toBe('sketch-2');
    expect(found?.featureId).toBe('pointArray-1');
  });

  it('種類を絞ると、種類の合わないスケッチは読み飛ばして次を探す', () => {
    const document = documentWithTwoSketches('sketch-2');
    // 編集中(スケッチ 2)の `line-1` は線分なので、面だけを探すと当たらない。
    expect(findSketchFeatureAt(document, 'line-1', new Set(['face']))).toBeUndefined();
    expect(findSketchFeatureAt(document, 'line-1', new Set(['line']))?.sketchId).toBe('sketch-2');
  });

  it('どのスケッチにも無い id は undefined', () => {
    expect(findSketchFeatureAt(documentWithTwoSketches('sketch-1'), 'face-9')).toBeUndefined();
  });
});
