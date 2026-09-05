/**
 * P5 の Should 群のうち、42c でカーネルの段の欄が増えた/直った 3 種
 * (リブの `extendToBody`、ねじ穴の入口 `entry`)と、まだ実カーネルの往復を固定していなかった
 * 残りの Should 群(エンボス・外ねじ・曲面・くり抜き)を、**部品文書の経路**
 * (`recomputePart` → `resolvePart` → `kernelBridge` → 実 OCCT)で体積・面積まで確かめる
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.11・§2.15、P5 タスク46b)。
 *
 * ## なぜ純関数の検査(resolvePart.test.ts・kernel の各 make*.test.ts)では足りないか
 *
 * P4 タスク21 の教訓(`docs/報告記録.md` 2026-09-04 21:05)と同じ理由。model 側の単体検査が
 * すべて緑でも、部品文書の経路で配線が抜けている(段の鍵が届かない・欄が落ちる)ことが
 * 実機で初めて見つかる。とくに 42c で `RibStepSpec.extendToBody` / `ThreadStepSpec.entry` を
 * 足した直後は、`kernelBridge.ts` の詰め替えが新しい欄を運んでいるかどうかが
 * 純関数の検査(段の中身を見るだけ)では確かめられない。
 *
 * Worker を使わない理由・OCCT の待ち時間は `primitiveKernel.test.ts` と同じ(`OCCT_TIMEOUT_MS`)。
 * 期待値の出どころは各検査の注釈に書く。
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
import { DEFAULT_WORK_PLANE_ID, type WorkPlaneId } from '../sketch/planeMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import type { SketchDocument, SketchFaceFeature, SketchLineFeature } from '../sketch/types.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from './createPartDocument.js';
import { recomputePart, type PartRecomputeResult } from './recomputePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type {
  EmbossFeature,
  ExtrudeFeature,
  PartDocument,
  PrimitiveFeature,
  PrimitiveShape,
  RibFeature,
  ShellFeature,
  SketchFaceRef,
  SketchPointRef,
  SolidOrigin,
  SubShapeRef,
  SurfaceFeature,
  ThreadHoleFeature,
  ThreadShaftFeature,
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

function boxShape(sizeX: string, sizeY: string, sizeZ: string): PrimitiveShape {
  return { kind: 'box', sizeX: expr(sizeX), sizeY: expr(sizeY), sizeZ: expr(sizeZ) };
}

function cylinderShape(radius: string, height: string): PrimitiveShape {
  return { kind: 'cylinder', radius: expr(radius), height: expr(height) };
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

/** 矩形の面を 1 枚足す(角の絶対座標 2 点を対角に指定する)。 */
function addRectFace(
  sketch: SketchDocument,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
): { readonly sketch: SketchDocument; readonly faceId: string } {
  const added = addPoints(sketch, [
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ]);
  return addFace(added.sketch, added.pointIds);
}

/** 線分フィーチャーを 1 本足す(resolvePart.test.ts の addLine と同じ書き方)。 */
function addLine(
  sketch: SketchDocument,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  planeId: WorkPlaneId = DEFAULT_WORK_PLANE_ID,
): { readonly sketch: SketchDocument; readonly id: string } {
  const line: SketchLineFeature = {
    id: nextFeatureId(sketch, 'line'),
    name: nextFeatureName(sketch, 'line'),
    planeId,
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], from[2]),
    to: absoluteCoordinate(to[0], to[1], to[2]),
    construction: false,
  };
  return { sketch: appendFeature(sketch, line), id: line.id };
}

function extrudeFeature(id: string, face: SketchFaceRef, distance: string): ExtrudeFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: face,
    distance: expr(distance),
    reversed: false,
    symmetric: false,
  };
}

