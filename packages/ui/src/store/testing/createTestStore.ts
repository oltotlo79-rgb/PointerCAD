import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  replaceSketch,
  resolveSketch,
  type ExtrudeFeature,
  type HoleFeature,
  type PartDocument,
  type PartRecomputeOptions,
  type PartRecomputeResult,
  type SketchDocument,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SketchPointFeature,
  type SketchRecomputeResult,
  type SolidBody,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';

import { DEFAULT_DISPLAY_SETTINGS } from '../../settings/settings.js';
import type { OrbitState } from '../../viewport/cameraMath.js';
import type { PartRecomputer } from '../attachKernel.js';
import { createInitialDocumentState } from '../initialDocumentState.js';
import { createAssemblyInitialState } from '../assemblySlice.js';
import { useAppStore } from '../useAppStore.js';

export interface PendingRecompute {
  readonly document: PartDocument;
  readonly options: PartRecomputeOptions;
  readonly settle: (result: PartRecomputeResult) => void;
}

/** 呼ばれた文書を覚え、こちらの好きな時点で結果を返す偽の再計算。 */
export function createFakeRecompute(): {
  readonly calls: PendingRecompute[];
  readonly recompute: PartRecomputer;
} {
  const calls: PendingRecompute[] = [];
  const recompute: PartRecomputer = (document, options) =>
    new Promise<PartRecomputeResult>((resolve) => {
      calls.push({ document, options, settle: resolve });
    });
  return { calls, recompute };
}

/** スケッチだけを解決した、失敗もボディも無い結果。 */
export function resultFor(document: PartDocument): PartRecomputeResult {
  return {
    sketches: document.sketches.map((sketch) => ({
      sketchId: sketch.id,
      resolved: resolveSketch(sketch),
      mesh: null,
      // 拘束の診断(model の P4b タスク8)。この検査の文書は拘束を持たない。
      diagnosis: null,
    })),
    bodies: [],
    errors: [],
    cacheHits: 0,
    cancelled: false,
    generation: 0,
  };
}

/** P1 の applySketch(スケッチ 1 本ぶんの結果)を作る。 */
export function sketchResultFor(sketch: SketchDocument): SketchRecomputeResult {
  return { resolved: resolveSketch(sketch), mesh: null, errors: [], diagnosis: null };
}

/** 予約 → 実行 → 反映は Promise を跨ぐので、待ち行列を空にしてから確かめる。 */
export async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function documentWithPoint(): SketchDocument {
  const empty = createEmptySketchDocument();
  return appendFeature(empty, createPointFeature(empty, absoluteCoordinate(1, 2, 3)));
}

/** いま編集しているスケッチを差し替えた部品文書。 */
export function partWithPoint(): PartDocument {
  return replaceSketch(createEmptyPartDocument(), documentWithPoint());
}

/** 押し出し 1 段だけの部品文書。ボディの id はフィーチャーの id と同じ(§0.a-0.5)。 */
export function extrudeFeature(id: string): ExtrudeFeature {
  return {
    id,
    kind: 'extrude',
    name: `押し出し${id}`,
    suppressed: false,
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: expressionValueFromNumber(10),
    reversed: false,
    symmetric: false,
  };
}

/** 押し出しを 3 段積んだ部品文書(タイムラインの帯が 3 件になる)。 */
export function partWithThreeSolids(): PartDocument {
  let document = createEmptyPartDocument();
  for (const id of ['1', '2', '3']) {
    document = appendSolid(document, extrudeFeature(id));
  }
  return document;
}

/**
 * 穴 1 つ(P4b タスク20 の並べ替えの検査用)。対象の立体を指すので、対象より前へは
 * 動かせない(`timelineOrder.ts` の依存)。中身は依存の材料としてしか使わない。
 */
export function holeFeature(id: string, targetFeatureId: string): HoleFeature {
  return {
    id,
    kind: 'hole',
    name: `穴${id}`,
    suppressed: false,
    targetFeatureId,
    face: {
      bodyFeatureId: targetFeatureId,
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 1200,
        position: [20, 15, 10],
        axis: [0, 0, 1],
        radius: null,
      },
    },
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
    diameter: expressionValueFromNumber(6),
    depth: { kind: 'through' },
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
}

/** 表示用のボディ 1 つ。中身は使わないので最小限の並びにする。 */
export function bodyFor(featureId: string): SolidBody {
  return {
    featureId,
    mesh: {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array(6),
      triangleCount: 1,
    },
    volume: 6000,
    isValid: true,
    // P3 タスク17 で SolidBody に必須で足された欄。この検査では中身を使わない。
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/**
 * 点・線・面(境界に使える/使えない)と立体が 1 つずつ入った部品文書(§0.a-0.23 ⑨)。
 * `setActiveTool('face')` の選択掃除を検査するのに使う。
 */
export function partWithMixedFeatures(): PartDocument {
  const point: SketchPointFeature = {
    id: 'point-1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(1, 2, 3),
  };
  const line: SketchLineFeature = {
    id: 'line-1',
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(10, 0, 0),
    construction: false,
  };
  const face: SketchFaceFeature = {
    id: 'face-1',
    name: '面1',
    planeId: 'xy',
    kind: 'face',
    boundary: [{ featureId: 'point-1' }],
    color: '#7aa2f7',
  };
  let sketch = createEmptySketchDocument();
  for (const feature of [point, line, face]) {
    sketch = appendFeature(sketch, feature);
  }
  return appendSolid(replaceSketch(createEmptyPartDocument(), sketch), extrudeFeature('extrude-1'));
}

export function orbitFrom(azimuthDegrees: number, elevationDegrees: number): OrbitState {
  return {
    azimuth: (azimuthDegrees * Math.PI) / 180,
    elevation: (elevationDegrees * Math.PI) / 180,
    distance: 200,
    target: [0, 0, 0],
  };
}

export function resetTestStore(): void {
  useAppStore.setState({
    ...createInitialDocumentState(),
    ...createAssemblyInitialState(),
    matchWorkPlaneRequestCount: 0,
    focusViewportRequestCount: 0,
    viewportSize: [0, 0],
    // createInitialDocumentState の外にある(文書を作り直しても戻らない)ので、
    // ここで明示的に初期化しないと前の検査の値が漏れる(§0.a-0.23 ⑨)。
    kernelLoaded: false,
    // displaySettings も同じ理由(タスク1)。他の検査が setDisplaySettings を呼んでも
    // 次の検査へ持ち越さない。
    displaySettings: DEFAULT_DISPLAY_SETTINGS,
  });
}
