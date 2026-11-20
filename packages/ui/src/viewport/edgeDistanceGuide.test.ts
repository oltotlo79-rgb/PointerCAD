import { beforeEach, describe, expect, it } from 'vitest';
import type { SolidBody } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { chooseNumericInput, createNumericInput, reduceNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { edgeDistanceGuide } from './edgeDistanceGuide.js';
import { isPlanarBasisGuideCurrent } from './planarBasisGuide.js';

beforeEach(resetTestStore);
const labels = { center: '穴の中心', edge1: '辺1', edge2: '辺2' };

/** 60×40 の板の上面(z = 10、三角形 2 枚)と、上面の縁の手前の辺(0)・右の辺(1)。期待は製品の式を使わずに手で書く。 */
function plate(): SolidBody {
  return {
    featureId: 'plate',
    mesh: {
      positions: new Float32Array([0, 0, 10, 60, 0, 10, 60, 40, 10, 0, 40, 10]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      edgePositions: new Float32Array([0, 0, 10, 60, 0, 10, 60, 0, 10, 60, 40, 10]),
      triangleCount: 2,
    },
    coordinateFrame: { space: 'local', origin: [0, 0, 0], maximumFloat32ErrorMm: 0.001, maximumLiveMeshBytes: 1000 },
    volume: 24000, isValid: true,
    faces: [{ index: 0, surfaceKind: 'plane', area: 2400, centroid: [30, 20, 10], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 2 }],
    edges: [
      { index: 0, curveKind: 'line', length: 60, midpoint: [30, 0, 10], start: [0, 0, 10], end: [60, 0, 10], axis: [1, 0, 0],
        radius: null, segmentOffset: 0, segmentCount: 1 },
      { index: 1, curveKind: 'line', length: 40, midpoint: [60, 20, 10], start: [60, 0, 10], end: [60, 40, 10], axis: [0, 1, 0],
        radius: null, segmentOffset: 1, segmentCount: 1 },
    ],
    vertices: [], threadMarks: [],
  };
}

function holeInput(placement: string, distances: readonly [string, string]): NumericInputState {
  let input = chooseNumericInput(createNumericInput('hole', 'holeSize'), 'holePlacement', placement);
  distances.forEach((source, offset) => {
    const index = input.fields.findIndex(field => field.key === (offset === 0 ? 'holeEdgeDistance1' : 'holeEdgeDistance2'));
    if (index >= 0) input = reduceNumericInput(input, { type: 'edit', index, source });
  });
  return input;
}

function fixture(selection: readonly string[], numericInput: NumericInputState): AppState {
  const initial = useAppStore.getState(), document = initial.document;
  const bodies = [plate()];
  return { ...initial, document, activeDocumentId: 'session', bodies, selection, numericInput,
    assembly: null, drawing: null, stagedSolid: null, sheetMetalTool: null, sheetMetalPreview: null,
    requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success', isComputing: false, recomputeCancelled: false,
    timelineIndex: null, mathGeometryResult: { document, generation: 7, evaluated: true, outcomes: new Map() },
    meshJsAccounting: { document, bodies, bodyLayouts: bodies.map(captureMeshBodyLayout), activeDocumentId: 'session',
      timelineIndex: null, outcome: 'success', receipt: { documentId: document.id, partId: 'part-native', generation: 7,
        reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 100,
          cacheProtectedBytes: 200, retainedReplyBytes: 200, requestPeakReservedBytes: 900 },
        final: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 0,
          cacheProtectedBytes: 100, hiddenBackingBytes: 0, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 160,
          replyCloneReservedBytes: 60 } } } };
}

const FACE = 'plate#face:0', FRONT = 'plate#edge:0', RIGHT = 'plate#edge:1';

describe('辺からの距離の穴の 3D の寸法線(M-02)', () => {
  it('右の辺(辺 1)から 8・手前の辺(辺 2)から 12 の中心 (52, 12, 10) へ、2 本の辺の足から寸法線を引く', () => {
    const state = fixture([FACE, RIGHT, FRONT], holeInput('edge-distance', ['8', '12']));
    const before = state.measurement;
    const guide = edgeDistanceGuide(state, labels);
    if (guide === null) throw new Error('予告が出ない');
    const near = (actual: readonly number[] | undefined, expected: readonly number[]) => {
      if (actual === undefined) throw new Error('点が無い');
      expect(Math.hypot(...actual.map((value, index) => value - expected[index]))).toBeLessThanOrEqual(1e-6);
    };
    near(guide.drawing.result.segment?.[1], [52, 12, 10]);
    near(guide.xDrawing.result.segment?.[0], [60, 12, 10]);
    near(guide.yDrawing.result.segment?.[0], [52, 0, 10]);
    expect([guide.drawing.text, guide.xDrawing.text, guide.yDrawing.text]).toEqual([labels.center, labels.edge1, labels.edge2]);
    expect([guide.xDrawing.result.value, guide.yDrawing.result.value]).toEqual([8, 12]);
    expect(isPlanarBasisGuideCurrent(guide, state)).toBe(true);
    expect(state.measurement).toBe(before);
  });

  it('面内 X・Y の時・辺が 1 本の時・距離が欠けた時・中心が面の外の時は出さない', () => {
    expect(edgeDistanceGuide(fixture([FACE, RIGHT, FRONT], holeInput('plane-face', ['8', '12'])), labels)).toBeNull();
    expect(edgeDistanceGuide(fixture([FACE, RIGHT], holeInput('edge-distance', ['8', '12'])), labels)).toBeNull();
    expect(edgeDistanceGuide(fixture([FACE, RIGHT, FRONT], holeInput('edge-distance', ['8', ''])), labels)).toBeNull();
    expect(edgeDistanceGuide(fixture([FACE, RIGHT, FRONT], holeInput('edge-distance', ['70', '12'])), labels)).toBeNull();
  });
});
