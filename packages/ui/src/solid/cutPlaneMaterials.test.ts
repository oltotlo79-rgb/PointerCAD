/**
 * 切る面の材料(EX-04 W1)の検査。
 *
 * 1. 5 方法(立体の面／3 点／点と法線／XYZ 軸に垂直な面／任意の作業平面)と、点の 3 種
 *    (立体の頂点／スケッチの点／座標の式)・辺の 2 方式(辺に垂直／辺を含む面)の、
 *    成功と理由付きの拒否の対応表(どの行も成功 1 件以上・拒否 1 件以上)。
 * 2. 保存した参照は、参照先を後で直しても書き換わらない(暗黙の更新 0)。
 * 3. 非対称の箱(40×30×8 に片側へ寄せた φ6 の貫通穴)を各方法の面で切ったときの体積を、
 *    実際の形の計算(Node の OCCT)で作り、解析値と相対 1e-9 で照らし合わせる(独立の照合)。
 * 4. 予告と確定の一致(EX-04 W2): 式 3 通り × 決め方 × 切替で、予告の面と決定した切断の面が
 *    法線の角度差 ≤1e-9 rad・原点の差 ≤1e-9 mm で一致する。W1 の 5 方法で予告が出る。
 *    予告の表示・切替・取消(Esc)で文書と元に戻す履歴が変わらない。
 *
 * 期待値は形と決め方の定義だけから導く(実装の計算を写さない)。
 */

import { createHash } from 'node:crypto';

import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { serializeDocument } from '@pointercad/io';
import {
  absoluteCoordinate,
  addSketch,
  analyzeParameters,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createSketchFor,
  DEFAULT_PRIMITIVE_AXIS,
  findSolid,
  FREE_WORK_PLANE_ID,
  recomputePart,
  replaceReference,
  replaceSketch,
  resolvePart,
  setActiveSketch,
  type BooleanFeature,
  type CutFeature,
  type PartDocument,
  type PlaneSpec,
  type PrimitiveFeature,
  type ResolvedPlane,
  type SketchPointFeature,
  type SolidBody,
  type Vec3,
} from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createNativeKernelBridgeForNodeTests,
  initializeNativeKernelForNodeTests,
} from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import {
  applyNumericInputKey,
  chooseNumericInput,
  commitNumericInput,
  createNumericInput,
  reduceNumericInput,
  toggleNumericInput,
  type NumericInputContext,
  type NumericInputState,
  type NumericToggleKey,
  type SolidInputCommit,
} from '../sketch/numericInput.js';
import { appendCoordinatePoints, commitWorkPlane } from '../sketch/referenceCommands.js';
import { bodyFor, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

import {
  commitCutInput,
  cutPlaneSpecFor,
  cutToolReadiness,
  inferPlaneSpec,
  resolveCutPlane,
  type CutContext,
  type CutKeep,
} from './cutCommands.js';
import { collectCutMaterials, cutPlaneMaterialRejection } from './cutPlaneMaterials.js';
import { cutPlanePreviewOf, type CutPlanePreview } from './cutPlanePreview.js';
import {
  subShapeElementId,
  subShapeBodiesOf,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SubShapeBody,
} from './subShapeSelection.js';

/* ------------------------------------------------------------------ *
 * ひな型
 * ------------------------------------------------------------------ */

type Point = readonly [number, number, number];

const value = (number: number): ExpressionValue => expressionValueFromNumber(number);

/** 式を実際の評価器で値にする(`10*2` のような式のまま持つ値)。 */
function expression(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`式を評価できません: ${source}`);
  }
  return result.value;
}

const BODY = 'box-1';
const SIZE: Point = [40, 30, 8];

/** 0 ≤ x ≤ 40、0 ≤ y ≤ 30、0 ≤ z ≤ 8 の箱(基本形状の箱は中心が基準点)。 */
function boxFeature(id = BODY, center: Point = [20, 15, 4], size: Point = SIZE): PrimitiveFeature {
  return {
    id,
    name: id,
    kind: 'primitive',
    suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(center[0], center[1], center[2]) },
    axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'box', sizeX: value(size[0]), sizeY: value(size[1]), sizeZ: value(size[2]) },
  };
}

function boxDocument(): PartDocument {
  return appendSolid(createEmptyPartDocument(), boxFeature());
}

function subtract3(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unit3(a: Point): Point {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * 箱の部分形状の一覧(カーネルが箱について返す形: 平面 6 枚・直線の稜線 12 本・頂点 8 つ)。
 * 頂点の番号は (x, y, z) の 0/最大 を 2 進で並べた順、稜線は角の組の順。
 * 末尾に曲がった辺(円)と曲がった面(円柱)を 1 つずつ足す(拒否の検査の材料)。
 */
function boxBody(): SubShapeBody {
  const corners: Point[] = [];
  for (const x of [0, SIZE[0]]) for (const y of [0, SIZE[1]]) for (const z of [0, SIZE[2]]) corners.push([x, y, z]);
  const pairs: (readonly [Point, Point])[] = [];
  corners.forEach((start, i) => corners.forEach((end, j) => {
    if (i < j && [0, 1, 2].filter((axis) => start[axis] !== end[axis]).length === 1) pairs.push([start, end]);
  }));
  const edges: SolidEdgeEntry[] = pairs.map(([start, end], index) => ({
    index, curveKind: 'line', length: Math.hypot(...subtract3(end, start)),
    midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
    start, end, axis: unit3(subtract3(end, start)), radius: null, segmentOffset: 0, segmentCount: 0,
  }));
  edges.push({ index: edges.length, curveKind: 'circle', length: 6 * Math.PI, midpoint: [13, 10, 8], start: [13, 10, 8],
    end: [13, 10, 8], axis: [0, 0, 1], radius: 3, segmentOffset: 0, segmentCount: 0 });
  const faces: SolidFaceEntry[] = [];
  for (const axis of [0, 1, 2]) {
    for (const side of [0, SIZE[axis]]) {
      const centroid: [number, number, number] = [SIZE[0] / 2, SIZE[1] / 2, SIZE[2] / 2];
      centroid[axis] = side;
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = side === 0 ? -1 : 1;
      faces.push({ index: faces.length, surfaceKind: 'plane', area: 1, centroid, axis: normal, radius: null,
        triangleOffset: 0, triangleCount: 0 });
    }
  }
  faces.push({ index: faces.length, surfaceKind: 'cylinder', area: 1, centroid: [10, 10, 4], axis: [0, 0, 1], radius: 3,
    triangleOffset: 0, triangleCount: 0 });
  return {
    featureId: BODY,
    mesh: { edgePositions: new Float32Array([0, 0, 0, SIZE[0], SIZE[1], SIZE[2]]) },
    faces,
    edges,
    vertices: corners.map((position, index) => ({ index, position })),
  };
}

const FIXTURE = boxBody();

function near(a: Point, b: Point): boolean {
  return Math.hypot(...subtract3(a, b)) < 1e-9;
}

function vertexAt(position: Point): string {
  const found = FIXTURE.vertices.find((vertex) => near(vertex.position, position));
  if (found === undefined) throw new Error(`頂点がありません: ${position.join(',')}`);
  return subShapeElementId(BODY, 'vertex', found.index);
}

function edgeBetween(a: Point, b: Point): string {
  const found = FIXTURE.edges.find((edge) => edge.curveKind === 'line'
    && ((near(edge.start, a) && near(edge.end, b)) || (near(edge.start, b) && near(edge.end, a))));
  if (found === undefined) throw new Error(`辺がありません: ${a.join(',')} - ${b.join(',')}`);
  return subShapeElementId(BODY, 'edge', found.index);
}

const TOP_FACE = subShapeElementId(BODY, 'face', 5);
const CYLINDER_FACE = subShapeElementId(BODY, 'face', 6);
const CIRCLE_EDGE = subShapeElementId(BODY, 'edge', 12);

/** 点のフィーチャー。3D スケッチ(作図面なし)なら座標がそのまま世界の位置になる。 */
function sketchPoint(id: string, at: Point, planeId: string = FREE_WORK_PLANE_ID): SketchPointFeature {
  return { id, name: id, kind: 'point', planeId, at: absoluteCoordinate(at[0], at[1], at[2]) };
}

/** 編集中のスケッチへ点を足す。 */
function withPoints(document: PartDocument, points: readonly SketchPointFeature[]): PartDocument {
  const sketch = document.sketches.find((candidate) => candidate.id === document.activeSketchId);
  if (sketch === undefined) throw new Error('編集中のスケッチがありません');
  return replaceSketch(document, points.reduce((current, point) => appendFeature(current, point), sketch));
}

function contextOf(document: PartDocument, selection: readonly string[], bodies: readonly SubShapeBody[] = [FIXTURE]): CutContext {
  return { document, bodies, selection };
}

function cutCommit(
  kind: string | undefined,
  values: SolidInputCommit['values'] = {},
  flags: SolidInputCommit['flags'] = {},
): SolidInputCommit {
  return {
    kind: 'solid',
    tool: 'cut',
    step: 'cutPlane',
    values,
    flags,
    ...(kind === undefined ? {} : { shapeChoices: { cutPlaneKind: kind } }),
  };
}

/** 座標の点を入れる確定(「点を座標で入れる」が入)。 */
function withCoordinate(kind: string, at: readonly [string, string, string], keepBoth = false): SolidInputCommit {
  return cutCommit(kind, { cutPointX: expression(at[0]), cutPointY: expression(at[1]), cutPointZ: expression(at[2]) },
    { cutPointByCoordinate: true, cutKeepBoth: keepBoth });
}

function cutsOf(document: PartDocument): CutFeature[] {
  return document.solids.filter((feature): feature is CutFeature => feature.kind === 'cut');
}

/** 確定して、積まれた 1 つ目の切断の平面を返す。断られたら検査を落とす。 */
function committedPlane(context: CutContext, commit: SolidInputCommit): { readonly document: PartDocument; readonly plane: PlaneSpec } {
  const outcome = commitCutInput(context, commit);
  if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
  const feature = findSolid(outcome.document, outcome.featureId);
  if (feature?.kind !== 'cut') throw new Error('切断が積まれていません');
  return { document: outcome.document, plane: feature.plane };
}

function expectRejected(context: CutContext, commit: SolidInputCommit, reasonKey: string): void {
  expect(commitCutInput(context, commit)).toEqual({ ok: false, reasonKey });
}

/** 文書の点の参照(`{ kind: 'point' }`)が指す基準点の座標の式。 */
function referencePointSources(document: PartDocument, pointId: string): readonly string[] {
  const feature = document.references.find((candidate) => candidate.id === pointId);
  if (feature?.kind !== 'referencePoint' || feature.definition.kind !== 'coordinate'
    || feature.definition.at.mode !== 'absolute') {
    throw new Error(`座標の基準点ではありません: ${pointId}`);
  }
  const { at } = feature.definition;
  expect(feature.visible).toBe(false);
  return [at.x.source, at.y.source, at.z.source];
}

/** resolvePart が解いた切断の面(原点と法線)。 */
function resolvedCut(document: PartDocument, featureId: string): { readonly origin: Vec3; readonly normal: Vec3 } {
  const resolved = resolvePart(document);
  const step = resolved.steps.find((candidate) => candidate.featureId === featureId);
  if (step === undefined || step.plan.kind !== 'cut') {
    throw new Error(`切断の段がありません: ${JSON.stringify(resolved.errors)}`);
  }
  return { origin: step.plan.origin, normal: step.plan.normal };
}

/* ------------------------------------------------------------------ *
 * 1. 5 方法 × 成功・理由付きの拒否(対応表)
 * ------------------------------------------------------------------ */

describe('立体の面(選んだ面・点を通る平行な面)', () => {
  it('成功: 平らな面そのもの、スケッチの点を通る平行な面', () => {
    const face = committedPlane(contextOf(boxDocument(), [BODY, TOP_FACE]), cutCommit('face')).plane;
    expect(face).toMatchObject({ kind: 'face', offset: { value: 0 } });
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [5, 25, 2])]);
    const parallel = committedPlane(contextOf(document, [BODY, 'point-1', TOP_FACE]), cutCommit(undefined));
    expect(parallel.plane).toMatchObject({ kind: 'pointAndParallelFace', point: { kind: 'point', pointId: 'point-1' } });
    expect(resolvedCut(parallel.document, cutsOf(parallel.document)[0].id).origin[2]).toBeCloseTo(2, 12);
  });

  it('拒否: 曲がった面、面を選んでいない', () => {
    expectRejected(contextOf(boxDocument(), [BODY, CYLINDER_FACE]), cutCommit('face'), 'cutError.curvedFace');
    expectRejected(contextOf(boxDocument(), [BODY]), cutCommit('face'), 'shapeError.noCutPlane');
  });
});

