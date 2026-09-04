/**
 * 投影・交差と上流追従を、**実物の幾何カーネル**で部品文書の経路ごと確かめる
 * (FR-325、FR-330、計画書 P4 タスク25)。
 *
 * ## なぜ偽の橋ではいけないか
 *
 * タスク21 の教訓(`docs/報告記録.md` 2026-09-04 21:05)。オフセットのときは、
 * model 側の単体検査がすべて緑でも**部品文書の経路(`recomputePart` → `resolvePart`)で
 * カーネルの往復が一度も呼ばれていない**配線もれがあり、実機で初めて見つかった。
 * 投影・交差は同じ 2 段の作りなので、同じ穴が開かないよう「実カーネルで、
 * `recomputePart` を呼んで、立体の体積まで確かめる」検査をここに置く。
 *
 * ## Worker を使わない理由
 *
 * 本番はブラウザ・Electron で Web Worker 越しに動く(rules/04、NFR-PF-4)が、Node の
 * 検査では Worker を起こせない(`docs/報告記録.md` 2026-09-02 14:50 の④)。そこで
 * `createDirectKernelBridge`(`kernelBridge.ts`)で同じ `KernelApi` へ直につなぐ。
 * 通るのは Comlink の詰め替えを除いた**同じ変換・同じ解決の道**である。
 *
 * OCCT の読み込みに数秒〜十数秒かかるので、この検査だけ待ち時間を長く取る。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';

// Node で OCCT を読み込む口。`@pointercad/kernel` の入口(index.ts)からは輸出しない
// (`opencascade.js/dist/node.js` は Node 専用で、ブラウザの組み立てへ混ぜられないため)。
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import {
  createDirectKernelBridge,
  type KernelBridge,
  type SolidBody,
} from '../kernelBridge.js';
import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  nextFeatureId,
  nextFeatureName,
} from '../sketch/createSketchDocument.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { DEFAULT_WORK_PLANE_ID, FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import type { SketchDocument, SketchFaceFeature, SketchFeature } from '../sketch/types.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { addSketch, appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type { ExtrudeFeature, PartDocument, SketchFaceRef } from './types.js';

/** OCCT の初期化を含むので、この検査だけ待ち時間を長く取る(kernel の検査と同じ値)。 */
const OCCT_TIMEOUT_MS = 180_000;

let bridge: KernelBridge;

beforeAll(async () => {
  // 形状キャッシュは窓口 1 つにつき 1 つ。検査の間ずっと使い回す(投影はこの鍵で形を引く)。
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

/** 覚え書きを 1 組作る(画面側と同じく持ち回る形)。 */
function caches(): Parameters<typeof recomputePart>[2] {
  return {
    offsets: createOffsetCache(),
    projections: createProjectionCache(),
    subShapes: createSubShapeCache(),
  };
}

/** 長方形の 4 隅に点を置き、その 4 点で面を張ったスケッチを作る。`height` は面の高さ(z)。 */
function rectangleSketch(
  id: string,
  width: number,
  depth: number,
  height = 0,
): { readonly sketch: SketchDocument; readonly faceId: string } {
  let sketch: SketchDocument = { id, name: id, features: [] };
  const pointIds: string[] = [];
  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [width, depth],
    [0, depth],
  ]) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, height));
    sketch = appendFeature(sketch, point);
    pointIds.push(point.id);
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: pointIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  return { sketch: appendFeature(sketch, face), faceId: face.id };
}

function extrudeFeature(
  id: string,
  profile: SketchFaceRef,
  distance: string,
  symmetric = false,
): ExtrudeFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile,
    distance: expr(distance),
    reversed: false,
    symmetric,
  };
}

/** 「投影・交差した輪郭を面にして押し出す」スケッチ。 */
function derivedSketch(id: string, source: SketchFeature): SketchDocument {
  const face: SketchFaceFeature = {
    id: 'f-derived',
    name: '面-取り込み',
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: [{ featureId: source.id }],
    color: DEFAULT_FACE_COLOR,
  };
  return { id, name: id, features: [source, face] };
}

/** 立体の一覧から、指定した高さにある水平な平らな面の参照を作る(UI の面選びと同じ手順)。 */
function topFaceRef(body: SolidBody, height: number): SubShapeRef {
  const found = body.faces.find(
    (face) =>
      face.surfaceKind === 'plane' &&
      face.axis !== null &&
      Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 &&
      Math.abs(face.centroid[2] - height) < 1e-9,
  );
  if (found === undefined) {
    throw new Error(`z=${height} の水平な面が見つかりません`);
  }
  return {
    bodyFeatureId: body.featureId,
    index: found.index,
    fingerprint: {
      kind: 'face',
      surfaceKind: found.surfaceKind,
      area: found.area,
      position: found.centroid,
      axis: found.axis,
      radius: found.radius,
    },
  };
}

