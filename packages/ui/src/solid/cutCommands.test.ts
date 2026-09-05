/**
 * 平面による切断のコマンド(`cutCommands.ts`)の検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27e の検証表)。
 *
 * 期待値の導出は §0.a-0.56(平面の決め方の推測)、§0.a-0.57(残す側)、
 * §0.a-0.58(「反対側も残す」で 2 段積む)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendSolid,
  createEmptyPartDocument,
  DEFAULT_CUT_KEEP,
  findSolid,
  type ExtrudeFeature,
  type PartDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { SolidInputCommit } from '../sketch/numericInput.js';

import {
  commitCut,
  commitCutInput,
  cutPlaneRejection,
  cutPlaneSpecFor,
  cutPreviewDiagonal,
  cutToolReadiness,
  cutTargetOf,
  inferPlaneSpec,
  resolveCutPlane,
  type CutContext,
} from './cutCommands.js';
import { solidToolReadiness } from './solidCommands.js';
import {
  subShapeElementId,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SolidVertexEntry,
  type SubShapeBody,
} from './subShapeSelection.js';

/* ------------------------------------------------------------------ *
 * ひな型(40 × 30 × 10 の板を想定した頂点・辺・面)
 * ------------------------------------------------------------------ */

const TEN = expressionValueFromNumber(10);

function faceEntry(index: number, surfaceKind: SolidFaceEntry['surfaceKind']): SolidFaceEntry {
  return {
    index,
    surfaceKind,
    area: 1200,
    centroid: [20, 15, index === 0 ? 10 : 0],
    axis: [0, 0, 1],
    radius: surfaceKind === 'cylinder' ? 5 : null,
    triangleOffset: index * 2,
    triangleCount: 2,
  };
}

function edgeEntry(index: number, curveKind: SolidEdgeEntry['curveKind']): SolidEdgeEntry {
  return {
    index,
    curveKind,
    length: 40,
    midpoint: [20, 0, 0],
    start: [0, 0, 0],
    end: [40, 0, 0],
    axis: [1, 0, 0],
    radius: curveKind === 'circle' ? 5 : null,
    segmentOffset: index,
    segmentCount: 1,
  };
}

function vertexEntry(index: number, position: readonly [number, number, number]): SolidVertexEntry {
  return { index, position };
}

/**
 * 40 × 30 × 10 の板のボディ。頂点は 3 点で平面が決まるものを 3 つと、
 * **一直線に並ぶ 3 つ目**(index 3)を別に持つ(先出し検査の材料)。
 */
function plateBody(featureId = 'extrude-1'): SubShapeBody {
  return {
    featureId,
    mesh: {
      // 境界箱の対角長を測る材料(§0.a-0.61)。線分 1 本で対角の 2 点を渡す。
      edgePositions: new Float32Array([0, 0, 0, 40, 30, 10]),
    },
    faces: [faceEntry(0, 'plane'), faceEntry(1, 'cylinder')],
    edges: [edgeEntry(0, 'line'), edgeEntry(1, 'circle')],
    vertices: [
      vertexEntry(0, [0, 0, 0]),
      vertexEntry(1, [40, 0, 0]),
      vertexEntry(2, [0, 30, 0]),
      // 0 → 1 と同じ向きに並ぶ 3 つ目(0・1・3 は一直線)。
      vertexEntry(3, [20, 0, 0]),
    ],
  };
}

function extrudeFeature(id: string): ExtrudeFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: TEN,
    reversed: false,
    symmetric: false,
  };
}

function documentWithPlate(): PartDocument {
  return appendSolid(createEmptyPartDocument(), extrudeFeature('extrude-1'));
}

function contextOf(selection: readonly string[]): CutContext {
  return { document: documentWithPlate(), bodies: [plateBody()], selection };
}

