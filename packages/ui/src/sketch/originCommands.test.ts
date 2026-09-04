import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import {
  appendFeature,
  appendReference,
  createEmptyPartDocument,
  createPointFeature,
  replaceSketch,
  resolveSketch,
  type CoordinateInput,
  type PartDocument,
  type ReferencePointFeature,
  type ResolvedReferences,
  type ResolvedSketch,
  type SketchDocument,
  type SketchPointFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { TreeRow } from '../solid/solidSummary.js';
import type { SubShapeBody } from '../solid/subShapeSelection.js';
import {
  applyOriginPick,
  originChangeFor,
  originNoticeText,
  originPickFor,
  treeRowTakesOrigin,
  type OriginCommandState,
} from './originCommands.js';

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`評価に失敗しました: ${source} / ${result.error.message}`);
  }
  return result.value;
}

/** 式で書いた絶対座標(`absoluteCoordinate` は数値しか受け取らないため)。 */
function coordinate(x: string, y: string, z: string): CoordinateInput {
  return { mode: 'absolute', x: expr(x), y: expr(y), z: expr(z) };
}

function addPoint(
  sketch: SketchDocument,
  at: CoordinateInput,
): { readonly sketch: SketchDocument; readonly featureId: string } {
  const point = createPointFeature(sketch, at);
  return { sketch: appendFeature(sketch, point), featureId: point.id };
}

function pointOf(document: PartDocument, featureId: string): SketchPointFeature {
  const feature = document.sketches[0].features.find((item) => item.id === featureId);
  if (feature === undefined || feature.kind !== 'point') {
    throw new Error(`点が見つかりません: ${featureId}`);
  }
  return feature;
}

function sourcesOf(point: SketchPointFeature): readonly [string, string, string] {
  if (point.at.mode !== 'absolute') {
    throw new Error(`絶対座標ではありません: ${point.at.mode}`);
  }
  return [point.at.x.source, point.at.y.source, point.at.z.source];
}

const NO_REFERENCES: ResolvedReferences = {
  planes: [],
  axes: [],
  points: [],
  coordinateSystems: [],
  errors: [],
};

/** 頂点 1 つだけを持つ板(原点にできるのは頂点だけなので、面・辺は最小限)。 */
const PLATE: SubShapeBody = {
  featureId: 'extrude-1',
  mesh: { edgePositions: new Float32Array([0, 0, 0, 20, 0, 0]) },
  faces: [
    {
      index: 0,
      surfaceKind: 'plane',
      area: 400,
      centroid: [10, 10, 5],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 2,
    },
  ],
  edges: [
    {
      index: 0,
      curveKind: 'line',
      length: 20,
      midpoint: [10, 0, 0],
      start: [0, 0, 0],
      end: [20, 0, 0],
      axis: [1, 0, 0],
      radius: null,
      segmentOffset: 0,
      segmentCount: 1,
    },
  ],
  vertices: [{ index: 0, position: [0, 0, 0] }, { index: 1, position: [20, 7, 4] }],
};

/** ストアが渡すものと同じ形の入力を、部品文書 1 つから組み立てる。 */
function stateOf(
  document: PartDocument,
  references: ResolvedReferences = NO_REFERENCES,
): OriginCommandState {
  const sketch = document.sketches[0];
  const resolved: ResolvedSketch = resolveSketch(sketch);
  return {
    document,
    sketch,
    resolvedSketch: resolved,
    resolvedReferences: references,
    bodies: [PLATE],
  };
}

/** 点 2 つ(`10 + π/2` と `3`)を持つ部品と、その 2 点の id。 */
function twoPointPart(): {
  readonly document: PartDocument;
  readonly first: string;
  readonly second: string;
} {
  const base = createEmptyPartDocument();
  const first = addPoint(base.sketches[0], coordinate('10 + π/2', '0', '0'));
  const second = addPoint(first.sketch, coordinate('3', '0', '0'));
  return {
    document: replaceSketch(base, second.sketch),
    first: first.featureId,
    second: second.featureId,
  };
}

function treeRow(id: string, kind: TreeRow['kind']): TreeRow {
  return {
    id,
    name: id,
    kind,
    kindLabelKey: 'featureTree.title',
    hasError: false,
    errorMessage: null,
    suppressed: false,
    consumed: false,
    hidden: false,
  };
}

