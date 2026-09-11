/**
 * 罫線面(FR-430)・ロフト(FR-410)が**部品文書の経路**(`recomputePart` → `resolvePart` →
 * `kernelBridge` → 実 OCCT)で作れることを、実物の幾何カーネルで体積まで確かめる
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.9、§0.a-0.82、0.87。P5 タスク25b)。
 *
 * ## なぜ純関数の検査(kernel の makeThruSections.test.ts・model の resolvePart.test.ts)では足りないか
 *
 * P4 タスク21 の教訓(`docs/報告記録.md` 2026-09-04 21:05)と同じ理由。model 側の単体検査が
 * すべて緑でも、部品文書の経路で配線が抜けている(段の鍵が届かない・欄が落ちる)ことが
 * 実機で初めて見つかる。罫線面・ロフトは
 *   ①`resolvePart` が断面(輪郭・球・立体の面)を段へ組み立て →
 *   ②`kernelBridge` が `ThruSectionSpec` へ詰め替え →
 *   ③カーネルが `BRepOffsetAPI_ThruSections` で実際に結ぶ
 * の 3 段を通るので、どこか 1 つで欄が落ちても純関数の検査は緑のまま通ってしまう。
 * とくに `solidFace`(立体の面を輪郭にする、§0.a-0.73)は**対象の段の鍵(`targetKey`)**を
 * 正しく引き直せているかが実物でしか確かめられない。
 *
 * Worker を使わない理由・OCCT の待ち時間は `primitiveKernel.test.ts` / `projectionKernel.test.ts`
 * と同じ(`OCCT_TIMEOUT_MS`)。期待値の出どころは各検査の注釈に書く。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type KernelBridge, type SolidBody } from '../kernelBridge.js';
import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  nextFeatureId,
  nextFeatureName,
} from '../sketch/createSketchDocument.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import type { SketchArcFeature, SketchDocument, SketchFaceFeature } from '../sketch/types.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type {
  LoftFeature,
  PartDocument,
  PrimitiveFeature,
  PrimitiveShape,
  RuledFeature,
  RuledSection,
  RuledSphereSegments,
  SolidOrigin,
  SubShapeRef,
} from './types.js';

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

/** 中心が原点(絶対座標)。何も選ばずに道具を押したときと同じ指定(NFR-UX-4)。 */
function originAt(x: number, y: number, z: number): SolidOrigin {
  return { kind: 'coordinate', value: absoluteCoordinate(x, y, z) };
}

/** 向きは既定のワールド Z。位置と寸法だけを検査ごとに変える(primitiveKernel.test.ts と同じ)。 */
function primitiveOf(
  id: string,
  shape: PrimitiveShape,
  origin: SolidOrigin = originAt(0, 0, 0),
): PrimitiveFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'primitive',
    origin,
    axis: { kind: 'world', axis: 'z' },
    shape,
  };
}

function sphereShape(radius: string): PrimitiveShape {
  return { kind: 'sphere', radius: expr(radius) };
}

function boxShape(sizeX: string, sizeY: string, sizeZ: string): PrimitiveShape {
  return { kind: 'box', sizeX: expr(sizeX), sizeY: expr(sizeY), sizeZ: expr(sizeZ) };
}

/** 罫線面(ruled)。既定の欄(twist 0、sphereSegments 24)は検査ごとに要るものだけ変える。 */
function ruledFeature(
  id: string,
  first: RuledSection,
  second: RuledSection,
  sphereSegments: RuledSphereSegments = 24,
): RuledFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'ruled',
    first,
    second,
    twist: expr('0'),
    sphereSegments,
  };
}

/** ロフト。球は置けない(§2.9.3)ので sphereSegments の欄を持たない。 */
function loftFeature(id: string, sections: readonly RuledSection[]): LoftFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'loft',
    smooth: false,
    sections,
    twist: expr('0'),
  };
}

function sketchFaceSection(sketchId: string, faceFeatureId: string): RuledSection {
  return { kind: 'sketchFace', ref: { sketchId, faceFeatureId } };
}

function sphereSection(sphereFeatureId: string): RuledSection {
  return { kind: 'sphere', sphereFeatureId };
}

