/**
 * 拘束(FR-313)が**部品文書の経路**(`recomputePart` → `resolvePart` →
 * `resolveConstrainedSketch`)で効くことを、実物の幾何カーネルで立体の体積まで
 * 確かめる(計画書 docs/plans/P4b-スケッチの仕上げ.md タスク8 の検証表)。
 *
 * ## なぜスケッチ単体の検査では足りないか
 *
 * P4 タスク21 の教訓(`docs/報告記録.md` 2026-09-04 21:05)。model 側の単体検査が
 * すべて緑でも、**部品文書の経路でオフセットのカーネル往復が一度も呼ばれていない**
 * 配線もれがあり、実機で初めて見つかった。拘束も「スケッチを解く場所が 2 か所ある」
 * 同じ形なので、同じ穴が開かないよう部品の側から体積で固定する。
 *
 * Worker を使わない理由と OCCT の待ち時間は `projectionKernel.test.ts` と同じ。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type KernelBridge } from '../kernelBridge.js';
import { absoluteCoordinate, DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import type { ConstraintTarget, SketchConstraint } from '../sketch/constraints/types.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchFaceFeature,
  SketchFeature,
} from '../sketch/types.js';
import { createEmptyPartDocument, appendSolid, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type { ExtrudeFeature, PartDocument } from './types.js';

/** OCCT の初期化を含むので、この検査だけ待ち時間を長く取る(kernel の検査と同じ値)。 */
const OCCT_TIMEOUT_MS = 180_000;

let bridge: KernelBridge;