describe('3 点(立体の頂点・スケッチの点・座標の式を混ぜる)', () => {
  it('成功: 頂点・スケッチの点・座標の式の 3 点。座標の点は選んだ点の後ろに並び、式のまま補助の基準点になる', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [0, 30, 0], 'xy')]);
    const before = document.references.length;
    const outcome = committedPlane(contextOf(document, [BODY, vertexAt([40, 0, 0]), 'point-1']),
      withCoordinate('threePoints', ['40', '0', '4*2']));
    if (outcome.plane.kind !== 'threePoints') throw new Error('3 点の面ではありません');
    expect(outcome.plane.p1.kind).toBe('subShape');
    expect(outcome.plane.p2).toEqual({ kind: 'point', pointId: 'point-1' });
    if (outcome.plane.p3.kind !== 'point') throw new Error('3 点目が座標の点ではありません');
    expect(referencePointSources(outcome.document, outcome.plane.p3.pointId)).toEqual(['40', '0', '4*2']);
    // 基準点 1 つと切断 1 つを 1 回の変更で積む(元に戻す 1 回で両方が消える)。
    expect(outcome.document.references).toHaveLength(before + 1);
    expect(cutsOf(outcome.document)).toHaveLength(1);
    // 解いた面: (40,0,0) → (0,30,0) と (40,0,8) の外積の向き = (3, 4, 0)/5。
    const normal = resolvedCut(outcome.document, cutsOf(outcome.document)[0].id).normal;
    expect(normal[0]).toBeCloseTo(0.6, 12);
    expect(normal[1]).toBeCloseTo(0.8, 12);
    expect(normal[2]).toBeCloseTo(0, 12);
  });

  it('拒否: 一直線に並ぶ 3 点(スケッチの点と座標の点も押す前に判定する)、点が足りない', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 0, 0], 'xy'),
      sketchPoint('point-2', [30, 0, 0], 'xy')]);
    expectRejected(contextOf(document, [BODY, vertexAt([0, 0, 0]), 'point-1']),
      withCoordinate('threePoints', ['40', '0', '0']), 'cutError.collinear');
    // 押す前の判定(道具の押せる・押せない)も、指紋に位置を持たないスケッチの点で一直線を見つける。
    expect(cutToolReadiness(contextOf(document, [BODY, vertexAt([0, 0, 0]), 'point-1', 'point-2'])))
      .toEqual({ ready: false, reasonKey: 'cutError.collinear' });
    expectRejected(contextOf(document, [BODY, 'point-1']), withCoordinate('threePoints', ['0', '30', '0']),
      'shapeError.noCutPlane');
  });
});

describe('点と法線(点と軸・点と辺に垂直)', () => {
  it('成功: スケッチの点と Z 軸、座標の点と Z 軸(傾き付き)、座標の点と辺に垂直', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 15, 6])]);
    const sketch = committedPlane(contextOf(document, [BODY, 'point-1']), cutCommit('pointAndAxis'));
    expect(sketch.plane).toMatchObject({ kind: 'pointAndAxis', point: { kind: 'point', pointId: 'point-1' },
      axis: { kind: 'world', axis: 'z' } });
    expect(resolvedCut(sketch.document, cutsOf(sketch.document)[0].id).origin).toEqual([20, 15, 6]);
    const typed = committedPlane(contextOf(boxDocument(), [BODY]), cutCommit('pointAndAxis',
      { cutTilt: expression('15*2'), cutPointX: expression('10*2'), cutPointY: expression('5'), cutPointZ: expression('0') },
      { cutPointByCoordinate: true }));
    if (typed.plane.kind !== 'pointAndAxis' || typed.plane.point.kind !== 'point') throw new Error('点と軸ではありません');
    expect(typed.plane.tilt.source).toBe('15*2');
    expect(referencePointSources(typed.document, typed.plane.point.pointId)).toEqual(['10*2', '5', '0']);
    const edge = committedPlane(contextOf(boxDocument(), [BODY, edgeBetween([0, 0, 0], [40, 0, 0])]),
      withCoordinate('pointAndEdge', ['10*3', '15', '4']));
    expect(edge.plane).toMatchObject({ kind: 'pointAndEdge', mode: 'perpendicular' });
    expect(resolvedCut(edge.document, cutsOf(edge.document)[0].id).origin).toEqual([30, 15, 4]);
  });

  it('拒否: 曲がった辺、数でない座標、選んだ点と座標の点が両方ある、点が無い', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 15, 6])]);
    expectRejected(contextOf(document, [BODY, 'point-1', CIRCLE_EDGE]), cutCommit('pointAndEdge'),
      'cutError.notStraightEdge');
    expectRejected(contextOf(boxDocument(), [BODY]), cutCommit('pointAndAxis',
      { cutPointX: { source: 'x', value: Number.NaN, display: 'NaN' }, cutPointY: value(0), cutPointZ: value(0) },
      { cutPointByCoordinate: true }), 'cutError.expressionInvalid');
    expectRejected(contextOf(document, [BODY, 'point-1']), withCoordinate('pointAndAxis', ['1', '2', '3']),
      'cutError.tooManyPoints');
    expectRejected(contextOf(boxDocument(), [BODY]), cutCommit('pointAndAxis'), 'shapeError.noCutPlane');
  });
});