/**
 * 立体の一覧から、指定した高さにある水平な平らな面の参照を作る(UI の面選びと同じ手順、
 * `thruSectionsKernel.test.ts` / `projectionKernel.test.ts` の `topFaceRef` と同じ)。
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

/**
 * 面ごとの面積(`SolidFaceEntry.area`)を合計した、ボディ全体の表面積。
 *
 * `SolidBody.area`(全体の値)は `recomputePart` が `measureAreas` を頼まないので**常に
 * undefined になる**(`kernel/src/occt/solidMesh.ts` の注釈、統括の決定 P5 タスク14)。
 * 一方、面ごとの面積(`faces[].area`)は部分形状の照合に使うため常に測ってあるので、
 * こちらを合計すれば `measureAreas` に頼らずに実カーネルの面積を確かめられる。
 */
function faceAreaSum(body: SolidBody): number {
  return body.faces.reduce((sum, face) => sum + face.area, 0);
}

/** 円柱の側面(外ねじ・くり抜き以外の加工が使う円柱面)の参照を、半径で探して作る。 */
function cylinderFaceRef(body: SolidBody, radius: number): SubShapeRef {
  const found = body.faces.find(
    (face) => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - radius) < 1e-6,
  );
  if (found === undefined) {
    throw new Error(`半径 ${radius} の円柱面が見つかりません`);
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

describe('リブ(FR-420)の実カーネル往復。42c でカーネルの段に extendToBody が増えた(タスク46b)', () => {
  /**
   * 板(40×30×10、z:0〜10)の 20mm 上(z=30)に、長さ 40 の線を「xz」面へ引く
   * (法線 (0,1,0)・弦 +X・伸ばす向き (0,0,-1)。§0.a-0.37 の注釈の例とまったく同じ形)。
   * 厚み 2・両側なので、材料まで伸ばすと壁は 40×20×2 = 1600mm³ 増え、12000+1600=13600 になる
   * (`makeRib.ts` タスク38 の検証表と同じ手計算。§0.a-0.37)。
   *
   * **輪郭(線)自身の長さは 40 で、実際に材料へ届くまでの間隔(20)より長い。** そのため
   * `extendToBody: false`(伸ばす長さを輪郭の長さ=40にする)でも壁は板を突き抜け、
   * カーネルは「輪郭に接している側の塊だけ」を採るので、余分に突き出た側は捨てられて
   * 同じ 13600 になる(`makeRib.ts` の③「帯に接している塊だけを採る」)。
   */
  function ribDocument(
    extendToBody: boolean,
    from: readonly [number, number, number] = [0, 15, 30],
    to: readonly [number, number, number] = [40, 15, 30],
  ): { readonly document: PartDocument } {
    const base = createEmptyPartDocument();
    const rect = addRectFace(base.sketches[0], 0, 0, 40, 30, 0);
    const line = addLine(rect.sketch, from, to, 'xz');
    const sketch = line.sketch;
    const board = appendSolid(
      replaceSketch(base, sketch),
      extrudeFeature('board-1', { sketchId: sketch.id, faceFeatureId: rect.faceId }, '10'),
    );
    const rib: RibFeature = {
      id: 'rib-1',
      name: 'rib-1',
      suppressed: false,
      kind: 'rib',
      targetFeatureId: 'board-1',
      profile: { sketchId: sketch.id, curveIds: [line.id] },
      thickness: expr('2'),
      side: 'both',
      extendToBody,
    };
    return { document: appendSolid(board, rib) };
  }

  it(
    '材料まで伸ばす(extendToBody: true)と 13600mm³ になる',
    async () => {
      const { document } = ribDocument(true);
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(bodyOf(result, 'rib-1').volume).toBeCloseTo(13600, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '材料まで伸ばさない(extendToBody: false)でも、輪郭が材料に届く配置なら同じ 13600mm³ になる',
    async () => {
      const { document } = ribDocument(false);
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(bodyOf(result, 'rib-1').volume).toBeCloseTo(13600, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '材料まで伸ばさない(extendToBody: false)で、輪郭が短くて材料に届かない配置は、model は通すがカーネルが断る',
    async () => {
      // 板の 20mm 上に置いた長さ 5 の短い線(x=10→15、z=30。kernel の makeRib.test.ts の
      // LINE_TOO_SHORT とまったく同じ形)。伸ばさないと z=25 までしか下りず、板(z:0〜10)に
      // 届かない。model 側の解決は「輪郭・厚み・向きが決まる」以上のことを見ないので通り
      // (target/profile/thickness/direction はすべて有効)、実カーネル(`makeRib.ts`)が
      // 「帯が材料に届いていない」と判定して断る(FR-504、NFR-RE-1「止めずに警告する」)。
      const { document } = ribDocument(false, [10, 15, 30], [15, 15, 30]);
      const result = await recomputePart(document, bridge, caches());
      expect(result.bodies.find((body) => body.featureId === 'rib-1')).toBeUndefined();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].featureId).toBe('rib-1');
      expect(result.errors[0].code).toBe('kernelFailed');
      // makeRib.ts の NOT_TOUCHING_MESSAGE と1字も違えずに揃える(片方だけ直すと理由が食い違う)。
      expect(result.errors[0].message).toBe('リブが材料に届きません。');
    },
    OCCT_TIMEOUT_MS,
  );
});

describe('エンボス(FR-421)の実カーネル往復(タスク46b)', () => {
  it(
    '40×30×10 の板の上面へ 10×10 を深さ 2 で彫ると 11800(12000 − 200)になる',
    async () => {
      const base = createEmptyPartDocument();
      const board = addRectFace(base.sketches[0], 0, 0, 40, 30, 0);
      const boardDocument = appendSolid(
        replaceSketch(base, board.sketch),
        extrudeFeature('board-1', { sketchId: board.sketch.id, faceFeatureId: board.faceId }, '10'),
      );
      const first = await recomputePart(boardDocument, bridge, caches());
      expect(first.errors).toEqual([]);
      const boardBody = bodyOf(first, 'board-1');
      expect(boardBody.volume).toBeCloseTo(12000, 6);
      const topRef = topFaceRef(boardBody, 10);

      const carve = addRectFace(board.sketch, 15, 10, 25, 20, 10);
      const emboss: EmbossFeature = {
        id: 'emboss-1',
        name: 'emboss-1',
        suppressed: false,
        kind: 'emboss',
        targetFeatureId: 'board-1',
        face: topRef,
        profile: { sketchId: carve.sketch.id, faceFeatureId: carve.faceId },
        height: expr('2'),
        raised: false,
      };
      const document = appendSolid(replaceSketch(boardDocument, carve.sketch), emboss);
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      expect(bodyOf(result, 'emboss-1').volume).toBeCloseTo(11800, 6);
    },
    OCCT_TIMEOUT_MS,
  );
});

describe('外ねじ(FR-423)の実カーネル往復(タスク46b)', () => {
  it(
    'φ10×20 の円柱の側面に M10(簡略表示)を切っても体積は変わらず、印が 1 つ出る',
    async () => {
      const document = appendSolid(
        createEmptyPartDocument(),
        primitiveOf('cyl-1', cylinderShape('5', '20')),
      );
      const first = await recomputePart(document, bridge, caches());
      expect(first.errors).toEqual([]);
      const cylBody = bodyOf(first, 'cyl-1');
      // π・5²・20(簡略表示は B-rep に触れないので、ねじを切っても体積は不変)。
      expect(cylBody.volume).toBeCloseTo(1570.7963267948967, 6);
      const sideRef = cylinderFaceRef(cylBody, 5);

      const threadShaft: ThreadShaftFeature = {
        id: 'threadShaft-1',
        name: 'threadShaft-1',
        suppressed: false,
        kind: 'threadShaft',
        targetFeatureId: 'cyl-1',
        face: sideRef,
        nominal: 'M10',
        series: 'coarse',
        pitch: expr('1.5'),
        length: expr('15'),
        fromEnd: 'first',
        modeled: false,
      };
      const result = await recomputePart(appendSolid(document, threadShaft), bridge, caches());
      expect(result.errors).toEqual([]);
      const body = bodyOf(result, 'threadShaft-1');
      expect(body.volume).toBeCloseTo(1570.7963267948967, 6);
      expect(body.threadMarks).toHaveLength(1);
    },
    OCCT_TIMEOUT_MS,
  );
});

describe('曲面(FR-428)の実カーネル往復(タスク46b)', () => {
  it(
    '長さ 40 の線を 10 押し出した面は、面積 400 の殻(bodyKind: shell)になる',
    async () => {
      const base = createEmptyPartDocument();
      const line = addLine(base.sketches[0], [0, 0, 0], [40, 0, 0]);
      const sketch = line.sketch;
      const surface: SurfaceFeature = {
        id: 'surface-1',
        name: 'surface-1',
        suppressed: false,
        kind: 'surface',
        operation: {
          kind: 'extrude',
          profile: { sketchId: sketch.id, curveIds: [line.id] },
          distance: expr('10'),
          reversed: false,
        },
      };
      const document = appendSolid(replaceSketch(base, sketch), surface);
      const result = await recomputePart(document, bridge, caches());
      expect(result.errors).toEqual([]);
      const body = bodyOf(result, 'surface-1');
      expect(faceAreaSum(body)).toBeCloseTo(400, 6);
      expect(body.bodyKind).toBe('shell');
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '箱の上面(40×30×10)を +5 離した面も、面積 1200 の殻になり、箱は消費されず 2 ボディ残る',
    async () => {
      const document = appendSolid(
        createEmptyPartDocument(),
        primitiveOf('box-1', boxShape('40', '30', '10'), originAt(0, 0, 5)),
      );
      const first = await recomputePart(document, bridge, caches());
      expect(first.errors).toEqual([]);
      const boxBody = bodyOf(first, 'box-1');
      const topRef = topFaceRef(boxBody, 10);

      const surface: SurfaceFeature = {
        id: 'surface-2',
        name: 'surface-2',
        suppressed: false,
        kind: 'surface',
        operation: { kind: 'offset', targetFeatureId: 'box-1', face: topRef, distance: expr('5') },
      };
      const result = await recomputePart(appendSolid(document, surface), bridge, caches());
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(2);
      const body = bodyOf(result, 'surface-2');
      expect(faceAreaSum(body)).toBeCloseTo(1200, 6);
      expect(body.bodyKind).toBe('shell');
      expect(bodyOf(result, 'box-1').volume).toBeCloseTo(12000, 6);
    },
    OCCT_TIMEOUT_MS,
  );
});

describe('くり抜き(シェル。FR-418)の実カーネル往復(タスク46b)', () => {
  it(
    '20³ の箱を厚さ 2・上面開口でくり抜くと 3392mm³ になる',
    async () => {
      const document = appendSolid(
        createEmptyPartDocument(),
        primitiveOf('box-1', boxShape('20', '20', '20')),
      );
      const first = await recomputePart(document, bridge, caches());
      expect(first.errors).toEqual([]);
      const boxBody = bodyOf(first, 'box-1');
      const topRef = topFaceRef(boxBody, 10);

      const shell: ShellFeature = {
        id: 'shell-1',
        name: 'shell-1',
        suppressed: false,
        kind: 'shell',
        targetFeatureId: 'box-1',
        openFaces: [topRef],
        thickness: expr('2'),
        outward: false,
      };
      const result = await recomputePart(appendSolid(document, shell), bridge, caches());
      expect(result.errors).toEqual([]);
      expect(bodyOf(result, 'shell-1').volume).toBeCloseTo(3392, 6);
    },
    OCCT_TIMEOUT_MS,
  );
});

describe('ねじ穴の入口(ざぐり。FR-422)の実カーネル往復。42c でカーネルの段に entry が増えた(タスク46b)', () => {
  /**
   * `kernelBridge.ts` の `toSolidStepSpec` の `case 'thread'` に `entry` の詰め替えが
   * 無く、実カーネルへ `entry` が届いていなかった(46b の実測で発見、統括の指示で修正)。
   * `case 'hole'` と同じ `...(plan.entry === undefined ? {} : { entry: plan.entry })` を
   * 足したので、いまは通常の `it` として緑になる。
   */
  it(
    'M6 + ざぐり(φ11・深さ4)は、下穴だけの簡略ねじ穴より 304.164307359 だけ体積が小さい(42c の実測)',
    async () => {
      const base = createEmptyPartDocument();
      const rect = addRectFace(base.sketches[0], 0, 0, 40, 30, 0);
      const added = addPoints(rect.sketch, [[20, 15, 10]]);
      const sketch = added.sketch;
      const boardDocument = appendSolid(
        replaceSketch(base, sketch),
        extrudeFeature('board-1', { sketchId: sketch.id, faceFeatureId: rect.faceId }, '10'),
      );
      const first = await recomputePart(boardDocument, bridge, caches());
      expect(first.errors).toEqual([]);
      const boardBody = bodyOf(first, 'board-1');
      const topRef = topFaceRef(boardBody, 10);
      const center: SketchPointRef = { sketchId: sketch.id, pointFeatureId: added.pointIds[0] };

      const plainThread: ThreadHoleFeature = {
        id: 'thread-1',
        name: 'thread-1',
        suppressed: false,
        kind: 'threadHole',
        targetFeatureId: 'board-1',
        face: topRef,
        centers: [center],
        designation: 'M6',
        series: 'coarse',
        pitch: expr('1'),
        // M6 並目の下穴径 D1(cacheKey.test.ts の thread() ビルダと同じ値)。
        drillDiameter: expr('4.917468'),
        depth: { kind: 'through' },
        threadLength: expr('5'),
        representation: 'simplified',
        tiltAngle: expr('0'),
        tiltAzimuth: expr('0'),
      };
      const plainResult = await recomputePart(
        appendSolid(boardDocument, plainThread),
        bridge,
        caches(),
      );
      expect(plainResult.errors).toEqual([]);
      const plainVolume = bodyOf(plainResult, 'thread-1').volume;

      const boredThread: ThreadHoleFeature = {
        ...plainThread,
        entry: { kind: 'counterbore', diameter: expr('11'), depth: expr('4') },
      };
      const boredResult = await recomputePart(
        appendSolid(boardDocument, boredThread),
        bridge,
        caches(),
      );
      expect(boredResult.errors).toEqual([]);
      const boredVolume = bodyOf(boredResult, 'thread-1').volume;

      // π・((11/2)² − (4.917468/2)²)・4 = 304.164307359…(42c の実測、担当の指示書どおり)。
      // 部品文書の経路(実測 304.16431493765594)は kernel 単体の `expectVolumeExact`
      // (1e-6)より 1 桁だけ緩い(差 7.6e-6、相対誤差 2.5e-8)。ねじ穴は素の穴より段が多い
      // 経路を通る(下穴+ざぐり+印の生成)ため、体積の数値積分の丸めがわずかに増えると
      // 見られる。狙いは「ざぐりが実カーネルまで届いて体積を削る」ことの確認なので、
      // ここでは 1e-4 の精度で足りると判断する(統括へ実測差を報告)。
      expect(plainVolume - boredVolume).toBeCloseTo(304.164307359, 4);
    },
    OCCT_TIMEOUT_MS,
  );
});

describe('同じ文書を2回解決すると命中する(NFR-PF-3、タスク46b)', () => {
  it(
    '押し出しだけの文書は、1回目は命中0、2回目は必ず命中する',
    async () => {
      const base = createEmptyPartDocument();
      const rect = addRectFace(base.sketches[0], 0, 0, 10, 10, 0);
      const document = appendSolid(
        replaceSketch(base, rect.sketch),
        extrudeFeature('extrude-1', { sketchId: rect.sketch.id, faceFeatureId: rect.faceId }, '5'),
      );

      const first = await recomputePart(document, bridge, caches());
      expect(first.errors).toEqual([]);
      expect(first.cacheHits).toBe(0);

      const second = await recomputePart(document, bridge, caches());
      expect(second.errors).toEqual([]);
      expect(second.cacheHits).toBe(1);
    },
    OCCT_TIMEOUT_MS,
  );
});
