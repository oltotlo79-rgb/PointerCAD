import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendSolid,
  createEmptyPartDocument,
  createEmptySketchDocument,
  FREE_WORK_PLANE_ID,
  resolveSketch,
  type ExtrudeFeature,
  type PartDocument,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { EDIT_MENU_ITEMS } from '../shell/toolbarMenus.js';
import { selectionKindForTool, type SubShapeBody } from '../solid/subShapeSelection.js';
import { editToolReadiness } from './editCommands.js';
import { freeSketchToolRejection } from './freeSketch.js';
import {
  commitPlaneSection,
  commitProjectedCurve,
  commitProjectionSources,
  projectionMissingTargetKey,
  projectionOrderRejection,
  projectionSourceOf,
  projectionSourcesFromSelection,
  projectionSourcesRejection,
  projectionTakesSubShape,
} from './projectionCommands.js';

/**
 * 板 1 枚ぶんのボディ(面 1 枚・辺 1 本・頂点 1 つ)。投影のもとになるのは面と辺だけなので、
 * 指紋の中身は「面か辺か」を見分けられる最小限にしてある。
 */
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
      curveKind: 'circle',
      length: 18.85,
      midpoint: [10, 10, 5],
      start: [13, 10, 5],
      end: [13, 10, 5],
      axis: [0, 0, 1],
      radius: 3,
      segmentOffset: 0,
      segmentCount: 1,
    },
  ],
  vertices: [{ index: 0, position: [0, 0, 0] }],
};

const BODIES: readonly SubShapeBody[] = [PLATE];

function sketch(): SketchDocument {
  return createEmptySketchDocument();
}

function extrudeFeature(id: string, sketchId: string): ExtrudeFeature {
  return {
    id,
    kind: 'extrude',
    name: `押し出し${id}`,
    suppressed: false,
    profile: { sketchId, faceFeatureId: 'face-1' },
    distance: expressionValueFromNumber(10),
    reversed: false,
    symmetric: false,
  };
}

/** 立体を履歴の順に並べた部品文書。id と、その立体が使うスケッチの id を並べて渡す。 */
function partWith(solids: readonly (readonly [string, string])[]): PartDocument {
  let document = createEmptyPartDocument();
  for (const [id, sketchId] of solids) {
    document = appendSolid(document, extrudeFeature(id, sketchId));
  }
  return document;
}

describe('投影・断面の道具の受け持ち(FR-325、タスク27)', () => {
  it('投影は面・辺を、断面は立体そのものを対象にする', () => {
    expect(projectionTakesSubShape('projectedCurve')).toBe(true);
    expect(projectionTakesSubShape('planeSection')).toBe(false);
  });

  it('対象が押されていないときの断りが道具ごとに分かれる', () => {
    expect(projectionMissingTargetKey('projectedCurve')).toBe('projection.error.needFaceOrEdge');
    expect(projectionMissingTargetKey('planeSection')).toBe('projection.error.needBody');
  });

  it('投影は面を選ぶ状態に、断面は立体を選ぶ状態に切り替わる(§0.a-0.6)', () => {
    expect(selectionKindForTool('projectedCurve')).toBe('face');
    expect(selectionKindForTool('planeSection')).toBe('body');
  });

  it('3D スケッチ(作図面なし)では使えない', () => {
    expect(freeSketchToolRejection(FREE_WORK_PLANE_ID, 'projectedCurve')).not.toBeNull();
    expect(freeSketchToolRejection(FREE_WORK_PLANE_ID, 'planeSection')).not.toBeNull();
    // 作図面があるスケッチでは断らない。
    expect(freeSketchToolRejection('xy', 'projectedCurve')).toBeNull();
    expect(freeSketchToolRejection('xy', 'planeSection')).toBeNull();
  });

  it('「編集」の一覧に並び、選択が空でも押せる(道具を選んでからクリックするため)', () => {
    const ids = EDIT_MENU_ITEMS.map((item) => item.id);
    expect(ids).toContain('projectedCurve');
    expect(ids).toContain('planeSection');
    const resolved = resolveSketch(sketch());
    for (const tool of ['projectedCurve', 'planeSection'] as const) {
      const readiness = editToolReadiness(tool, resolved, []);
      expect(readiness.ready).toBe(true);
      expect(readiness.reasonKey).toBeNull();
    }
  });
});

