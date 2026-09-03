import type { Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import type { SolidEdgeEntry, SolidFaceEntry, SolidVertexEntry } from '../solid/subShapeSelection.js';

import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import { buildSubShapeGeometry, EMPTY_SUB_SHAPE_HIGHLIGHT } from './buildSubShapeGeometry.js';

/**
 * 4 三角形(12 頂点、頂点は三角形どうしで共有しない)を持つボディ。
 * 頂点 k の座標・法線はどちらも (k, k, k) にして、値が正しく写っているかを確かめやすくする。
 * 面 0 は三角形 0・1(頂点 0-5)、面 1 は三角形 2・3(頂点 6-11)。
 */
function makePositions(vertexCount: number): Float32Array {
  const values = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    values[vertex * 3] = vertex;
    values[vertex * 3 + 1] = vertex;
    values[vertex * 3 + 2] = vertex;
  }
  return values;
}

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

function edge(
  index: number,
  segmentOffset: number,
  segmentCount: number,
  start: Vec3,
  end: Vec3,
): SolidEdgeEntry {
  return {
    index,
    curveKind: 'line',
    length: Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
    start,
    end,
    axis: null,
    radius: null,
    segmentOffset,
    segmentCount,
  };
}

function vertex(index: number, position: Vec3): SolidVertexEntry {
  return { index, position };
}

const BODY: SolidBodyWithSubShapes = {
  featureId: 'extrude-1',
  mesh: {
    positions: makePositions(12),
    normals: makePositions(12),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    edgePositions: Float32Array.from([
      0, 0, 0, 10, 0, 0,
      10, 0, 0, 10, 10, 0,
    ]),
    triangleCount: 4,
  },
  volume: 1000,
  isValid: true,
  faces: [face(0, 0, 2), face(1, 2, 2)],
  edges: [edge(0, 0, 1, [0, 0, 0], [10, 0, 0]), edge(1, 1, 1, [10, 0, 0], [10, 10, 0])],
  vertices: [vertex(0, [0, 0, 0]), vertex(1, [10, 0, 0]), vertex(2, [10, 10, 0])],
  threadMarks: [],
};

/** 部分形状の一覧が空のボディ。強調は何も描かない。 */
const BODY_WITHOUT_SUB_SHAPES: SolidBodyWithSubShapes = {
  featureId: 'revolve-1',
  mesh: BODY.mesh,
  volume: 500,
  isValid: true,
  faces: [],
  edges: [],
  vertices: [],
  threadMarks: [],
};

/** 4 辺が輪になって隣どうしで頂点を共有する正方形(§0.a-0.23-⑩ の重複除去の検査用)。 */
const SQUARE: SolidBodyWithSubShapes = {
  featureId: 'sketch-loop',
  mesh: {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    edgePositions: new Float32Array(0),
    triangleCount: 0,
  },
  volume: 0,
  isValid: true,
  faces: [],
  edges: [
    edge(0, 0, 0, [0, 0, 0], [10, 0, 0]),
    edge(1, 0, 0, [10, 0, 0], [10, 10, 0]),
    edge(2, 0, 0, [10, 10, 0], [0, 10, 0]),
    edge(3, 0, 0, [0, 10, 0], [0, 0, 0]),
  ],
  vertices: [],
  threadMarks: [],
};

