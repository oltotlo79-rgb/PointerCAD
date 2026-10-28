/**
 * 平面による切断のコマンド(`cutCommands.ts`)の検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27e の検証表)。
 *
 * 期待値の導出は §0.a-0.56(平面の決め方の推測)、§0.a-0.57(残す側)、
 * §0.a-0.58(「反対側も残す」で 2 段積む)。
 */

import { stdout } from 'node:process';

import { expressionValueFromNumber } from '@pointercad/expression';
import { createFunctionMathSource, createMathBackend, executeFunctionCurveWorkRequest,
  executeFunctionSurfaceWorkRequest, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { FunctionSurfaceWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import { parseDocument, readPcadFile, serializeDocument, writePcadFile } from '@pointercad/io';
import {
  absoluteCoordinate,
  appendSolid,
  createEmptyPartDocument,
  createFunctionCurve,
  createFunctionSurface,
  DEFAULT_CUT_KEEP,
  DEFAULT_PRIMITIVE_AXIS,
  FunctionSurfacePlanCache,
  findSolid,
  appendFeature,
  findSketch,
  recomputePart,
  replaceSketch,
  resolvePart,
  resolveSketch,
  type BooleanFeature,
  type ExtrudeFeature,
  type PartDocument,
  type PartRecomputeOptions,
  type PrimitiveFeature,
  type ResolvedPart,
  type SolidBody,
} from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNativeKernelBridgeForNodeTests,
  createInspectableNativeKernelForNodeTests,
  initializeNativeKernelForNodeTests,
} from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { inspectNativeCutShape } from '../../../model/src/testing/inspectNativeCutShape.node.js';
import { applySolidCommit } from '../sketch/commitToStore.js';
import { chooseNumericInput, createNumericInput, toggleNumericInput, type SolidInputCommit } from '../sketch/numericInput.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

import {
  commitCut,
  commitCutInput,
  commitProfileCut,
  PROFILE_CUT_KIND,
  profileCutGeometry,
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
  subShapeBodiesOf,
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

/* ------------------------------------------------------------------ *
 * EX04 閉じた輪郭で貫いて切る(UNEXECUTED until Root runs it)
 *
 * 期待値は形と既存の型からだけ決める(実装の計算を写さない)。
 * - 箱は境界箱 0〜10 の立方体、輪郭は作図面 XY(z = 0)の中心 (5, 5) の円。
 * - 両側押し出しの片側の長さは、作図面から箱の最も遠い面までの 10 を越えなければ貫けない。
 * - 確定は押し出し 1 段 + 差 1 段を 1 回の文書の変更として返し、既存の段と作図には触れない。
 * ------------------------------------------------------------------ */

const ZERO_VALUE = expressionValueFromNumber(0);
const PROFILE_FACE = 'face-c';

function at(x: number, y: number) {
  return { mode: 'absolute' as const, x: expressionValueFromNumber(x), y: expressionValueFromNumber(y), z: ZERO_VALUE };
}

/**
 * 0〜10 の立方体のボディ。カーネルが箱について返すとおり、平面 6 枚・直線の稜線 12 本(両端は double の
 * 角の座標)を持たせる(表示用の稜線の点は対角の 2 端だけ。`plateBody` と同じ渡し方)。
 */
function cubeBody(): SubShapeBody {
  type Point = readonly [number, number, number];
  const corners: Point[] = [];
  for (const x of [0, 10]) for (const y of [0, 10]) for (const z of [0, 10]) corners.push([x, y, z]);
  // 角の組のうち、座標が 1 つだけ違う組が稜線(i < j で 1 回ずつ数え、12 本)。
  const edges: (readonly [Point, Point])[] = [];
  corners.forEach((start, i) => corners.forEach((end, j) => {
    if (i < j && [0, 1, 2].filter((axis) => start[axis] !== end[axis]).length === 1) edges.push([start, end]);
  }));
  return { featureId: BODY, mesh: { edgePositions: new Float32Array([0, 0, 0, 10, 10, 10]) },
    faces: [0, 1, 2, 3, 4, 5].map((index) => ({ index, surfaceKind: 'plane' as const, area: 100,
      centroid: [5, 5, 5] as const, axis: null, radius: null, triangleOffset: 0, triangleCount: 0 })),
    edges: edges.map(([start, end], index) => ({ index, curveKind: 'line' as const, length: 10,
      midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2] as const,
      start, end, axis: null, radius: null, segmentOffset: 0, segmentCount: 0 })),
    vertices: [] };
}

function withSketchFeatures(features: readonly Parameters<typeof appendFeature>[1][]): PartDocument {
  const base = documentWithPlate();
  const sketch = findSketch(base, 'sketch-1');
  if (sketch === undefined) throw new Error('sketch-1 がありません');
  return replaceSketch(base, features.reduce((current, feature) => appendFeature(current, feature), sketch));
}

/** 作図面 XY の円(全周)と、それを境界にした閉じた面。 */
function documentWithCircle(radius: number, center: readonly [number, number] = [5, 5]): PartDocument {
  return withSketchFeatures([
    { id: 'circle-1', name: '円', kind: 'arc', planeId: 'xy', center: at(center[0], center[1]),
      radius: expressionValueFromNumber(radius), startAngle: ZERO_VALUE, endAngle: expressionValueFromNumber(360),
      construction: false },
    { id: PROFILE_FACE, name: '輪郭', kind: 'face', planeId: 'xy', boundary: [{ featureId: 'circle-1' }], color: '#6699aa' },
  ]);
}

function line(id: string, from: readonly [number, number], to: readonly [number, number]) {
  return { id, name: id, kind: 'line' as const, planeId: 'xy' as const, from: at(from[0], from[1]), to: at(to[0], to[1]),
    construction: false };
}

function profileContext(selection: readonly string[], document: PartDocument = documentWithCircle(3)): CutContext {
  return { document, bodies: [cubeBody()], selection };
}

const PROFILE_COMMIT = { shapeChoices: { cutPlaneKind: PROFILE_CUT_KIND } };

describe('EX04 閉じた輪郭で貫いて切る(押し出し + 差を 1 回で積む)', () => {
  it('選んだ立体と閉じた輪郭から、輪郭を参照する両側押し出しと差を 1 回の変更で積む', () => {
    const before = documentWithCircle(3);
    const outcome = commitCutInput(profileContext([BODY, PROFILE_FACE], before), cutCommit(PROFILE_COMMIT));
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    const added = outcome.document.solids.slice(before.solids.length);
    expect(added.map((feature) => feature.kind)).toEqual(['extrude', 'boolean']);
    const [tool, cut] = added;
    if (tool.kind !== 'extrude' || cut.kind !== 'boolean') throw new Error('段の種類が違います');
    // 輪郭は参照のまま(座標を写さない)なので、作図の円を直せば切り口も変わる。
    expect(tool.profile).toEqual({ sketchId: 'sketch-1', faceFeatureId: PROFILE_FACE });
    // 長さは確定時の数ではなく、選んだ立体を名指しして再計算のたびに決める(closed-profile-cut-parametric-r1)。
    expect(tool.end).toEqual({ kind: 'throughTarget', targetFeatureId: BODY });
    expect(tool.symmetric).toBe(false);
    expect(tool.reversed).toBe(false);
    // 片側の長さが作図面(z = 0)から箱の上面(z = 10)までを越えないと貫けない。
    expect(tool.distance.value / 2).toBeGreaterThan(10);
    expect(Number.isFinite(tool.distance.value)).toBe(true);
    // 実際に削れない差は再計算で断られるよう、この入口の差だけが requireRemoval を立てる。
    expect(cut).toMatchObject({ operation: 'subtract', targetFeatureId: BODY, toolFeatureId: tool.id, requireRemoval: true });
    expect(outcome.featureId).toBe(cut.id);
    // 既存の段と作図には触れない(1 回の変更 = 元に戻す 1 回で消える 2 段だけ)。
    expect(outcome.document.solids.slice(0, before.solids.length)).toEqual(before.solids);
    expect(outcome.document.sketches).toEqual(before.sketches);
  });

  it('確定後に作図の円の半径を 2 に直しても、押し出しは同じ輪郭を指したまま新しい円を切る', () => {
    const before = documentWithCircle(3);
    const outcome = commitProfileCut(profileContext([BODY, PROFILE_FACE], before));
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    const sketch = findSketch(outcome.document, 'sketch-1');
    if (sketch === undefined) throw new Error('sketch-1 がありません');
    const edited = replaceSketch(outcome.document, { ...sketch, features: sketch.features.map((feature) =>
      feature.id === 'circle-1' && feature.kind === 'arc' ? { ...feature, radius: expressionValueFromNumber(2) } : feature) });
    const tool = edited.solids.find((feature) => feature.kind === 'extrude' && feature.id !== 'extrude-1');
    expect(tool?.kind === 'extrude' ? tool.profile : null).toEqual({ sketchId: 'sketch-1', faceFeatureId: PROFILE_FACE });
    const editedSketch = findSketch(edited, 'sketch-1');
    if (editedSketch === undefined) throw new Error('sketch-1 がありません');
    const face = resolveSketch(editedSketch).faces.find((candidate) => candidate.featureId === PROFILE_FACE);
    const circle = face?.curves[0];
    expect(circle?.kind === 'arc' ? circle.radius : null).toBe(2);
    // 直した後の文書でも同じ確かめが通る(輪郭は箱の中にあり、平らで、閉じている)。
    expect(profileCutGeometry(profileContext([BODY, PROFILE_FACE], edited), BODY,
      { sketchId: 'sketch-1', faceFeatureId: PROFILE_FACE }).ok).toBe(true);
  });

  it('全周の円は始点と終点が同じでも平らと判定され、向きは作図面の法線になる', () => {
    const geometry = profileCutGeometry(profileContext([BODY, PROFILE_FACE]), BODY,
      { sketchId: 'sketch-1', faceFeatureId: PROFILE_FACE });
    if (!geometry.ok) throw new Error(`断られました: ${geometry.reasonKey}`);
    expect(Math.abs(geometry.normal[2])).toBeCloseTo(1, 12);
    expect(Math.hypot(geometry.normal[0], geometry.normal[1])).toBeCloseTo(0, 12);
  });

  it('楕円の閉じた輪郭も選べる(曲線のまま押し出しへ渡る)', () => {
    const document = withSketchFeatures([
      { id: 'ellipse-1', name: '楕円', kind: 'ellipse', planeId: 'xy', center: at(5, 5),
        majorRadius: expressionValueFromNumber(4), minorRadius: expressionValueFromNumber(2),
        rotation: ZERO_VALUE, startAngle: ZERO_VALUE, endAngle: expressionValueFromNumber(360), construction: false },
      { id: 'face-e', name: '輪郭', kind: 'face', planeId: 'xy', boundary: [{ featureId: 'ellipse-1' }], color: '#6699aa' },
    ]);
    const outcome = commitProfileCut(profileContext([BODY, 'face-e'], document));
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    const tool = outcome.document.solids.find((feature) => feature.kind === 'extrude' && feature.id !== 'extrude-1');
    expect(tool?.kind === 'extrude' ? tool.profile.faceFeatureId : null).toBe('face-e');
  });

  it('断るときは理由を返し、文書を変えない(いまの形が残る)', () => {
    // 輪郭を選んでいない。
    expect(commitCutInput(profileContext([BODY]), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.noProfile' });
    // 切る立体を選んでいない。
    expect(commitCutInput(profileContext([PROFILE_FACE]), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'shapeError.noTargetBody' });
    // 輪郭が箱の外(中心 (50, 50))にあり、作図面へ写しても重ならない。
    expect(commitCutInput(profileContext([BODY, PROFILE_FACE], documentWithCircle(3, [50, 50])), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.profileMissesTarget' });
    // 開いた輪郭(線分 1 本だけを境界にした面)。
    const open = withSketchFeatures([line('l-open', [1, 1], [9, 9]),
      { id: 'face-open', name: '開いた輪郭', kind: 'face', planeId: 'xy', boundary: [{ featureId: 'l-open' }], color: '#6699aa' }]);
    const openOutcome = commitCutInput(profileContext([BODY, 'face-open'], open), cutCommit(PROFILE_COMMIT));
    expect(openOutcome.ok).toBe(false);
    expect(openOutcome.ok ? null : openOutcome.reasonKey).toBe('cutError.profileInvalid');
    // 自分自身と交わる輪郭(蝶ネクタイ形)。作図の解決が先に断ればその理由でもよいが、通してはならない。
    const bowTie = withSketchFeatures([line('b1', [1, 1], [9, 9]), line('b2', [9, 9], [9, 1]), line('b3', [9, 1], [1, 9]),
      line('b4', [1, 9], [1, 1]),
      { id: 'face-bow', name: '交差', kind: 'face', planeId: 'xy',
        boundary: [{ featureId: 'b1' }, { featureId: 'b2' }, { featureId: 'b3' }, { featureId: 'b4' }], color: '#6699aa' }]);
    const bowOutcome = commitCutInput(profileContext([BODY, 'face-bow'], bowTie), cutCommit(PROFILE_COMMIT));
    expect(bowOutcome.ok).toBe(false);
    expect(['cutError.profileSelfIntersects', 'cutError.profileInvalid'])
      .toContain(bowOutcome.ok ? null : bowOutcome.reasonKey);
  });

  it('決め方が平面のままなら、輪郭を選んでいても従来の平面の切断を積む(既存の切断は変わらない)', () => {
    const before = documentWithCircle(3);
    const outcome = commitCutInput(profileContext([BODY, PROFILE_FACE], before),
      cutCommit({ shapeChoices: { cutPlaneKind: 'xy' } }));
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    const added = outcome.document.solids.slice(before.solids.length);
    expect(added.map((feature) => feature.kind)).toEqual(['cut']);
    expect(added[0]).toMatchObject({ kind: 'cut', targetFeatureId: BODY, keep: DEFAULT_CUT_KEEP, pairedWith: null });
  });
});
/* ------------------------------------------------------------------ *
 * EX04 押す前の「届かない」判定は、本当の形を必ず含む範囲でだけ断る(closed-profile-cut-preflight-r1。
 * UNEXECUTED until Root runs it)。期待値は形だけから決める。
 * ------------------------------------------------------------------ */

/**
 * 原点中心・半径 10 の球のボディ。OCCT の全周の球は面 1 枚・稜線 3 本(u = 0 の継ぎ目の子午線と、
 * 長さの無い極 2 つ)なので、表示用の稜線の点は XZ 面の x ≥ 0 の半円だけになる。
 */
function sphereBody(): SubShapeBody {
  const meridian: number[] = [];
  for (let step = 0; step < 8; step += 1) {
    const a = (Math.PI * step) / 8, b = (Math.PI * (step + 1)) / 8;
    meridian.push(10 * Math.sin(a), 0, 10 * Math.cos(a), 10 * Math.sin(b), 0, 10 * Math.cos(b));
  }
  return { featureId: BODY, mesh: { edgePositions: new Float32Array(meridian) },
    faces: [{ index: 0, surfaceKind: 'sphere', area: 400 * Math.PI, centroid: [0, 0, 0], axis: [0, 0, 1],
      radius: 10, triangleOffset: 0, triangleCount: 0 }],
    edges: [{ index: 0, curveKind: 'circle', length: 10 * Math.PI, midpoint: [10, 0, 0], start: [0, 0, 10],
      end: [0, 0, -10], axis: [0, 1, 0], radius: 10, segmentOffset: 0, segmentCount: 8 }],
    vertices: [] };
}

/** 作図面 XY の閉じたスプライン(通過点 or 制御点)と、それを境界にした閉じた面。 */
function documentWithSpline(mode: 'interpolate' | 'control', points: readonly (readonly [number, number])[]): PartDocument {
  return withSketchFeatures([
    { id: 'spline-1', name: 'スプライン', kind: 'spline', planeId: 'xy', mode, points: points.map(([x, y]) => at(x, y)),
      closed: true, construction: false },
    { id: 'face-s', name: '輪郭', kind: 'face', planeId: 'xy', boundary: [{ featureId: 'spline-1' }], color: '#6699aa' },
  ]);
}

describe('押す前の「届かない」は、本当の形を必ず含む範囲でだけ断る(EX04 preflight)', () => {
  it('球の中の輪郭を「届かない」と断らない(旧: 表示用の稜線の箱 x 0..10 で断っていた反例)', () => {
    // 半径 2 の円の中心は球の中心から 5。5 + 2 < 10 なので円板はまるごと球の中にあり、貫けば必ず削れる。
    const center = [-5, 0] as const, radius = 2;
    expect(Math.hypot(center[0], center[1]) + radius).toBeLessThan(10);
    const context: CutContext = { document: documentWithCircle(radius, center), bodies: [sphereBody()],
      selection: [BODY, PROFILE_FACE] };
    const outcome = commitCutInput(context, cutCommit(PROFILE_COMMIT));
    // 旧の判定は x の範囲 [-7, -3] と稜線の箱 [0, 10] が離れているとして cutError.profileMissesTarget を返していた。
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    const cut = outcome.document.solids.find((feature) => feature.id === outcome.featureId);
    // 実際に削れるかは再計算の差が判定する(届かなければ理由つきで断り、直前の形を残す)。
    expect(cut).toMatchObject({ kind: 'boolean', operation: 'subtract', requireRemoval: true });
  });

  it('多面体の対象と線分・円・制御点の輪郭では、離れていれば押す前に断る(従来どおり)', () => {
    expect(commitCutInput(profileContext([BODY, PROFILE_FACE], documentWithCircle(3, [50, 50])),
      cutCommit(PROFILE_COMMIT))).toEqual({ ok: false, reasonKey: 'cutError.profileMissesTarget' });
    // 制御点のスプラインは制御点の凸包に収まるので、制御点がすべて箱の外なら曲線も外。
    const control = documentWithSpline('control', [[40, 40], [50, 40], [50, 50], [40, 50]]);
    expect(commitCutInput(profileContext([BODY, 'face-s'], control), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.profileMissesTarget' });
  });

  it('通過点のスプラインは点の外へ膨らみうるので、押す前には断らず再計算に任せる', () => {
    const interpolate = documentWithSpline('interpolate', [[40, 40], [50, 40], [50, 50], [40, 50]]);
    const outcome = commitCutInput(profileContext([BODY, 'face-s'], interpolate), cutCommit(PROFILE_COMMIT));
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    expect(outcome.document.solids.find((feature) => feature.id === outcome.featureId))
      .toMatchObject({ kind: 'boolean', requireRemoval: true });
  });

  it('作図の許容差より近い(接するだけの)配置は押す前には断らない(削れる量 0 は再計算が断る)', () => {
    // 半径 2 の円が x = 12 で箱の面 x = 10 に接する(中心 (12, 5) で左端 x = 10)。
    const outcome = commitCutInput(profileContext([BODY, PROFILE_FACE], documentWithCircle(2, [12, 5])),
      cutCommit(PROFILE_COMMIT));
    expect(outcome.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * EX-04 W3 閉じた輪郭の切断の残す側(内側・外側・両方。UNEXECUTED until Root runs it)
 *
 * 入口は平面の切断と同じつまみ(統括の判断 2026-10-24 18:4x 1(d)): 既定は輪郭の外側を残す差(従来どおり)、
 * 「反対側を残す」で輪郭の内側を残す積、「反対側も残す(2 つに分ける)」で差と積の対(2 つ目が
 * `pairedWith` で 1 つ目を指す)。押し出しは 1 つを共有し、全てを 1 回の文書の変更で積む。
 * ------------------------------------------------------------------ */

/** 確定で積まれた段(押し出しと、ブーリアンは演算・印・結び)を並べる。 */
function addedSteps(before: PartDocument, after: PartDocument) {
  return after.solids.slice(before.solids.length).map((feature) => feature.kind === 'boolean'
    ? { kind: feature.kind, id: feature.id, operation: feature.operation, requireRemoval: feature.requireRemoval,
      pairedWith: feature.pairedWith }
    : { kind: feature.kind, id: feature.id });
}

describe('EX-04 W3 閉じた輪郭の切断で残す側を選ぶ(つまみ 2 つを無視しない)', () => {
  const cases = [
    { name: '既定(つまみなし)は外側を残す差 1 つ(従来どおり)', flags: {},
      expected: [['subtract', undefined]] },
    { name: '「反対側を残す」は内側を残す積 1 つ', flags: { cutKeepOpposite: true },
      expected: [['intersect', undefined]] },
    { name: '「反対側も残す」は外側の差と、それを指す内側の積の対', flags: { cutKeepBoth: true },
      expected: [['subtract', undefined], ['intersect', 'first']] },
    { name: '2 つとも入れると内側の積が 1 つ目、外側の差が 2 つ目の対', flags: { cutKeepOpposite: true, cutKeepBoth: true },
      expected: [['intersect', undefined], ['subtract', 'first']] },
  ] as const;

  it.each(cases)('$name', ({ flags, expected }) => {
    const before = documentWithCircle(3);
    const outcome = commitCutInput(profileContext([BODY, PROFILE_FACE], before), cutCommit({ ...PROFILE_COMMIT, flags }));
    if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
    const added = addedSteps(before, outcome.document);
    const [tool, ...booleans] = added;
    if (tool === undefined) throw new Error('押し出しが積まれていません');
    expect(tool.kind).toBe('extrude');
    expect(booleans).toHaveLength(expected.length);
    const firstId = booleans[0]?.id;
    expect(booleans.map((step) => step.kind === 'boolean'
      ? [step.operation, step.pairedWith === undefined ? undefined : step.pairedWith === firstId ? 'first' : step.pairedWith]
      : [step.kind, undefined])).toEqual(expected);
    // どのブーリアンも同じ対象と、共有する 1 つの押し出しを名指しし、何も切れなければ断る印を持つ。
    const cuts = outcome.document.solids.filter((feature): feature is BooleanFeature => feature.kind === 'boolean');
    for (const cut of cuts) {
      expect(cut).toMatchObject({ targetFeatureId: BODY, toolFeatureId: tool.id, requireRemoval: true });
    }
    // 返す id は 1 つ目(利用者が押した操作の主役。平面の切断と同じ)。
    expect(outcome.featureId).toBe(firstId);
    // 既存の段と作図には触れない(1 回の変更 = 元に戻す 1 回で消える段だけ)。
    expect(outcome.document.solids.slice(0, before.solids.length)).toEqual(before.solids);
    expect(outcome.document.sketches).toEqual(before.sketches);
  });

  it('閉じた輪郭の決め方で入力欄に出るつまみは全て効き(文書が変わるか理由つきで断る)、出る欄は 0 個', () => {
    // 入力欄はポップアップと同じ reducer で作る(決め方を「選んだ閉じた輪郭で貫く」にした状態)。
    const state = chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', PROFILE_CUT_KIND);
    expect(state.fields.map((field) => field.key)).toEqual([]);
    const keys = state.toggles.map((toggle) => toggle.key);
    expect(keys).toEqual(['cutKeepOpposite', 'cutKeepBoth', 'cutPointByCoordinate']);
    const context = profileContext([BODY, PROFILE_FACE]);
    const base = commitCutInput(context, cutCommit(PROFILE_COMMIT));
    if (!base.ok) throw new Error(`断られました: ${base.reasonKey}`);
    const effects = keys.map((key) => {
      const flags: SolidInputCommit['flags'] = key === 'cutKeepOpposite' ? { cutKeepOpposite: true }
        : key === 'cutKeepBoth' ? { cutKeepBoth: true } : { cutPointByCoordinate: true };
      const outcome = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT, flags }));
      return outcome.ok ? JSON.stringify(addedSteps(context.document, outcome.document)) : outcome.reasonKey;
    });
    // どのつまみも既定と違う結果になる(無視されるつまみ 0)。座標の点は閉じた輪郭では使えないので理由つきで断る。
    for (const effect of effects) expect(effect).not.toBe(JSON.stringify(addedSteps(context.document, base.document)));
    expect(effects[2]).toBe('cutError.coordinatePointUnused');
  });

  it('commitProfileCut の既定は従来の 1 引数の呼び方と同じ文書になる(外側・単独)', () => {
    const context = profileContext([BODY, PROFILE_FACE]);
    expect(commitProfileCut(context, 'outside', false)).toEqual(commitProfileCut(context));
  });

  it('断る入力は残す側のつまみに関わらず同じ理由で断り、文書を変えない', () => {
    for (const flags of [{ cutKeepOpposite: true }, { cutKeepBoth: true }]) {
      expect(commitCutInput(profileContext([BODY]), cutCommit({ ...PROFILE_COMMIT, flags })))
        .toEqual({ ok: false, reasonKey: 'cutError.noProfile' });
      expect(commitCutInput(profileContext([BODY, PROFILE_FACE], documentWithCircle(3, [50, 50])),
        cutCommit({ ...PROFILE_COMMIT, flags }))).toEqual({ ok: false, reasonKey: 'cutError.profileMissesTarget' });
    }
  });
});

/* 実カーネルで再計算した体積(EX-04 W3 の合格条件 1)。期待値は形だけから決める。 */

const W3_BOX = 'box-1';
const W3_FACE = 'face-w3';

/** 0〜10 の立方体(基本形状の箱は中心が基準点)。 */
function w3Box(): PrimitiveFeature {
  return {
    id: W3_BOX, name: '箱1', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(5, 5, 5) }, axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'box', sizeX: expressionValueFromNumber(10), sizeY: expressionValueFromNumber(10),
      sizeZ: expressionValueFromNumber(10) },
  };
}

type W3Curve = Parameters<typeof appendFeature>[1];

/** 作図面 XY の中心 (5, 5) の全周の円。 */
function w3Circle(radius: number): W3Curve {
  return { id: 'curve-w3', name: '円', kind: 'arc', planeId: 'xy', center: at(5, 5),
    radius: expressionValueFromNumber(radius), startAngle: ZERO_VALUE, endAngle: expressionValueFromNumber(360),
    construction: false };
}

/** 作図面 XY の中心 (5, 5)・長半径 4・短半径 2 を 30 度回した全周の楕円。 */
function w3Ellipse(): W3Curve {
  return { id: 'curve-w3', name: '楕円', kind: 'ellipse', planeId: 'xy', center: at(5, 5),
    majorRadius: expressionValueFromNumber(4), minorRadius: expressionValueFromNumber(2),
    rotation: expressionValueFromNumber(30), startAngle: ZERO_VALUE, endAngle: expressionValueFromNumber(360),
    construction: false };
}

/** 立方体と、閉じた輪郭(曲線 1 本を境界にした面)だけの文書。 */
function w3Document(curve: W3Curve): PartDocument {
  const base = createEmptyPartDocument();
  const sketch = findSketch(base, 'sketch-1');
  if (sketch === undefined) throw new Error('sketch-1 がありません');
  const withProfile = appendFeature(appendFeature(sketch, curve), { id: W3_FACE, name: '輪郭', kind: 'face',
    planeId: 'xy', boundary: [{ featureId: 'curve-w3' }], color: '#6699aa' });
  return appendSolid(replaceSketch(base, withProfile), w3Box());
}

const W3_PROFILES = [
  { profile: '円 r = 2', curve: () => w3Circle(2), area: Math.PI * 2 * 2, major: 2, minor: 2, rotation: 0 },
  { profile: '円 r = 3', curve: () => w3Circle(3), area: Math.PI * 3 * 3, major: 3, minor: 3, rotation: 0 },
  { profile: '30 度回した楕円 a = 4・b = 2', curve: () => w3Ellipse(), area: Math.PI * 4 * 2, major: 4, minor: 2, rotation: Math.PI / 6 },
];

/**
 * 残す側の 3 通り。両方を先に計算する(差と積の 2 つの形を実カーネルで作る)。外側だけ・内側だけの文書は
 * 同じ id・同じ入力の段なので鍵が同じになり、同じ計算の口では形状キャッシュの同じ形を使う
 * (対の結びは鍵に混ざらない。楕円の厳密な体積の計算を繰り返さないため)。
 */
const W3_MODES = [
  { mode: '両方', flags: { cutKeepBoth: true }, sides: ['outside', 'inside'] },
  { mode: '外側', flags: {}, sides: ['outside'] },
  { mode: '内側', flags: { cutKeepOpposite: true }, sides: ['inside'] },
] as const;

// A serial native recompute plus its independent oracle uses the existing finite functional-test allowance.
// This bounds verification work; it is not a product speed target. No cancellation deadline is changed.
const CUT_WORKFLOW_STEP_TIMEOUT_MS = 60_000;

const W3_SAVED_AT = '2026-10-25T00:00:00.000Z';

function w3ExpectRelative(actual: number | undefined, expected: number, label: string): void {
  if (actual === undefined) throw new Error(`体積がありません: ${label}`);
  expect(Math.abs(actual - expected) / Math.abs(expected), `${label}: ${String(actual)} / ${String(expected)}`)
    .toBeLessThanOrEqual(1e-9);
}

/** 画面に出る立体が、残す側のブーリアンだけで、それぞれ解析値の体積を持つことを確かめる。 */
function expectKeptSides(bodies: readonly SolidBody[], booleans: readonly BooleanFeature[],
  sides: readonly ('outside' | 'inside')[], area: number, label: string): void {
  const core = area * 10;
  // 対象の立方体と輪郭の押し出しは出ない(1 度だけ消費される = 未意図の表示 0)。
  expect(bodies.map((body) => body.featureId), label).toEqual(booleans.map((feature) => feature.id));
  expect(booleans.map((feature) => feature.operation), label)
    .toEqual(sides.map((side) => side === 'outside' ? 'subtract' : 'intersect'));
  bodies.forEach((body, index) => {
    expect(body.isValid, label).toBe(true);
    expect(body.bodyKind ?? 'solid', label).toBe('solid');
    w3ExpectRelative(body.volume, sides[index] === 'outside' ? 1000 - core : core, `${label} ${sides[index] ?? ''}`);
  });
  if (sides.length === 2) {
    w3ExpectRelative((bodies[0]?.volume ?? Number.NaN) + (bodies[1]?.volume ?? Number.NaN), 1000, `${label} 和`);
  }
}

type CutPoint = readonly [number, number, number];
type NativeCutFixture = Awaited<ReturnType<typeof createInspectableNativeKernelForNodeTests>>;

/** Analytic local coordinates, transformed by the fixture's centre/rotation; no measured input. */
function conicOraclePoints(major: number, minor: number, full = false, rotation = 0): readonly CutPoint[] {
  const local: readonly CutPoint[] = full
    ? [[major, 0, 5], [0, minor, 7], [0, 0, 2], [major / 4, minor / 4, 8],
      [0, minor + 1, 5], [-major - 0.5, 0, 3]]
    : [[0, minor, 5], [major / Math.sqrt(2), minor / Math.sqrt(2), 7],
      [0, minor / 2, 2], [major / 4, minor / 4, 8], [0, minor + 1, 5], [-4, 5, 3]];
  const c = Math.cos(rotation), s = Math.sin(rotation), cy = full ? 5 : 0;
  return [...local.map(([x, y, z]): CutPoint => [5 + c * x - s * y, cy + s * x + c * y, z]),
    [5, full ? 5 : minor / 2, 11], [-1, 1, 5]];
}

async function recomputeInspectableCut(document: PartDocument, fixture: NativeCutFixture) {
  let resolved: ResolvedPart | undefined;
  const result = await recomputePart(document, fixture.bridge, { partId: document.id,
    onResolved: value => { resolved = value; } });
  return { ...result, inspect: async (points: readonly CutPoint[]) => Promise.all(result.bodies.map(body => {
    const step = resolved?.steps.find(candidate => candidate.featureId === body.featureId);
    if (step === undefined) throw new Error(`Missing resolved cut ${body.featureId}`);
    return inspectNativeCutShape(fixture.inspectShape(step.key).readBrepBytes(), points);
  })) };
}

async function expectNativeCut(result: Awaited<ReturnType<typeof recomputeInspectableCut>>, points: readonly CutPoint[],
  inside: readonly boolean[], label: string, chord = false) {
  const measurements = await result.inspect(points);
  expect(measurements, label).toHaveLength(inside.length);
  measurements.forEach((measurement, index) => {
    const core = inside[index];
    const expected = ['ON', 'ON', core ? 'IN' : 'OUT', core ? 'IN' : 'OUT',
      core ? 'OUT' : 'IN', core ? 'OUT' : 'IN', 'OUT', 'OUT'];
    // The diameter y=0 lies on the original box, not on a shared cut wall.
    if (chord) expected.push(core ? 'ON' : 'OUT', 'OUT');
    expect(measurement.states, label).toEqual(expected);
    expect(measurement.valid, label).toBe(true);
    expect(measurement.topology.solids, label).toBe(1);
    expect(measurement.topology.faces, label).toBe(result.bodies[index].faces.length);
    expect(measurement.topology.edges, label).toBe(result.bodies[index].edges.length);
    expect(measurement.topology.vertices, label).toBe(result.bodies[index].vertices.length);
    expect(measurement.signedVolume, label).toBeGreaterThan(0);
    expect(Number.isFinite(measurement.integrationError), label).toBe(true);
    expect(measurement.integrationError, label).toBeGreaterThanOrEqual(0);
    expect(measurement.integrationError, label).toBeLessThanOrEqual(1e-12);
    w3ExpectRelative(measurement.signedVolume, result.bodies[index].volume, `${label} native signed`);
  });
  stdout.write(`EX-04 independent native ${label}: ${JSON.stringify({ points, measurements })}${String.fromCharCode(10)}`);
  return measurements;
}

async function expectCutSaveReopen(document: PartDocument, original: Awaited<ReturnType<typeof recomputeInspectableCut>>,
  points: readonly CutPoint[], inside: readonly boolean[], label: string, chord = false): Promise<void> {
  const measurements = await expectNativeCut(original, points, inside, label, chord);
  const keys = resolvePart(document).steps.map(step => step.key);
  const json = parseDocument(serializeDocument(document, { savedAt: W3_SAVED_AT }));
  if (!json.ok) throw new Error(`JSON: ${json.error.code}`);
  const pcad = readPcadFile(writePcadFile(document, { savedAt: W3_SAVED_AT }));
  if (!pcad.ok) throw new Error(`.pcad: ${pcad.error.code}`);
  for (const [format, reopened] of [['JSON', json.document], ['.pcad', pcad.document]] as const) {
    expect(reopened.solids, format).toEqual(document.solids);
    expect(reopened.sketches, format).toEqual(document.sketches);
    expect(resolvePart(reopened).steps.map(step => step.key), format).toEqual(keys);
    // A fresh cache forces the reopened definition through native computation again.
    const fixture = await createInspectableNativeKernelForNodeTests();
    try {
      const restored = await recomputeInspectableCut(reopened, fixture);
      expect(restored.errors, format).toEqual([]);
      expect(restored.bodies.map(body => [body.featureId, body.volume, body.isValid]), format)
        .toEqual(original.bodies.map(body => [body.featureId, body.volume, body.isValid]));
      const after = await expectNativeCut(restored, points, inside, `${label} ${format}`, chord);
      after.forEach((measurement, index) => {
        expect(measurement.topology, format).toEqual(measurements[index].topology);
        expect(measurement.states, format).toEqual(measurements[index].states);
        w3ExpectRelative(measurement.signedVolume, measurements[index].signedVolume, `${format} signed volume`);
      });
    } finally { fixture.dispose(); }
  }
}

describe('EX-04 W3 残す側の体積が解析値と相対 1e-9 で一致し、有効な立体が 1 個・2 個できる(実カーネル)', () => {
  beforeAll(async () => {
    await initializeNativeKernelForNodeTests();
  }, 180_000);

  /*
   * 1 つの輪郭ごとに: 両方 → 保存・読み直し(JSON と .pcad)→ 外側だけ → 内側だけ。どれも UI の確定
   * (`commitCutInput`)で積み、実カーネルで再計算する。保存・読み直しは定義・作図・鍵が同じことと、
   * 読み直した文書の再計算が同じ立体・同じ体積になることを確かめる。
   */
  it.each(W3_PROFILES)('$profile: 両方は 2 個・外側と内側は各 1 個の有効な立体、保存・読み直しでも同じ', async ({ curve, area, profile, major, minor, rotation }) => {
    const fixture = await createInspectableNativeKernelForNodeTests(), { bridge } = fixture;
    const points = conicOraclePoints(major, minor, true, rotation);
    const document = w3Document(curve());
    try {
      const before = await recomputePart(document, bridge, { partId: document.id });
      expect(before.errors).toEqual([]);
      w3ExpectRelative(before.bodies.find((body) => body.featureId === W3_BOX)?.volume, 1000, '切る前');
      const context: CutContext = { document, bodies: subShapeBodiesOf(before.bodies), selection: [W3_BOX, W3_FACE] };
      for (const { mode, flags, sides } of W3_MODES) {
        const label = `${profile}・${mode}`;
        const outcome = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT, flags }));
        if (!outcome.ok) throw new Error(`${label}: 断られました: ${outcome.reasonKey}`);
        const booleans = outcome.document.solids.filter((feature): feature is BooleanFeature => feature.kind === 'boolean');
        const after = await recomputeInspectableCut(outcome.document, fixture);
        // 実測の記録(最終報告の幾何の表の原票)。期待値は形だけから決めた解析値。
        stdout.write(`EX-04 W3 体積 ${label}: ${JSON.stringify(after.bodies.map((body, index) => {
          const expected = sides[index] === 'outside' ? 1000 - area * 10 : area * 10;
          return { featureId: body.featureId, volume: body.volume, expected, isValid: body.isValid,
            relativeError: Math.abs(body.volume - expected) / expected };
        }))}${String.fromCharCode(10)}`);
        expect(after.errors, label).toEqual([]);
        expectKeptSides(after.bodies, booleans, sides, area, label);
        if (sides.length === 2) {
          await expectCutSaveReopen(outcome.document, after, points, sides.map(side => side === 'inside'), label);
        } else {
          await expectNativeCut(after, points, sides.map(side => side === 'inside'), label);
        }
      }
    } finally {
      fixture.dispose();
    }
  }, 300_000);
});

/* 元に戻す 1 回で全結果(両方の 2 個を含む)が戻る(EX-04 W3 の合格条件 3)。ストアの確定の道筋で確かめる。 */

describe('EX-04 W3 閉じた輪郭の切断は元に戻す 1 回で全結果が戻る(ストア)', () => {
  beforeEach(resetTestStore);
  beforeAll(initializeNativeKernelForNodeTests, 180_000);

  it.each([
    ['外側', {}, ['extrude', 'subtract']],
    ['内側', { cutKeepOpposite: true }, ['extrude', 'intersect']],
    ['両方', { cutKeepBoth: true }, ['extrude', 'subtract', 'intersect']],
  ] as const)('%s: 確定は 1 段、元に戻す 1 回で全て消え、やり直しで全て戻る', async (_mode, flags, expected) => {
    const before = w3Document(w3Circle(3));
    const bridge = createNativeKernelBridgeForNodeTests();
    useAppStore.getState().applyDocument(before);
    const detach = attachPartRecompute((document, options) => recomputePart(document, bridge, options));
    try {
      await vi.waitFor(() => {
        const state = useAppStore.getState();
        expect(state.isComputing).toBe(false);
        expect(state.lastOutcome).toBe('success');
        expect(state.completedGeneration).toBe(state.requestedGeneration);
      }, { timeout: 60_000 });
      useAppStore.getState().setSelection([W3_BOX, W3_FACE]);
      let input = chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', 'profile');
      if ('cutKeepOpposite' in flags && flags.cutKeepOpposite) input = toggleNumericInput(input, 'cutKeepOpposite');
      if ('cutKeepBoth' in flags && flags.cutKeepBoth) input = toggleNumericInput(input, 'cutKeepBoth');
      useAppStore.getState().updateNumericInput(input);
      const opened = useAppStore.getState();
      const pastBefore = opened.undoStack.past.length;
      expect(applySolidCommit(cutCommit({ ...PROFILE_COMMIT, flags }))).toBe(false);
      expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().undoStack).toBe(opened.undoStack);
      await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 60_000 });
      const committed = useAppStore.getState();
      const after = committed.document;
      expect(committed.undoStack.past).toHaveLength(pastBefore + 1);
      expect(addedSteps(before, after).map((step) => step.kind === 'boolean' ? step.operation : step.kind)).toEqual(expected);
      expect(committed.bodies).toHaveLength(expected.length - 1);
      expect(committed.bodies.every(body => body.isValid)).toBe(true);
      committed.undo();
      expect(useAppStore.getState().document).toBe(before);
      expect(useAppStore.getState().undoStack.past).toHaveLength(pastBefore);
      useAppStore.getState().redo();
      expect(useAppStore.getState().document).toBe(after);
    } finally { detach(); bridge.dispose(); }
  }, 90_000);
});

function openConicDocument(kind: 'arc' | 'ellipse', reverse = false, full = false): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  const common = { id: 'open-blade', name: '刃', planeId: 'xy', center: at(5, 0), construction: false,
    startAngle: expressionValueFromNumber(reverse ? 180 : 0), endAngle: expressionValueFromNumber(full ? 360 : reverse ? 0 : 180) };
  const curve: W3Curve = kind === 'arc' ? { ...common, kind, radius: expressionValueFromNumber(3) }
    : { ...common, kind, majorRadius: expressionValueFromNumber(4), minorRadius: expressionValueFromNumber(2), rotation: ZERO_VALUE };
  return appendSolid(replaceSketch(document, appendFeature(sketch, curve)), w3Box());
}

