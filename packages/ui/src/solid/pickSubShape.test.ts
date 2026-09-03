import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@pointercad/model';

import { PICK_RADIUS_PIXELS } from '../sketch/pickMath.js';

import {
  faceIndexOfTriangle,
  pickSolidSubShape,
  SUB_SHAPE_PICK_RADIUS_PIXELS,
} from './pickSubShape.js';
import type { SolidEdgeEntry, SolidFaceEntry, SubShapeBody } from './subShapeSelection.js';

/** 画面座標は x・y をそのまま使う(奥行き z は捨てる = 深度を見ない、§0.a-0.27)。 */
const project = (point: Vec3): readonly [number, number] => [point[0], point[1]];

/** カメラの裏に回って写せない状態。 */
const projectNothing = (): null => null;

/**
 * 稜線の線分列(1 本あたり 6 個)。
 * 0: 表の辺(0,0,0)-(100,0,0) / 1: 表の辺(100,0,0)-(100,100,0)
 * 2: 裏の辺(0,1,-50)-(100,1,-50) / 3: 長さ 0 に退化した辺(200,200,0)
 */
const EDGE_POSITIONS = new Float32Array([
  0, 0, 0, 100, 0, 0,
  100, 0, 0, 100, 100, 0,
  0, 1, -50, 100, 1, -50,
  200, 200, 0, 200, 200, 0,
]);

function lineEdge(
  index: number,
  segmentOffset: number,
  start: Vec3,
  end: Vec3,
): SolidEdgeEntry {
  const midpoint: Vec3 = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
    (start[2] + end[2]) / 2,
  ];
  return {
    index,
    curveKind: 'line',
    length: Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    midpoint,
    start,
    end,
    axis: null,
    radius: null,
    segmentOffset,
    segmentCount: 1,
  };
}