describe('選択・クリックから投影・断面のもとを作る(FR-325)', () => {
  it('投影は面の要素 id から指紋つきの参照を作る', () => {
    const source = projectionSourceOf('projectedCurve', BODIES, 'extrude-1#face:0');
    expect(source).not.toBeNull();
    expect(source?.kind).toBe('subShape');
    if (source?.kind === 'subShape') {
      expect(source.ref.bodyFeatureId).toBe('extrude-1');
      expect(source.ref.index).toBe(0);
      expect(source.ref.fingerprint.kind).toBe('face');
    }
  });

  it('投影は辺の要素 id も受け取る(穴の丸い辺を写す)', () => {
    const source = projectionSourceOf('projectedCurve', BODIES, 'extrude-1#edge:0');
    expect(source?.kind).toBe('subShape');
    if (source?.kind === 'subShape') {
      expect(source.ref.fingerprint.kind).toBe('edge');
    }
  });

  it('投影は頂点・立体そのもの・無い番号を受け取らない', () => {
    expect(projectionSourceOf('projectedCurve', BODIES, 'extrude-1#vertex:0')).toBeNull();
    expect(projectionSourceOf('projectedCurve', BODIES, 'extrude-1')).toBeNull();
    expect(projectionSourceOf('projectedCurve', BODIES, 'extrude-1#face:9')).toBeNull();
  });

  it('断面は立体の id だけを受け取り、面・辺・知らない立体は受け取らない', () => {
    expect(projectionSourceOf('planeSection', BODIES, 'extrude-1')).toEqual({
      kind: 'body',
      bodyFeatureId: 'extrude-1',
    });
    expect(projectionSourceOf('planeSection', BODIES, 'extrude-1#face:0')).toBeNull();
    expect(projectionSourceOf('planeSection', BODIES, 'extrude-9')).toBeNull();
  });

  it('選択からは選んだ順に拾い、対象にならないものは飛ばす', () => {
    const sources = projectionSourcesFromSelection('projectedCurve', BODIES, [
      'extrude-1#edge:0',
      'point-1',
      'extrude-1#vertex:0',
      'extrude-1#face:0',
    ]);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.kind === 'subShape' && sources[0].ref.fingerprint.kind).toBe('edge');
    expect(sources[1]?.kind === 'subShape' && sources[1].ref.fingerprint.kind).toBe('face');
  });
});

describe('履歴へ積む(FR-325)', () => {
  it('投影は kind: projectedCurve を作図面つきで足す', () => {
    const source = projectionSourceOf('projectedCurve', BODIES, 'extrude-1#face:0');
    expect(source?.kind).toBe('subShape');
    if (source?.kind !== 'subShape') {
      return;
    }
    const next = commitProjectedCurve(sketch(), 'xz', source.ref);
    expect(next.features).toHaveLength(1);
    const feature = next.features[0];
    expect(feature.kind).toBe('projectedCurve');
    expect(feature.planeId).toBe('xz');
    expect(feature.name).toBe('投影1');
    if (feature.kind === 'projectedCurve') {
      // 取り込んだ輪郭は面の境界・押し出しの材料に使えるのが既定(構築線にはしない)。
      expect(feature.construction).toBe(false);
      expect(feature.source.bodyFeatureId).toBe('extrude-1');
    }
  });

  it('断面は kind: planeSection を立体の id つきで足す', () => {
    const next = commitPlaneSection(sketch(), 'xy', 'extrude-1');
    const feature = next.features[0];
    expect(feature.kind).toBe('planeSection');
    expect(feature.name).toBe('断面1');
    if (feature.kind === 'planeSection') {
      expect(feature.targetFeatureId).toBe('extrude-1');
      expect(feature.construction).toBe(false);
    }
  });

  it('まとめて積んでも文書の差し替えは 1 回で、id と名前は重ならない', () => {
    const sources = projectionSourcesFromSelection('projectedCurve', BODIES, [
      'extrude-1#face:0',
      'extrude-1#edge:0',
    ]);
    const next = commitProjectionSources(sketch(), 'xy', sources);
    expect(next.features.map((feature) => feature.id)).toEqual([
      'projectedCurve-1',
      'projectedCurve-2',
    ]);
    expect(next.features.map((feature) => feature.name)).toEqual(['投影1', '投影2']);
  });

  it('元の文書は書き換えない(不変)', () => {
    const before = sketch();
    commitPlaneSection(before, 'xy', 'extrude-1');
    expect(before.features).toHaveLength(0);
  });
});