function openConicContext(document: PartDocument): CutContext {
  return { document, bodies: [{ ...cubeBody(), featureId: W3_BOX }], selection: [W3_BOX, 'open-blade'],
    resolvedSketches: { document, sketches: resolvePart(document).sketches } };
}

describe('EX-04.02 開いた刃の選択は現在の作図と計算結果だけを使う', () => {
  it('参照を保存し、反対側の対を1回の候補へまとめ、入力と元の参照を変えない', () => {
    const document = openConicDocument('arc'), context = openConicContext(document);
    const serialized = serializeDocument(document, { savedAt: W3_SAVED_AT }), selection = [...context.selection];
    const outcome = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT, flags: { cutKeepBoth: true } }));
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    const cuts = outcome.document.solids.filter(feature => feature.kind === 'surfaceCut');
    expect(cuts).toHaveLength(2);
    expect(cuts.map(feature => feature.keep)).toEqual(['positive', 'negative']);
    expect(cuts[1].pairedWith).toBe(cuts[0].id);
    expect(cuts[0].blade).toEqual({ kind: 'extrusion', profile: { sketchId: document.activeSketchId, curveIds: ['open-blade'] } });
    expect(outcome.document.sketches).toBe(document.sketches);
    expect(serializeDocument(document, { savedAt: W3_SAVED_AT })).toBe(serialized);
    expect(context.selection).toEqual(selection);
  });

  it('欠落・旧計算・別作図・混在・全周・不連続の選択を候補採用前に断る', () => {
    const document = openConicDocument('arc'), context = openConicContext(document);
    expect(commitCutInput({ ...context, resolvedSketches: undefined }, cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeNotCurrent' });
    expect(commitCutInput({ ...context, selection: [W3_BOX, 'missing'] }, cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeSelectionAmbiguous' });
    const changed = { ...document, solids: [w3Box(), { ...w3Box(), id: 'other-box' }] };
    expect(commitCutInput({ ...context, document: changed }, cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeNotCurrent' });
    const sketch = document.sketches[0];
    const otherSketch = { ...sketch, id: 'other-sketch' };
    const ambiguous = { ...document, sketches: [...document.sketches, otherSketch] };
    expect(commitCutInput(openConicContext(ambiguous), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeSelectionAmbiguous' });
    const onlyOther = { ...document, activeSketchId: otherSketch.id, sketches: [sketch, { ...otherSketch, features: [] }] };
    expect(commitCutInput(openConicContext(onlyOther), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeSelectionAmbiguous' });
    const closed = w3Document(w3Circle(3));
    expect(commitCutInput({ ...openConicContext(closed), selection: [W3_BOX, W3_FACE, 'curve-w3'] }, cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeSelectionAmbiguous' });
    expect(commitCutInput(openConicContext(openConicDocument('ellipse', false, true)), cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeMustBeOpen' });
    const original = sketch.features[0];
    const disconnected = replaceSketch(document, appendFeature(sketch, { ...original, id: 'separate-blade' }));
    expect(commitCutInput({ ...openConicContext(disconnected), selection: [W3_BOX, 'open-blade', 'separate-blade'] }, cutCommit(PROFILE_COMMIT)))
      .toEqual({ ok: false, reasonKey: 'cutError.bladeDisconnected' });
  });
});

describe('EX-04.02 実callerから開いた円弧・楕円弧を切り、保存と方向を解析値で照合する', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);
  it.each(['arc', 'ellipse'] as const)('%s: 片側・両側・反転と保存再開', async kind => {
    const fixture = await createInspectableNativeKernelForNodeTests(), { bridge } = fixture;
    const inside = (kind === 'arc' ? 45 : 40) * Math.PI;
    const points = conicOraclePoints(kind === 'arc' ? 3 : 4, kind === 'arc' ? 3 : 2);
    try {
      for (const reverse of [false, true]) {
        const document = openConicDocument(kind, reverse), baseline = await recomputePart(document, bridge, { partId: document.id });
        expect(baseline.errors).toEqual([]);
        const context: CutContext = { document, bodies: subShapeBodiesOf(baseline.bodies), selection: [W3_BOX, 'open-blade'],
          resolvedSketches: { document, sketches: baseline.sketches } };
        const before = serializeDocument(document, { savedAt: W3_SAVED_AT });
        for (const flags of [{ cutKeepBoth: true }, {}, { cutKeepOpposite: true }]) {
          const outcome = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT, flags }));
          if (!outcome.ok) throw new Error(outcome.reasonKey);
          const result = await recomputeInspectableCut(outcome.document, fixture);
          expect(result.errors).toEqual([]);
          const cuts = outcome.document.solids.filter(feature => feature.kind === 'surfaceCut');
          const expectedKeeps = 'cutKeepBoth' in flags && flags.cutKeepBoth ? ['positive', 'negative']
            : ['cutKeepOpposite' in flags && flags.cutKeepOpposite ? 'negative' : 'positive'];
          expect(cuts.map(cut => cut.keep)).toEqual(expectedKeeps);
          const keptInside = expectedKeeps.map(keep => (keep === 'negative') !== reverse);
          expect(result.bodies.map(body => body.featureId)).toEqual(cuts.map(feature => feature.id));
          for (const [index, body] of result.bodies.entries()) {
            const negative = cuts[index].keep === 'negative';
            w3ExpectRelative(body.volume, negative !== reverse ? inside : 1000 - inside, '開いた刃');
            expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('solid');
          }
          if (result.bodies.length === 2) {
            w3ExpectRelative(result.bodies.reduce((sum, body) => sum + (body.volume ?? 0), 0), 1000, '両側の和');
            await expectCutSaveReopen(outcome.document, result, points,
              keptInside, `${kind} reverse=${String(reverse)}`);
          } else {
            await expectNativeCut(result, points, keptInside, kind);
          }
        }
        expect(serializeDocument(document, { savedAt: W3_SAVED_AT })).toBe(before);
      }
    } finally { fixture.dispose(); }
  }, 180_000);

  it.each([
    { kind: 'arc', keepInside: false, inside: 45 * Math.PI, from: 2, to: 8 },
    { kind: 'arc', keepInside: true, inside: 45 * Math.PI, from: 2, to: 8 },
    { kind: 'ellipse', keepInside: false, inside: 40 * Math.PI, from: 1, to: 9 },
    { kind: 'ellipse', keepInside: true, inside: 40 * Math.PI, from: 1, to: 9 },
  ] as const)('閉じた半円・半楕円＋閉じ線: $kind / inside=$keepInside は独立体積と一致する', async ({ kind, keepInside, inside, from, to }) => {
    const fixture = await createInspectableNativeKernelForNodeTests(), { bridge } = fixture;
    const base = openConicDocument(kind);
    const points: readonly CutPoint[] = [...conicOraclePoints(kind === 'arc' ? 3 : 4, kind === 'arc' ? 3 : 2),
      [5, 0, 5], [5, -1, 5]];
    const sketch = base.sketches[0];
    const closed = appendFeature(appendFeature(sketch, line('diameter', [from, 0], [to, 0])), {
      id: W3_FACE, name: '半円', kind: 'face', planeId: 'xy', color: '#6699aa',
      boundary: [{ featureId: 'open-blade' }, { featureId: 'diameter' }],
    });
    const document = replaceSketch(base, closed);
    try {
      const before = await recomputePart(document, bridge, { partId: document.id });
      const context: CutContext = { document, bodies: subShapeBodiesOf(before.bodies), selection: [W3_BOX, W3_FACE] };
      const outcome = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT, flags: { cutKeepOpposite: keepInside } }));
      if (!outcome.ok) throw new Error(outcome.reasonKey);
      expect(outcome.document.solids.at(-1)?.kind).toBe('boolean');
      const result = await recomputeInspectableCut(outcome.document, fixture);
      expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1); expect(result.bodies[0].isValid).toBe(true);
      w3ExpectRelative(result.bodies[0].volume, keepInside ? inside : 1000 - inside, '閉じた部分弧＋閉じ線');
      await expectNativeCut(result, points, [keepInside], `closed ${kind} inside=${String(keepInside)}`, true);
      if (!keepInside) {
        const paired = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT, flags: { cutKeepBoth: true } }));
        if (!paired.ok) throw new Error(paired.reasonKey);
        const both = await recomputeInspectableCut(paired.document, fixture);
        expect(both.errors).toEqual([]);
        expect(both.bodies).toHaveLength(2);
        const cuts = paired.document.solids.filter((feature): feature is BooleanFeature => feature.kind === 'boolean');
        expectKeptSides(both.bodies, cuts, ['outside', 'inside'], inside / 10, `closed ${kind} both`);
        await expectCutSaveReopen(paired.document, both, points, [false, true], `closed ${kind} both`, true);
      }
    } finally { fixture.dispose(); }
  // Baseline, single side, both sides, fresh JSON, fresh PCAD: five serial native passes, unchanged.
  }, 5 * CUT_WORKFLOW_STEP_TIMEOUT_MS);
});