function solidFaceSection(ref: SubShapeRef): RuledSection {
  return { kind: 'solidFace', ref };
}

function bodyOf(result: PartRecomputeResult, featureId: string): SolidBody {
  const body = result.bodies.find((entry) => entry.featureId === featureId);
  if (body === undefined) {
    throw new Error(
      `立体 ${featureId} が返っていません(${result.errors.map((e) => e.message).join(' / ')})`,
    );
  }
  return body;
}

/**
 * 相対誤差での比較(§0.a-0.74 の分割数ごとの実測値と比べるとき用)。
 * 絶対誤差だと値の大きさによって厳しさが変わってしまうため、割合で揃える。
 */
function expectRelativeClose(actual: number, expected: number, epsilon: number): void {
  const diff = Math.abs(actual - expected) / Math.abs(expected);
  expect(diff).toBeLessThan(epsilon);
}

/** 点を順に足す(resolvePart.test.ts の addPoints と同じ書き方)。 */
function addPoints(
  sketch: SketchDocument,
  points: readonly (readonly [number, number, number])[],
): { readonly sketch: SketchDocument; readonly pointIds: readonly string[] } {
  let current = sketch;
  const pointIds: string[] = [];
  for (const [x, y, z] of points) {
    const point = createPointFeature(current, absoluteCoordinate(x, y, z));
    current = appendFeature(current, point);
    pointIds.push(point.id);
  }
  return { sketch: current, pointIds };
}

