/**
 * 基本形状(FR-429)が**部品文書の経路**(`recomputePart` → `resolvePart` →
 * `kernelBridge` → カーネル)で作れることを、実物の幾何カーネルで体積まで確かめる
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク16 の検証表)。
 *
 * ## なぜ純関数の検査では足りないか
 *
 * P4 タスク21 の教訓(`docs/報告記録.md` 2026-09-04 21:05)。model 側の単体検査が
 * すべて緑でも、部品文書の経路で配線が抜けている(段が組み立たない・欄が落ちる)ことが
 * 実機で初めて見つかった。基本形状は
 *   ①`resolvePart` が段を組み立て → ②`kernelBridge` が依頼へ詰め替え →
 *   ③カーネルが `gp_Ax2` で置いて形を作る
 * の 3 段を通るので、どこか 1 つで欄が落ちても純関数の検査は緑のまま通ってしまう。
 * とくに **基準点を立体の頂点にしたときの `originQuery` / `targetKey`** は、model が
 * 詰め忘れてもカーネルは「頂点を使わない基本形状」として黙って作れてしまい、
 * 位置だけが間違った形が出る。だから体積と位置の両方を実物で固定する。
 *
 * Worker を使わない理由と OCCT の待ち時間は `constraintKernel.test.ts` と同じ。
 * 期待値の導出は下の各検査の注釈に書く(すべて閉じた式で手計算できる)。
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
} from '../sketch/createSketchDocument.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import type { SketchDocument, SketchFaceFeature } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type {
  ExtrudeFeature,
  PartDocument,
  PrimitiveFeature,
  PrimitiveShape,
  SolidFeature,
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

/** 向きは既定のワールド Z。位置と寸法だけを検査ごとに変える。 */
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

function partWith(...solids: readonly SolidFeature[]): PartDocument {
  return solids.reduce((current, solid) => appendSolid(current, solid), createEmptyPartDocument());
}

function bodyOf(result: PartRecomputeResult, featureId: string): SolidBody {
  const body = result.bodies.find((entry) => entry.featureId === featureId);
  if (body === undefined) {
    throw new Error(`立体 ${featureId} が返っていません(${result.errors.map((e) => e.message).join(' / ')})`);
  }
  return body;
}

/** 三角形の頂点から境界箱を測る。基準点の意味(中心か底面の中心か)を確かめるために使う。 */
function boundsOf(body: SolidBody): { readonly low: Vec3; readonly high: Vec3 } {
  const positions = body.mesh.positions;
  if (positions.length < 3) {
    throw new Error('テストの前提が壊れている: 三角形が 1 枚も無い');
  }
  const low: [number, number, number] = [positions[0], positions[1], positions[2]];
  const high: [number, number, number] = [positions[0], positions[1], positions[2]];
  for (let index = 3; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis], positions[index + axis]);
      high[axis] = Math.max(high[axis], positions[index + axis]);
    }
  }
  return { low, high };
}

/** 境界箱の中心。球の位置を測るのに使う(球の三角形は中心について対称なので誤差が打ち消し合う)。 */
function centerOf(body: SolidBody): Vec3 {
  const { low, high } = boundsOf(body);
  return [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2];
}