beforeAll(async () => {
  await loadOcctForNode();
  bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, OCCT_TIMEOUT_MS);

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}`);
  }
  return result.value;
}

function caches(): Parameters<typeof recomputePart>[2] {
  return {
    offsets: createOffsetCache(),
    projections: createProjectionCache(),
    subShapes: createSubShapeCache(),
  };
}

function lineOf(id: string, from: CoordinateInput, to: CoordinateInput): SketchFeature {
  return { id, kind: 'line', name: id, planeId: DEFAULT_WORK_PLANE_ID, from, to, construction: false };
}

function atVertex(featureId: string, vertex: 'start' | 'end'): ConstraintTarget {
  return { kind: 'vertex', featureId, vertex };
}

function atCurve(featureId: string): ConstraintTarget {
  return { kind: 'curve', element: { featureId } };
}

/**
 * 4 本の線分でできた枠のスケッチ。**わざと 40×30 からずらした座標**で作り、
 * 拘束(始点の固定・4 つの一致・2 つの水平・2 つの垂直・2 つの長さ)だけで
 * 長方形へ整えさせる。
 *
 * 自由度の数え方: 点 8 つ = 変数 16、固定で −2 → 14。式は一致 4×2 + 水平 2 + 垂直 2 +
 * 長さ 2 = 14。差し引き 0 で形が一意に決まる。
 */
function frameSketch(width: ExpressionValue, depth: ExpressionValue): {
  readonly sketch: SketchDocument;
  readonly faceId: string;
} {
  const corner1 = absoluteCoordinate(0, 0, 0);
  const corner2 = absoluteCoordinate(38, 1, 0);
  const corner3 = absoluteCoordinate(39, 29, 0);
  const corner4 = absoluteCoordinate(1, 31, 0);
  const features: SketchFeature[] = [
    lineOf('line-1', corner1, corner2),
    lineOf('line-2', corner2, corner3),
    lineOf('line-3', corner3, corner4),
    lineOf('line-4', corner4, corner1),
  ];
  const face: SketchFaceFeature = {
    id: 'face-1',
    name: '面1',
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: [
      { featureId: 'line-1' },
      { featureId: 'line-2' },
      { featureId: 'line-3' },
      { featureId: 'line-4' },
    ],
    color: DEFAULT_FACE_COLOR,
  };
  const constraints: SketchConstraint[] = [
    { id: 'fix-1', name: '固定1', kind: 'fix', target: atVertex('line-1', 'start') },
    {
      id: 'c-1',
      name: '一致1',
      kind: 'coincident',
      a: atVertex('line-1', 'end'),
      b: atVertex('line-2', 'start'),
    },
    {
      id: 'c-2',
      name: '一致2',
      kind: 'coincident',
      a: atVertex('line-2', 'end'),
      b: atVertex('line-3', 'start'),
    },
    {
      id: 'c-3',
      name: '一致3',
      kind: 'coincident',
      a: atVertex('line-3', 'end'),
      b: atVertex('line-4', 'start'),
    },
    {
      id: 'c-4',
      name: '一致4',
      kind: 'coincident',
      a: atVertex('line-4', 'end'),
      b: atVertex('line-1', 'start'),
    },
    { id: 'h-1', name: '水平1', kind: 'horizontal', target: atCurve('line-1') },
    { id: 'h-2', name: '水平2', kind: 'horizontal', target: atCurve('line-3') },
    { id: 'v-1', name: '垂直1', kind: 'vertical', target: atCurve('line-2') },
    { id: 'v-2', name: '垂直2', kind: 'vertical', target: atCurve('line-4') },
    {
      id: 'd-width',
      name: '幅1',
      kind: 'distance',
      a: atVertex('line-1', 'start'),
      b: atVertex('line-1', 'end'),
      length: width,
    },
    {
      id: 'd-depth',
      name: '奥行1',
      kind: 'distance',
      a: atVertex('line-2', 'start'),
      b: atVertex('line-2', 'end'),
      length: depth,
    },
  ];
  return {
    sketch: { id: 'sketch-1', name: 'スケッチ1', features: [...features, face], constraints },
    faceId: face.id,
  };
}

function extrudeOf(distance: string): ExtrudeFeature {
  return {
    id: 'extrude-1',
    name: '押し出し1',
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: expr(distance),
    reversed: false,
    symmetric: false,
  };
}

function partOf(sketch: SketchDocument): PartDocument {
  return appendSolid(replaceSketch(createEmptyPartDocument(), sketch), extrudeOf('10'));
}

function volumeOf(result: PartRecomputeResult): number {
  const body = result.bodies.find((entry) => entry.featureId === 'extrude-1');
  if (body === undefined) {
    throw new Error('立体 extrude-1 が返っていません');
  }
  return body.volume;
}

describe('拘束を部品文書の経路で解く(FR-313、タスク8)', () => {
  it(
    '拘束だけで整えた 40×30 の枠を 10 押し出すと 12000 mm³ になる',
    async () => {
      const frame = frameSketch(expr('40'), expr('30'));
      const result = await recomputePart(partOf(frame.sketch), bridge, caches());
      expect(result.errors).toEqual([]);
      expect(volumeOf(result)).toBeCloseTo(12000, 6);
      expect(result.sketches[0].diagnosis?.degreesOfFreedom).toBe(0);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '長さ拘束を 40 から 50 へ変えると 15000 mm³ になる',
    async () => {
      const wider = frameSketch(expr('50'), expr('30'));
      const result = await recomputePart(partOf(wider.sketch), bridge, caches());
      expect(result.errors).toEqual([]);
      expect(volumeOf(result)).toBeCloseTo(15000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    'パラメータ「幅」を 40 から 50 へ変えると体積が 12000 から 15000 になる',
    async () => {
      // 長さ拘束の式をパラメータ名にする。値は `applyParameters` が配り直す(タスク3)。
      const frame = frameSketch({ source: '幅', value: 0, display: '0' }, expr('30'));
      const base = partOf(frame.sketch);
      const narrow: PartDocument = {
        ...base,
        parameters: [{ name: '幅', value: expr('40'), unit: 'mm', description: '' }],
      };
      const first = await recomputePart(narrow, bridge, caches());
      expect(first.errors).toEqual([]);
      expect(volumeOf(first)).toBeCloseTo(12000, 6);

      const wide: PartDocument = {
        ...base,
        parameters: [{ name: '幅', value: expr('50'), unit: 'mm', description: '' }],
      };
      const second = await recomputePart(wide, bridge, caches());
      expect(second.errors).toEqual([]);
      expect(volumeOf(second)).toBeCloseTo(15000, 6);
    },
    OCCT_TIMEOUT_MS,
  );
});