describe('EX-04.03 数式面・閉輪郭の独立体積と式編集後の別セッション位相', () => {
  let backend: ReturnType<typeof createMathBackend>;
  beforeAll(async () => { backend = createMathBackend(); await initializeNativeKernelForNodeTests(); }, 180_000);
  const value = expressionValueFromNumber;
  function surfaceDefinition(constant: number) {
    return { format: 'pointercad-function/1' as const,
      bounds: { X: { min: value(-1), max: value(11) }, Y: { min: value(-1), max: value(11) },
        Z: { min: value(-1), max: value(11) } }, tolerance: value(0.01),
      formula: { kind: 'coordinate-surface' as const, output: 'Z' as const,
        expression: createFunctionMathSource(`${constant}+0.01*X*Y`, 'text', 'radian',
          { axes: ['X', 'Y'], parameters: [], coefficients: [] }, backend) } };
  }
  function profileDefinition(constant: number) {
    const source = (text: string) => createFunctionMathSource(text, 'text', 'radian',
      { axes: ['X'], parameters: [], coefficients: [] }, backend);
    return { format: 'pointercad-function/1' as const,
      bounds: { X: { min: value(0), max: value(10) }, Y: { min: value(0), max: value(12) },
        Z: { min: value(-1), max: value(3) } }, tolerance: value(0.001),
      formula: { kind: 'coordinate-curve' as const, independent: 'X' as const,
        outputs: { Y: source(`X^2/10+${constant}`), Z: source('0') } } };
  }
  function profileLines(constant: number) {
    return [line('formula-right', [10, 10 + constant], [10, 0]), line('formula-bottom', [10, 0], [0, 0]),
      line('formula-left', [0, 0], [0, constant])];
  }
  function documentFor(kind: 'surface' | 'profile', constant: number): PartDocument {
    const document = appendSolid(createEmptyPartDocument(), kind === 'surface' ? w3Box() : {
      ...w3Box(), origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 5) },
      shape: { kind: 'box', sizeX: value(40), sizeY: value(30), sizeZ: value(10) },
    });
    if (kind === 'surface') return appendSolid(document, createFunctionSurface(document, surfaceDefinition(constant)));
    const sketch = document.sketches[0], curve = createFunctionCurve(sketch, profileDefinition(constant));
    let closed = appendFeature(sketch, curve);
    for (const segment of profileLines(constant)) closed = appendFeature(closed, segment);
    closed = appendFeature(closed, { id: 'formula-face', name: '式の輪郭', kind: 'face', planeId: 'xy', color: '#6699aa',
      boundary: [curve.id, 'formula-right', 'formula-bottom', 'formula-left'].map(featureId => ({ featureId })) });
    return replaceSketch(document, closed);
  }
  function editFormula(document: PartDocument, kind: 'surface' | 'profile', constant: number): PartDocument {
    if (kind === 'surface') return { ...document, solids: document.solids.map(feature => feature.kind === 'functionSurface'
      ? { ...feature, definition: surfaceDefinition(constant) } : feature) };
    const replacements = profileLines(constant);
    return { ...document, sketches: document.sketches.map(sketch => ({ ...sketch, features: sketch.features.map(feature =>
      feature.kind === 'functionCurve' ? { ...feature, definition: profileDefinition(constant) }
        : replacements.find(line => line.id === feature.id) ?? feature) })) };
  }
  class SurfacePort implements MathWorkerPort {
    onmessage: MathWorkerPort['onmessage'] = null;
    onerror: MathWorkerPort['onerror'] = null;
    onmessageerror: MathWorkerPort['onmessageerror'] = null;
    postMessage(input: unknown): void {
      queueMicrotask(() => this.onmessage?.({ data: executeFunctionSurfaceWorkRequest(input, backend) }));
    }
    terminate(): void { this.onmessage = null; }
  }
  function options(document: PartDocument, revision: number, surfaces: FunctionSurfaceWorkerClient): PartRecomputeOptions {
    return { generation: revision, math: { identity: { documentId: document.id, documentVersion: revision }, isCurrent: () => true,
      client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
          { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)),
            declaredIds: new Set() }).result }) } }, functions: {
      curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) }, surfaces } };
  }
  // Match the application cache lifetime; reopened native sessions always start with an empty plan cache.
  const surfacePlans = new WeakMap<NativeCutFixture, FunctionSurfacePlanCache>();
  async function compute(document: PartDocument, fixture: NativeCutFixture, revision: number, surfaces: FunctionSurfaceWorkerClient) {
    const started = performance.now();
    let plans = surfacePlans.get(fixture);
    if (plans === undefined) { plans = new FunctionSurfacePlanCache(); surfacePlans.set(fixture, plans); }
    const evaluated = options(document, revision, surfaces);
    if (evaluated.functions === undefined) throw new Error('Missing formula evaluators');
    let resolved: ResolvedPart | undefined;
    const result = await recomputePart(document, fixture.bridge, { ...evaluated,
      functions: { ...evaluated.functions, surfacePlans: plans }, partId: document.id,
      onResolved: current => { resolved = current; } });
    // The authored finite blade remains a shell. Only cut solids enter volume/topology assertions.
    stdout.write(`EX-04.03 timing compute revision=${revision} features=${document.solids.length}: ${performance.now() - started}ms${String.fromCharCode(10)}`);
    const bodies = result.bodies.filter(body => body.bodyKind === 'solid');
    return { ...result, bodies, allBodies: result.bodies, keys: resolved?.steps.map(step => [step.featureId, step.key]) ?? [],
      inspect: (points: readonly CutPoint[]) => Promise.all(bodies.map(body => {
        const step = resolved?.steps.find(candidate => candidate.featureId === body.featureId);
        if (step === undefined) throw new Error(`Missing formula shape ${body.featureId}`);
        return inspectNativeCutShape(fixture.inspectShape(step.key).readBrepBytes(), points);
      })) };
  }
  function pointsFor(kind: 'surface' | 'profile', constant: number): readonly CutPoint[] {
    return kind === 'surface'
      ? [[2, 3, constant + 0.06], [8, 7, constant + 0.56], [2, 3, constant - 0.44], [8, 7, constant + 0.06],
        [2, 3, constant + 0.56], [8, 7, constant + 1.06], [11, 5, 5], [5, 5, 11]]
      // An exact closing wall and the analytic endpoint are ON; no approximate curve midpoint is claimed exact.
      : [[10, 2, 5], [10, 10 + constant, 7], [5, 1, 2], [8, 2, 8], [5, 10, 5], [20, 15, 3], [-1, 2, 5], [5, 5, 11]];
  }
  async function check(result: Awaited<ReturnType<typeof compute>>, kind: 'surface' | 'profile', constant: number,
    inside: readonly boolean[], label: string) {
    expect(result.errors, label).toEqual([]); expect(result.cancelled, label).toBe(false);
    expect(result.bodies, label).toHaveLength(inside.length);
    const started = performance.now();
    const points = pointsFor(kind, constant), measurements = await result.inspect(points);
    stdout.write(`EX-04.03 timing inspect ${label}: ${performance.now() - started}ms${String.fromCharCode(10)}`);
    const total = kind === 'surface' ? 1000 : 12000;
    const core = kind === 'surface' ? 100 * constant + 25 : 10 * (100 / 3 + 10 * constant);
    measurements.forEach((measurement, index) => {
      const low = inside[index], body = result.bodies[index], expected = low ? core : total - core;
      expect(measurement.states, label).toEqual(['ON', 'ON', low ? 'IN' : 'OUT', low ? 'IN' : 'OUT',
        low ? 'OUT' : 'IN', low ? 'OUT' : 'IN', 'OUT', 'OUT']);
      expect(body.isValid, label).toBe(true); expect(body.bodyKind, label).toBe('solid');
      expect(body.volume, label).toBeGreaterThan(0); expect(measurement.valid, label).toBe(true);
      expect(measurement.signedVolume, label).toBeGreaterThan(0); expect(measurement.topology.solids, label).toBe(1);
      expect([measurement.topology.faces, measurement.topology.edges, measurement.topology.vertices], label)
        .toEqual([body.faces.length, body.edges.length, body.vertices.length]);
      expect(Number.isFinite(measurement.integrationError), label).toBe(true);
      expect(measurement.integrationError, label).toBeGreaterThanOrEqual(0);
      expect(measurement.integrationError, label).toBeLessThanOrEqual(1e-12);
      w3ExpectRelative(measurement.signedVolume, body.volume, `${label} native/body`);
      if (kind === 'surface') {
        w3ExpectRelative(body.volume, expected, label); w3ExpectRelative(measurement.signedVolume, expected, label);
      } else {
        // Preserve the existing formula-profile acceptance; this is not an analytic relative 1e-9 assertion.
        expect(Math.abs(body.volume - expected), label).toBeLessThan(0.1);
        expect(Math.abs(measurement.signedVolume - expected), label).toBeLessThan(0.1);
      }
    });
    if (inside.length === 2) w3ExpectRelative(result.bodies.reduce((sum, body) => sum + body.volume, 0), total, `${label} sum`);
    stdout.write(`EX-04.03 formula ${label}: ${JSON.stringify({ kind, constant, points, measurements,
      analyticCore: core, analyticAcceptance: kind === 'surface' ? { relative: 1e-9 } : { absoluteMm3: 0.1 },
      // A radius-delta tube of the analytic arc: H*(2*L*delta+pi*delta^2), L<=10*sqrt(5).
      // This conservative bound is separate from the stricter existing empirical 0.1 mm3 guard.
      profileGeometricBudgetMm3: kind === 'profile' ? 10 * (2 * 10 * Math.sqrt(5) * 0.001 + Math.PI * 0.001 ** 2) : 0 })}${String.fromCharCode(10)}`);
    return measurements;
  }

  it('数式面の複数刃・混合選択・古い評価・抑制・無効bodyを文書不変で断る', async () => {
    const fixture = await createInspectableNativeKernelForNodeTests(), surfaces = new FunctionSurfaceWorkerClient({ createWorker: () => new SurfacePort() });
    const document = documentFor('surface', 2);
    try {
      const baseline = await compute(document, fixture, 1, surfaces);
      expect(baseline.errors).toEqual([]);
      const blade = document.solids.find(feature => feature.kind === 'functionSurface');
      if (blade === undefined) throw new Error('Missing formula blade');
      const context: CutContext = { document, bodies: subShapeBodiesOf(baseline.allBodies), selection: [W3_BOX, blade.id],
        resolvedSketches: { document, sketches: baseline.sketches } };
      expect(cutTargetOf(context)).toBe(W3_BOX);
      expect(cutToolReadiness(context)).toEqual({ ready: true, reasonKey: null });
      const duplicate = appendSolid(document, { ...blade, id: 'second-formula-blade' });
      const cases: readonly (readonly [CutContext, string])[] = [
        [{ ...context, selection: [W3_BOX, blade.id, blade.id] }, 'cutError.bladeSelectionAmbiguous'],
        [{ ...context, document: duplicate, selection: [W3_BOX, blade.id, 'second-formula-blade'] }, 'cutError.bladeSelectionAmbiguous'],
        [{ ...context, selection: [W3_BOX, blade.id, 'formula-face'] }, 'cutError.bladeSelectionAmbiguous'],
        [{ ...context, resolvedSketches: undefined }, 'cutError.bladeNotCurrent'],
        [{ ...context, document: editFormula(document, 'surface', 3) }, 'cutError.bladeNotCurrent'],
        [{ ...context, document: { ...document, solids: document.solids.map(feature => feature.id === blade.id
          ? { ...feature, suppressed: true } : feature) } }, 'cutError.bladeNotCurrent'],
        [{ ...context, bodies: context.bodies.map(body => body.featureId === blade.id ? { ...body, isValid: false } : body) }, 'cutError.bladeNotCurrent'],
        [{ ...context, bodies: context.bodies.filter(body => body.featureId !== blade.id) }, 'cutError.bladeNotCurrent'],
      ];
      for (const [current, reasonKey] of cases) {
        const before = serializeDocument(current.document, { savedAt: W3_SAVED_AT });
        expect(commitCutInput(current, cutCommit(PROFILE_COMMIT))).toEqual({ ok: false, reasonKey });
        expect(serializeDocument(current.document, { savedAt: W3_SAVED_AT })).toBe(before);
      }
    } finally { surfaces.dispose(); fixture.dispose(); }
  }, 60_000);

  function geometryOf(bodies: readonly SolidBody[]) {
    return bodies.map(body => ({ featureId: body.featureId, volume: body.volume, bodyKind: body.bodyKind,
      isValid: body.isValid, coordinateFrame: body.coordinateFrame,
      positions: Array.from(body.mesh.positions), normals: Array.from(body.mesh.normals),
      indices: Array.from(body.mesh.indices), edgePositions: Array.from(body.mesh.edgePositions),
      triangleCount: body.mesh.triangleCount, faces: body.faces, edges: body.edges, vertices: body.vertices }));
  }
  async function settledAfter(generation: number) {
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      expect(state.requestedGeneration).toBeGreaterThan(generation);
      expect(state.isComputing).toBe(false); expect(state.lastOutcome).toBe('success');
      expect(state.completedGeneration).toBe(state.requestedGeneration);
    }, { timeout: 60_000 });
  }

  it.each([
    { outcome: 'success', keepBoth: false }, { outcome: 'success', keepBoth: true },
    { outcome: 'cancelled', keepBoth: true }, { outcome: 'incomplete-cut', keepBoth: true },
  ] as const)('数式面の公開確定 $outcome (both=$keepBoth): 実形状Undo/Redo・取消/途中停止は履歴不変', async ({ outcome, keepBoth }) => {
    resetTestStore();
    const fixture = await createInspectableNativeKernelForNodeTests(), surfaces = new FunctionSurfaceWorkerClient({ createWorker: () => new SurfacePort() });
    const full = documentFor('surface', 2);
    const document = outcome !== 'incomplete-cut' ? full : { ...full, solids: full.solids.map(feature => feature.kind === 'functionSurface'
      ? { ...feature, definition: { ...feature.definition, bounds: { ...feature.definition.bounds,
        X: { min: value(-1), max: value(5) } } } } : feature) };
    let release: (() => void) | undefined, started = false, finished = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    useAppStore.getState().applyDocument(document);
    const detach = attachPartRecompute(async (current, attached) => {
      if (outcome === 'cancelled' && current.solids.some(feature => feature.kind === 'surfaceCut')) {
        started = true; await barrier;
      }
      try {
        return await recomputePart(current, fixture.bridge, { ...options(current, attached.generation ?? 1, surfaces), ...attached });
      } finally { if (started) finished = true; }
    });
    try {
      await vi.waitFor(() => {
        const state = useAppStore.getState();
        expect(state.isComputing).toBe(false); expect(state.lastOutcome).toBe('success');
        expect(state.completedGeneration).toBe(state.requestedGeneration);
      }, { timeout: 60_000 });
      const blade = document.solids.find(feature => feature.kind === 'functionSurface');
      if (blade === undefined) throw new Error('Missing formula blade');
      useAppStore.getState().setSelection([W3_BOX, blade.id]);
      const baseInput = chooseNumericInput(createNumericInput('cut', 'cutPlane'), 'cutPlaneKind', PROFILE_CUT_KIND);
      const input = keepBoth ? toggleNumericInput(baseInput, 'cutKeepBoth') : baseInput;
      useAppStore.getState().updateNumericInput(input);
      const before = useAppStore.getState(), saved = serializeDocument(document, { savedAt: W3_SAVED_AT });
      const geometry = geometryOf(before.bodies);
      expect(applySolidCommit(cutCommit({ ...PROFILE_COMMIT, flags: { cutKeepBoth: keepBoth } }))).toBe(false);
      expect(useAppStore.getState().document).toBe(document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      if (outcome === 'cancelled') {
        await vi.waitUntil(() => started, { timeout: 60_000 });
        useAppStore.getState().cancelRecompute(); release?.();
        await vi.waitUntil(() => finished, { timeout: 60_000 });
        expect(useAppStore.getState().stagedSolid?.status).not.toBe('pending');
      } else if (outcome === 'incomplete-cut') {
        await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); }, { timeout: 60_000 });
        const failed = useAppStore.getState().stagedSolid;
        expect(failed?.status).toBe('failed');
        expect(failed?.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'kernelFailed', reason: 'incomplete-cut' })]));
      } else {
        await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 60_000 });
        const state = useAppStore.getState(), after = state.document;
        expect(state.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
        expect(after.solids.slice(document.solids.length)).toEqual([
          expect.objectContaining({ kind: 'surfaceCut', targetFeatureId: W3_BOX,
            blade: { kind: 'surface', surfaceFeatureId: blade.id }, keep: 'positive', pairedWith: null }),
          expect.objectContaining({ kind: 'surfaceCut', targetFeatureId: W3_BOX,
            blade: { kind: 'surface', surfaceFeatureId: blade.id }, keep: 'negative', pairedWith: after.solids[document.solids.length].id }),
        ].slice(0, keepBoth ? 2 : 1));
        expect(state.undoStack.present).toBe(after); expect(state.undoStack.future).toEqual([]);
        const afterGeometry = geometryOf(state.bodies), afterIds = state.bodies.map(body => body.featureId);
        const result = await compute(after, fixture, 2, surfaces);
        await check(result, 'surface', 2, keepBoth ? [false, true] : [false], 'public stage');
        const beforeUndoGeneration = useAppStore.getState().requestedGeneration;
        state.undo();
        await settledAfter(beforeUndoGeneration);
        const undone = useAppStore.getState();
        expect(undone.document).toBe(document); expect(undone.undoStack.present).toBe(document);
        expect(undone.undoStack.past).toEqual(before.undoStack.past);
        expect(undone.undoStack.future).toEqual([after]);
        expect(undone.bodies.map(body => body.featureId)).toEqual(before.bodies.map(body => body.featureId));
        expect(geometryOf(undone.bodies)).toEqual(geometry);
        const beforeRedoGeneration = undone.requestedGeneration;
        undone.redo();
        await settledAfter(beforeRedoGeneration);
        const redone = useAppStore.getState();
        expect(redone.document).toBe(after); expect(redone.undoStack.present).toBe(after);
        expect(redone.undoStack.past).toEqual(state.undoStack.past); expect(redone.undoStack.future).toEqual([]);
        expect(redone.bodies.map(body => body.featureId)).toEqual(afterIds);
        expect(geometryOf(redone.bodies)).toEqual(afterGeometry);
        const redoneVolumes = redone.bodies.filter(body => body.bodyKind === 'solid').map(body => body.volume);
        expect(redoneVolumes).toHaveLength(keepBoth ? 2 : 1);
        redoneVolumes.forEach((volume, index) => { expect(volume).toBeCloseTo([775, 225][index], 8); });
      }
      if (outcome !== 'success') {
        const state = useAppStore.getState();
        expect(state.document).toBe(document); expect(state.undoStack).toBe(before.undoStack);
        expect(state.numericInput).toBe(input); expect(state.selection).toEqual(before.selection);
        expect(geometryOf(state.bodies)).toEqual(geometry);
      }
      expect(serializeDocument(document, { savedAt: W3_SAVED_AT })).toBe(saved);
    } finally {
      detach(); release?.();
      if (started && !finished) await vi.waitUntil(() => finished, { timeout: 60_000 });
      surfaces.dispose(); fixture.dispose();
    }
  }, 90_000);

  it.each(['surface', 'profile'] as const)('%s: 両側/片側・式編集・独立分類とJSON/PCAD別セッション再開', async kind => {
    const fixture = await createInspectableNativeKernelForNodeTests(), surfaces = new FunctionSurfaceWorkerClient({ createWorker: () => new SurfacePort() });
    const constant = kind === 'surface' ? 2 : 1, document = documentFor(kind, constant);
    try {
      const baseline = await compute(document, fixture, 1, surfaces);
      expect(baseline.errors).toEqual([]);
      const bladeId = kind === 'surface' ? document.solids.find(feature => feature.kind === 'functionSurface')?.id : 'formula-face';
      if (bladeId === undefined) throw new Error('Missing formula blade');
      const context: CutContext = { document, bodies: subShapeBodiesOf(baseline.allBodies), selection: [W3_BOX, bladeId],
        resolvedSketches: { document, sketches: baseline.sketches } };
      for (const mode of ['both', 'outside', 'inside'] as const) {
        const kept = mode === 'both' ? [false, true] : [mode === 'inside'];
        const outcome = commitCutInput(context, cutCommit({ ...PROFILE_COMMIT,
          flags: { cutKeepBoth: mode === 'both', cutKeepOpposite: mode === 'inside' } }));
        if (!outcome.ok) throw new Error(outcome.reasonKey);
        const authored = outcome.document;
        let originalKeys: readonly (readonly string[])[] | undefined;
        for (const revision of [1, 2]) {
          const current = revision === 1 ? authored : editFormula(authored, kind, constant + 1);
          const currentConstant = constant + revision - 1, label = `${kind}/${mode}/revision=${revision}`;
          const result = await compute(current, fixture, revision, surfaces);
          const cutIds = current.solids.filter(feature => feature.kind === 'surfaceCut' || feature.kind === 'boolean').map(feature => feature.id);
          expect(result.bodies.map(body => body.featureId), label).toEqual(cutIds);
          const keys = result.keys.filter(entry => cutIds.includes(entry[0]));
          if (revision === 1) originalKeys = keys;
          else { expect(current.solids.filter(feature => feature.kind === 'surfaceCut' || feature.kind === 'boolean'))
            .toEqual(authored.solids.filter(feature => feature.kind === 'surfaceCut' || feature.kind === 'boolean'));
            expect(keys, label).not.toEqual(originalKeys); }
          const measurements = await check(result, kind, currentConstant, kept, label);
          if (mode !== 'both') continue;
          const json = parseDocument(serializeDocument(current, { savedAt: W3_SAVED_AT }));
          const pcad = readPcadFile(writePcadFile(current, { savedAt: W3_SAVED_AT }));
          if (!json.ok || !pcad.ok) throw new Error('Formula save did not reopen');
          for (const [format, reopened] of [['JSON', json.document], ['PCAD', pcad.document]] as const) {
            expect(reopened.sketches).toEqual(current.sketches); expect(reopened.solids).toEqual(current.solids);
            const session = await createInspectableNativeKernelForNodeTests();
            try {
              const restored = await compute(reopened, session, revision, surfaces);
              expect(restored.keys, format).toEqual(result.keys);
              const after = await check(restored, kind, currentConstant, kept, `${label}/${format}`);
              after.forEach((measurement, index) => {
                expect(measurement.topology, format).toEqual(measurements[index].topology);
                expect(measurement.states, format).toEqual(measurements[index].states);
                w3ExpectRelative(measurement.signedVolume, measurements[index].signedVolume, `${label}/${format} signed`);
              });
            } finally { session.dispose(); }
          }
        }
      }
    } finally { surfaces.dispose(); fixture.dispose(); }
  // Baseline1 + both/revision2 + JSON2 + PCAD2 + outside2 + inside2: eleven unchanged serial passes.
  }, 11 * CUT_WORKFLOW_STEP_TIMEOUT_MS);
});