describe('辺の 2 方式(辺に垂直・辺を含む面)', () => {
  const vertical = (): string => edgeBetween([40, 30, 0], [40, 30, 8]);

  it('成功: 辺を含む面(辺と点)、辺に垂直(辺の向きが法線)', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 0, 0], 'xy')]);
    const containing = committedPlane(contextOf(document, [BODY, vertical(), 'point-1']),
      cutCommit('pointAndEdgeContaining'));
    expect(containing.plane).toMatchObject({ kind: 'pointAndEdge', mode: 'containing',
      point: { kind: 'point', pointId: 'point-1' } });
    // 法線は辺の向き(+Z)と「辺の中点 (40,30,4) → 点」の外積 = (30, −20, 0) の向き。
    const normal = resolvedCut(containing.document, cutsOf(containing.document)[0].id).normal;
    expect(normal[0]).toBeCloseTo(3 / Math.sqrt(13), 12);
    expect(normal[1]).toBeCloseTo(-2 / Math.sqrt(13), 12);
    const perpendicular = committedPlane(contextOf(document, [BODY, vertical(), 'point-1']), cutCommit('pointAndEdge'));
    expect(perpendicular.plane).toMatchObject({ kind: 'pointAndEdge', mode: 'perpendicular' });
  });

  it('拒否: 点が辺の延長線の上(辺と点が同一直線)、辺を選んでいない', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [60, 0, 0], 'xy')]);
    const context = contextOf(document, [BODY, edgeBetween([0, 0, 0], [40, 0, 0]), 'point-1']);
    expectRejected(context, cutCommit('pointAndEdgeContaining'), 'cutError.pointOnEdgeLine');
    expectRejected(contextOf(document, [BODY, 'point-1']), cutCommit('pointAndEdgeContaining'), 'shapeError.noCutPlane');
  });
});

describe('XYZ 軸に垂直な面(位置は式)', () => {
  it.each([
    { kind: 'axisX', axis: 'x', normal: [1, 0, 0], sources: ['10*2', '0', '0'], origin: [20, 0, 0] },
    { kind: 'axisY', axis: 'y', normal: [0, 1, 0], sources: ['0', '10*2', '0'], origin: [0, 20, 0] },
    { kind: 'axisZ', axis: 'z', normal: [0, 0, 1], sources: ['0', '0', '10*2'], origin: [0, 0, 20] },
  ] as const)('成功: $kind は位置の式を補助の基準点に持ち、法線は +$axis', ({ kind, axis, normal, sources, origin }) => {
    const outcome = committedPlane(contextOf(boxDocument(), [BODY]), cutCommit(kind, { cutPosition: expression('10*2') }));
    if (outcome.plane.kind !== 'pointAndAxis' || outcome.plane.point.kind !== 'point') throw new Error('点と軸ではありません');
    expect(outcome.plane.axis).toEqual({ kind: 'world', axis });
    expect(outcome.plane.tilt.value).toBe(0);
    expect(referencePointSources(outcome.document, outcome.plane.point.pointId)).toEqual(sources);
    const resolved = resolvedCut(outcome.document, cutsOf(outcome.document)[0].id);
    resolved.normal.forEach((component, index) => expect(component, `法線 ${String(index)}`).toBeCloseTo(normal[index], 12));
    expect(resolved.origin).toEqual(origin);
    // 選択だけでは位置が決まらないので、予告の面は出さない(確定は欄の値から組み立てる)。
    expect(cutPlaneSpecFor(contextOf(boxDocument(), [BODY]), kind)).toBeNull();
  });

  it('拒否: 位置が数でない(式が評価できない)、座標の点を入れたまま', () => {
    expectRejected(contextOf(boxDocument(), [BODY]),
      cutCommit('axisX', { cutPosition: { source: '10*', value: Number.NaN, display: 'NaN' } }), 'cutError.expressionInvalid');
    expectRejected(contextOf(boxDocument(), [BODY]),
      cutCommit('axisZ', { cutPosition: value(2), cutPointX: value(0), cutPointY: value(0), cutPointZ: value(0) },
        { cutPointByCoordinate: true }), 'cutError.coordinatePointUnused');
  });
});

describe('任意の作業平面(モデルブラウザで選ぶ)', () => {
  /** 3 点 (20,0,0) (40,20,0) (20,0,8) を通る作業平面(x − y = 20)。 */
  function withWorkPlane(points: readonly Point[] = [[20, 0, 0], [40, 20, 0], [20, 0, 8]]): PartDocument {
    const placed = appendCoordinatePoints(boxDocument(), points.map(([x, y, z]) => absoluteCoordinate(x, y, z)));
    const [p1, p2, p3] = placed.points;
    if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error('点が足りません');
    return commitWorkPlane(placed.document, { kind: 'threePoints', p1, p2, p3 }).document;
  }

  it('成功: 決め方「選んだ作業平面」と、何も決めずに作業平面だけを選んだときの推測', () => {
    const document = withWorkPlane();
    const planeId = document.references.find((feature) => feature.kind === 'referencePlane')?.id;
    if (planeId === undefined) throw new Error('作業平面がありません');
    const chosen = committedPlane(contextOf(document, [BODY, planeId]), cutCommit('workPlane'));
    expect(chosen.plane).toEqual({ kind: 'workPlane', planeId, offset: value(0) });
    expect(inferPlaneSpec(contextOf(document, [BODY, planeId]))).toEqual(chosen.plane);
    const normal = resolvedCut(chosen.document, cutsOf(chosen.document)[0].id).normal;
    expect(normal[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(normal[1]).toBeCloseTo(-Math.SQRT1_2, 12);
  });

  it('拒否: 作業平面を選んでいない、作業平面そのものが決まらない(3 点が一直線)', () => {
    expectRejected(contextOf(withWorkPlane(), [BODY]), cutCommit('workPlane'), 'shapeError.noCutPlane');
    const broken = withWorkPlane([[0, 0, 0], [10, 0, 0], [20, 0, 0]]);
    const planeId = broken.references.find((feature) => feature.kind === 'referencePlane')?.id ?? '';
    expectRejected(contextOf(broken, [BODY, planeId]), cutCommit('workPlane'), 'cutError.workPlaneMissing');
    expect(cutToolReadiness(contextOf(broken, [BODY, planeId])))
      .toEqual({ ready: false, reasonKey: 'cutError.workPlaneMissing' });
  });
});

describe('スケッチの点を選ぶときの断り(点の取り違えを防ぐ)', () => {
  it('前のスケッチに同じ名前の点があれば断る(文書の順に探す model の規則で別の点になるため)', () => {
    const first = withPoints(boxDocument(), [sketchPoint('point-1', [1, 1, 1])]);
    const second = createSketchFor(first);
    const document = withPoints(setActiveSketch(addSketch(first, second), second.id), [sketchPoint('point-1', [20, 15, 6])]);
    const context = contextOf(document, [BODY, 'point-1']);
    expect(collectCutMaterials(context)).toEqual({ ok: false, reasonKey: 'cutError.sketchPointOtherSketch' });
    expect(cutToolReadiness(context)).toEqual({ ready: false, reasonKey: 'cutError.sketchPointOtherSketch' });
    expectRejected(context, cutCommit('pointAndAxis'), 'cutError.sketchPointOtherSketch');
    // 予告と選び直し(プロパティ)は面を出さない。
    expect(cutPlaneSpecFor(context, 'pointAndAxis')).toBeNull();
    expect(inferPlaneSpec(context)).toBeNull();
  });

  it('位置が決まらない点(基準の点が無い相対座標)は断る', () => {
    const broken: SketchPointFeature = { id: 'point-1', name: 'point-1', kind: 'point', planeId: FREE_WORK_PLANE_ID,
      at: { mode: 'relative', base: { kind: 'point', pointId: 'missing' }, dx: value(0), dy: value(0), dz: value(0) } };
    const context = contextOf(withPoints(boxDocument(), [broken]), [BODY, 'point-1']);
    expectRejected(context, cutCommit('pointAndAxis'), 'cutError.sketchPointUnresolved');
  });

  it('点そのものと点列の 1 点だけを点とみなし、線などは材料にしない', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 15, 6])]);
    const materials = collectCutMaterials(contextOf(document, [BODY, 'point-1', 'line-9', 'point-1']));
    expect(materials).toEqual({ ok: true, materials: { points: [{ kind: 'point', pointId: 'point-1' }], edges: [],
      faces: [], workPlaneIds: [] } });
  });
});

