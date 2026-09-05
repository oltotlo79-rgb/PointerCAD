/**
 * `kernelBridge.ts` の `measure`(FR-1101、FR-1102、P5 タスク29)の橋渡しの検査。
 *
 * 実物の OCCT は起こさず、`KernelApi.measure` だけを差し替えた偽物で
 * ①対象の立体を「段の鍵」へ正しく引き直すこと、②鍵が引けない対象があるときは
 * カーネルを呼ばずに断ること、③kernel の結果を model の `MeasureOutcome` へ
 * そのまま詰め替えること、を確かめる(kernel との実配線は P5 タスク28 の
 * `kernel/src/worker/kernelApi.test.ts` が実 OCCT で確かめ済み)。
 */

import { describe, expect, it, vi } from 'vitest';

import type { KernelApi, MeasureRequest, MeasureResult } from '@pointercad/kernel';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createDirectKernelBridge, type KernelBridge, type MeasureTarget } from '../kernelBridge.js';
import type { ResolvedSolidStep } from '../part/resolvePart.js';

/** 呼ばれてはいけないメソッドが呼ばれたときにすぐ分かるようにする。 */
function unimplemented(name: string): never {
  throw new Error(`このテストでは呼ばれないはずのメソッド: ${name}`);
}

/** `measure` だけを差し替えた偽の `KernelApi`。他のメソッドは呼ばれない前提。 */
function createFakeKernelApi(measureImpl: (request: MeasureRequest) => Promise<MeasureResult>): KernelApi {
  return {
    tessellateSketch: () => unimplemented('tessellateSketch'),
    recomputeSolids: () => unimplemented('recomputeSolids'),
    offsetSketchCurves: () => unimplemented('offsetSketchCurves'),
    projectSketchCurves: () => unimplemented('projectSketchCurves'),
    sectionSketchCurves: () => unimplemented('sectionSketchCurves'),
    measure: measureImpl,
  };
}

/** 基本形状(球)の段 1 つ。`measure` は plan の中身を見ないので、型を満たすだけの値。 */
function fakeStep(featureId: string, key: string): ResolvedSolidStep {
  return {
    featureId,
    name: featureId,
    key,
    visible: true,
    plan: {
      kind: 'primitive',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      shape: { kind: 'sphere', radius: 10 },
      originQuery: null,
      targetKey: null,
    },
  };
}

const FACE_REF: SubShapeRef = {
  bodyFeatureId: 'body-1',
  index: 3,
  fingerprint: {
    kind: 'face',
    surfaceKind: 'plane',
    area: 1200,
    position: [5, 5, 0],
    axis: [0, 0, 1],
    radius: null,
  },
};

describe('KernelBridge.measure', () => {
  it('鍵が引けない対象があるときはカーネルを呼ばずに断る(§0.a-0.30)', async () => {
    const measureImpl = vi.fn<(request: MeasureRequest) => Promise<MeasureResult>>();
    const bridge: KernelBridge = createDirectKernelBridge(createFakeKernelApi(measureImpl));

    const targets: readonly MeasureTarget[] = [
      { bodyFeatureId: 'body-1', subShape: null },
      { bodyFeatureId: 'body-2', subShape: null },
    ];
    // steps に 'body-2' が無い(消えた・まだ計算していない)。
    const result = await bridge.measure([fakeStep('body-1', 'key-1')], targets, 'distance');

    expect(result).toEqual({
      kind: 'failed',
      // kernelBridge.ts の MEASURE_MISSING_SHAPE_MESSAGE と同じ文言(kernel の
      // kernelApi.ts の MEASURE_MISSING_SHAPE_MESSAGE をそのまま複製したもの)。
      message: '測れませんでした。もう一度お試しください。',
    });
    expect(measureImpl).not.toHaveBeenCalled();
  });

  it('対象を段の鍵へ引き直し、部分形状の指紋を kernel の SubShapeQuery へ詰め替えて渡す', async () => {
    let receivedRequest: MeasureRequest | undefined;
    const measureImpl = (request: MeasureRequest): Promise<MeasureResult> => {
      receivedRequest = request;
      return Promise.resolve({
        kind: 'distance',
        distance: 37.416573867739416,
        pointA: [0, 0, 0],
        pointB: [10, 20, 30],
        inner: false,
      });
    };
    const bridge = createDirectKernelBridge(createFakeKernelApi(measureImpl));

    const targets: readonly MeasureTarget[] = [
      { bodyFeatureId: 'body-1', subShape: FACE_REF },
      { bodyFeatureId: 'body-2', subShape: null },
    ];
    const steps = [fakeStep('body-1', 'key-1'), fakeStep('body-2', 'key-2')];

    const outcome = await bridge.measure(steps, targets, 'distance');

    expect(receivedRequest).toEqual({
      kind: 'distance',
      targets: [
        {
          bodyKey: 'key-1',
          subShape: {
            kind: 'face',
            index: 3,
            surfaceKind: 'plane',
            area: 1200,
            position: [5, 5, 0],
            axis: [0, 0, 1],
            radius: null,
          },
        },
        { bodyKey: 'key-2', subShape: null },
      ],
    });
    expect(outcome).toEqual({
      kind: 'distance',
      distance: 37.416573867739416,
      pointA: [0, 0, 0],
      pointB: [10, 20, 30],
      inner: false,
    });
  });

  it('質量特性の結果をそのまま model の言葉へ詰め替える(密度は掛けない)', async () => {
    // 数値は詰め替えが値を触らないことだけを確かめる仮の値(物理量としての妥当性は
    // kernel/src/occt/measureShape.test.ts が実 OCCT で確かめ済み)。3 軸で別の値にして、
    // 並びを取り違えていないことも確かめる。
    const measureImpl = (): Promise<MeasureResult> =>
      Promise.resolve({
        kind: 'massProperties',
        volume: 4188.79,
        area: 1256.64,
        centreOfMass: [1, 2, 3],
        principalMoments: [111.1, 222.2, 333.3],
        principalAxes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      });
    const bridge = createDirectKernelBridge(createFakeKernelApi(measureImpl));

    const outcome = await bridge.measure(
      [fakeStep('sphere-1', 'key-1')],
      [{ bodyFeatureId: 'sphere-1', subShape: null }],
      'massProperties',
    );

    expect(outcome).toEqual({
      kind: 'massProperties',
      volume: 4188.79,
      area: 1256.64,
      centreOfMass: [1, 2, 3],
      principalMoments: [111.1, 222.2, 333.3],
      principalAxes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    });
  });

  it('kernel が failed で返したときはその message をそのまま持ち回る(FR-504)', async () => {
    const measureImpl = (): Promise<MeasureResult> =>
      Promise.resolve({
        kind: 'failed',
        message: '2 つの形の間の距離を測れませんでした。',
      });
    const bridge = createDirectKernelBridge(createFakeKernelApi(measureImpl));

    const outcome = await bridge.measure(
      [fakeStep('body-1', 'key-1'), fakeStep('body-2', 'key-2')],
      [
        { bodyFeatureId: 'body-1', subShape: null },
        { bodyFeatureId: 'body-2', subShape: null },
      ],
      'distance',
    );

    expect(outcome).toEqual({ kind: 'failed', message: '2 つの形の間の距離を測れませんでした。' });
  });
});
