import { describe, expect, it } from 'vitest';
import { chooseNumericInput, createNumericInput, toggleNumericInput } from '../sketch/numericInput.js';
import { picksHoleEdges, withHoleEdge } from './edgeDistanceHoleInput.js';
import { subShapeElementId } from './subShapeSelection.js';

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