/** 40×30 の長方形を 1 枚だけ持つスケッチ。押し出して 40×30×h の箱にする。 */
function rectangleSketch(): SketchDocument {
  const base = createEmptyPartDocument().sketches[0];
  const corners: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [40, 0, 0],
    [40, 30, 0],
    [0, 30, 0],
  ];
  let sketch = base;
  const pointIds: string[] = [];
  for (const [x, y, z] of corners) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, z));
    sketch = appendFeature(sketch, point);
    pointIds.push(point.id);
  }
  const face: SketchFaceFeature = {
    id: 'face-1',
    name: '面1',
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: pointIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  return { ...sketch, features: [...sketch.features, face] };
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

/** 押し出した箱の、指した位置にいちばん近い頂点の指紋(利用者が画面で角を選んだのと同じ形)。 */
function vertexRefNear(body: SolidBody, target: Vec3): SubShapeRef {
  let best: { index: number; position: Vec3; gap: number } | null = null;
  for (const vertex of body.vertices) {
    const gap = Math.hypot(
      vertex.position[0] - target[0],
      vertex.position[1] - target[1],
      vertex.position[2] - target[2],
    );
    if (best === null || gap < best.gap) {
      best = { index: vertex.index, position: [...vertex.position], gap };
    }
  }
  if (best === null) {
    throw new Error('テストの前提が壊れている: 頂点が 1 つも返っていない');
  }
  expect(best.gap).toBeLessThan(1e-6);
  return {
    bodyFeatureId: body.featureId,
    index: best.index,
    fingerprint: { kind: 'vertex', position: best.position },
  };
}

describe('基本形状を部品文書の経路で作る(FR-429、タスク16)', () => {
  it(
    '中心が原点の箱 20×20×20 は体積 8000・面 6 枚で、境界箱が -10〜10 になる',
    async () => {
      const document = partWith(
        primitiveOf('box-1', {
          kind: 'box',
          sizeX: expr('20'),
          sizeY: expr('20'),
          sizeZ: expr('20'),
        }),
      );
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      const body = bodyOf(result, 'box-1');
      // 20³ = 8000。箱は「中心」指定(§0.a-0.17)なので角が -10、+10 に来る。
      expect(body.volume).toBeCloseTo(8000, 6);
      expect(body.faces).toHaveLength(6);
      const { low, high } = boundsOf(body);
      for (const axis of [0, 1, 2]) {
        expect(low[axis]).toBeCloseTo(-10, 6);
        expect(high[axis]).toBeCloseTo(10, 6);
      }
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '半径 10 の球は体積 4188.790204786391(4/3・π・1000)',
    async () => {
      const document = partWith(primitiveOf('sphere-1', { kind: 'sphere', radius: expr('10') }));
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(bodyOf(result, 'sphere-1').volume).toBeCloseTo((4 / 3) * Math.PI * 1000, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '半径 10・高さ 20 の円柱は体積 6283.185307179587 で、底面の中心が原点になる',
    async () => {
      const document = partWith(
        primitiveOf('cylinder-1', {
          kind: 'cylinder',
          radius: expr('10'),
          height: expr('20'),
        }),
      );
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      const body = bodyOf(result, 'cylinder-1');
      // π・10²・20。円柱は「底面の中心」指定(§0.a-0.17)なので z は 0〜20。
      expect(body.volume).toBeCloseTo(Math.PI * 100 * 20, 6);
      const { low, high } = boundsOf(body);
      expect(low[2]).toBeCloseTo(0, 6);
      expect(high[2]).toBeCloseTo(20, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '既定の円錐(下 10・上 0・高さ 20)は体積 2094.3951023931953',
    async () => {
      const document = partWith(
        primitiveOf('cone-1', {
          kind: 'cone',
          bottomRadius: expr('10'),
          topRadius: expr('0'),
          height: expr('20'),
        }),
      );
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      // π/3・10²・20(尖った円錐)。
      expect(bodyOf(result, 'cone-1').volume).toBeCloseTo((Math.PI / 3) * 100 * 20, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '主半径 20・管の半径 5 のトーラスは体積 9869.604401089358',
    async () => {
      const document = partWith(
        primitiveOf('torus-1', {
          kind: 'torus',
          majorRadius: expr('20'),
          minorRadius: expr('5'),
        }),
      );
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      // 2π²・R・r² = 2π²・20・25。
      expect(bodyOf(result, 'torus-1').volume).toBeCloseTo(2 * Math.PI ** 2 * 20 * 25, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '押し出した箱の角を中心にすると 2 ボディになり、押し出しを伸ばすと球も追従する',
    async () => {
      const sketch = rectangleSketch();
      // ① まず押し出しだけを作り、画面で角を選んだのと同じ手順で頂点の指紋を採る。
      const boxOnly = replaceSketch(createEmptyPartDocument(), sketch);
      const first = await recomputePart(
        appendSolid(boxOnly, extrudeOf('10')),
        bridge,
        caches(),
      );
      expect(first.errors).toEqual([]);
      const extruded = bodyOf(first, 'extrude-1');
      expect(extruded.volume).toBeCloseTo(12000, 6);
      const corner = vertexRefNear(extruded, [40, 30, 10]);

      // ② その角を中心にした半径 5 の球を足す。対象は消費しないので 2 ボディ残る。
      const sphere = primitiveOf('sphere-1', { kind: 'sphere', radius: expr('5') }, {
        kind: 'vertex',
        ref: corner,
      });
      const withSphere = appendSolid(appendSolid(boxOnly, extrudeOf('10')), sphere);
      const second = await recomputePart(withSphere, bridge, caches());
      expect(second.errors).toEqual([]);
      expect(second.bodies).toHaveLength(2);
      expect(bodyOf(second, 'extrude-1').volume).toBeCloseTo(12000, 6);
      // 4/3・π・5³ = 523.5987755982988。
      expect(bodyOf(second, 'sphere-1').volume).toBeCloseTo((4 / 3) * Math.PI * 125, 6);
      // 位置は三角形の境界箱から測るので、球の面の近似のぶん(実測 5e-3 mm 程度)だけ
      // ずれる。追従したかどうかは 10mm の動きで見るので、この精度で足りる。
      const centerBefore = centerOf(bodyOf(second, 'sphere-1'));
      for (const [axis, expected] of [40, 30, 10].entries()) {
        expect(centerBefore[axis]).toBeCloseTo(expected, 1);
      }

      // ③ 押し出しを 10 → 20 にすると角が動く。**指紋は 10 のときのまま**でも
      //    カーネルが選び直し、球が新しい角へ付いてくる(鍵が変わって作り直される)。
      const taller = appendSolid(appendSolid(boxOnly, extrudeOf('20')), sphere);
      const third = await recomputePart(taller, bridge, caches());
      expect(third.errors).toEqual([]);
      expect(third.bodies).toHaveLength(2);
      expect(bodyOf(third, 'extrude-1').volume).toBeCloseTo(24000, 6);
      expect(bodyOf(third, 'sphere-1').volume).toBeCloseTo((4 / 3) * Math.PI * 125, 6);
      const centerAfter = centerOf(bodyOf(third, 'sphere-1'));
      for (const [axis, expected] of [40, 30, 20].entries()) {
        expect(centerAfter[axis]).toBeCloseTo(expected, 1);
      }
      // 同じ形を同じ粗さで分割しているので近似のずれは打ち消し合う。
      // 動いた量は Z へちょうど 10mm(押し出しを 10 伸ばしたぶん)になる。
      for (const [axis, expected] of [0, 0, 10].entries()) {
        expect(centerAfter[axis] - centerBefore[axis]).toBeCloseTo(expected, 5);
      }
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '中心にしたスケッチの点を動かすと、基本形状も一緒に動く',
    async () => {
      const build = async (z: number): Promise<SolidBody> => {
        const base = createEmptyPartDocument();
        const point = createPointFeature(base.sketches[0], absoluteCoordinate(5, 5, z));
        const sketch = appendFeature(base.sketches[0], point);
        const box = primitiveOf(
          'box-1',
          { kind: 'box', sizeX: expr('20'), sizeY: expr('20'), sizeZ: expr('20') },
          { kind: 'sketchPoint', ref: { sketchId: sketch.id, pointFeatureId: point.id } },
        );
        const document = appendSolid(replaceSketch(base, sketch), box);
        const result = await recomputePart(document, bridge, caches());
        expect(result.errors).toEqual([]);
        return bodyOf(result, 'box-1');
      };
      // 箱は中心指定なので、点が (5,5,5) にあれば z は -5〜15、(5,5,15) なら 5〜25。
      const low = boundsOf(await build(5));
      expect(low.low[2]).toBeCloseTo(-5, 6);
      expect(low.high[2]).toBeCloseTo(15, 6);
      const high = boundsOf(await build(15));
      expect(high.low[2]).toBeCloseTo(5, 6);
      expect(high.high[2]).toBeCloseTo(25, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '頂点の指紋がどれにも当たらなければ missingSubShape で断り、押し出しは残る',
    async () => {
      const sketch = rectangleSketch();
      const boxOnly = appendSolid(
        replaceSketch(createEmptyPartDocument(), sketch),
        extrudeOf('10'),
      );
      // 通し番号も位置も箱から大きく外れた指紋。model は「立体はある」と通すので、
      // 断るのはカーネルの選び直し(`matchVertex` がしきい値 0.6 に届かない)である。
      const lost: SubShapeRef = {
        bodyFeatureId: 'extrude-1',
        index: 999,
        fingerprint: { kind: 'vertex', position: [1000, 1000, 1000] },
      };
      const document = appendSolid(
        boxOnly,
        primitiveOf('sphere-1', { kind: 'sphere', radius: expr('5') }, { kind: 'vertex', ref: lost }),
      );
      const result = await recomputePart(document, bridge, caches());
      // 止めずに警告する(FR-504)。押し出しは作れているので画面に残る。
      expect(bodyOf(result, 'extrude-1').volume).toBeCloseTo(12000, 6);
      expect(result.bodies).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      // カーネルの断りの語尾から `recomputePart` が理由の種類を見分ける(`solidKernelFailed`)。
      // 基本形状のためにこの詰め替えを足す必要が無いことを、この検査で固定する。
      expect(result.errors[0].code).toBe('missingSubShape');
      expect(result.errors[0].message).toContain('中心にする頂点が見つかりません');
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '寸法が範囲の外なら model が先に断り、カーネルを呼ばずに理由だけが残る',
    async () => {
      const document = partWith(primitiveOf('sphere-1', { kind: 'sphere', radius: expr('0') }));
      const result = await recomputePart(document, bridge, caches());
      expect(result.bodies).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('invalidValue');
      // カーネルの断り(kernelFailed)ではなく、model の断り(invalidValue)が 1 つだけ出る。
      expect(result.errors[0].message).toBe('半径は 0 より大きい数にしてください。');
    },
    OCCT_TIMEOUT_MS,
  );
});
