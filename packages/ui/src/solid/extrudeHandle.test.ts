import {
  absoluteCoordinate, addSketch, appendFeature, createEmptyPartDocument, createSketchFor, replaceSketch, resolveSketch,
  type SketchDocument, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { createNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { distanceHandleOf } from './extrudeHandle.js';
import { subShapeElementId } from './subShapeSelection.js';

const corners: readonly Vec3[] = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]];

function withFace(sketch: SketchDocument, id: string): SketchDocument {
  const boundary = corners.map((_, index) => ({ featureId: `${id}-corner-${String(index + 1)}` }));
  const withPoints = corners.reduce((current, point, index) => appendFeature(current, {
    id: boundary[index].featureId, name: boundary[index].featureId, planeId: 'xy', kind: 'point',
    at: absoluteCoordinate(...point),
  }), sketch);
  return appendFeature(withPoints, { id, name: id, planeId: 'xy', kind: 'face', boundary, color: '#808080' });
}

function profileState() {
  const empty = createEmptyPartDocument();
  const first = withFace(empty.sketches[0], 'face-1');
  const sketch = appendFeature(first, {
    id: 'face-2', name: 'face-2', planeId: 'xy', kind: 'face', color: '#808080',
    boundary: corners.map((_, index) => ({ featureId: `face-1-corner-${String(index + 1)}` })),
  });
  const otherSketch = withFace(createSketchFor(empty), 'face-3');
  return {
    ...useAppStore.getState(),
    document: addSketch(replaceSketch(empty, sketch), otherSketch),
    sketch,
    resolvedSketch: resolveSketch(sketch),
    selection: ['face-1'],
    numericInput: createNumericInput('extrude', 'extrudeDistance'),
  };
}

describe('押し出しの矢印のつまみ(M-05 4-2b)', () => {
  it('片側の根もとは標本の平均から距離だけ押し出した先端に出る', () => {
    expect(distanceHandleOf(profileState())).toEqual({
      base: [20, 15, 0], normal: [0, 0, 1], distanceMm: 10, origin: [20, 15, 10],
      fieldKey: 'distance', scale: 1, positiveOnly: true,
    });
  });

  it.each([
    ['reversed', [0, 0, -1], [20, 15, -10], 1],
    ['symmetric', [0, 0, 1], [20, 15, 5], 0.5],
  ] as const)('%s のときの向き・先端・倍率を使う', (key, normal, origin, scale) => {
    const state = profileState();
    const numericInput = reduceNumericInput(state.numericInput, { type: 'toggle', key });
    expect(distanceHandleOf({ ...state, numericInput })).toMatchObject({ normal, origin, scale });
  });

  it('確定と同じ読み方で読めない欄は距離 0 になり、反転と両側の設定は残る', () => {
    const state = profileState();
    const reversed = reduceNumericInput(state.numericInput, { type: 'toggle', key: 'reversed' });
    const symmetric = reduceNumericInput(reversed, { type: 'toggle', key: 'symmetric' });
    const numericInput = reduceNumericInput(symmetric, { type: 'edit', index: 0, source: '2*' });
    const handle = distanceHandleOf({ ...state, numericInput });
    expect(handle).toMatchObject({ distanceMm: 0, origin: [20, 15, 0], scale: 0.5 });
    expect(handle?.normal[2]).toBe(-1);
  });

  it.each(['toFace', 'toNext'] as const)('終わり方が %s のときは出さない', value => {
    const state = profileState();
    const numericInput = reduceNumericInput(state.numericInput, { type: 'choose', key: 'extrudeEnd', value });
    expect(distanceHandleOf({ ...state, numericInput })).toBeNull();
  });

  it.each([
    ['面が複数', ['face-1', 'face-2']],
    ['別のスケッチの面', ['face-3']],
    ['立体の面', [subShapeElementId('extrude-1', 'face', 0)]],
  ] as const)('%sのときは出さない', (_name, selection) => {
    expect(distanceHandleOf({ ...profileState(), selection })).toBeNull();
  });

  it('閉じた領域からの押し出しでは出さない', () => {
    const state = profileState();
    const numericInput = {
      ...state.numericInput,
      extrudeRegion: { sketchId: state.sketch.id, planeId: 'xy' as const, boundary: [{ featureId: 'face-1-corner-1' }] },
    };
    expect(distanceHandleOf({ ...state, numericInput })).toBeNull();
  });
});