describe('座標の点を使わない決め方では、入にしたまま決めると理由を出して止める', () => {
  it.each([undefined, 'xy', 'face', 'workPlane', 'profile'] as const)('決め方 %s', (kind) => {
    const commit = cutCommit(kind, { cutPointX: value(0), cutPointY: value(0), cutPointZ: value(0) },
      { cutPointByCoordinate: true });
    expectRejected(contextOf(boxDocument(), [BODY, TOP_FACE]), commit, 'cutError.coordinatePointUnused');
  });

  it('押す前の確かめは、画面で解けない材料(関数の上の点など)を含む面では断らない', () => {
    const plane: PlaneSpec = { kind: 'tilted', base: 'xy', axis: { kind: 'world', axis: 'x' }, angle: value(30) };
    expect(cutPlaneMaterialRejection(contextOf(boxDocument(), [BODY]), plane)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2. 保存参照の暗黙の更新 0
 * ------------------------------------------------------------------ */

describe('保存した参照は、参照先を後で直しても書き換わらない(暗黙の更新 0)', () => {
  it('スケッチの点を動かしても切断の保存内容は同じもので、解いた面だけが点に付いていく', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 15, 6])]);
    const committed = committedPlane(contextOf(document, [BODY, 'point-1']), cutCommit('pointAndAxis'));
    const cut = cutsOf(committed.document)[0];
    const sketch = committed.document.sketches[0];
    const moved = replaceSketch(committed.document, { ...sketch, features: sketch.features.map((feature) =>
      feature.id === 'point-1' && feature.kind === 'point' ? { ...feature, at: absoluteCoordinate(20, 15, 4) } : feature) });
    expect(findSolid(moved, cut.id)).toBe(cut);
    expect(JSON.stringify(findSolid(moved, cut.id))).toBe(JSON.stringify(cut));
    expect(resolvedCut(committed.document, cut.id).origin).toEqual([20, 15, 6]);
    expect(resolvedCut(moved, cut.id).origin).toEqual([20, 15, 4]);
  });

  it('座標の式の基準点を直しても切断の保存内容は同じもので、解いた面が付いていく', () => {
    const committed = committedPlane(contextOf(boxDocument(), [BODY]), cutCommit('axisZ', { cutPosition: expression('2') }));
    const cut = cutsOf(committed.document)[0];
    if (cut.plane.kind !== 'pointAndAxis' || cut.plane.point.kind !== 'point') throw new Error('点と軸ではありません');
    const pointId = cut.plane.point.pointId;
    const point = committed.document.references.find((feature) => feature.id === pointId);
    if (point?.kind !== 'referencePoint') throw new Error('基準点がありません');
    const edited = replaceReference(committed.document, pointId, { ...point,
      definition: { kind: 'coordinate', at: { mode: 'absolute', x: value(0), y: value(0), z: expression('3*2') } } });
    expect(findSolid(edited, cut.id)).toBe(cut);
    expect(resolvedCut(committed.document, cut.id).origin).toEqual([0, 0, 2]);
    expect(resolvedCut(edited, cut.id).origin).toEqual([0, 0, 6]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 独立の照合(実際の形の計算)
 * ------------------------------------------------------------------ */

const TARGET = 'subtract-1';
/** φ6 の貫通穴の体積 π·3²·8。 */
const HOLE = 72 * Math.PI;
/** 穴をあけた箱の体積。 */
const TOTAL = SIZE[0] * SIZE[1] * SIZE[2] - HOLE;
/** 箱の断面 40×30(z に垂直な面の面積)から穴の断面 π·3² を引いたもの。 */
const SLAB = SIZE[0] * SIZE[1] - 9 * Math.PI;

/** 40×30×8 の箱から、中心 (10, 10) の φ6 の円柱(z −1〜9)を引いた非対称の立体。 */
function holeBoxDocument(): PartDocument {
  const cylinder: PrimitiveFeature = {
    id: 'cylinder-1', name: 'cylinder-1', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(10, 10, -1) }, axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'cylinder', radius: value(3), height: value(10) },
  };
  const hole: BooleanFeature = {
    id: TARGET, name: TARGET, kind: 'boolean', suppressed: false, operation: 'subtract',
    targetFeatureId: BODY, toolFeatureId: cylinder.id,
  };
  return appendSolid(appendSolid(boxDocument(), cylinder), hole);
}

function bodyOf(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const body = bodies.find((candidate) => candidate.featureId === featureId);
  if (body === undefined) throw new Error(`立体がありません: ${featureId}`);
  return body;
}

function realVertex(bodies: readonly SolidBody[], position: Point): string {
  const found = bodyOf(bodies, TARGET).vertices.find((vertex) => Math.hypot(...subtract3(vertex.position, position)) < 1e-6);
  if (found === undefined) throw new Error(`頂点がありません: ${position.join(',')}`);
  return subShapeElementId(TARGET, 'vertex', found.index);
}

function realEdge(bodies: readonly SolidBody[], a: Point, b: Point): { readonly id: string; readonly axis: Point } {
  const close = (p: Point, q: Point): boolean => Math.hypot(...subtract3(p, q)) < 1e-6;
  const found = bodyOf(bodies, TARGET).edges.find((edge) => edge.curveKind === 'line'
    && ((close(edge.start, a) && close(edge.end, b)) || (close(edge.start, b) && close(edge.end, a))));
  if (found === undefined || found.axis === null) throw new Error(`辺がありません: ${a.join(',')} - ${b.join(',')}`);
  return { id: subShapeElementId(TARGET, 'edge', found.index), axis: found.axis };
}

/** 平らな面のうち、指定の軸の座標がその値のもの(穴のある面は重心がずれるので座標 1 つで探す)。 */
function realFace(bodies: readonly SolidBody[], featureId: string, axis: 0 | 1 | 2, at: number): { readonly id: string; readonly axis: Point } {
  const found = bodyOf(bodies, featureId).faces.find((face) => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(face.centroid[axis] - at) < 1e-6 && Math.abs(face.axis[axis]) > 0.999);
  if (found === undefined || found.axis === null) throw new Error(`面がありません: ${featureId} ${axis}=${at}`);
  return { id: subShapeElementId(featureId, 'face', found.index), axis: found.axis };
}

function dot3(a: Point, b: Point): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Point, b: Point): Point {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 法線の向きで、[法線の側, 反対側] の体積の並びを決める(解析値は向きに依らない)。 */
function bySide(normalPointsToFirst: boolean, first: number, second: number): readonly [number, number] {
  return normalPointsToFirst ? [first, second] : [second, first];
}

interface OracleCase {
  readonly name: string;
  /** 切る前の文書(穴のある箱に、材料のスケッチの点・作業平面・定規の箱を足したもの)。 */
  readonly document: () => PartDocument;
  readonly selection: (bodies: readonly SolidBody[], document: PartDocument) => readonly string[];
  readonly commit: SolidInputCommit;
  /** [法線の側, 反対側] の解析値。辺・面の向きは実際の形の値から読む(入力の値。答えではない)。 */
  readonly expected: (bodies: readonly SolidBody[]) => readonly [number, number];
}

const both = { cutKeepBoth: true } as const;

const ORACLE_CASES: readonly OracleCase[] = [
  {
    name: 'X 軸に垂直な面・位置 10*2(x = 20)',
    document: holeBoxDocument,
    selection: () => [TARGET],
    commit: cutCommit('axisX', { cutPosition: expression('10*2') }, both),
    expected: () => [20 * SIZE[1] * SIZE[2], 20 * SIZE[1] * SIZE[2] - HOLE],
  },
  {
    name: 'Y 軸に垂直な面・位置 10(穴の中心を通る y = 10)',
    document: holeBoxDocument,
    selection: () => [TARGET],
    commit: cutCommit('axisY', { cutPosition: expression('10') }, both),
    expected: () => [SIZE[0] * 20 * SIZE[2] - HOLE / 2, SIZE[0] * 10 * SIZE[2] - HOLE / 2],
  },
  {
    name: 'Z 軸に垂直な面・位置 4/2(z = 2)',
    document: holeBoxDocument,
    selection: () => [TARGET],
    commit: cutCommit('axisZ', { cutPosition: expression('4/2') }, both),
    expected: () => [6 * SLAB, 2 * SLAB],
  },
  {
    name: '3 点: 立体の頂点 (40,0,0)・スケッチの点 (0,30,0)・座標の式 (40, 0, 4*2)(3x + 4y = 120)',
    document: () => withPoints(holeBoxDocument(), [sketchPoint('point-1', [0, 30, 0], 'xy')]),
    selection: (bodies) => [TARGET, realVertex(bodies, [40, 0, 0]), 'point-1'],
    commit: withCoordinate('threePoints', ['40', '0', '4*2'], true),
    // 法線 (3, 4, 0)/5 の側は頂点 (40,0)・(40,30)・(0,30) の三角柱 600×8。
    expected: () => [600 * SIZE[2], TOTAL - 600 * SIZE[2]],
  },
  {
    name: '点と軸: スケッチの点 (20, 15, 6) と Z 軸(z = 6)',
    document: () => withPoints(holeBoxDocument(), [sketchPoint('point-1', [20, 15, 6])]),
    selection: () => [TARGET, 'point-1'],
    commit: cutCommit('pointAndAxis', {}, both),
    expected: () => [2 * SLAB, 6 * SLAB],
  },
  {
    name: '点と辺に垂直: 座標の式 (10*3, 15, 4) と x 方向の辺(x = 30)',
    document: holeBoxDocument,
    selection: (bodies) => [TARGET, realEdge(bodies, [0, 0, 0], [40, 0, 0]).id],
    commit: withCoordinate('pointAndEdge', ['10*3', '15', '4'], true),
    expected: (bodies) => bySide(realEdge(bodies, [0, 0, 0], [40, 0, 0]).axis[0] > 0,
      10 * SIZE[1] * SIZE[2], 30 * SIZE[1] * SIZE[2] - HOLE),
  },
  {
    name: '辺を含む面: 縦の辺 (40,30) とスケッチの点 (20, 0, 0)(3x − 2y = 60)',
    document: () => withPoints(holeBoxDocument(), [sketchPoint('point-1', [20, 0, 0], 'xy')]),
    selection: (bodies) => [TARGET, realEdge(bodies, [40, 30, 0], [40, 30, 8]).id, 'point-1'],
    commit: cutCommit('pointAndEdgeContaining', {}, both),
    expected: (bodies) => {
      // 辺を含む面の法線 = 辺の向き × (辺の中点 → 点)(model の決め方の定義)。角 (40, 0) の側は三角柱 300×8。
      const edge = realEdge(bodies, [40, 30, 0], [40, 30, 8]);
      const normal = cross3(edge.axis, subtract3([20, 0, 0], [40, 30, 4]));
      return bySide(dot3(normal, subtract3([40, 0, 4], [20, 0, 0])) > 0, 300 * SIZE[2], TOTAL - 300 * SIZE[2]);
    },
  },
  {
    name: '立体の面に平行: スケッチの点 (5, 25, 2) と上の面(z = 2)',
    document: () => withPoints(holeBoxDocument(), [sketchPoint('point-1', [5, 25, 2])]),
    selection: (bodies) => [TARGET, 'point-1', realFace(bodies, TARGET, 2, 8).id],
    commit: cutCommit(undefined, {}, both),
    expected: (bodies) => bySide(realFace(bodies, TARGET, 2, 8).axis[2] > 0, 6 * SLAB, 2 * SLAB),
  },
  {
    name: '立体の面そのもの: 別の箱(定規)の x = 22 の面',
    document: () => appendSolid(holeBoxDocument(), boxFeature('box-2', [24, 42, 4], [4, 4, 8])),
    selection: (bodies) => [TARGET, realFace(bodies, 'box-2', 0, 22).id],
    commit: cutCommit('face', {}, both),
    expected: (bodies) => bySide(realFace(bodies, 'box-2', 0, 22).axis[0] < 0,
      22 * SIZE[1] * SIZE[2] - HOLE, 18 * SIZE[1] * SIZE[2]),
  },
  {
    name: '任意の作業平面: 3 点 (20,0,0) (40,20,0) (20,0,8) の作業平面(x − y = 20)',
    document: () => {
      const placed = appendCoordinatePoints(holeBoxDocument(),
        [absoluteCoordinate(20, 0, 0), absoluteCoordinate(40, 20, 0), absoluteCoordinate(20, 0, 8)]);
      const [p1, p2, p3] = placed.points;
      if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error('点が足りません');
      return commitWorkPlane(placed.document, { kind: 'threePoints', p1, p2, p3 }).document;
    },
    selection: (_bodies, document) => [TARGET,
      document.references.find((feature) => feature.kind === 'referencePlane')?.id ?? ''],
    commit: cutCommit('workPlane', {}, both),
    // 法線 (1, −1, 0)/√2 の側は (20,0)・(40,0)・(40,20) の三角柱 200×8。
    expected: () => [200 * SIZE[2], TOTAL - 200 * SIZE[2]],
  },
];

function expectRelative(actual: number | undefined, expected: number, label: string): void {
  if (actual === undefined) throw new Error(`体積がありません: ${label}`);
  expect(Math.abs(actual - expected) / Math.abs(expected), `${label}: ${String(actual)} / ${String(expected)}`)
    .toBeLessThanOrEqual(1e-9);
}

describe('非対称の箱を各方法の面で切ると、正側・負側の体積が解析値に相対 1e-9 で一致する(独立の照合)', () => {
  beforeAll(async () => {
    await initializeNativeKernelForNodeTests();
  }, 180_000);

  it.each(ORACLE_CASES)('$name', async ({ document: build, selection, commit, expected }) => {
    // 1 件ごとに形の計算の口を作って閉じる(commitToStore.test.ts の実カーネルの検査と同じ形)。
    const bridge = createNativeKernelBridgeForNodeTests();
    const document = build();
    try {
      const before = await recomputePart(document, bridge, { partId: document.id });
      expect(before.errors).toEqual([]);
      expectRelative(bodyOf(before.bodies, TARGET).volume, TOTAL, '切る前');
      const outcome = commitCutInput(
        { document, bodies: subShapeBodiesOf(before.bodies), selection: selection(before.bodies, document) }, commit);
      if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
      const [first, second] = cutsOf(outcome.document);
      if (first === undefined || second === undefined) throw new Error('両側の切断が積まれていません');
      expect([first.keep, second.keep, second.pairedWith]).toEqual(['positive', 'negative', first.id]);
      const after = await recomputePart(outcome.document, bridge, { partId: document.id });
      expect(after.errors).toEqual([]);
      const [positive, negative] = expected(before.bodies);
      const positiveVolume = after.bodies.find((body) => body.featureId === first.id)?.volume;
      const negativeVolume = after.bodies.find((body) => body.featureId === second.id)?.volume;
      expectRelative(positiveVolume, positive, '法線の側');
      expectRelative(negativeVolume, negative, '反対側');
      expectRelative((positiveVolume ?? Number.NaN) + (negativeVolume ?? Number.NaN), TOTAL, '両側の和');
      expectRelative(positive + negative, TOTAL, '解析値の和');
    } finally {
      bridge.dispose();
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * 4. 予告と確定の一致(EX-04 W2)
 *
 * 予告(`cutPlanePreviewOf`)の面と、同じ入力で決定して積んだ切断を model の `resolvePart` が解いた
 * 面(原点と法線)を比べる。入力欄はポップアップと同じ reducer で作り、決定も Enter と同じ
 * `commitNumericInput` を通す。予告の面が、決め方の定義から別に求めた面と一致することも確かめる
 * (実装の計算を写さない)。
 * ------------------------------------------------------------------ */

/** 法線の角度差の上限(rad)と、原点(面上の代表点)の差の上限(mm)。 */
const ANGLE_TOLERANCE = 1e-9;
const ORIGIN_TOLERANCE = 1e-9;

/** 文書のパラメータ「幅」= 10 mm と「角度」= 15 度(パラメータを含む式の材料)。 */
function withParameters(document: PartDocument): PartDocument {
  return {
    ...document,
    parameters: [
      { name: '幅', value: expression('10'), unit: 'mm', description: '' },
      { name: '角度', value: expression('15'), unit: 'degree', description: '' },
    ],
  };
}

/** 決定(ポップアップの Enter)と同じ式の評価の文脈: パラメータの解析と表示の単位。 */
function evaluationOf(document: PartDocument): NumericInputContext {
  return { ...analyzeParameters(document.parameters, []), lengthUnit: 'mm' };
}

/** 文書へ保存する座標の式を、その文書のパラメータで評価する(スケッチの点・基準点の座標)。 */
function documentValue(document: PartDocument, source: string): ExpressionValue {
  const result = evaluateExpression(source, analyzeParameters(document.parameters, []));
  if (!result.ok) throw new Error(`式を評価できません: ${source}`);
  return result.value;
}

/** 座標を式で書いたスケッチの点(3D スケッチの点。座標がそのまま世界の位置)を編集中のスケッチへ足す。 */
function withSketchPointAt(document: PartDocument, id: string, at: readonly [string, string, string]): PartDocument {
  return withPoints(document, [{ id, name: id, kind: 'point', planeId: FREE_WORK_PLANE_ID, at: { mode: 'absolute',
    x: documentValue(document, at[0]), y: documentValue(document, at[1]), z: documentValue(document, at[2]) } }]);
}

/** 3 点 (20,0,0)・(x,10,0)・(20,0,8) を通る作業平面(x を式で書く。x = 30 なら x − y = 20)。 */
function withWorkPlaneThrough(document: PartDocument, x: string): PartDocument {
  const placed = appendCoordinatePoints(document, [absoluteCoordinate(20, 0, 0),
    { ...absoluteCoordinate(0, 10, 0), x: documentValue(document, x) }, absoluteCoordinate(20, 0, 8)]);
  const [p1, p2, p3] = placed.points;
  if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error('点が足りません');
  return commitWorkPlane(placed.document, { kind: 'threePoints', p1, p2, p3 }).document;
}

function workPlaneIdOf(document: PartDocument): string {
  const id = document.references.find((feature) => feature.kind === 'referencePlane')?.id;
  if (id === undefined) throw new Error('作業平面がありません');
  return id;
}

/** 箱の直線の稜線の向き(実際の形の一覧の値。辺を含む面の法線の材料)。 */
function edgeAxisBetween(a: Point, b: Point): Point {
  const found = FIXTURE.edges.find((edge) => edge.curveKind === 'line'
    && ((near(edge.start, a) && near(edge.end, b)) || (near(edge.start, b) && near(edge.end, a))));
  if (found === undefined || found.axis === null) throw new Error(`辺がありません: ${a.join(',')} - ${b.join(',')}`);
  return found.axis;
}

/** 切断の入力欄。決め方を選び、つまみを入れ、欄へ式を打つ(ポップアップと同じ reducer)。 */
function cutInput(kind: string | undefined, toggles: readonly NumericToggleKey[],
  fields: Readonly<Record<string, string>> = {}): NumericInputState {
  let state = createNumericInput('cut', 'cutPlane');
  if (kind !== undefined) state = chooseNumericInput(state, 'cutPlaneKind', kind);
  for (const toggle of toggles) state = toggleNumericInput(state, toggle);
  for (const [key, source] of Object.entries(fields)) {
    const index = state.fields.findIndex((field) => field.key === key);
    if (index === -1) throw new Error(`欄がありません: ${key}`);
    state = reduceNumericInput(state, { type: 'edit', index, source });
  }
  return state;
}

/** 予告(ビューポートと同じ純関数。式の評価の文脈も決定と同じ)。 */
function previewOf(document: PartDocument, selection: readonly string[], input: NumericInputState): CutPlanePreview | null {
  return cutPlanePreviewOf({ numericInput: input, document, bodies: [FIXTURE], selection, evaluation: evaluationOf(document) });
}

interface CommittedCut {
  readonly keep: CutKeep;
  readonly origin: Vec3;
  readonly normal: Vec3;
}

/** 同じ入力で決定し(Enter と同じ評価器)、積んだ切断ごとに resolvePart が解いた面と残す側を返す。 */
function committedCuts(document: PartDocument, selection: readonly string[], input: NumericInputState): readonly CommittedCut[] {
  const transition = commitNumericInput(input, evaluationOf(document));
  if (transition.kind !== 'solidCommitted') throw new Error(`決定できません: ${transition.kind}`);
  const outcome = commitCutInput({ document, bodies: [FIXTURE], selection }, transition.commit);
  if (!outcome.ok) throw new Error(`断られました: ${outcome.reasonKey}`);
  return cutsOf(outcome.document).map((cut) => ({ keep: cut.keep, ...resolvedCut(outcome.document, cut.id) }));
}

function angleBetween(a: Point, b: Point): number {
  return Math.atan2(Math.hypot(...cross3(a, b)), dot3(a, b));
}

/** 文書の SHA-256 を比べるときの保存時刻(封筒の `savedAt` は呼ぶたびの時刻になるため固定する)。 */
const SHA_SAVED_AT = '2026-10-25T00:00:00.000Z';

/** 保存する形(.pcad の文書の JSON)の SHA-256。保存時刻の欄は固定して、文書の中身だけを比べる。 */
function shaOf(document: PartDocument): string {
  return createHash('sha256').update(serializeDocument(document, { savedAt: SHA_SAVED_AT })).digest('hex');
}

/** 予告の面と確定の面: 法線の角度差 ≤ 1e-9 rad、原点の差 ≤ 1e-9 mm。 */
function expectSamePlane(preview: CutPlanePreview, committed: CommittedCut, label: string): void {
  expect(angleBetween(preview.plane.normal, committed.normal), `${label}: 法線の角度差`)
    .toBeLessThanOrEqual(ANGLE_TOLERANCE);
  expect(Math.hypot(...subtract3(preview.plane.origin, committed.origin)), `${label}: 原点の差`)
    .toBeLessThanOrEqual(ORIGIN_TOLERANCE);
}

/** 法線が `normal` の向きで `point` を通る面であること(決め方の定義から別に求めた面)。 */
function planeThrough(normal: Point, point: Point): (plane: ResolvedPlane) => void {
  const unit = unit3(normal);
  return (plane) => {
    expect(angleBetween(plane.normal, unit), '期待の法線との角度').toBeLessThanOrEqual(ANGLE_TOLERANCE);
    expect(Math.abs(dot3(unit, subtract3(plane.origin, point))), '期待の面からの距離')
      .toBeLessThanOrEqual(ORIGIN_TOLERANCE);
  };
}

/** 点を通り、法線が Z 軸から `degrees` 度だけ傾いた面であること(点と軸の決め方の定義)。 */
function tiltedThrough(point: Point, degrees: number): (plane: ResolvedPlane) => void {
  return (plane) => {
    expect(Math.abs(angleBetween(plane.normal, [0, 0, 1]) - (degrees * Math.PI) / 180), '傾き')
      .toBeLessThanOrEqual(ANGLE_TOLERANCE);
    expect(Math.hypot(...subtract3(plane.origin, point)), '原点').toBeLessThanOrEqual(ORIGIN_TOLERANCE);
  };
}

/** 式の 3 つの書き方(数・計算・文書のパラメータ)。各組の 3 つは同じ値になる。 */
const FORMS = {
  degrees30: ['30', '15*2', '角度*2'],
  mm30: ['30', '15*2', '幅*3'],
  mm15: ['15', '7.5*2', '幅*1.5'],
  mm6: ['6', '3*2', '幅-4'],
} as const;

interface AgreementCase {
  readonly name: string;
  readonly document: () => PartDocument;
  readonly selection: (document: PartDocument) => readonly string[];
  /** 決め方(省くと既定の XY)。 */
  readonly kind: string | undefined;
  /** 「点を座標で入れる」を入にする。 */
  readonly byCoordinate: boolean;
  readonly fields: Readonly<Record<string, string>>;
  readonly expected: (plane: ResolvedPlane) => void;
}

const PARAMETERS = (): PartDocument => withParameters(boxDocument());

/** 軸に垂直な面の行: 決め方・位置の 3 通りの書き方・法線・面上の点。 */
const AXIS_ROWS: readonly { readonly kind: string; readonly forms: readonly string[]; readonly normal: Point;
  readonly point: Point }[] = [
  { kind: 'axisX', forms: FORMS.mm30, normal: [1, 0, 0], point: [30, 0, 0] },
  { kind: 'axisY', forms: FORMS.mm15, normal: [0, 1, 0], point: [0, 15, 0] },
  { kind: 'axisZ', forms: FORMS.mm6, normal: [0, 0, 1], point: [0, 0, 6] },
];

const AGREEMENT_CASES: readonly AgreementCase[] = [
  // 既定の XY: 材料が無ければ XY 面そのもの。スケッチの点を選べば、点を通り Z 軸に垂直な面(高さを式で書く)。
  { name: '既定の XY・材料なし', document: PARAMETERS, selection: () => [BODY], kind: undefined, byCoordinate: false,
    fields: {}, expected: planeThrough([0, 0, 1], [0, 0, 0]) },
  ...FORMS.mm6.map((z): AgreementCase => ({
    name: `既定の XY・スケッチの点 (5, 25, ${z})`,
    document: () => withSketchPointAt(PARAMETERS(), 'point-1', ['5', '25', z]),
    selection: () => [BODY, 'point-1'], kind: undefined, byCoordinate: false, fields: {},
    expected: planeThrough([0, 0, 1], [5, 25, 6]),
  })),
  // 点と軸: スケッチの点 (20, 15, 6) と Z 軸。傾き 30 度を 3 通りに書く(以前の予告は 15*2 を 0 度と読んだ)。
  ...FORMS.degrees30.map((tilt): AgreementCase => ({
    name: `点と軸・傾き ${tilt}`,
    document: () => withSketchPointAt(PARAMETERS(), 'point-1', ['20', '15', '6']),
    selection: () => [BODY, 'point-1'], kind: 'pointAndAxis', byCoordinate: false, fields: { cutTilt: tilt },
    expected: tiltedThrough([20, 15, 6], 30),
  })),
  // XYZ 軸に垂直な面: 位置を 3 通りに書く(X は 30、Y は 15、Z は 6。どれも箱の中)。
  ...AXIS_ROWS.flatMap((row) => row.forms.map((position): AgreementCase => ({
    name: `${row.kind}・位置 ${position}`, document: PARAMETERS, selection: () => [BODY], kind: row.kind,
    byCoordinate: false, fields: { cutPosition: position }, expected: planeThrough(row.normal, row.point),
  }))),
  // 3 点: 頂点 (40,0,0)・スケッチの点 (0,30,0)・座標の点 (x, 0, 8)。x = 30 を 3 通りに書く。
  ...FORMS.mm30.map((x): AgreementCase => ({
    name: `3 点・座標の点の X ${x}`,
    document: () => withSketchPointAt(PARAMETERS(), 'point-2', ['0', '30', '0']),
    selection: () => [BODY, vertexAt([40, 0, 0]), 'point-2'], kind: 'threePoints', byCoordinate: true,
    fields: { cutPointX: x, cutPointY: '0', cutPointZ: '8' },
    // 法線は 1 点目 → 2 点目と 1 点目 → 3 点目の外積(3 点の決め方の定義)。
    expected: planeThrough(cross3(subtract3([0, 30, 0], [40, 0, 0]), subtract3([30, 0, 8], [40, 0, 0])), [40, 0, 0]),
  })),
  // 辺を含む面: 縦の辺 (40,30,0)–(40,30,8) と座標の点 (x, 0, 0)。法線は辺の向き × (辺の中点 → 点)。
  ...FORMS.mm30.map((x): AgreementCase => ({
    name: `辺を含む面・座標の点の X ${x}`,
    document: PARAMETERS,
    selection: () => [BODY, edgeBetween([40, 30, 0], [40, 30, 8])], kind: 'pointAndEdgeContaining', byCoordinate: true,
    fields: { cutPointX: x, cutPointY: '0', cutPointZ: '0' },
    expected: planeThrough(cross3(edgeAxisBetween([40, 30, 0], [40, 30, 8]), subtract3([30, 0, 0], [40, 30, 4])),
      [30, 0, 0]),
  })),
  // 任意の作業平面: 3 点 (20,0,0)・(x,10,0)・(20,0,8) の作業平面。x = 30 を 3 通りに書く(x − y = 20)。
  ...FORMS.mm30.map((x): AgreementCase => ({
    name: `作業平面・2 点目の X ${x}`,
    document: () => withWorkPlaneThrough(PARAMETERS(), x),
    selection: (document) => [BODY, workPlaneIdOf(document)], kind: 'workPlane', byCoordinate: false, fields: {},
    expected: planeThrough(cross3([10, 10, 0], [0, 0, 8]), [20, 0, 0]),
  })),
];

/** つまみの切替: 残す側(反対側を残す)と、両側(反対側も残す = 切断 2 つ)。 */
const KEEP_VARIANTS: readonly { readonly name: string; readonly toggles: readonly NumericToggleKey[];
  readonly keeps: readonly CutKeep[] }[] = [
  { name: 'つまみなし', toggles: [], keeps: ['positive'] },
  { name: '反対側を残す', toggles: ['cutKeepOpposite'], keeps: ['negative'] },
  { name: '両側', toggles: ['cutKeepBoth'], keeps: ['positive', 'negative'] },
];

describe('予告の面は、同じ入力で決定した切断の面と一致する(EX-04 W2、式 3 通り × 決め方 × 切替)', () => {
  it.each(AGREEMENT_CASES)('$name', ({ document: build, selection, kind, byCoordinate, fields, expected }) => {
    const document = build();
    const selected = selection(document);
    const sha = shaOf(document);
    for (const variant of KEEP_VARIANTS) {
      const toggles: readonly NumericToggleKey[] = byCoordinate
        ? ['cutPointByCoordinate', ...variant.toggles] : variant.toggles;
      const input = cutInput(kind, toggles, fields);
      const preview = previewOf(document, selected, input);
      if (preview === null) throw new Error(`予告が出ません: ${variant.name}`);
      expected(preview.plane);
      const cuts = committedCuts(document, selected, input);
      expect(cuts.map((cut) => cut.keep), variant.name).toEqual(variant.keeps);
      // 予告の矢印は 1 つ目の切断の残す側を指す(両側でも 1 つ目)。
      expect(preview.keep, variant.name).toBe(variant.keeps[0]);
      cuts.forEach((cut, index) => { expectSamePlane(preview, cut, `${variant.name} ${String(index + 1)} つ目`); });
    }
    // 予告を出しても文書は変わらない(補助の基準点を積んだ仮の文書は予告の中だけで使う)。
    expect(shaOf(document)).toBe(sha);
  });
});

describe('W1 の 5 方法でも予告が出て、確定の面と一致する(以前の予告は出なかった)', () => {
  /** 予告が出て、決め方の定義どおりの面で、決定した切断の面と一致すること。 */
  function expectPreviewMatches(document: PartDocument, selection: readonly string[], input: NumericInputState,
    expected: (plane: ResolvedPlane) => void): void {
    const preview = previewOf(document, selection, input);
    expect(preview).not.toBeNull();
    if (preview === null) return;
    expected(preview.plane);
    for (const cut of committedCuts(document, selection, input)) expectSamePlane(preview, cut, '確定');
  }

  it('スケッチの点: 点を通り Z 軸に垂直な面', () => {
    const document = withSketchPointAt(boxDocument(), 'point-1', ['20', '15', '6']);
    // 以前の予告の解き方(指紋と基準の面だけ)では、スケッチの点の位置が読めず予告が無かった。
    const spec = cutPlaneSpecFor(contextOf(document, [BODY, 'point-1']), undefined);
    expect(spec === null ? null : resolveCutPlane(spec)).toBeNull();
    expectPreviewMatches(document, [BODY, 'point-1'], cutInput(undefined, []), planeThrough([0, 0, 1], [20, 15, 6]));
  });

  it('座標の点: 点と軸で「点を座標で入れる」(10*2, 5, 0)', () => {
    // 以前は選択だけから面を組み立てたので、座標の点では決め方の材料が無く予告が無かった。
    expect(cutPlaneSpecFor(contextOf(boxDocument(), [BODY]), 'pointAndAxis')).toBeNull();
    expectPreviewMatches(boxDocument(), [BODY], cutInput('pointAndAxis', ['cutPointByCoordinate'],
      { cutPointX: '10*2', cutPointY: '5', cutPointZ: '0' }), planeThrough([0, 0, 1], [20, 5, 0]));
  });

  it.each([
    { kind: 'axisX', normal: [1, 0, 0], point: [20, 0, 0] },
    { kind: 'axisY', normal: [0, 1, 0], point: [0, 20, 0] },
    { kind: 'axisZ', normal: [0, 0, 1], point: [0, 0, 20] },
  ] as const)('軸の位置: $kind・位置 10*2', ({ kind, normal, point }) => {
    // 以前は位置の欄を読まず、軸に垂直な面の予告が無かった。
    expect(cutPlaneSpecFor(contextOf(boxDocument(), [BODY]), kind)).toBeNull();
    expectPreviewMatches(boxDocument(), [BODY], cutInput(kind, [], { cutPosition: '10*2' }), planeThrough(normal, point));
  });

  it('辺: 縦の辺とスケッチの点 (20, 0, 0) で「辺を含む面」', () => {
    const document = withPoints(boxDocument(), [sketchPoint('point-1', [20, 0, 0], 'xy')]);
    const selection = [BODY, edgeBetween([40, 30, 0], [40, 30, 8]), 'point-1'];
    const spec = cutPlaneSpecFor(contextOf(document, selection), 'pointAndEdgeContaining');
    expect(spec === null ? null : resolveCutPlane(spec)).toBeNull();
    expectPreviewMatches(document, selection, cutInput('pointAndEdgeContaining', []),
      planeThrough(cross3(edgeAxisBetween([40, 30, 0], [40, 30, 8]), subtract3([20, 0, 0], [40, 30, 4])), [20, 0, 0]));
  });

  it('任意の作業平面: 選んだ作業平面(x − y = 20)', () => {
    const document = withWorkPlaneThrough(boxDocument(), '30');
    const selection = [BODY, workPlaneIdOf(document)];
    // 以前の予告は基準の 3 面しか解けず、任意の作業平面では予告が無かった。
    const spec = cutPlaneSpecFor(contextOf(document, selection), 'workPlane');
    expect(spec === null ? null : resolveCutPlane(spec)).toBeNull();
    expectPreviewMatches(document, selection, cutInput('workPlane', []), planeThrough([1, -1, 0], [20, 0, 0]));
  });

  it('確定が断る入力では予告を出さない(一直線の 3 点・欄の誤り・材料不足・座標の点の使い残し・閉じた輪郭)', () => {
    const collinear = withPoints(boxDocument(), [sketchPoint('point-1', [20, 0, 0], 'xy'),
      sketchPoint('point-2', [30, 0, 0], 'xy')]);
    const rejected: readonly (readonly [PartDocument, readonly string[], NumericInputState])[] = [
      [collinear, [BODY, vertexAt([0, 0, 0]), 'point-1', 'point-2'], cutInput('threePoints', [])],
      [withSketchPointAt(boxDocument(), 'point-1', ['20', '15', '6']), [BODY, 'point-1'],
        cutInput('pointAndAxis', [], { cutTilt: '15*' })],
      [boxDocument(), [BODY], cutInput('threePoints', [])],
      [boxDocument(), [BODY], cutInput('xy', ['cutPointByCoordinate'])],
      [boxDocument(), [BODY], cutInput('profile', [])],
      // 切る立体を選んでいない。
      [boxDocument(), [], cutInput(undefined, [])],
    ];
    for (const [document, selection, input] of rejected) {
      expect(previewOf(document, selection, input)).toBeNull();
    }
  });
});

/* 予告の表示・切替・取消(ストアの道筋)。ビューポートと同じ材料をストアから読む。 */

/** 検査の箱をストアのボディ(カーネルが返す形)へ写す。 */
function solidBodyOf(body: SubShapeBody): SolidBody {
  const base = bodyFor(body.featureId);
  return { ...base, mesh: { ...base.mesh, edgePositions: body.mesh.edgePositions }, faces: body.faces,
    edges: body.edges, vertices: body.vertices };
}

/** ビューポートの予告(ViewportCanvas の cutPreviewOf)と同じ組み立てを、いまのストアから行う。 */
function storePreview(): CutPlanePreview | null {
  const state = useAppStore.getState();
  return cutPlanePreviewOf({ numericInput: state.numericInput, document: state.document,
    bodies: subShapeBodiesOf(state.bodies), selection: state.selection,
    evaluation: { ...state.parameterAnalysis, lengthUnit: state.displaySettings.lengthUnit } });
}

/** いまのストアの文書の SHA-256。 */
function documentSha(): string {
  return shaOf(useAppStore.getState().document);
}

/** 箱とスケッチの点 (20, 15, 6) の文書を開き、箱と点を選んで切断の入力欄を開く。 */
function openCutOnPoint(): void {
  useAppStore.getState().applyDocument(withSketchPointAt(boxDocument(), 'point-1', ['20', '15', '6']));
  useAppStore.setState({ bodies: [solidBodyOf(FIXTURE)] });
  useAppStore.getState().setSelection([BODY, 'point-1']);
  useAppStore.getState().openNumericInput(createNumericInput('cut', 'cutPlane'), [0, 0]);
}

/** 開いている入力欄へ 1 手(つまみ・選択肢・欄)を加える。 */
function updateCutInput(change: (state: NumericInputState) => NumericInputState): void {
  const current = useAppStore.getState().numericInput;
  if (current === null) throw new Error('入力欄が開いていません');
  useAppStore.getState().updateNumericInput(change(current));
}

describe('予告の表示・切替・取消は文書も元に戻す履歴も変えない(EX-04 W2)', () => {
  beforeEach(resetTestStore);

  it('Esc(取消のボタンと同じ道筋)で予告が 0 になり、文書と元に戻す履歴は増えない', () => {
    openCutOnPoint();
    const before = useAppStore.getState();
    const sha = documentSha();
    const preview = storePreview();
    if (preview === null) throw new Error('予告が出ません');
    planeThrough([0, 0, 1], [20, 15, 6])(preview.plane);
    const input = before.numericInput;
    if (input === null) throw new Error('入力欄が開いていません');
    // ポップアップの Esc と「取消」のボタンは、どちらもこの 1 手(NumericInputPopover の handleKey('Escape'))。
    applyNumericTransition(applyNumericInputKey(input, 'Escape', { ...before.parameterAnalysis,
      lengthUnit: before.displaySettings.lengthUnit }));
    const after = useAppStore.getState();
    expect(after.numericInput).toBeNull();
    expect(storePreview()).toBeNull();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length);
    expect(after.undoStack.future).toHaveLength(before.undoStack.future.length);
    expect(documentSha()).toBe(sha);
    expect(cutsOf(after.document)).toHaveLength(0);
  });

  it('予告の表示・反対側/両側の切替・道具を替えて閉じる、のどの段でも文書の SHA-256 と履歴が変わらない', () => {
    openCutOnPoint();
    const before = useAppStore.getState();
    const sha = documentSha();
    const shown = storePreview();
    expect(shown?.keep).toBe('positive');
    // 反対側を残す: 面はそのまま、残す側だけが逆になる。
    updateCutInput((state) => toggleNumericInput(state, 'cutKeepOpposite'));
    const opposite = storePreview();
    expect(opposite?.keep).toBe('negative');
    expect(opposite?.plane).toEqual(shown?.plane);
    expect(documentSha()).toBe(sha);
    // 両側(反対側も残す): 予告の矢印は 1 つ目の切断の残す側。
    updateCutInput((state) => toggleNumericInput(toggleNumericInput(state, 'cutKeepOpposite'), 'cutKeepBoth'));
    const both = storePreview();
    expect(both?.keep).toBe('positive');
    expect(both?.plane).toEqual(shown?.plane);
    expect(documentSha()).toBe(sha);
    // 決め方を「点と軸」・傾き 15*2 に変えると、予告の面も 30 度傾く(決定と同じ評価器)。
    updateCutInput((state) => reduceNumericInput(chooseNumericInput(state, 'cutPlaneKind', 'pointAndAxis'),
      { type: 'edit', index: 0, source: '15*2' }));
    const tilted = storePreview();
    expect(tilted).not.toBeNull();
    if (tilted !== null) tiltedThrough([20, 15, 6], 30)(tilted.plane);
    expect(documentSha()).toBe(sha);
    // 道具を替えると入力欄が閉じ、予告も消える。文書と元に戻す履歴は開く前のまま。
    useAppStore.getState().setActiveTool('select');
    const after = useAppStore.getState();
    expect(after.numericInput).toBeNull();
    expect(storePreview()).toBeNull();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(documentSha()).toBe(sha);
    // 対照: 同じ材料で決定(Enter)すれば、文書が変わり(SHA-256 が変わる)、元に戻す履歴が 1 段増える。
    useAppStore.getState().setSelection([BODY, 'point-1']);
    useAppStore.getState().openNumericInput(createNumericInput('cut', 'cutPlane'), [0, 0]);
    const reopened = useAppStore.getState();
    if (reopened.numericInput === null) throw new Error('入力欄が開いていません');
    applyNumericTransition(applyNumericInputKey(reopened.numericInput, 'Enter', { ...reopened.parameterAnalysis,
      lengthUnit: reopened.displaySettings.lengthUnit }));
    const committed = useAppStore.getState();
    expect(committed.numericInput).toBeNull();
    expect(cutsOf(committed.document)).toHaveLength(1);
    expect(committed.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(documentSha()).not.toBe(sha);
  });
});