const BODY = 'extrude-1';
const V0 = subShapeElementId(BODY, 'vertex', 0);
const V1 = subShapeElementId(BODY, 'vertex', 1);
const V2 = subShapeElementId(BODY, 'vertex', 2);
const V3 = subShapeElementId(BODY, 'vertex', 3);
const EDGE_LINE = subShapeElementId(BODY, 'edge', 0);
const EDGE_CIRCLE = subShapeElementId(BODY, 'edge', 1);
const FACE_PLANE = subShapeElementId(BODY, 'face', 0);
const FACE_CYLINDER = subShapeElementId(BODY, 'face', 1);

function cutCommit(overrides: Partial<SolidInputCommit> = {}): SolidInputCommit {
  return {
    kind: 'solid',
    tool: 'cut',
    step: 'cutPlane',
    values: {},
    flags: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 平面の決め方の推測(§0.a-0.56、NFR-UX-4)
 * ------------------------------------------------------------------ */

describe('選んだものから切る面を推測する(タスク27e、NFR-UX-4)', () => {
  it('立体 1 + 頂点 3 → 3 点を通る面', () => {
    const plane = inferPlaneSpec(contextOf([BODY, V0, V1, V2]));
    expect(plane?.kind).toBe('threePoints');
    if (plane?.kind !== 'threePoints') {
      return;
    }
    // 点は座標を写さず、指紋つきの参照で持つ(上流が動けば切る面も動く)。
    expect(plane.p1.kind).toBe('subShape');
    expect(plane.p1.kind === 'subShape' ? plane.p1.ref.index : null).toBe(0);
    expect(plane.p3.kind === 'subShape' ? plane.p3.ref.index : null).toBe(2);
  });

  it('立体 1 + 頂点 1 + 辺 1 → 点と辺(辺に垂直)', () => {
    const plane = inferPlaneSpec(contextOf([BODY, V0, EDGE_LINE]));
    expect(plane?.kind).toBe('pointAndEdge');
    expect(plane?.kind === 'pointAndEdge' ? plane.mode : null).toBe('perpendicular');
  });

  it('立体 1 + 頂点 1 + 面 1 → 点と平行な面', () => {
    const plane = inferPlaneSpec(contextOf([BODY, V0, FACE_PLANE]));
    expect(plane?.kind).toBe('pointAndParallelFace');
  });

  it('立体 1 + 頂点 1 だけ → 点と軸(Z 軸・傾き 0)', () => {
    const plane = inferPlaneSpec(contextOf([BODY, V0]));
    expect(plane?.kind).toBe('pointAndAxis');
    if (plane?.kind !== 'pointAndAxis') {
      return;
    }
    expect(plane.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(plane.tilt.value).toBe(0);
    expect(plane.azimuth.value).toBe(0);
  });

  it('平面の材料が無ければ推測しない(呼び出し側が基準の面へ後退する)', () => {
    expect(inferPlaneSpec(contextOf([BODY]))).toBeNull();
    expect(inferPlaneSpec(contextOf([]))).toBeNull();
  });

  it('辺と面の両方を選んでいるときは辺を優先する', () => {
    expect(inferPlaneSpec(contextOf([BODY, V0, EDGE_LINE, FACE_PLANE]))?.kind).toBe(
      'pointAndEdge',
    );
  });

  it('材料が無ければ選択肢の基準面になる(既定は XY 面)', () => {
    expect(cutPlaneSpecFor(contextOf([BODY]), 'xz')).toEqual({
      kind: 'workPlane',
      planeId: 'xz',
      offset: expressionValueFromNumber(0),
    });
    expect(cutPlaneSpecFor(contextOf([BODY]), undefined)?.kind).toBe('workPlane');
  });

  it('基準面を選んでいても、材料があれば推測が勝つ(NFR-UX-4)', () => {
    expect(cutPlaneSpecFor(contextOf([BODY, V0, V1, V2]), 'xy')?.kind).toBe('threePoints');
  });

  it('決め方を明示したときは、その材料だけを見る(すり替えない)', () => {
    // 3 点を選んでいても「点と軸」を選んだなら点と軸で決める。
    expect(cutPlaneSpecFor(contextOf([BODY, V0, V1, V2]), 'pointAndAxis')?.kind).toBe(
      'pointAndAxis',
    );
    // 材料が足りなければ null(基準面へ黙って落ちない)。
    expect(cutPlaneSpecFor(contextOf([BODY]), 'threePoints')).toBeNull();
    expect(cutPlaneSpecFor(contextOf([BODY, V0]), 'pointAndEdge')).toBeNull();
    expect(cutPlaneSpecFor(contextOf([BODY]), 'face')).toBeNull();
  });

  it('「選んだ面」はその面そのものを切る面にする', () => {
    const plane = cutPlaneSpecFor(contextOf([BODY, FACE_PLANE]), 'face');
    expect(plane?.kind).toBe('face');
    expect(plane?.kind === 'face' ? plane.offset.value : null).toBe(0);
  });

  it('知らない決め方は null(黙って別の面で切らない)', () => {
    expect(cutPlaneSpecFor(contextOf([BODY, V0]), 'まっぷたつ')).toBeNull();
  });

  it('傾き角は「点と軸」の面へそのまま入る(FR-202)', () => {
    const plane = cutPlaneSpecFor(
      contextOf([BODY, V0]),
      'pointAndAxis',
      { source: '15*2', value: 30, display: '30' },
    );
    expect(plane?.kind === 'pointAndAxis' ? plane.tilt.value : null).toBe(30);
    expect(plane?.kind === 'pointAndAxis' ? plane.tilt.source : null).toBe('15*2');
  });
});

/* ------------------------------------------------------------------ *
 * 先出し検査(NFR-UX-5)
 * ------------------------------------------------------------------ */

describe('切断の先出し検査(タスク27e 手順3、NFR-UX-5)', () => {
  it('対象の立体が選ばれていなければ押せない', () => {
    expect(cutToolReadiness(contextOf([]))).toEqual({
      ready: false,
      reasonKey: 'shapeError.noTargetBody',
    });
    expect(cutTargetOf(contextOf([BODY]))).toBe(BODY);
  });

  it('立体を 2 つ選ぶと対象が決まらない', () => {
    const document = appendSolid(documentWithPlate(), extrudeFeature('extrude-2'));
    const context: CutContext = {
      document,
      bodies: [plateBody(), plateBody('extrude-2')],
      selection: ['extrude-1', 'extrude-2'],
    };
    expect(cutTargetOf(context)).toBeNull();
    expect(cutToolReadiness(context).reasonKey).toBe('shapeError.noTargetBody');
  });

  it('立体だけ選んでいれば押せる(基準の面へ後退できる、NFR-UX-4)', () => {
    expect(cutToolReadiness(contextOf([BODY]))).toEqual({ ready: true, reasonKey: null });
  });

  it('3 点が一直線なら理由が出る(文言に「一直線」)', () => {
    const readiness = cutToolReadiness(contextOf([BODY, V0, V1, V3]));
    expect(readiness.ready).toBe(false);
    expect(readiness.reasonKey).toBe('cutError.collinear');
  });

  it('曲がった辺は切る面の基準にできない', () => {
    expect(cutToolReadiness(contextOf([BODY, V0, EDGE_CIRCLE])).reasonKey).toBe(
      'cutError.notStraightEdge',
    );
  });

  it('平らでない面は切る面の基準にできない', () => {
    expect(cutToolReadiness(contextOf([BODY, V0, FACE_CYLINDER])).reasonKey).toBe(
      'cutError.curvedFace',
    );
    expect(cutPlaneRejection(cutPlaneSpecFor(contextOf([BODY, FACE_CYLINDER]), 'face'))).toBe(
      'cutError.curvedFace',
    );
  });

  it('平面の材料が足りないときは「切る面を決めるものが足りません」', () => {
    expect(cutPlaneRejection(null)).toBe('shapeError.noCutPlane');
  });

  it('`solidToolReadiness` から同じ判定が引ける', () => {
    const context = contextOf([BODY, V0, V1, V3]);
    expect(solidToolReadiness(context.document, context.selection, 'cut', context.bodies)).toEqual(
      cutToolReadiness(context),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 確定(§0.a-0.57、§0.a-0.58)
 * ------------------------------------------------------------------ */

describe('切断の確定(タスク27e、§0.a-0.58)', () => {
  const XY_PLANE = { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0) } as const;

  it('反対側を残さないときはフィーチャーが 1 つ、pairedWith は null', () => {
    const outcome = commitCut(contextOf([BODY]), XY_PLANE, 'positive', false);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const cuts = outcome.document.solids.filter((feature) => feature.kind === 'cut');
    expect(cuts).toHaveLength(1);
    const first = findSolid(outcome.document, outcome.featureId);
    expect(first?.kind).toBe('cut');
    if (first?.kind !== 'cut') {
      return;
    }
    expect(first.pairedWith).toBeNull();
    expect(first.keep).toBe('positive');
    expect(first.targetFeatureId).toBe(BODY);
  });

  it('反対側も残すとフィーチャーが 2 つ。2 つ目は残す側が逆で、対の印を持つ', () => {
    const outcome = commitCut(contextOf([BODY]), XY_PLANE, 'positive', true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const cuts = outcome.document.solids.filter((feature) => feature.kind === 'cut');
    expect(cuts).toHaveLength(2);
    const [first, second] = cuts;
    if (first?.kind !== 'cut' || second?.kind !== 'cut') {
      return;
    }
    expect(first.keep).toBe('positive');
    expect(second.keep).toBe('negative');
    expect(second.pairedWith).toBe(first.id);
    expect(first.pairedWith).toBeNull();
    // 2 つとも同じ対象を切り、切る面の中身も同じ。
    expect(second.targetFeatureId).toBe(first.targetFeatureId);
    expect(second.plane).toEqual(first.plane);
    // 返す id は 1 つ目(利用者が押した操作の主役)。
    expect(outcome.featureId).toBe(first.id);
    expect(first.name).toBe('切断1');
    expect(second.name).toBe('切断2');
  });

  it('残す側を反対にしても、対の 2 つ目はさらに逆になる', () => {
    const outcome = commitCut(contextOf([BODY]), XY_PLANE, 'negative', true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const cuts = outcome.document.solids.filter((feature) => feature.kind === 'cut');
    expect(cuts.map((feature) => (feature.kind === 'cut' ? feature.keep : null))).toEqual([
      'negative',
      'positive',
    ]);
  });

  it('対象が決まらなければ履歴を変えずに断る', () => {
    const context = contextOf([]);
    expect(commitCut(context, XY_PLANE, 'positive', false)).toEqual({
      ok: false,
      reasonKey: 'shapeError.noTargetBody',
    });
    expect(context.document.solids).toHaveLength(1);
  });

  it('先出し検査に引っかかる面では作らない', () => {
    const context = contextOf([BODY, V0, V1, V3]);
    const plane = inferPlaneSpec(context);
    expect(plane).not.toBeNull();
    if (plane === null) {
      return;
    }
    expect(commitCut(context, plane, 'positive', false)).toEqual({
      ok: false,
      reasonKey: 'cutError.collinear',
    });
  });

  it('その場入力からの確定: つまみが残す側と 2 つに分けるかを決める(§0.a-0.57)', () => {
    const plain = commitCutInput(contextOf([BODY]), cutCommit());
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      const feature = findSolid(plain.document, plain.featureId);
      expect(feature?.kind === 'cut' ? feature.keep : null).toBe(DEFAULT_CUT_KEEP);
    }

    const opposite = commitCutInput(
      contextOf([BODY]),
      cutCommit({ flags: { cutKeepOpposite: true } }),
    );
    expect(opposite.ok).toBe(true);
    if (opposite.ok) {
      const feature = findSolid(opposite.document, opposite.featureId);
      expect(feature?.kind === 'cut' ? feature.keep : null).toBe('negative');
    }

    const both = commitCutInput(contextOf([BODY]), cutCommit({ flags: { cutKeepBoth: true } }));
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.document.solids.filter((feature) => feature.kind === 'cut')).toHaveLength(2);
    }
  });

  it('その場入力からの確定: 傾きに `15*2` と書くと 30 度になり、式も残る(FR-202)', () => {
    const outcome = commitCutInput(
      contextOf([BODY, V0]),
      cutCommit({
        shapeChoices: { cutPlaneKind: 'pointAndAxis' },
        values: { cutTilt: { source: '15*2', value: 30, display: '30' } },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = findSolid(outcome.document, outcome.featureId);
    expect(feature?.kind).toBe('cut');
    if (feature?.kind !== 'cut' || feature.plane.kind !== 'pointAndAxis') {
      return;
    }
    expect(feature.plane.tilt.value).toBe(30);
    expect(feature.plane.tilt.source).toBe('15*2');
  });

  it('その場入力からの確定: 決め方の材料が足りなければ断る', () => {
    expect(
      commitCutInput(contextOf([BODY]), cutCommit({ shapeChoices: { cutPlaneKind: 'threePoints' } })),
    ).toEqual({ ok: false, reasonKey: 'shapeError.noCutPlane' });
  });
});

/* ------------------------------------------------------------------ *
 * 予告の材料(§0.a-0.61)
 * ------------------------------------------------------------------ */

describe('予告表示のための解決(タスク27e 手順5・6、§0.a-0.61)', () => {
  it('境界箱の対角長を稜線の端点から測る(40 × 30 × 10 → √2600)', () => {
    expect(cutPreviewDiagonal(contextOf([BODY]), BODY)).toBeCloseTo(50.99019513592785, 12);
  });

  it('ボディが見つからない・稜線が無いときは 0(予告を出さない)', () => {
    expect(cutPreviewDiagonal(contextOf([BODY]), 'extrude-9')).toBe(0);
    const empty: CutContext = {
      document: documentWithPlate(),
      bodies: [{ ...plateBody(), mesh: { edgePositions: new Float32Array(0) } }],
      selection: [BODY],
    };
    expect(cutPreviewDiagonal(empty, BODY)).toBe(0);
  });

  it('基準の 3 面はその場で解ける(法線が軸に一致する)', () => {
    const plane = resolveCutPlane({
      kind: 'workPlane',
      planeId: 'xy',
      offset: expressionValueFromNumber(0),
    });
    expect(plane).not.toBeNull();
    expect(plane?.normal).toEqual([0, 0, 1]);
  });

  it('3 点を通る面も指紋だけで解ける(カーネルへ行かない)', () => {
    const spec = inferPlaneSpec(contextOf([BODY, V0, V1, V2]));
    expect(spec).not.toBeNull();
    if (spec === null) {
      return;
    }
    const plane = resolveCutPlane(spec);
    expect(plane).not.toBeNull();
    // (0,0,0)→(40,0,0)→(0,30,0) の右ねじは +Z。
    expect(plane?.normal[2]).toBeCloseTo(1, 12);
  });

  it('座標の読めない点(スケッチの点)では解けず、予告を出さない', () => {
    const plane = resolveCutPlane({
      kind: 'pointAndAxis',
      point: { kind: 'point', pointId: 'point-1' },
      axis: { kind: 'world', axis: 'z' },
      tilt: expressionValueFromNumber(0),
      azimuth: expressionValueFromNumber(0),
    });
    expect(plane).toBeNull();
  });
});