describe('順序の制約の先読み(§0.a-0.11、FR-504)', () => {
  const faceSource = { kind: 'body', bodyFeatureId: 'extrude-1' } as const;

  it('もとの立体が、このスケッチを使う立体より前にあれば取り込める', () => {
    // extrude-1(sketch-1 から作る)→ extrude-2(sketch-2 から作る)の順。
    // sketch-2 が extrude-1 を取り込むのは前の立体なので通る。
    const document = partWith([
      ['extrude-1', 'sketch-1'],
      ['extrude-2', 'sketch-2'],
    ]);
    expect(projectionOrderRejection(document, 'sketch-2', faceSource)).toBeNull();
  });

  it('もとの立体が、このスケッチを使う立体と同じか後にあれば断る', () => {
    // extrude-1 が sketch-2 を使っているのに、その sketch-2 が extrude-1 を取り込もうとする。
    const document = partWith([
      ['extrude-1', 'sketch-2'],
      ['extrude-2', 'sketch-1'],
    ]);
    expect(projectionOrderRejection(document, 'sketch-2', faceSource)).toBe(
      'projection.error.laterBody',
    );
  });

  it('そのスケッチをどの立体も使っていなければ制約は無い', () => {
    const document = partWith([['extrude-1', 'sketch-1']]);
    expect(projectionOrderRejection(document, 'sketch-9', faceSource)).toBeNull();
  });

  it('もとの立体が履歴に無ければ断る', () => {
    const document = partWith([['extrude-2', 'sketch-1']]);
    expect(projectionOrderRejection(document, 'sketch-1', faceSource)).toBe(
      'projection.error.missingBody',
    );
  });

  it('抑制された立体は「使う立体」として数えない(FR-503)', () => {
    const base = partWith([
      ['extrude-1', 'sketch-2'],
      ['extrude-2', 'sketch-1'],
    ]);
    const suppressed: PartDocument = {
      ...base,
      solids: base.solids.map((feature) =>
        feature.id === 'extrude-1' ? { ...feature, suppressed: true } : feature,
      ),
    };
    expect(projectionOrderRejection(suppressed, 'sketch-2', faceSource)).toBeNull();
  });

  it('まとめて取り込むときは、取り込めない 1 件目の理由だけを返す', () => {
    const document = partWith([
      ['extrude-1', 'sketch-1'],
      ['extrude-2', 'sketch-2'],
    ]);
    expect(
      projectionSourcesRejection(document, 'sketch-2', [
        { kind: 'body', bodyFeatureId: 'extrude-1' },
        { kind: 'body', bodyFeatureId: 'extrude-9' },
      ]),
    ).toBe('projection.error.missingBody');
    expect(
      projectionSourcesRejection(document, 'sketch-2', [
        { kind: 'body', bodyFeatureId: 'extrude-1' },
      ]),
    ).toBeNull();
  });
});