const BOX: SubShapeBody = {
  featureId: 'box',
  mesh: { edgePositions: EDGE_POSITIONS },
  faces: [
    {
      index: 0,
      surfaceKind: 'plane',
      area: 100,
      centroid: [50, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 2,
    },
  ],
  edges: [
    lineEdge(0, 0, [0, 0, 0], [100, 0, 0]),
    lineEdge(1, 1, [100, 0, 0], [100, 100, 0]),
    lineEdge(2, 2, [0, 1, -50], [100, 1, -50]),
    lineEdge(3, 3, [200, 200, 0], [200, 200, 0]),
  ],
  vertices: [
    { index: 0, position: [0, 0, 0] },
    { index: 1, position: [100, 0, 0] },
    { index: 2, position: [200, 200, 0] },
  ],
};

/** 2 つ目のボディ。ボディをまたいで近いほうを選べることを確かめるために置く。 */
const PIN: SubShapeBody = {
  featureId: 'hole-1',
  mesh: { edgePositions: new Float32Array([0, 40, 0, 100, 40, 0]) },
  faces: [],
  edges: [lineEdge(0, 0, [0, 40, 0], [100, 40, 0])],
  vertices: [{ index: 0, position: [0, 40, 0] }],
};

const BODIES: readonly SubShapeBody[] = [BOX, PIN];

describe('立体の部分形状の当たり判定(FR-106、§2.3.2)', () => {
  it('判定の半径はスケッチ要素と同じ 6px', () => {
    expect(SUB_SHAPE_PICK_RADIUS_PIXELS).toBe(PICK_RADIUS_PIXELS);
    expect(SUB_SHAPE_PICK_RADIUS_PIXELS).toBe(6);
  });

  it('頂点の真上では、その頂点を拾う', () => {
    expect(pickSolidSubShape(BODIES, project, [0, 0], 'vertex')).toEqual({
      elementId: 'box#vertex:0',
      kind: 'vertex',
      distance: 0,
    });
  });

  it('近い頂点が 2 つあるときは画面上で近いほうを拾う', () => {
    // (98,0) から 頂点1(100,0)まで 2、頂点0(0,0)まで 98。
    expect(pickSolidSubShape(BODIES, project, [98, 0], 'vertex')).toEqual({
      elementId: 'box#vertex:1',
      kind: 'vertex',
      distance: 2,
    });
  });

  it('辺の近くでは、その辺を拾う', () => {
    // (50,-2) から 辺0(y = 0)まで 2、裏の辺2(y = 1)まで 3。頂点はどれも 50 以上離れている。
    expect(pickSolidSubShape(BODIES, project, [50, -2], 'edge')).toEqual({
      elementId: 'box#edge:0',
      kind: 'edge',
      distance: 2,
    });
  });

  it('頂点と辺が両方 6px 以内なら頂点が勝つ', () => {
    // (3,3) から 辺0(y = 0 の横線)まで 3、頂点0 まで √18 ≈ 4.243。辺のほうが近いが頂点を取る。
    expect(pickSolidSubShape(BODIES, project, [3, 3], 'edge')).toEqual({
      elementId: 'box#vertex:0',
      kind: 'vertex',
      distance: Math.hypot(3, 3),
    });
  });

  it('種類が頂点のときは辺を拾わない', () => {
    expect(pickSolidSubShape(BODIES, project, [50, -2], 'vertex')).toBeNull();
  });

  it('裏側(面に隠れた)の辺も画面上の近さだけで拾う(§0.a-0.27)', () => {
    // 辺2 は z = -50 の裏側にあるが、画面では (50,1) にあり 辺0(距離 1)より近い。
    expect(pickSolidSubShape(BODIES, project, [50, 1], 'edge')).toEqual({
      elementId: 'box#edge:2',
      kind: 'edge',
      distance: 0,
    });
  });

  it('ボディをまたいで近いほうを拾う', () => {
    // (50,38) から hole-1 の辺0(y = 40)まで 2、box の辺0(y = 0)まで 38。
    expect(pickSolidSubShape(BODIES, project, [50, 38], 'edge')).toEqual({
      elementId: 'hole-1#edge:0',
      kind: 'edge',
      distance: 2,
    });
  });

  it('長さ 0 に退化した辺でも 0 除算せず、点までの距離で拾う', () => {
    // 辺3 は始点と終点が同じ (200,200)。頂点2 も同じ位置にあるので、辺だけを見る種類で確かめる。
    expect(pickSolidSubShape(BODIES, project, [203, 204], 'edge')).toEqual({
      elementId: 'box#vertex:2',
      kind: 'vertex',
      distance: 5,
    });
    expect(pickSolidSubShape([{ ...BOX, vertices: [] }], project, [203, 204], 'edge')).toEqual({
      elementId: 'box#edge:3',
      kind: 'edge',
      distance: 5,
    });
  });

  it('判定の半径ちょうどは拾い、外れたら拾わない', () => {
    // (50,-6) は 辺0 までちょうど 6、裏の辺2 までは 7。
    expect(pickSolidSubShape(BODIES, project, [50, -6], 'edge')?.elementId).toBe('box#edge:0');
    expect(pickSolidSubShape(BODIES, project, [50, -6.5], 'edge')).toBeNull();
    expect(pickSolidSubShape(BODIES, project, [0, 6], 'vertex')?.elementId).toBe('box#vertex:0');
    expect(pickSolidSubShape(BODIES, project, [0, 6.5], 'vertex')).toBeNull();
  });

  it('近くに何も無ければ null', () => {
    expect(pickSolidSubShape(BODIES, project, [50, 20], 'edge')).toBeNull();
    expect(pickSolidSubShape([], project, [0, 0], 'edge')).toBeNull();
  });

  it('写せない(カメラの裏の)点しか無くても例外にならない', () => {
    expect(pickSolidSubShape(BODIES, projectNothing, [0, 0], 'vertex')).toBeNull();
    expect(pickSolidSubShape(BODIES, projectNothing, [0, 0], 'edge')).toBeNull();
  });

  it('範囲表が線分の並びの外を指していても例外にならない', () => {
    const broken: SubShapeBody = {
      ...BOX,
      vertices: [],
      edges: [lineEdge(0, 100, [0, 0, 0], [100, 0, 0])],
    };
    expect(pickSolidSubShape([broken], project, [50, 0], 'edge')).toBeNull();
  });

  it('面はここでは拾わない(深度が要るので Raycaster の側で拾う)', () => {
    expect(pickSolidSubShape(BODIES, project, [50, 0], 'face')).toBeNull();
  });

  it('判定の半径を狭めると拾わなくなる', () => {
    expect(pickSolidSubShape(BODIES, project, [50, -2], 'edge', 1)).toBeNull();
    expect(pickSolidSubShape(BODIES, project, [50, -2], 'edge', 3)?.elementId).toBe('box#edge:0');
  });
});

describe('三角形の番号から面の通し番号を引く(FR-106)', () => {
  /** 面 1 枚ぶんの素性。範囲だけを差し替えて使う。 */
  function face(index: number, triangleOffset: number, triangleCount: number): SolidFaceEntry {
    return {
      index,
      surfaceKind: 'plane',
      area: 1,
      centroid: [0, 0, 0],
      axis: null,
      radius: null,
      triangleOffset,
      triangleCount,
    };
  }

  /** 範囲表 [0,2)・[2,4)・[4,6)。 */
  const RANGES: readonly SolidFaceEntry[] = [face(0, 0, 2), face(1, 2, 2), face(2, 4, 2)];

  it('範囲の中の三角形はその面を返す', () => {
    expect(faceIndexOfTriangle(RANGES, 0)).toBe(0);
    expect(faceIndexOfTriangle(RANGES, 1)).toBe(0);
    expect(faceIndexOfTriangle(RANGES, 3)).toBe(1);
    expect(faceIndexOfTriangle(RANGES, 4)).toBe(2);
    expect(faceIndexOfTriangle(RANGES, 5)).toBe(2);
  });

  it('範囲の外・整数でない番号・空の一覧は null', () => {
    expect(faceIndexOfTriangle(RANGES, 6)).toBeNull();
    expect(faceIndexOfTriangle(RANGES, -1)).toBeNull();
    expect(faceIndexOfTriangle(RANGES, 1.5)).toBeNull();
    expect(faceIndexOfTriangle(RANGES, Number.NaN)).toBeNull();
    expect(faceIndexOfTriangle([], 0)).toBeNull();
  });

  it('三角形が 0 枚の面は飛ばして、次の面を返す', () => {
    const withEmpty: readonly SolidFaceEntry[] = [face(0, 0, 2), face(1, 2, 0), face(2, 2, 3)];
    expect(faceIndexOfTriangle(withEmpty, 1)).toBe(0);
    expect(faceIndexOfTriangle(withEmpty, 2)).toBe(2);
    expect(faceIndexOfTriangle(withEmpty, 4)).toBe(2);
    expect(faceIndexOfTriangle(withEmpty, 5)).toBeNull();
  });

  it('末尾の面が三角形 0 枚でも、その先の番号は null', () => {
    const trailingEmpty: readonly SolidFaceEntry[] = [face(0, 0, 2), face(1, 2, 0)];
    expect(faceIndexOfTriangle(trailingEmpty, 1)).toBe(0);
    expect(faceIndexOfTriangle(trailingEmpty, 2)).toBeNull();
  });

  it('返すのは並びの位置ではなく面の通し番号', () => {
    expect(faceIndexOfTriangle([face(7, 0, 2)], 1)).toBe(7);
  });
});