describe('buildSubShapeGeometry(FR-105、FR-106、§0.a-0.7)', () => {
  it('ホバーも選択も無ければ空(同じ入れ物を返す)', () => {
    const bundle = buildSubShapeGeometry([BODY], null, []);
    expect(bundle).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT);
    expect(bundle.hovered.facePositions.length).toBe(0);
    expect(bundle.selected.facePositions.length).toBe(0);
    expect(bundle.faceTriangleCount).toBe(0);
    expect(bundle.edgeCount).toBe(0);
    expect(bundle.vertexCount).toBe(0);
  });

  it('面 1 枚を選択すると、その面の三角形数 × 9 個の位置が積まれる', () => {
    const bundle = buildSubShapeGeometry([BODY], null, ['extrude-1#face:0']);
    expect(bundle.selected.facePositions.length).toBe(2 * 9);
    expect(bundle.selected.faceNormals.length).toBe(2 * 9);
    expect(bundle.selected.faceIndices.length).toBe(2 * 3);
    expect(bundle.hovered).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT.hovered);
  });

  it('面 1 枚をホバーすると hovered に入り、selected は空のまま', () => {
    const bundle = buildSubShapeGeometry([BODY], 'extrude-1#face:0', []);
    expect(bundle.hovered.facePositions.length).toBe(2 * 9);
    expect(bundle.selected).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT.selected);
  });

  it('同じ面をホバーかつ選択すると、selected にだけ入る(二重描きしない)', () => {
    const bundle = buildSubShapeGeometry([BODY], 'extrude-1#face:0', ['extrude-1#face:0']);
    expect(bundle.selected.facePositions.length).toBe(2 * 9);
    expect(bundle.hovered).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT.hovered);
  });

  it('辺 2 本を選択すると、線分の合計 × 6 個の位置が積まれる', () => {
    const bundle = buildSubShapeGeometry(
      [BODY],
      null,
      ['extrude-1#edge:0', 'extrude-1#edge:1'],
    );
    expect(bundle.selected.edgePositions.length).toBe(2 * 6);
  });

  it('頂点 1 つを選択すると 3 個の位置になる', () => {
    const bundle = buildSubShapeGeometry([BODY], null, ['extrude-1#vertex:0']);
    expect(bundle.selected.vertexPositions.length).toBe(3);
    expect([...bundle.selected.vertexPositions]).toEqual([0, 0, 0]);
  });

  it('番号が範囲外の参照は飛ばされ、例外にならない', () => {
    const bundle = buildSubShapeGeometry([BODY], null, ['extrude-1#face:99']);
    expect(bundle).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT);
  });

  it('ボディに無い id は飛ばされる', () => {
    const bundle = buildSubShapeGeometry([BODY], null, ['missing-1#face:0']);
    expect(bundle).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT);
  });

  it('スケッチ要素の id(point-1#3)は飛ばされる', () => {
    const bundle = buildSubShapeGeometry([BODY], 'point-1#3', ['point-1#3', 'pa1#0']);
    expect(bundle).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT);
  });

  it('部分形状の一覧を持たないボディ(タスク17 前)は黙って飛ばす', () => {
    const bundle = buildSubShapeGeometry(
      [BODY_WITHOUT_SUB_SHAPES],
      'revolve-1#face:0',
      ['revolve-1#edge:0', 'revolve-1#vertex:0'],
    );
    expect(bundle).toBe(EMPTY_SUB_SHAPE_HIGHLIGHT);
  });

  it('同じ入力を 2 回組み立てると同じ結果になる(決定性)', () => {
    const selection = ['extrude-1#face:0', 'extrude-1#edge:1'];
    const first = buildSubShapeGeometry([BODY], 'extrude-1#vertex:2', selection);
    const second = buildSubShapeGeometry([BODY], 'extrude-1#vertex:2', selection);
    expect([...first.selected.facePositions]).toEqual([...second.selected.facePositions]);
    expect([...first.selected.edgePositions]).toEqual([...second.selected.edgePositions]);
    expect([...first.hovered.vertexPositions]).toEqual([...second.hovered.vertexPositions]);
  });

  it('faceIndexOfTriangle が返す面の三角形が、選択した面の並びと一致する', () => {
    // 三角形 2・3 は面 1(triangleOffset 2, triangleCount 2)の範囲。
    expect(faceIndexOfTriangle(BODY.faces ?? [], 2)).toBe(1);
    expect(faceIndexOfTriangle(BODY.faces ?? [], 3)).toBe(1);

    const bundle = buildSubShapeGeometry([BODY], null, ['extrude-1#face:1']);
    // 頂点 6..11(indices[6..11])の座標がそのまま入っているはず。
    const expected: number[] = [];
    for (let vertexIndex = 6; vertexIndex <= 11; vertexIndex += 1) {
      expected.push(vertexIndex, vertexIndex, vertexIndex);
    }
    expect([...bundle.selected.facePositions]).toEqual(expected);
  });

  it('選択した辺の端点の点が入り、共有する頂点は重複を除いて 1 点にまとめる(§0.a-0.23-⑩)', () => {
    const bundle = buildSubShapeGeometry(
      [SQUARE],
      null,
      ['sketch-loop#edge:0', 'sketch-loop#edge:1', 'sketch-loop#edge:2', 'sketch-loop#edge:3'],
    );
    // 4 辺・8 個の端点の言及だが、隣どうしで共有するので実際は 4 点(重複を除く)。
    expect(bundle.selected.vertexPositions.length).toBe(4 * 3);
  });

  it('ホバー中の辺には端点の点を出さない(選択との差、§0.a-0.23-⑩)', () => {
    const bundle = buildSubShapeGeometry([BODY], 'extrude-1#edge:0', []);
    expect(bundle.hovered.edgePositions.length).toBe(1 * 6);
    expect(bundle.hovered.vertexPositions.length).toBe(0);
  });

  it('頂点を直接ホバーすると、辺の端点とは違い hovered にも点が入る', () => {
    const bundle = buildSubShapeGeometry([BODY], 'extrude-1#vertex:1', []);
    expect(bundle.hovered.vertexPositions.length).toBe(3);
    expect([...bundle.hovered.vertexPositions]).toEqual([10, 0, 0]);
  });

  it('faceIndices は三角形どうしで頂点を共有しない連番になる(0 始まり)', () => {
    const bundle = buildSubShapeGeometry([BODY], null, ['extrude-1#face:0']);
    expect([...bundle.selected.faceIndices]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