describe('原点にできる点の見分け(FR-331、タスク35b)', () => {
  it('スケッチの点フィーチャーは、いま編集しているスケッチの点として指せる', () => {
    const part = twoPointPart();
    const pick = originPickFor({ ...stateOf(part.document), elementId: part.first });
    expect(pick).not.toBeNull();
    expect(pick?.target).toEqual({
      kind: 'sketchPoint',
      sketchId: part.document.sketches[0].id,
      featureId: part.first,
    });
    // 式が復元できなかったときの後退先として、解決済みの位置も添える。
    expect(pick?.position?.[0]).toBeCloseTo(11.5707963267949, 12);
    expect(pick?.labelKey).toBe('originCommand.action');
  });

  it('立体の頂点は、丸めない倍精度の座標として指せる(式を持たないため)', () => {
    const part = twoPointPart();
    const pick = originPickFor({ ...stateOf(part.document), elementId: 'extrude-1#vertex:1' });
    expect(pick?.target).toEqual({ kind: 'position', position: [20, 7, 4] });
    // 文言は頂点だけ言い方を変える(NFR-UX-1)。
    expect(pick?.labelKey).toBe('originCommand.vertexAction');
  });

  it('基準点(座標で置いたもの)も指せる', () => {
    const base = createEmptyPartDocument();
    const feature: ReferencePointFeature = {
      id: 'refPoint-1',
      name: '基準点1',
      visible: true,
      kind: 'referencePoint',
      definition: { kind: 'coordinate', at: coordinate('5', '6', '7') },
    };
    const document = appendReference(base, feature);
    const references: ResolvedReferences = {
      ...NO_REFERENCES,
      points: [{ featureId: 'refPoint-1', name: '基準点1', visible: true, position: [5, 6, 7] }],
    };

    const pick = originPickFor({ ...stateOf(document, references), elementId: 'refPoint-1' });
    expect(pick?.target).toEqual({ kind: 'referencePoint', featureId: 'refPoint-1' });
    expect(pick?.position).toEqual([5, 6, 7]);
  });

  it('点でないもの(立体の面・辺・知らない id)は原点にできない', () => {
    const part = twoPointPart();
    const state = stateOf(part.document);
    expect(originPickFor({ ...state, elementId: 'extrude-1#face:0' })).toBeNull();
    expect(originPickFor({ ...state, elementId: 'extrude-1#edge:0' })).toBeNull();
    expect(originPickFor({ ...state, elementId: 'このidはない' })).toBeNull();
  });

  it('木の一覧に「ここを原点にする」を出すのはスケッチの点と基準点の行だけ', () => {
    expect(treeRowTakesOrigin('sketch', treeRow('point-1', 'point'))).toBe(true);
    expect(treeRowTakesOrigin('sketch', treeRow('line-1', 'line'))).toBe(false);
    expect(treeRowTakesOrigin('reference', treeRow('refPoint-1', 'referencePoint'))).toBe(true);
    expect(treeRowTakesOrigin('reference', treeRow('refPlane-1', 'referencePlane'))).toBe(false);
    expect(treeRowTakesOrigin('solid', treeRow('extrude-1', 'extrude'))).toBe(false);
  });
});

describe('選んだ点を原点にする(FR-331、タスク35b)', () => {
  it('選んだ点は 0 になり、ほかの点は式のまま追従する', () => {
    const part = twoPointPart();
    const change = originChangeFor(stateOf(part.document), part.first);
    if (change === null) {
      throw new Error('原点を移せませんでした');
    }

    expect(sourcesOf(pointOf(change.document, part.first))).toEqual(['0', '0', '0']);
    const other = pointOf(change.document, part.second);
    expect(sourcesOf(other)).toEqual(['3 - (10 + π/2)', '0', '0']);
    if (other.at.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect(other.at.x.value).toBeCloseTo(-8.5707963267949, 12);
    // 履歴の行は増えない(式を書き換えるだけ、利用者の決定 2026-09-04)。
    expect(change.document.sketches[0].features).toHaveLength(2);
  });

  it('もとの原点がどこへ移ったかを式のまま帯へ出す', () => {
    const part = twoPointPart();
    const change = originChangeFor(stateOf(part.document), part.first);
    expect(change?.notice).toBe('原点を (10 + π/2, 0, 0) から移しました。');
  });

  it('立体の頂点を原点にすると、数値で移したことを添える', () => {
    const part = twoPointPart();
    const change = originChangeFor(stateOf(part.document), 'extrude-1#vertex:1');
    if (change === null) {
      throw new Error('原点を移せませんでした');
    }
    expect(change.notice).toBe(
      '原点を (20, 7, 4) から移しました(式が復元できないため数値で移しました)。',
    );
    // 頂点には式が無いので数値のシフトになる。整数どうしなので厳密に計算できて簡約される。
    expect(sourcesOf(pointOf(change.document, part.second))).toEqual(['-17', '-7', '-4']);
  });

  it('極座標の点は式へ復元できないので、解決済みの座標で移す', () => {
    const base = createEmptyPartDocument();
    const polar = addPoint(base.sketches[0], {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: expr('10'),
      azimuth: expr('0'),
      elevation: expr('0'),
    });
    const other = addPoint(polar.sketch, coordinate('3', '0', '0'));
    const document = replaceSketch(base, other.sketch);

    const pick = originPickFor({ ...stateOf(document), elementId: polar.featureId });
    if (pick === null) {
      throw new Error('点として指せませんでした');
    }
    const change = applyOriginPick(document, pick);
    if (change === null) {
      throw new Error('原点を移せませんでした');
    }
    expect(change.notice).toContain('式が復元できないため数値で移しました');
    // 距離 10・方位 0・仰角 0 は XY 面の (10, 0, 0)。整数どうしなので 3 - 10 = -7 へ簡約される。
    expect(sourcesOf(pointOf(change.document, other.featureId))[0]).toBe('-7');
  });

  it('点でないものを渡しても何も起きない(null を返す)', () => {
    const part = twoPointPart();
    expect(originChangeFor(stateOf(part.document), 'extrude-1#face:0')).toBeNull();
  });
});

describe('帯の一言の組み立て(FR-905)', () => {
  it('式が長すぎるときは評価値へ落とす', () => {
    const long = expr('1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15');
    const text = originNoticeText({ x: long, y: expr('0'), z: expr('0') }, true);
    expect(text).toBe('原点を (120, 0, 0) から移しました。');
  });

  it('短い式はそのまま出す', () => {
    const text = originNoticeText({ x: expr('2/4'), y: expr('0'), z: expr('0') }, true);
    expect(text).toBe('原点を (2/4, 0, 0) から移しました。');
  });
});