function bodyOf(result: PartRecomputeResult, featureId: string): SolidBody {
  const found = result.bodies.find((body) => body.featureId === featureId);
  if (found === undefined) {
    throw new Error(`立体 ${featureId} が返っていません`);
  }
  return found;
}

describe('投影・交差を実カーネルで部品文書ごと解く(FR-325、タスク25)', () => {
  it(
    '板の上面を投影した輪郭を押し出すと、40×30×5 = 6000 mm³ の立体になる',
    async () => {
      // ① 40×30 の面を 10 押し出して板を作る。
      const plate = rectangleSketch('sketch-1', 40, 30);
      let document: PartDocument = replaceSketch(createEmptyPartDocument(), plate.sketch);
      document = appendSolid(
        document,
        extrudeFeature('extrude-1', { sketchId: 'sketch-1', faceFeatureId: plate.faceId }, '10'),
      );
      const first = await recomputePart(document, bridge, caches());
      expect(first.errors).toEqual([]);
      expect(bodyOf(first, 'extrude-1').volume).toBeCloseTo(12000, 6);

      // ② その上面(z=10)を XY の作図面へ投影し、輪郭を面にして 5 押し出す。
      const source = topFaceRef(bodyOf(first, 'extrude-1'), 10);
      document = addSketch(
        document,
        derivedSketch('sketch-2', {
          id: 'pj1',
          name: '投影1',
          planeId: DEFAULT_WORK_PLANE_ID,
          kind: 'projectedCurve',
          source,
          construction: false,
        }),
      );
      document = appendSolid(
        document,
        extrudeFeature('extrude-2', { sketchId: 'sketch-2', faceFeatureId: 'f-derived' }, '5'),
      );

      const startedAt = performance.now();
      const result = await recomputePart(document, bridge, caches());
      const elapsedMs = performance.now() - startedAt;
      console.log(`投影 1 件を含む再計算: ${elapsedMs.toFixed(1)}ms`);

      expect(result.errors).toEqual([]);
      // 投影された輪郭は線分 4 本(板の上面の外周)。
      const sketch2 = result.sketches.find((entry) => entry.sketchId === 'sketch-2');
      expect(sketch2?.resolved.pendingProjections).toEqual([]);
      expect(sketch2?.resolved.curvesByFeature.get('pj1')).toHaveLength(4);
      // 面積 1200 の輪郭を 5 押し出して 6000 mm³(手計算)。
      expect(bodyOf(result, 'extrude-2').volume).toBeCloseTo(6000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '箱と作図面の交線を押し出すと、20×20×5 = 2000 mm³ の立体になる',
    async () => {
      // 20×20 の面を「両側へ」20 押し出して、z = -10〜+10 の箱を作る。
      const square = rectangleSketch('sketch-1', 20, 20);
      let document: PartDocument = replaceSketch(createEmptyPartDocument(), square.sketch);
      document = appendSolid(
        document,
        extrudeFeature(
          'extrude-1',
          { sketchId: 'sketch-1', faceFeatureId: square.faceId },
          '20',
          true,
        ),
      );
      // XY の作図面(z=0)は箱の真ん中を通るので、断面は一辺 20 の正方形になる。
      document = addSketch(
        document,
        derivedSketch('sketch-2', {
          id: 'sc1',
          name: '断面1',
          planeId: DEFAULT_WORK_PLANE_ID,
          kind: 'planeSection',
          targetFeatureId: 'extrude-1',
          construction: false,
        }),
      );
      document = appendSolid(
        document,
        extrudeFeature('extrude-2', { sketchId: 'sketch-2', faceFeatureId: 'f-derived' }, '5'),
      );

      const startedAt = performance.now();
      const result = await recomputePart(document, bridge, caches());
      const elapsedMs = performance.now() - startedAt;
      console.log(`交差 1 件を含む再計算: ${elapsedMs.toFixed(1)}ms`);

      expect(result.errors).toEqual([]);
      expect(bodyOf(result, 'extrude-1').volume).toBeCloseTo(8000, 6);
      const sketch2 = result.sketches.find((entry) => entry.sketchId === 'sketch-2');
      expect(sketch2?.resolved.curvesByFeature.get('sc1')).toHaveLength(4);
      expect(bodyOf(result, 'extrude-2').volume).toBeCloseTo(2000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '立体と交わらない作図面で切ると、止めずに「交わりません」と断る(FR-504)',
    async () => {
      // 面を z=20 に置いて 10 押し出すと、板は z = 20〜30 になる。
      // XY の作図面(z=0)はこの板とどこでも交わらない。
      const plate = rectangleSketch('sketch-1', 40, 30, 20);
      let document: PartDocument = replaceSketch(createEmptyPartDocument(), plate.sketch);
      document = appendSolid(
        document,
        extrudeFeature('extrude-1', { sketchId: 'sketch-1', faceFeatureId: plate.faceId }, '10'),
      );
      document = addSketch(
        document,
        derivedSketch('sketch-2', {
          id: 'sc1',
          name: '断面1',
          planeId: DEFAULT_WORK_PLANE_ID,
          kind: 'planeSection',
          targetFeatureId: 'extrude-1',
          construction: false,
        }),
      );

      const result = await recomputePart(document, bridge, caches());

      const refusal = result.errors.find((error) => error.featureId === 'sc1');
      expect(refusal?.code).toBe('degenerate');
      expect(refusal?.message).toContain('交わりません');
      // 板そのものは作れている(FR-504「止めずに警告する」)。
      expect(bodyOf(result, 'extrude-1').volume).toBeCloseTo(12000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '3D スケッチが参照した立体の頂点は、上流の押し出しを変えると追従する(FR-330)',
    async () => {
      const plate = rectangleSketch('sketch-1', 40, 30);
      let document: PartDocument = replaceSketch(createEmptyPartDocument(), plate.sketch);
      document = appendSolid(
        document,
        extrudeFeature('extrude-1', { sketchId: 'sketch-1', faceFeatureId: plate.faceId }, '10'),
      );
      const first = await recomputePart(document, bridge, caches());
      const corner = bodyOf(first, 'extrude-1').vertices.find(
        (vertex) =>
          Math.abs(vertex.position[0] - 40) < 1e-9 &&
          Math.abs(vertex.position[1] - 30) < 1e-9 &&
          Math.abs(vertex.position[2] - 10) < 1e-9,
      );
      if (corner === undefined) {
        throw new Error('(40, 30, 10) の頂点が見つかりません');
      }
      const reference: SubShapeRef = {
        bodyFeatureId: 'extrude-1',
        index: corner.index,
        fingerprint: { kind: 'vertex', position: corner.position },
      };
      document = addSketch(document, {
        id: 'sketch-2',
        name: 'スケッチ2',
        features: [
          {
            id: 'p-v',
            name: '点-頂点',
            planeId: FREE_WORK_PLANE_ID,
            kind: 'point',
            at: {
              mode: 'relative',
              base: { kind: 'subShape', ref: reference },
              dx: expr('0'),
              dy: expr('0'),
              dz: expr('0'),
            },
          },
        ],
      });

      const before = await recomputePart(document, bridge, caches());
      const beforePoint = before.sketches.find((entry) => entry.sketchId === 'sketch-2');
      expect(beforePoint?.resolved.points[0].position).toEqual([40, 30, 10]);

      // 上流の押し出しを 10 → 20 にすると、指紋が指す頂点は (40, 30, 20) へ動く。
      const taller: PartDocument = {
        ...document,
        solids: document.solids.map((feature) =>
          feature.id === 'extrude-1' && feature.kind === 'extrude'
            ? { ...feature, distance: expr('20') }
            : feature,
        ),
      };
      const after = await recomputePart(taller, bridge, caches());

      expect(after.errors).toEqual([]);
      const afterPoint = after.sketches.find((entry) => entry.sketchId === 'sketch-2');
      expect(afterPoint?.resolved.points[0].position[2]).toBeCloseTo(20, 9);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '覚え書きを持ち回ると、2 回目の再計算ではカーネルへ投影を頼み直さない(NFR-PF-2)',
    async () => {
      const plate = rectangleSketch('sketch-1', 40, 30);
      let document: PartDocument = replaceSketch(createEmptyPartDocument(), plate.sketch);
      document = appendSolid(
        document,
        extrudeFeature('extrude-1', { sketchId: 'sketch-1', faceFeatureId: plate.faceId }, '10'),
      );
      const shared = caches();
      const first = await recomputePart(document, bridge, shared);
      const source = topFaceRef(bodyOf(first, 'extrude-1'), 10);
      document = addSketch(
        document,
        derivedSketch('sketch-2', {
          id: 'pj1',
          name: '投影1',
          planeId: DEFAULT_WORK_PLANE_ID,
          kind: 'projectedCurve',
          source,
          construction: false,
        }),
      );

      let calls = 0;
      const counting: KernelBridge = {
        ...bridge,
        projectSketchCurves: (requests) => {
          calls += 1;
          return bridge.projectSketchCurves(requests);
        },
      };

      const second = await recomputePart(document, counting, shared);
      expect(second.errors).toEqual([]);
      expect(calls).toBe(1);

      const third = await recomputePart(document, counting, shared);
      expect(third.errors).toEqual([]);
      // 2 回目は覚え書きから引けるので、カーネルへの往復は増えない。
      expect(calls).toBe(1);
    },
    OCCT_TIMEOUT_MS,
  );
});
