/**
 * 面の移動の矢印のつまみ(M-05 4-2a)の位置と向き(`faceOffsetHandle.ts`)。
 * 距離は確定と同じ道筋(`previewSolidCommit`)で読む事、出す条件(面の移動の段・平らな面 1 枚・作れた立体)、
 * 外向きの法線の上に欄の距離だけ動かした所へ出る事を確かめる。面の一覧の素性は手で組む(`pushPull.test.ts` と同じ形)。
 */
import type { SolidBody, SolidFaceEntry } from '@pointercad/model';
import { afterEach, describe, expect, it } from 'vitest';

import { createNumericInput, previewSolidCommit, reduceNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import { bodyFor, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { faceOffsetHandleOf } from './faceOffsetHandle.js';
import { subShapeElementId } from './subShapeSelection.js';

afterEach(() => { resetTestStore(); });

function planeFace(index: number, centroid: SolidFaceEntry['centroid'], axis: SolidFaceEntry['axis']): SolidFaceEntry {
  return { index, surfaceKind: 'plane', area: 300, centroid, axis, radius: null, triangleOffset: index, triangleCount: 1 };
}

/** 板(40×30×10)の右の端面(0)・円柱の面(1)・下面(2)・法線が求まらない平らな面(3)・長さ 2 の法線の面(4)。 */
function board(isValid = true): SolidBody {
  return { ...bodyFor('extrude-1'), isValid, faces: [
    planeFace(0, [40, 15, 5], [1, 0, 0]),
    { ...planeFace(1, [10, 15, 5], [0, 0, 1]), surfaceKind: 'cylinder', radius: 3 },
    planeFace(2, [20, 15, 0], [0, 0, -1]),
    planeFace(3, [0, 15, 5], null),
    planeFace(4, [20, 30, 5], [0, 2, 0]),
  ] };
}

const END_FACE = subShapeElementId('extrude-1', 'face', 0);

function distanceInput(source: string): NumericInputState {
  return reduceNumericInput(createNumericInput('faceOffset', 'faceOffsetDistance'), { type: 'edit', index: 0, source });
}

function sourceWith(overrides: Partial<ReturnType<typeof useAppStore.getState>>): ReturnType<typeof useAppStore.getState> {
  resetTestStore();
  return { ...useAppStore.getState(), bodies: [board()], selection: [END_FACE], numericInput: distanceInput('5'), ...overrides };
}

describe('面の移動のつまみは、外向きの法線の上の欄の距離の所に出る(M-05 4-2a)', () => {
  it('右の端面に 5 を打つと、根もとは重心から +X へ 5 の所', () => {
    expect(faceOffsetHandleOf(sourceWith({}))).toEqual({ base: [40, 15, 5], normal: [1, 0, 0], distanceMm: 5, origin: [45, 15, 5] });
  });

  it('負の距離は内側(法線の逆)。式は確定と同じ評価で読む', () => {
    expect(faceOffsetHandleOf(sourceWith({ numericInput: distanceInput('-3') }))?.origin).toEqual([37, 15, 5]);
    expect(faceOffsetHandleOf(sourceWith({ numericInput: distanceInput('2*3') }))?.distanceMm).toBe(6);
  });

  it('距離は確定(previewSolidCommit)の値と同じ。空欄は確定と同じ既定の距離', () => {
    for (const source of ['5', '', '1.25']) {
      const state = sourceWith({ numericInput: distanceInput(source) });
      const commit = previewSolidCommit(distanceInput(source), { ...state.parameterAnalysis, lengthUnit: 'mm' });
      expect(faceOffsetHandleOf(state)?.distanceMm).toBe(commit?.values.faceOffsetDistance?.value);
    }
  });

  it('確定と同じ読み方で読めない欄は距離 0(つまみは面の上)', () => {
    expect(faceOffsetHandleOf(sourceWith({ numericInput: distanceInput('2*') }))).toEqual({
      base: [40, 15, 5], normal: [1, 0, 0], distanceMm: 0, origin: [40, 15, 5],
    });
  });

  it('表示の単位が inch の時は、打った数を inch として mm へ直す(確定と同じ)', () => {
    const state = sourceWith({ numericInput: distanceInput('1') });
    const inch = { ...state, displaySettings: { ...state.displaySettings, lengthUnit: 'inch' as const } };
    expect(faceOffsetHandleOf(inch)?.distanceMm).toBeCloseTo(25.4, 12);
  });

  it('下を向いた面は下へ動く。長さ 1 でない法線は向きだけを使う', () => {
    expect(faceOffsetHandleOf(sourceWith({ selection: [subShapeElementId('extrude-1', 'face', 2)], numericInput: distanceInput('2') }))
      ?.origin).toEqual([20, 15, -2]);
    expect(faceOffsetHandleOf(sourceWith({ selection: [subShapeElementId('extrude-1', 'face', 4)] }))).toMatchObject({
      normal: [0, 1, 0], origin: [20, 35, 5],
    });
  });

  it.each([
    ['入力欄が無い', { numericInput: null }],
    ['面の移動でない段', { numericInput: createNumericInput('faceRotate', 'faceRotateAngle') }],
    ['面が 2 枚', { selection: [END_FACE, subShapeElementId('extrude-1', 'face', 2)] }],
    ['何も選んでいない', { selection: [] }],
    ['立体そのもの', { selection: ['extrude-1'] }],
    ['辺', { selection: [subShapeElementId('extrude-1', 'edge', 0)] }],
    ['円柱の面', { selection: [subShapeElementId('extrude-1', 'face', 1)] }],
    ['法線が求まらない面', { selection: [subShapeElementId('extrude-1', 'face', 3)] }],
    ['一覧に無い面', { selection: [subShapeElementId('extrude-1', 'face', 9)] }],
    ['知らない立体', { selection: [subShapeElementId('extrude-2', 'face', 0)] }],
    ['作れていない立体', { bodies: [board(false)] }],
  ] as const)('%s時は出さない', (_name, overrides) => {
    expect(faceOffsetHandleOf(sourceWith(overrides))).toBeNull();
  });
});