/** 点列から面フィーチャーを 1 枚作る。 */
function addFace(
  sketch: SketchDocument,
  pointIds: readonly string[],
): { readonly sketch: SketchDocument; readonly faceId: string } {
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

/** 矩形の面を 1 枚、指定した高さへ足す(角を原点に置く。体積は幅・奥行き・高さにしか効かない)。 */
function addRectangleFace(
  sketch: SketchDocument,
  width: number,
  depth: number,
  z: number,
): { readonly sketch: SketchDocument; readonly faceId: string } {
  const added = addPoints(sketch, [
    [0, 0, z],
    [width, 0, z],
    [width, depth, z],
    [0, depth, z],
  ]);
  return addFace(added.sketch, added.pointIds);
}

/**
 * 全周の円 1 本を境界にした面を 1 枚足す(§2.9.3。1 本の円弧で輪になるのは全周の円だけ、
 * `resolveSketch.ts` の `resolveCurveLoop`)。作図面は既定(XY)のままで、中心の z だけを
 * ずらして高さを決める(`projectionKernel.test.ts` の `rectangleSketch` と同じ考え方)。
 */
function addCircleFace(
  sketch: SketchDocument,
  center: readonly [number, number],
  radius: number,
  z: number,
): { readonly sketch: SketchDocument; readonly faceId: string } {
  const arc: SketchArcFeature = {
    id: nextFeatureId(sketch, 'arc'),
    name: nextFeatureName(sketch, 'arc'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'arc',
    center: absoluteCoordinate(center[0], center[1], z),
    radius: expr(String(radius)),
    startAngle: expr('0'),
    endAngle: expr('360'),
    construction: false,
  };
  const withArc = appendFeature(sketch, arc);
  const face: SketchFaceFeature = {
    id: nextFeatureId(withArc, 'face'),
    name: nextFeatureName(withArc, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: [{ featureId: arc.id }],
    color: DEFAULT_FACE_COLOR,
  };
  return { sketch: appendFeature(withArc, face), faceId: face.id };
}

/**
 * 立体の一覧から、指定した高さにある水平な平らな面の参照を作る(UI の面選びと同じ手順、
 * `projectionKernel.test.ts` の `topFaceRef` と同じ)。
 */
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

describe('罫線面・ロフトの実カーネル往復(タスク25b)', () => {
  it(
    'スケッチの面2枚(z=0の40×30、z=10の20×15)をruledでつなぐと台形則どおり7000mm³になり、元の立体は無い',
    async () => {
      const base = createEmptyPartDocument();
      const bottom = addRectangleFace(base.sketches[0], 40, 30, 0);
      const top = addRectangleFace(bottom.sketch, 20, 15, 10);
      const sketch = top.sketch;
      const document = appendSolid(
        replaceSketch(base, sketch),
        ruledFeature(
          'ruled-1',
          sketchFaceSection(sketch.id, bottom.faceId),
          sketchFaceSection(sketch.id, top.faceId),
        ),
      );

      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      // h/3・(A1+A2+√(A1・A2)) = 10/3・(1200+300+600) = 7000(makeThruSections.test.ts と同じ手計算)。
      expect(bodyOf(result, 'ruled-1').volume).toBeCloseTo(7000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '同じ2枚をloftでつないでも、断面が2つだけなら直線で結ぶ以外に道が無く7000mm³になる',
    async () => {
      const base = createEmptyPartDocument();
      const bottom = addRectangleFace(base.sketches[0], 40, 30, 0);
      const top = addRectangleFace(bottom.sketch, 20, 15, 10);
      const sketch = top.sketch;
      const document = appendSolid(
        replaceSketch(base, sketch),
        loftFeature('loft-1', [
          sketchFaceSection(sketch.id, bottom.faceId),
          sketchFaceSection(sketch.id, top.faceId),
        ]),
      );

      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expect(bodyOf(result, 'loft-1').volume).toBeCloseTo(7000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '球r10(中心原点)とz=−30の全周円r20をruledでつなぐと厳密経路で24741.124688560027になり、分割数(24/72)に依らない',
    async () => {
      const base = createEmptyPartDocument();
      const circle = addCircleFace(base.sketches[0], [0, 0], 20, -30);
      const sketch = circle.sketch;
      let document: PartDocument = replaceSketch(base, sketch);
      document = appendSolid(document, primitiveOf('sphere-1', sphereShape('10')));
      const section2 = sketchFaceSection(sketch.id, circle.faceId);
      document = appendSolid(
        document,
        ruledFeature('ruled-3-24', sphereSection('sphere-1'), section2, 24),
      );
      document = appendSolid(
        document,
        ruledFeature('ruled-3-72', sphereSection('sphere-1'), section2, 72),
      );

      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      // (a) 軸対称の厳密経路(円錐台の側面+球冠+平面の縫合)。ec15366 のコミットメッセージの実測値
      // (球r10+円r20@z-30)。分割数は使わない経路なので 24 と 72 で同じ値になる。
      const expected = 24741.124688560027;
      expect(bodyOf(result, 'ruled-3-24').volume).toBeCloseTo(expected, 6);
      expect(bodyOf(result, 'ruled-3-72').volume).toBeCloseTo(expected, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '球r10+z=−20,中心(5,0)の円r8をsphereSegments 24/48/72でつなぐと、24bの実測どおりの体積で単調に増える',
    async () => {
      const base = createEmptyPartDocument();
      const circle = addCircleFace(base.sketches[0], [5, 0], 8, -20);
      const sketch = circle.sketch;
      let document: PartDocument = replaceSketch(base, sketch);
      document = appendSolid(document, primitiveOf('sphere-1', sphereShape('10')));
      const section2 = sketchFaceSection(sketch.id, circle.faceId);
      // 報告記録 2026-09-05 17:23(タスク24b の実測)。軸から外れた輪郭なので (b) の近似経路に入り、
      // 分割数が多いほど厳密値(24741.124688560027)へ単調に近づく(内接多角形近似のため必ず少なめ)。
      const choices: readonly { readonly segments: RuledSphereSegments; readonly id: string; readonly expected: number }[] = [
        { segments: 24, id: 'ruled-4-24', expected: 6975.920596 },
        { segments: 48, id: 'ruled-4-48', expected: 7072.168197 },
        { segments: 72, id: 'ruled-4-72', expected: 7090.318721 },
      ];
      for (const choice of choices) {
        document = appendSolid(
          document,
          ruledFeature(choice.id, sphereSection('sphere-1'), section2, choice.segments),
        );
      }

      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      const volumes = choices.map((choice) => bodyOf(result, choice.id).volume);
      console.log(
        `sphereSegments 24/48/72 の体積: ${volumes.map((v) => v.toFixed(6)).join(' / ')}`,
      );
      choices.forEach((choice, index) => {
        expectRelativeClose(volumes[index], choice.expected, 1e-6);
      });
      expect(volumes[0]).toBeLessThan(volumes[1]);
      expect(volumes[1]).toBeLessThan(volumes[2]);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '箱40×30×10の上面(solidFace)とz=30の矩形20×15をruledでつなぐと14000mm³になり、箱は消費されず2ボディ残る',
    async () => {
      // ① 箱だけを作り、画面で上面を選んだのと同じ手順で面の指紋を採る(中心 (0,0,5) なので
      //    z は 0〜10、上面は z=10)。
      const boxOnly = appendSolid(
        createEmptyPartDocument(),
        primitiveOf('box-1', boxShape('40', '30', '10'), originAt(0, 0, 5)),
      );
      const first = await recomputePart(boxOnly, bridge, caches());
      expect(first.errors).toEqual([]);
      const boxBody = bodyOf(first, 'box-1');
      expect(boxBody.volume).toBeCloseTo(12000, 6);
      const topRef = topFaceRef(boxBody, 10);

      // ② その上面と、z=30 に置いた 20×15 の矩形を ruled でつなぐ。箱はそのまま残す(§0.a-0.27)。
      const base = createEmptyPartDocument();
      const rect = addRectangleFace(base.sketches[0], 20, 15, 30);
      const sketch = rect.sketch;
      let document: PartDocument = replaceSketch(base, sketch);
      document = appendSolid(
        document,
        primitiveOf('box-1', boxShape('40', '30', '10'), originAt(0, 0, 5)),
      );
      document = appendSolid(
        document,
        ruledFeature(
          'ruled-5',
          solidFaceSection(topRef),
          sketchFaceSection(sketch.id, rect.faceId),
        ),
      );

      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(2);
      expect(bodyOf(result, 'box-1').volume).toBeCloseTo(12000, 6);
      // h/3・(A1+A2+√(A1・A2)) = 20/3・(1200+300+600) = 14000(makeThruSections.test.ts と同じ手計算)。
      expect(bodyOf(result, 'ruled-5').volume).toBeCloseTo(14000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '同じ文書を2回解決すると、段の鍵が同じなので2回目はカーネルの形状キャッシュに命中する(NFR-PF-3)',
    async () => {
      const base = createEmptyPartDocument();
      const bottom = addRectangleFace(base.sketches[0], 10, 10, 0);
      const top = addRectangleFace(bottom.sketch, 5, 5, 6);
      const sketch = top.sketch;
      const document = appendSolid(
        replaceSketch(base, sketch),
        ruledFeature(
          'ruled-cache-1',
          sketchFaceSection(sketch.id, bottom.faceId),
          sketchFaceSection(sketch.id, top.faceId),
        ),
      );

      const first = await recomputePart(document, bridge, caches());
      expect(first.errors).toEqual([]);
      expect(first.bodies).toHaveLength(1);
      // 罫線面の段が1つだけの文書。まだ誰も同じ鍵で作っていないので命中0。
      expect(first.cacheHits).toBe(0);

      const second = await recomputePart(document, bridge, caches());
      expect(second.errors).toEqual([]);
      // 段は1つだけで、内容(document)が変わっていないので鍵も同じ→2回目は必ず命中する。
      expect(second.cacheHits).toBe(1);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '断面が1つだけのロフトはmissingProfileでmodelが断り、カーネルを1回も呼ばない',
    async () => {
      const base = createEmptyPartDocument();
      const only = addRectangleFace(base.sketches[0], 10, 10, 0);
      const sketch = only.sketch;
      const document = appendSolid(
        replaceSketch(base, sketch),
        loftFeature('loft-missing', [sketchFaceSection(sketch.id, only.faceId)]),
      );

      let calls = 0;
      const counting: KernelBridge = {
        ...bridge,
        recomputeSolids: (steps, options) => {
          calls += 1;
          return bridge.recomputeSolids(steps, options);
        },
      };

      const result = await recomputePart(document, counting, caches());
      expect(calls).toBe(0);
      expect(result.bodies).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('missingProfile');
      // resolvePart.ts の THRU_SECTIONS_TOO_FEW_MESSAGE と同じ文言(片方だけ直すと理由が食い違う)。
      expect(result.errors[0].message).toBe('つなぐ面を 2 つ選んでください。');
    },
    OCCT_TIMEOUT_MS,
  );
});
