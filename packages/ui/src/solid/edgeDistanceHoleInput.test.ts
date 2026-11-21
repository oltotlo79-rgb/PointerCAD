import { describe, expect, it } from 'vitest';
import { chooseNumericInput, createNumericInput, toggleNumericInput } from '../sketch/numericInput.js';
import { faceOfEdgePair, picksHoleEdges, withHoleEdge } from './edgeDistanceHoleInput.js';
import { subShapeElementId, type SolidEdgeEntry, type SolidFaceEntry, type SubShapeBody } from './subShapeSelection.js';

/** 辺からの距離の穴(M-02)の、3D で辺を選ぶ間の判定と、選択への辺の足し方。 */
describe('辺からの距離の穴の辺の選び方(M-02)', () => {
  it.each([['hole', 'holeSize'], ['threadHole', 'threadSize']] as const)('%s: 置き方が辺からの距離で、円筒のつまみが切の間だけ辺を拾う', (tool, step) => {
    const initial = createNumericInput(tool, step);
    expect(picksHoleEdges(null)).toBe(false);
    expect(picksHoleEdges(initial)).toBe(false);
    expect(picksHoleEdges(chooseNumericInput(initial, 'holePlacement', 'plane-face'))).toBe(false);
    const byEdges = chooseNumericInput(initial, 'holePlacement', 'edge-distance');
    expect(picksHoleEdges(byEdges)).toBe(true);
    // 辺からの距離を選んでいる間は円筒のつまみが止まり、円筒にすると置き方は点だけになる(拾わない)。
    expect(toggleNumericInput(byEdges, 'cylinderFace')).toBe(byEdges);
    const cylindrical = toggleNumericInput(initial, 'cylinderFace');
    expect(chooseNumericInput(cylindrical, 'holePlacement', 'edge-distance')).toBe(cylindrical);
    expect(picksHoleEdges(cylindrical)).toBe(false);
  });

  it('押した辺は押した順に 2 本まで足し、面は残し、同じ辺は外し、3 本目は最も古い辺を外す', () => {
    const face = subShapeElementId('box-1', 'face', 5);
    const [a, b, c] = [3, 4, 7].map(index => subShapeElementId('box-1', 'edge', index));
    const one = withHoleEdge([face], a);
    expect(one).toEqual([face, a]);
    const two = withHoleEdge(one, b);
    expect(two).toEqual([face, a, b]);
    expect(withHoleEdge(two, a)).toEqual([face, b]);
    expect(withHoleEdge(two, c)).toEqual([face, b, c]);
    expect(withHoleEdge([], a)).toEqual([a]);
  });
});

/** 箱のボディ。面の縁の辺の番号だけが判定に効くので、位置の値は使わない。 */
function boxBody(featureId: string, faces: readonly Pick<SolidFaceEntry, 'index' | 'surfaceKind' | 'boundaryEdgeIndices'>[],
  circles: readonly number[] = []): SubShapeBody {
  const edge = (index: number): SolidEdgeEntry => ({ index, curveKind: circles.includes(index) ? 'circle' : 'line', length: 10,
    midpoint: [0, 0, 0], start: [0, 0, 0], end: [0, 0, 0], axis: null, radius: null, segmentOffset: 0, segmentCount: 0 });
  return { featureId, mesh: { edgePositions: new Float32Array(0) }, vertices: [],
    edges: [0, 1, 2, 3, 4, 5].map(edge),
    faces: faces.map(face => ({ ...face, area: 100, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 2 })) };
}

describe('面を選ばず辺 2 本から、穴をあける面を決める(M-10 ③)', () => {
  const edge = (index: number, body = 'box-1'): string => subShapeElementId(body, 'edge', index);
  const top = { index: 4, surfaceKind: 'plane', boundaryEdgeIndices: [0, 1, 2, 3] } as const;
  const side = { index: 1, surfaceKind: 'plane', boundaryEdgeIndices: [1, 5] } as const;

  it('2 本が縁に入る平らな面が 1 枚だけなら、その面(選んだ順は問わない)', () => {
    const bodies = [boxBody('box-1', [side, top])];
    expect(faceOfEdgePair(bodies, [edge(1), edge(0)])).toBe(subShapeElementId('box-1', 'face', 4));
    expect(faceOfEdgePair(bodies, [edge(0), edge(1)])).toBe(subShapeElementId('box-1', 'face', 4));
    // 向かい合う(平行な)2 本も面は決まる。平行かは確定の時に計算部が断る。
    expect(faceOfEdgePair(bodies, [edge(0), edge(2)])).toBe(subShapeElementId('box-1', 'face', 4));
  });

  it('面に決まらない時は null(縁を共にしない・縁が分からない・曲面・2 枚・円の辺・別の立体・同じ辺・面も選んでいる)', () => {
    const bodies = [boxBody('box-1', [side, top])];
    expect(faceOfEdgePair(bodies, [edge(0), edge(5)])).toBeNull();
    expect(faceOfEdgePair([boxBody('box-1', [{ index: 4, surfaceKind: 'plane' }])], [edge(0), edge(1)])).toBeNull();
    expect(faceOfEdgePair([boxBody('box-1', [{ ...top, surfaceKind: 'cylinder' }])], [edge(0), edge(1)])).toBeNull();
    expect(faceOfEdgePair([boxBody('box-1', [top, { ...top, index: 5 }])], [edge(0), edge(1)])).toBeNull();
    expect(faceOfEdgePair([boxBody('box-1', [top], [1])], [edge(0), edge(1)])).toBeNull();
    expect(faceOfEdgePair([...bodies, boxBody('box-2', [top])], [edge(0), edge(1, 'box-2')])).toBeNull();
    expect(faceOfEdgePair(bodies, [edge(0), edge(0)])).toBeNull();
    expect(faceOfEdgePair(bodies, [subShapeElementId('box-1', 'face', 4), edge(0), edge(1)])).toBeNull();
    expect(faceOfEdgePair(bodies, [edge(0)])).toBeNull();
  });
});
